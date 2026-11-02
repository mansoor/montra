import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { LocalStorage, storageKey } from '../src/storage/storage.js';

describe('LocalStorage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'montra-storage-'));
  const storage = new LocalStorage({ STORAGE_DIR: root } as AppConfig);
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('round-trips generated keys on every platform (POSIX keys on Windows paths)', async () => {
    const key = storageKey(
      '11111111-1111-1111-1111-111111111111',
      'receipt',
      '22222222-2222-2222-2222-222222222222',
    );
    await storage.put(key, new Uint8Array([1, 2, 3]), 'image/jpeg');
    expect([...(await storage.get(key))]).toEqual([1, 2, 3]);
  });

  it('never overwrites an existing key', async () => {
    await storage.put('ws/statement/2026/once', new Uint8Array([1]), 'text/csv');
    await expect(storage.put('ws/statement/2026/once', new Uint8Array([2]), 'text/csv')).rejects.toThrow();
  });

  it.each([
    '',
    '/etc/passwd',
    '../outside',
    'ws/../../outside',
    'ws//double',
    'ws/./dot',
    'ws\\back',
    'C:\\x',
    'ws/\0',
  ])('rejects the unsafe key %j', async (key) => {
    await expect(storage.get(key)).rejects.toThrow(/Unsafe storage key/);
  });
});
