/**
 * Connecting the workspace to the household's Family Document Vault (ADR-0054 §2, §7, §8; VLT-01, VLT-08). Montra makes
 * the key pair, the vault's owner registers it in the vault and gets a code, the owner pastes the code back, and Montra
 * checks it: the code names Montra's key, the address passes the guard, the vault says which vault it is (pinned), and
 * a signed connection test passes or says it waits for someone there to approve. Replacing the key and disconnecting
 * are here too. Nothing is sent yet: the connection's "send files" switch stays off until sending ships (PR 3).
 *
 * Only an owner connects, replaces the key or disconnects, with a recent sign-in (the controller asks for it; D4).
 * Owners and admins see the connection and may ask Montra to check it again. The private key goes in sealed and never
 * comes back out: not in a DTO, an error, a log line, the security log or an archive.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import type { StorageDestinationTable, Trx, VaultConnectionStateTable } from '@montra/db';
import {
  VAULT_GROUP_DEFAULTS,
  VAULT_GROUPS,
  VaultGroup,
  VaultGroupMode,
  VaultKindDto,
  VaultStage,
  vaultFileKinds,
  vaultGroupModes,
  type DisconnectVaultRequest,
  type PasteVaultCodeRequest,
  type ReplaceVaultKeyRequest,
  type VaultConnectionDto,
} from '@montra/schemas';
import { AppError } from '../../common/errors.js';
import { isAdmin } from '../../common/roles.js';
import { FieldCrypto } from '../../crypto/crypto.service.js';
import { Db } from '../../db/database.js';
import { defaultFolder } from '../destinations/paths.js';
import { VaultError, type VaultCheck } from '../destinations/vault.js';
import { SECRET_COLUMN } from '../storage-destinations.service.js';
import { readVaultCode, VaultConnection, type VaultCode } from './connection.js';
import { makeVaultKey, VaultSecret } from './keys.js';
import { assertVaultAddress, VAULT_TRANSPORT, type VaultTransport } from './transport.js';

type Ctx = { workspaceId: string; userId: string };
type Row = Selectable<StorageDestinationTable>;
type StateRow = Selectable<VaultConnectionStateTable>;

/** The connection's label; the vault's household name is shown once the vault has said it. */
export const VAULT_LABEL = 'Family Document Vault';
/** Five failed checks in a row with no success turn the connection `failing`, as for a mirror (§12). */
export const VAULT_FAILING_AFTER = 5;
/** When the job (PR 3) should next look: daily once connected, sooner while waiting for approval (§2 step 4). */
const NEXT_CHECK_MS = { connected: 24 * 3600_000, waiting: 15 * 60_000 };

/** What isn't secret, as stored in `config` for an `fdv` row (§11). Parsed again whenever it is read. */
const VaultConfig = z.object({
  stage: VaultStage,
  publicKey: z.string(),
  fingerprint: z.string(),
  newKey: z.object({ publicKey: z.string(), fingerprint: z.string() }).nullable().default(null),
  address: z.string().nullable().default(null),
  appId: z.string().nullable().default(null),
  keyId: z.string().nullable().default(null),
  /** The vault's installation id, pinned when the code was accepted. */
  identity: z.string().nullable().default(null),
  householdName: z.string().nullable().default(null),
  actingAs: z.string().nullable().default(null),
  sendKinds: z.array(VaultKindDto).default([]),
  mediaTypes: z.array(z.string()).default([]),
  mayReadBack: z.boolean().default(false),
  mayDelete: z.boolean().default(false),
  groups: z
    .array(z.object({ group: VaultGroup, mode: VaultGroupMode, vaultKind: z.string().nullable() }))
    .default([]),
  describeMore: z.boolean().default(false),
});
type VaultConfig = z.infer<typeof VaultConfig>;

const ownerOnly = () =>
  new AppError(
    403,
    'vault.owner_only',
    'Only an owner can connect, change or disconnect the Family Document Vault',
  );
const ownersAndAdmins = () =>
  new AppError(
    403,
    'vault.not_allowed',
    'Only an owner or admin can see the Family Document Vault connection',
  );
const notConnected = () => new AppError(404, 'not_found', 'The Family Document Vault isn’t connected');
const conflict = () =>
  new AppError(
    409,
    'version.conflict',
    'The vault connection was changed by someone else; reload and try again',
  );
