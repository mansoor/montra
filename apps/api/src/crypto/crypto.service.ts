import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Trx } from '@montra/db';
import { CONFIG, type AppConfig } from '../config.js';

/** Wraps and unwraps data keys (envelope encryption, design 03 §12). Production uses AWS KMS. */
export interface KmsPort {
  wrap(dataKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}
export const KMS_PORT = Symbol('KMS_PORT');

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed[0] !== VERSION) throw new Error('Unsupported ciphertext version');
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/** Local KMS for development and tests: AES-256-GCM under a master key from configuration. */
@Injectable()
export class LocalKms implements KmsPort {
  private readonly master: Buffer;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.master = config.MASTER_KEY
      ? Buffer.from(config.MASTER_KEY, 'base64')
      : createHash('sha256').update('montra-insecure-development-master-key').digest();
    if (this.master.length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64-encoded');
  }

  async wrap(dataKey: Buffer): Promise<Buffer> {
    return seal(this.master, dataKey, Buffer.from('montra:dek'));
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    return open(this.master, wrapped, Buffer.from('montra:dek'));
  }
}

/**
 * Field-level encryption for `_enc` columns (NFR-01). One data key per workspace, created lazily and cached
 * in memory for five minutes; ciphertext is bound to the workspace and column through AES-GCM associated data.
 */
@Injectable()
export class FieldCrypto {
  private readonly cache = new Map<string, { key: Buffer; until: number }>();

  constructor(@Inject(KMS_PORT) private readonly kms: KmsPort) {}

  async encrypt(
    trx: Trx,
    workspaceId: string,
    column: string,
    value: string | null | undefined,
  ): Promise<Buffer | null> {
    if (value === null || value === undefined || value === '') return null;
    const key = await this.dataKey(trx, workspaceId);
    return seal(key, Buffer.from(value, 'utf8'), Buffer.from(`${workspaceId}:${column}`));
  }

  async decrypt(
    trx: Trx,
    workspaceId: string,
    column: string,
    sealed: Buffer | null,
  ): Promise<string | null> {
    if (!sealed) return null;
    const key = await this.dataKey(trx, workspaceId);
    return open(key, sealed, Buffer.from(`${workspaceId}:${column}`)).toString('utf8');
  }

  private async dataKey(trx: Trx, workspaceId: string): Promise<Buffer> {
    const cached = this.cache.get(workspaceId);
    if (cached && cached.until > Date.now()) return cached.key;
    let row = await trx
      .selectFrom('app.workspace_key')
      .select('wrapped_key')
      .where('workspace_id', '=', workspaceId)
      .orderBy('key_version', 'desc')
      .executeTakeFirst();
    if (!row) {
      const fresh = randomBytes(32);
      const wrapped = await this.kms.wrap(fresh);
      await trx
        .insertInto('app.workspace_key')
        .values({ workspace_id: workspaceId, wrapped_key: wrapped })
        .onConflict((oc) => oc.doNothing())
        .execute();
      row = await trx
        .selectFrom('app.workspace_key')
        .select('wrapped_key')
        .where('workspace_id', '=', workspaceId)
        .orderBy('key_version', 'desc')
        .executeTakeFirstOrThrow();
    }
    const key = await this.kms.unwrap(row.wrapped_key);
    this.cache.set(workspaceId, { key, until: Date.now() + 5 * 60_000 });
    return key;
  }
}
