/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHOTO_UPLOAD_DEFAULTS } from '@montra/schemas';
import { loadConfig } from '../src/config.js';
import { APP_URL } from './env.js';
import { startHarness, type Harness } from './harness.js';

/**
 * BAK-08: photos are compressed on the web and the phone with the API's limits, unless the person keeps originals. The
 * choice is theirs (`/v1/me`), off by default, and the usage meter counts the bytes that were stored.
 */
let h: Harness;
let tuned: Harness;

beforeAll(async () => {
  h = await startHarness();
  tuned = await startHarness({
    PHOTO_MAX_EDGE_PX: '1600',
    PHOTO_QUALITY: '75',
    PHOTO_TARGET_BYTES: '800000',
  });
});
afterAll(async () => {
  await h.close();
  await tuned.close();
});

async function uploadReceipt(email: string, workspaceId: string, bytes: Uint8Array, fileName: string) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/receipts/files`,
    headers: {
      authorization: `Bearer dev:${email}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('photo uploads (BAK-08)', () => {
  it('compresses by default and sends the limits with the profile', async () => {
    const me = h.as('photos-default@example.com');
    const res = await me.get('/v1/me');
    expect(res.status).toBe(200);
    expect(res.body.keepOriginalPhotos).toBe(false);
    expect(res.body.photoLimits).toEqual(PHOTO_UPLOAD_DEFAULTS);
  });

  it('keeps originals for the person who chose it, and no one else', async () => {
    const me = h.as('photos-keep@example.com');
    const other = h.as('photos-other@example.com');
    await other.get('/v1/me');
    const res = await me.patch('/v1/me', { keepOriginalPhotos: true });
    expect(res.status).toBe(200);
    expect(res.body.keepOriginalPhotos).toBe(true);
    expect((await me.get('/v1/me')).body.keepOriginalPhotos).toBe(true);
    expect((await other.get('/v1/me')).body.keepOriginalPhotos).toBe(false);
    // Changing something else leaves the choice as it is; and it can be turned off again.
    expect((await me.patch('/v1/me', { displayName: 'Kim' })).body.keepOriginalPhotos).toBe(true);
    expect((await me.patch('/v1/me', { keepOriginalPhotos: false })).body.keepOriginalPhotos).toBe(false);
    expect((await me.patch('/v1/me', { keepOriginalPhotos: 'yes' })).status).toBe(400);
  });

  it('takes the limits from the settings', async () => {
    const res = await tuned.as('photos-tuned@example.com').get('/v1/me');
    expect(res.body.photoLimits).toEqual({
      maxEdgePx: 1600,
      quality: 75,
      minQuality: PHOTO_UPLOAD_DEFAULTS.minQuality,
      targetBytes: 800_000,
    });
  });

  it('refuses to start with limits that make no sense', () => {
    const base = { DATABASE_URL: APP_URL, NODE_ENV: 'test' };
    expect(() => loadConfig({ ...base, PHOTO_QUALITY: '50', PHOTO_MIN_QUALITY: '70' })).toThrow(/PHOTO_/);
    expect(() => loadConfig({ ...base, PHOTO_MAX_EDGE_PX: '10' })).toThrow(/PHOTO_/);
    expect(() => loadConfig({ ...base, PHOTO_QUALITY: '101' })).toThrow(/PHOTO_/);
    expect(loadConfig(base).PHOTO_MAX_EDGE_PX).toBe(PHOTO_UPLOAD_DEFAULTS.maxEdgePx);
  });

  it('counts what was stored: the compressed photo the client sent, byte for byte', async () => {
    const email = 'photos-meter@example.com';
    const ws = await h.as(email).post('/v1/workspaces', { name: 'Photos', baseCurrency: 'USD' });
    expect(ws.status).toBe(201);
    const before = (await h.as(email).get(`/v1/workspaces/${ws.body.id}/storage`)).body;
    expect(before.usedBytes).toBe('0');
    // What a browser sends after compressing: a JPEG, of whatever size it came out at.
    const jpeg = new Uint8Array(345_678);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    jpeg[jpeg.length - 2] = 0xff;
    jpeg[jpeg.length - 1] = 0xd9;
    const up = await uploadReceipt(email, ws.body.id, jpeg, 'receipt.jpg');
    expect(up.status).toBe(201);
    expect(up.body.bytes).toBe(jpeg.length);
    const after = (await h.as(email).get(`/v1/workspaces/${ws.body.id}/storage`)).body;
    expect(after.usedBytes).toBe(String(jpeg.length));
    expect(after.byKind).toEqual({ receipt: String(jpeg.length) });
  });
});