/** A `VaultError` as an answer to the person who asked: its words, never its detail. */
const refusal = (e: VaultError) => new AppError(422, `vault.${e.code}`, e.shown);

@Injectable()
export class VaultService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(VAULT_TRANSPORT) private readonly transport: VaultTransport,
  ) {}

  // ----- Reading ---------------------------------------------------------------------------------------------------

  async get(ctx: Ctx, role: string): Promise<VaultConnectionDto | null> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      return row ? this.dto(trx, row) : null;
    });
  }

  // ----- Connecting (§2) ---------------------------------------------------------------------------------------------

  /**
   * Step 1: a fresh key pair for this workspace, the private key sealed at once. Asking again before a code is pasted
   * gives back the same key, so a reload doesn't leave the vault with a key Montra has thrown away.
   */
  async start(ctx: Ctx, role: string): Promise<VaultConnectionDto> {
    if (role !== 'owner') throw ownerOnly();
    return this.db.run(ctx, async (trx) => {
      const existing = await this.row(trx, ctx);
      if (existing) {
        if (configOf(existing).stage === 'register') return this.dto(trx, existing);
        throw new AppError(
          409,
          'vault.exists',
          'This workspace is already connected to a Family Document Vault',
        );
      }
      const key = makeVaultKey();
      const config: VaultConfig = VaultConfig.parse({
        stage: 'register',
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        groups: VAULT_GROUPS.map((group) => ({ group, mode: VAULT_GROUP_DEFAULTS[group], vaultKind: null })),
      });
      const ws = await trx
        .selectFrom('app.workspace')
        .select('name')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('app.storage_destination')
        .values({
          workspace_id: ctx.workspaceId,
          kind: 'fdv',
          label: VAULT_LABEL,
          config: JSON.stringify(config),
          secret_enc: (await this.seal(trx, ctx, {
            v: 1,
            current: { pkcs8: key.pkcs8, keyId: null },
            next: null,
          }))!,
          secret_hint: null,
          // Unused for a vault (backups never go there), but the column is NOT NULL (ADR-0054, As built: PR 1).
          folder: defaultFolder(ws.name),
          // Nothing is sent until sending ships (PR 3): the trigger queues nothing while this is off.
          mirror_files: false,
          file_kinds: vaultFileKinds(modesOf(config)),
          status: 'needs_vault',
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // Nothing for the job to look at until there is a code.
      await trx
        .insertInto('app.vault_connection_state')
        .values({
          workspace_id: ctx.workspaceId,
          destination_id: row.id,
          next_check_at: sql<Date>`'infinity'::timestamptz`,
        })
        .execute();
      await this.security(trx, ctx, 'vault_changed', { keyMade: true, fingerprint: key.fingerprint });
      return this.dto(trx, row);
    });
  }

  /**
   * Step 3, and the end of a key change: the code the vault gave. Checked in order: it names the key Montra is waiting
   * on, its address passes the guard, the server there is a vault that takes apps (and, for a key change, the one
   * pinned), and a signed connection test passes. Nothing is saved unless all of that holds.
   */
  async paste(ctx: Ctx, role: string, req: PasteVaultCodeRequest): Promise<VaultConnectionDto> {
    if (role !== 'owner') throw ownerOnly();
    const row = await this.db.run(ctx, (trx) => this.row(trx, ctx));
    if (!row) throw notConnected();
    if (BigInt(row.version) !== BigInt(req.version)) throw conflict();
    const config = configOf(row);
    const rotating = config.newKey !== null;
    if (!rotating && config.stage !== 'register') {
      throw new AppError(
        409,
        'vault.already_connected',
        'Montra is already connected to this vault. To use a new code, replace the key or disconnect first.',
      );
    }

    let code: VaultCode;
    try {
      code = readVaultCode(req.code);
      const expected = rotating ? config.newKey!.fingerprint : config.fingerprint;
      if (code.fingerprint !== expected) throw new VaultError('other_key');
      // A new key is for the same app in the same vault.
      if (rotating && code.appId !== config.appId) throw new VaultError('other_key', { detail: 'other app' });
      assertVaultAddress(code.address);
    } catch (e) {
      throw refusal(e instanceof VaultError ? e : new VaultError('invalid_code'));
    }

    const secret = await this.unseal(ctx, row);
    const key = rotating ? secret.next : secret.current;
    if (!key) throw conflict();
    const check = await this.tryCheck(
      code.address,
      code.appId,
      code.keyId,
      key.pkcs8,
      rotating ? config.identity : null,
    );
    if (check instanceof VaultError) throw refusal(check);
    if (code.identity !== null && code.identity !== check.identity) {
      throw refusal(new VaultError('identity_changed', { detail: 'code' }));
    }

    const oldKeyId = secret.current.keyId;
    const updated = await this.db.run(ctx, async (trx) => {
      const now = new Date();
      const next: VaultConfig = {
        ...config,
        ...this.reported(check),
        stage: check.approved ? 'connected' : 'approval',
        address: new URL(code.address).origin,
        appId: code.appId,
        keyId: code.keyId,
        identity: check.identity,
        ...(rotating
          ? { publicKey: config.newKey!.publicKey, fingerprint: config.newKey!.fingerprint, newKey: null }
          : {}),
      };
      const sealed: VaultSecret = rotating
        ? { v: 1, current: { pkcs8: secret.next!.pkcs8, keyId: code.keyId }, next: null }
        : { v: 1, current: { pkcs8: secret.current.pkcs8, keyId: code.keyId }, next: null };
      const saved = await trx
        .updateTable('app.storage_destination')
        .set({
          config: JSON.stringify(next),
          secret_enc: (await this.seal(trx, ctx, sealed))!,
          can_delete: check.mayDelete,
          status: check.approved ? (row.status === 'paused' ? 'paused' : 'active') : 'needs_vault',
          consecutive_failures: 0,
          last_error: null,
          last_error_at: null,
          ...(check.approved ? { last_success_at: now } : {}),
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .returningAll()
        .executeTakeFirst();
      if (!saved) throw conflict();
      await this.saveState(trx, ctx, row.id, check, { keyRotation: 'none' });
      if (rotating) {
        await this.security(trx, ctx, 'vault_key_replaced', { fingerprint: next.fingerprint });
      } else {
        await this.security(trx, ctx, 'vault_connected', {
          host: new URL(code.address).host,
          householdName: check.householdName,
          approved: check.approved,
          fingerprint: next.fingerprint,
        });
      }
      return this.dto(trx, saved);
    });

    // The old key is no longer used. The vault retires it on its own a few days after the new one is first used; this
    // only makes it sooner, so a vault that doesn't take it changes nothing.
    if (rotating && oldKeyId && oldKeyId !== code.keyId) {
      const conn = this.open(code.address, code.appId, code.keyId, secret.next!.pkcs8, check.identity);
      await conn.retireKey(oldKeyId).catch(() => undefined);
      conn.close();
    }
    return updated;
  }

  /**
   * "Check again" (§2 step 4, §12.1): the signed connection test, now. Approved: connected. Still waiting: as it was.
   * A problem with the connection itself, or a different vault at the address, stops it (`needs_vault`) with the words
   * to show; anything else is a failed check, and five in a row turn it `failing`.
   */
  async checkAgain(ctx: Ctx, role: string): Promise<VaultConnectionDto> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    const row = await this.db.run(ctx, (trx) => this.row(trx, ctx));
    if (!row) throw notConnected();
    const config = configOf(row);
    if (config.stage === 'register' || !config.address || !config.appId || !config.keyId) {
      throw new AppError(409, 'vault.no_code', 'Paste the code from the vault first');
    }
    const secret = await this.unseal(ctx, row);
    const check = await this.tryCheck(
      config.address,
      config.appId,
      config.keyId,
      secret.current.pkcs8,
      config.identity,
    );
    return this.db.run(ctx, async (trx) => {
      const now = new Date();
      const set: Record<string, unknown> = { updated_at: now, version: sql`version + 1` };
      if (check instanceof VaultError) {
        set.last_error = check.shown;
        set.last_error_at = now;
        if (check.stopsConnection) {
          if (row.status !== 'paused') set.status = 'needs_vault';
        } else if (check.countsAsFailure) {
          const failures = row.consecutive_failures + 1;
          set.consecutive_failures = failures;
          if (failures >= VAULT_FAILING_AFTER && row.status === 'active') set.status = 'failing';
        }
      } else {
        set.config = JSON.stringify({
          ...config,
          ...this.reported(check),
          stage: check.approved ? 'connected' : 'approval',
        } satisfies VaultConfig);
        set.can_delete = check.mayDelete;
        set.last_error = null;
        set.last_error_at = null;
        set.consecutive_failures = 0;
        if (check.approved) set.last_success_at = now;
        if (row.status !== 'paused') set.status = check.approved ? 'active' : 'needs_vault';
      }
      const saved = await trx
        .updateTable('app.storage_destination')
        .set(set as never)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (!(check instanceof VaultError)) await this.saveState(trx, ctx, row.id, check);
      return this.dto(trx, saved);
    });
  }

  /**
   * "Replace the key" (§2): a new pair, sealed beside the current one. Someone in the vault adds its public key to
   * Montra's app there and gets a code, which the owner pastes as when connecting; Montra signs with the current key
   * until that code checks out. `cancel` drops a new key not yet confirmed.
   */
  async replaceKey(ctx: Ctx, role: string, req: ReplaceVaultKeyRequest): Promise<VaultConnectionDto> {
    if (role !== 'owner') throw ownerOnly();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      if (BigInt(row.version) !== BigInt(req.version)) throw conflict();
      const config = configOf(row);
      if (config.stage === 'register' || !config.keyId) {
        throw new AppError(409, 'vault.no_code', 'Paste the code from the vault first');
      }
      const secret = await this.unseal(ctx, row, trx);
      const key = req.cancel ? null : makeVaultKey();
      const now = new Date();
      const saved = await trx
        .updateTable('app.storage_destination')
        .set({
          config: JSON.stringify({
            ...config,
            newKey: key ? { publicKey: key.publicKey, fingerprint: key.fingerprint } : null,
          } satisfies VaultConfig),
          secret_enc: (await this.seal(trx, ctx, {
            v: 1,
            current: secret.current,
            next: key ? { pkcs8: key.pkcs8, keyId: null } : null,
          }))!,
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .returningAll()
        .executeTakeFirst();
      if (!saved) throw conflict();
      await trx
        .updateTable('app.vault_connection_state')
        .set({
          key_rotation: key ? 'made' : 'none',
          key_rotation_at: key ? now : null,
          updated_at: now,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', row.id)
        .execute();
      if (key || config.newKey) {
        await this.security(
          trx,
          ctx,
          'vault_changed',
          key ? { newKeyMade: true, fingerprint: key.fingerprint } : { newKeyCancelled: true },
        );
      }
      return this.dto(trx, saved);
    });
  }

  /**
   * Disconnecting destroys the key with the connection; connecting again makes a new one (§7). Montra holds every file
   * it sent until PR 5, so there is nothing to bring back first and `anyway` changes nothing yet. The app stays
   * registered in the vault until someone there removes it; Settings says so.
   */
  async disconnect(ctx: Ctx, role: string, _req: DisconnectVaultRequest): Promise<void> {
    if (role !== 'owner') throw ownerOnly();
    await this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) return;
      const config = configOf(row);
      await trx
        .deleteFrom('app.storage_destination')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .execute();
      await this.security(trx, ctx, 'vault_disconnected', {
        host: config.address ? new URL(config.address).host : null,
        householdName: config.householdName,
      });
    });
  }

  // ----- Inside ----------------------------------------------------------------------------------------------------

  async row(trx: Trx, ctx: Ctx): Promise<Row | undefined> {
    return trx
      .selectFrom('app.storage_destination')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kind', '=', 'fdv')
      .executeTakeFirst();
  }

  private open(address: string, appId: string, keyId: string, pkcs8: string, pinned: string | null) {
    return new VaultConnection({
      address,
      appId,
      keyId,
      privateKey: Buffer.from(pkcs8, 'base64'),
      pinned,
      transport: this.transport,
    });
  }

  /** The connection test, as a result or the `VaultError` it came to. The key is held only for this. */
  private async tryCheck(
    address: string,
    appId: string,
    keyId: string,
    pkcs8: string,
    pinned: string | null,
  ): Promise<VaultCheck | VaultError> {
    let conn: VaultConnection | undefined;
    try {
      conn = this.open(address, appId, keyId, pkcs8, pinned);
      return await conn.check();
    } catch (e) {
      return e instanceof VaultError ? e : new VaultError('failed', { detail: 'check' });
    } finally {
      conn?.close();
    }
  }

  /** What the connection test says that Settings shows (§3): kept in `config`. */
  private reported(check: VaultCheck): Partial<VaultConfig> {
    return {
      householdName: check.householdName,
      actingAs: check.actingAs,
      sendKinds: check.sendKinds,
      mediaTypes: check.mediaTypes,
      mayReadBack: check.mayReadBack,
      mayDelete: check.mayDelete,
    };
  }

  private async saveState(
    trx: Trx,
    ctx: Ctx,
    destinationId: string,
    check: VaultCheck,
    more: { keyRotation?: 'none' } = {},
  ): Promise<void> {
    const now = Date.now();
    await trx
      .updateTable('app.vault_connection_state')
      .set({
        checked_at: new Date(now),
        next_check_at: new Date(now + (check.approved ? NEXT_CHECK_MS.connected : NEXT_CHECK_MS.waiting)),
        daily_reset_at: check.dailyResetAt,
        clock_offset_ms:
          check.clockOffsetMs === null
            ? null
            : Math.max(-86_400_000, Math.min(86_400_000, check.clockOffsetMs)),
        ...(more.keyRotation ? { key_rotation: more.keyRotation, key_rotation_at: null } : {}),
        updated_at: new Date(now),
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', destinationId)
      .execute();
  }

  private async dto(trx: Trx, row: Row): Promise<VaultConnectionDto> {
    const config = configOf(row);
    const state = (await trx
      .selectFrom('app.vault_connection_state')
      .selectAll()
      .where('workspace_id', '=', row.workspace_id)
      .where('destination_id', '=', row.id)
      .executeTakeFirst()) as StateRow | undefined;
    const counts = await trx
      .selectFrom('app.vault_item')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('workspace_id', '=', row.workspace_id)
      .where('destination_id', '=', row.id)
      .groupBy('status')
      .execute();
    const n = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const modes = modesOf(config);
    return {
      id: row.id,
      stage: config.stage,
      status: row.status,
      address: config.address,
      householdName: config.householdName,
      publicKey: config.publicKey,
      fingerprint: config.fingerprint,
      newKey: config.newKey,
      actingAs: config.actingAs,
      groups: VAULT_GROUPS.map((group) => ({
        group,
        mode: modes[group],
        vaultKind: config.groups.find((g) => g.group === group)?.vaultKind ?? null,
      })),
      vaultKinds: config.sendKinds,
      describeMore: config.describeMore,
      deleteWithMontra: row.delete_with_montra,
      canDelete: row.can_delete,
      items: {
        queued: n('queued'),
        pending: n('pending'),
        received: n('received'),
        filed: n('filed'),
        notKept: n('not_kept'),
        failed: n('failed'),
        outOfReach: n('out_of_reach'),
      },
      heldUntil: {
        sending: iso(state?.send_held_until),
        reading: iso(state?.read_held_until),
      },
      clockOffsetMs: state?.clock_offset_ms ?? null,
      keyRotation: state?.key_rotation ?? 'none',
      lastSuccessAt: iso(row.last_success_at),
      lastError: row.last_error,
      lastErrorAt: iso(row.last_error_at),
      createdAt: row.created_at.toISOString(),
      version: Number(row.version),
    };
  }

  private seal(trx: Trx, ctx: Ctx, secret: VaultSecret) {
    return this.crypto.encrypt(
      trx,
      ctx.workspaceId,
      SECRET_COLUMN,
      JSON.stringify(VaultSecret.parse(secret)),
    );
  }

  private async unseal(ctx: Ctx, row: Row, trx?: Trx): Promise<VaultSecret> {
    const open = (t: Trx) => this.crypto.decrypt(t, ctx.workspaceId, SECRET_COLUMN, row.secret_enc);
    const plain = trx ? await open(trx) : await this.db.run(ctx, open);
    return VaultSecret.parse(JSON.parse(plain!));
  }

  private async security(trx: Trx, ctx: Ctx, kind: string, detail: Record<string, unknown>): Promise<void> {
    await trx
      .insertInto('app.security_event')
      .values({ user_id: ctx.userId, workspace_id: ctx.workspaceId, kind, detail: JSON.stringify(detail) })
      .execute();
  }
}

function configOf(row: Row): VaultConfig {
  return VaultConfig.parse(row.config);
}

function modesOf(config: VaultConfig): Record<VaultGroup, VaultGroupMode> {
  return vaultGroupModes(Object.fromEntries(config.groups.map((g) => [g.group, g.mode])));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
