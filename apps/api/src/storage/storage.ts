import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CONFIG, type AppConfig } from '../config.js';

/** Object storage for uploaded files (design 02 §8): S3 in production, MinIO locally, the filesystem in tests. */
export interface StoragePort {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}
export const STORAGE_PORT = Symbol('STORAGE_PORT');

/** Keys are opaque and never contain user input beyond ids: `<workspace>/<kind>/<yyyy>/<file id>`. */
export function storageKey(workspaceId: string, kind: string, fileId: string, now = new Date()): string {
  return `${workspaceId}/${kind}/${now.getUTCFullYear()}/${fileId}`;
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const assertSafeKey = (key: string) => {
  if (!key || isAbsolute(key) || key.includes('..') || key.includes('\0') || normalize(key) !== key) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
};

@Injectable()
export class LocalStorage implements StoragePort {
  private readonly root: string;
  constructor(@Inject(CONFIG) config: AppConfig) {
    this.root = resolve(config.STORAGE_DIR);
  }

  private path(key: string): string {
    assertSafeKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/')) throw new Error(`Unsafe storage key: ${key}`);
    return p;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes, { flag: 'wx' }); // never overwrite: keys are unique per upload
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }
}

@Injectable()
export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(@Inject(CONFIG) config: AppConfig) {
    this.bucket = config.S3_BUCKET!;
    this.client = new S3Client({
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
      ...(config.S3_ACCESS_KEY && config.S3_SECRET_KEY
        ? { credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } }
        : {}),
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return new Uint8Array(await res.Body!.transformToByteArray());
  }
}

export const storageProvider = (config: AppConfig) => ({
  provide: STORAGE_PORT,
  useClass: config.STORAGE_MODE === 's3' ? S3Storage : LocalStorage,
});
