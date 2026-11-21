import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import pg from 'pg';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, type AppConfig } from '../src/config.js';
import { S3Storage, STORAGE_PORT, type StoragePort } from '../src/storage/storage.js';
import { S3Destination } from '../src/storage/destinations/s3.js';
import { DestinationError } from '../src/storage/destinations/types.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Harness } from './harness.js';

// S3 storage against a real MinIO (backlog item 4): the in-process fakes check what Montra sends; this checks that a
// real S3 server takes it. Locally: `docker compose -f infra/docker-compose.yml up -d minio`, then set
// S3_TEST_ENDPOINT (e.g. http://localhost:19000), S3_TEST_ACCESS_KEY and S3_TEST_SECRET_KEY. CI starts MinIO and sets
// S3_TEST_REQUIRED=1, so there a missing server fails rather than skips.
const endpoint = process.env.S3_TEST_ENDPOINT;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? '';
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? '';
if (process.env.S3_TEST_REQUIRED === '1' && !endpoint)
  throw new Error('S3_TEST_REQUIRED is set but S3_TEST_ENDPOINT is not: the MinIO tests would not run');

const bucket = `montra-test-${randomBytes(4).toString('hex')}`;
const raw = () =>
  new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
const text = async (key: string) => {
  const res = await raw().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body!.transformToString();
};
const streamText = async (s: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

describe.skipIf(!endpoint)('S3 storage against MinIO (backlog item 4)', () => {
  beforeAll(async () => {
    await raw().send(new CreateBucketCommand({ Bucket: bucket }));
  });
  afterAll(async () => {
    const s3 = raw();
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (listed.Contents?.length)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: listed.Contents.map((o) => ({ Key: o.Key! })) },
        }),
      );
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  });

  describe("Montra's own file store (STORAGE_MODE=s3)", () => {
    const store = () =>
      new S3Storage({
        S3_BUCKET: bucket,
        S3_REGION: 'us-east-1',
        S3_ENDPOINT: endpoint,
        S3_ACCESS_KEY: accessKeyId,
        S3_SECRET_KEY: secretAccessKey,
      } as AppConfig);

    it('puts, gets, streams a file from disk, and deletes', async () => {
      const s = store();
      await s.put('ws/receipt/2026/a', new TextEncoder().encode('receipt bytes'), 'image/png');
      expect(new TextDecoder().decode(await s.get('ws/receipt/2026/a'))).toBe('receipt bytes');
      // Archives go up from disk and come back as a stream (ADR-0019).
      const dir = mkdtempSync(join(tmpdir(), 'montra-s3-'));
      const big = 'x'.repeat(256 * 1024);
      writeFileSync(join(dir, 'archive.zip'), big);
      await s.putFile('ws/archive/2026/b', join(dir, 'archive.zip'), 'application/zip');
      expect(await streamText(await s.getStream('ws/archive/2026/b'))).toBe(big);
      await s.delete('ws/receipt/2026/a');
      await expect(s.get('ws/receipt/2026/a')).rejects.toMatchObject({ name: 'NoSuchKey' });
      // Deleting what's already gone is fine.
      await s.delete('ws/receipt/2026/a');
      await expect(s.put('../escape', new Uint8Array([1]), 'text/plain')).rejects.toThrow(
        'Unsafe storage key',
      );
    });
  });

  describe('your own storage, S3-compatible (ADR-0031 §2)', () => {
    const destination = (secret = { accessKeyId, secretAccessKey }, bucketName = bucket) =>
      new S3Destination(
        { endpoint: endpoint!, region: 'us-east-1', bucket: bucketName, pathStyle: true },
        secret,
        { allowPrivate: true },
      );

    it('puts, gets within a size limit, and deletes', async () => {
      const d = destination();
      const body = new TextEncoder().encode('statement pdf');
      await d.put('Montra/Statements/2026/october.pdf', body, {
        contentType: 'application/pdf',
        bytes: body.length,
      });
      expect(await text('Montra/Statements/2026/october.pdf')).toBe('statement pdf');
      expect(new TextDecoder().decode(await d.get('Montra/Statements/2026/october.pdf', 1024))).toBe(
        'statement pdf',
      );
      await expect(d.get('Montra/Statements/2026/october.pdf', 4)).rejects.toMatchObject({ code: 'full' });
      await d.delete('Montra/Statements/2026/october.pdf');
      await expect(d.get('Montra/Statements/2026/october.pdf', 1024)).rejects.toMatchObject({
        code: 'not_found',
      });
      await d.delete('Montra/Statements/2026/october.pdf');
      d.close();
    });

    it("says what's wrong with a key or a bucket the way the connection screen expects", async () => {
      const body = new Uint8Array([1, 2, 3]);
      const wrongKey = destination({ accessKeyId: 'AKIAWRONG', secretAccessKey: 'nope-nope-nope' });
      const refused = await wrongKey.put('x', body, { contentType: 'text/plain', bytes: 3 }).catch((e) => e);
      expect(refused).toBeInstanceOf(DestinationError);
      expect(refused.code).toBe('refused');
      const noBucket = destination(undefined, `${bucket}-missing`);
      const missing = await noBucket.put('x', body, { contentType: 'text/plain', bytes: 3 }).catch((e) => e);
      expect(missing).toMatchObject({ code: 'not_found' });
      wrongKey.close();
      noBucket.close();
    });
  });

  describe('the API with STORAGE_MODE=s3', () => {
    let h: Harness;
    let admin: pg.Client;
    beforeAll(async () => {
      h = await startHarness({
        STORAGE_MODE: 's3',
        S3_BUCKET: bucket,
        S3_ENDPOINT: endpoint!,
        S3_ACCESS_KEY: accessKeyId,
        S3_SECRET_KEY: secretAccessKey,
      });
      admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
    });
    afterAll(async () => {
      await admin?.end();
      await h?.close();
    });

    it('stores an upload in the bucket and reads it back', async () => {
      expect(h.app.get(CONFIG).STORAGE_MODE).toBe('s3');
      expect(h.app.get<StoragePort>(STORAGE_PORT)).toBeInstanceOf(S3Storage);
      const email = 's3-minio@example.test';
      const c = h.as(email);
      const ws = (await c.post('/v1/workspaces', { name: 'S3', baseCurrency: 'USD', template: 'household' }))
        .body;
      const boundary = '----montra-s3';
      const csv = 'Date,Description,Amount\n2026-11-02,CORNER DELI,-6.50\n';
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws.id}/uploads`,
        headers: {
          authorization: `Bearer dev:${email}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="deli.csv"\r\nContent-Type: text/csv\r\n\r\n`,
          ),
          Buffer.from(csv),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      expect(res.statusCode).toBe(201);
      const fileId = JSON.parse(res.body).fileId as string;
      const { rows } = await admin.query('select storage_key from app.file where id = $1', [fileId]);
      expect(await text(rows[0].storage_key)).toBe(csv);
      const back = await h.app.get<StoragePort>(STORAGE_PORT).get(rows[0].storage_key);
      expect(new TextDecoder().decode(back)).toBe(csv);
    });
  });
});
