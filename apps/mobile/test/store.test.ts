import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MemoryStore, type LocalTransaction, type OutboxItem, type SyncStore } from '@montra/sync';
import { SqliteStore } from '../src/store/sqlite-store';
import { keyPragma, listQuery, type SqlDriver, type SqlParam } from '../src/store/sql';
import { deleteKey, getOrCreateKey, keyName, type SecretPort } from '../src/store/key';

/** node:sqlite stands in for expo-sqlite (same SQLite engine, minus SQLCipher). */
function nodeDriver(): SqlDriver & { destroyed: boolean } {
  const db = new DatabaseSync(':memory:');
  const d = {
    destroyed: false,
    exec: async (sql: string) => void db.exec(sql),
    run: async (sql: string, params: readonly SqlParam[] = []) => void db.prepare(sql).run(...params),
    all: async <T>(sql: string, params: readonly SqlParam[] = []) => db.prepare(sql).all(...params) as T[],
    destroy: async () => {
      db.close();
      d.destroyed = true;
    },
  };
  return d;
}

const txn = (id: string, date: string, extra: Partial<LocalTransaction> = {}): LocalTransaction => ({
  id,
  date,
  payee: null,
  description: '',
  amount: '-100',
  currency: 'USD',
  accountId: 'acct-1',
  categoryId: null,
  categoryName: null,
  memberId: null,
  memo: null,
  tags: [],
  reviewState: 'reviewed',
  status: 'posted',
  suggestedCategoryId: null,
  confidence: null,
  explanation: null,
  merchantName: null,
  version: '1',
  pending: false,
  server: null,
  ...extra,
});

const item = (opId: string): OutboxItem => ({
  op: {
    opId,
    kind: 'transaction.delete',
    id: '00000000-0000-4000-8000-000000000001',
    changedAt: '2026-10-31T10:00:00.000Z',
  },
  status: 'pending',
  attempts: 0,
  error: null,
  createdAt: '2026-10-31T10:00:00.000Z',
  nextAttemptAt: null,
});

const stores: Array<[string, () => Promise<SyncStore>]> = [
  ['MemoryStore', async () => new MemoryStore()],
  ['SqliteStore', async () => SqliteStore.open(nodeDriver())],
];

describe.each(stores)('%s (SyncStore contract)', (_name, make) => {
  it('lists by date desc then id desc, with filters, search and keyset paging', async () => {
    const s = await make();
    await s.putTransactions([
      txn('a', '2026-10-01', { payee: 'Blue Bottle' }),
      txn('b', '2026-10-03', { description: 'SHELL OIL 123', accountId: 'acct-2' }),
      txn('c', '2026-10-03', { payee: 'Kroger', reviewState: 'needs_review' }),
      txn('d', '2026-09-30'),
    ]);
    expect((await s.listTransactions({})).map((t) => t.id)).toEqual(['c', 'b', 'a', 'd']);
    expect((await s.listTransactions({ accountId: 'acct-2' })).map((t) => t.id)).toEqual(['b']);
    expect((await s.listTransactions({ reviewState: 'needs_review' })).map((t) => t.id)).toEqual(['c']);
    expect((await s.listTransactions({ search: 'shell' })).map((t) => t.id)).toEqual(['b']);
    expect((await s.listTransactions({ search: ' BLUE ' })).map((t) => t.id)).toEqual(['a']);
    expect(
      (await s.listTransactions({ before: { date: '2026-10-03', id: 'c' }, limit: 2 })).map((t) => t.id),
    ).toEqual(['b', 'a']);
    await s.putTransactions([txn('a', '2026-10-05', { payee: 'Blue Bottle', memo: 'x' })]);
    expect((await s.getTransaction('a'))?.memo).toBe('x');
    await s.removeTransactions(['a', 'missing']);
    expect(await s.getTransaction('a')).toBeNull();
  });

  it('replaces and merges reference rows keeping order', async () => {
    const s = await make();
    const cat = (id: string, name: string) => ({ id, name }) as never;
    await s.replaceReference({
      accounts: [],
      categories: [cat('1', 'A'), cat('2', 'B')],
      members: [],
      entities: [],
    });
    await s.mergeReference({ categories: [cat('2', 'B2'), cat('3', 'C')] });
    expect((await s.getReference('categories')).map((c) => `${c.id}:${c.name}`)).toEqual([
      '1:A',
      '2:B2',
      '3:C',
    ]);
    await s.replaceReference({ accounts: [], categories: [cat('9', 'Z')], members: [], entities: [] });
    expect((await s.getReference('categories')).map((c) => c.id)).toEqual(['9']);
  });

  it('keeps the outbox in order and patches items without changing their opId', async () => {
    const s = await make();
    await s.enqueue(item('op-1'));
    await s.enqueue(item('op-2'));
    await s.updateOutbox('op-1', { status: 'draft', attempts: 2, error: { code: 'x', message: 'y' } });
    const box = await s.outbox();
    expect(box.map((o) => [o.op.opId, o.status, o.attempts])).toEqual([
      ['op-1', 'draft', 2],
      ['op-2', 'pending', 0],
    ]);
    await s.removeOutbox(['op-1']);
    expect((await s.outbox()).map((o) => o.op.opId)).toEqual(['op-2']);
  });

  it('stores conflicts and meta, and rolls back a failed transaction', async () => {
    const s = await make();
    await s.setMeta('latestSeq', '42');
    await s.addConflict({ transactionId: 't', opId: 'op-1', conflicts: [], at: '2026-10-31T00:00:00Z' });
    await s.addConflict({ transactionId: 't', opId: 'op-2', conflicts: [], at: '2026-10-31T00:00:00Z' });
    await s.clearConflicts(['op-1']);
    expect((await s.conflicts()).map((c) => c.opId)).toEqual(['op-2']);
    await expect(
      s.transaction(async () => {
        await s.setMeta('latestSeq', '43');
        await s.putTransactions([txn('z', '2026-10-01')]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await s.getMeta('latestSeq')).toBe('42');
    expect(await s.getTransaction('z')).toBeNull();
    await s.setMeta('latestSeq', null);
    expect(await s.getMeta('latestSeq')).toBeNull();
  });
});

describe('SqliteStore specifics', () => {
  it('migrates once and wipes the file and the key on sign-out (BAK-10)', async () => {
    const d = nodeDriver();
    let keyDeleted = false;
    const s = await SqliteStore.open(d, async () => {
      keyDeleted = true;
    });
    expect(await d.all<{ user_version: number }>('pragma user_version')).toEqual([{ user_version: 1 }]);
    await s.wipe();
    expect(d.destroyed).toBe(true);
    expect(keyDeleted).toBe(true);
  });

  it('builds parameterized list queries', () => {
    expect(listQuery({ search: "o'brien", limit: 5 })).toEqual({
      sql: 'select data from txn where (instr(search_payee, ?) > 0 or instr(search_desc, ?) > 0) order by date desc, id desc limit ?',
      params: ["o'brien", "o'brien", 5],
    });
  });

  it('only accepts a 256-bit hex key for SQLCipher', () => {
    expect(keyPragma('ab'.repeat(32))).toBe(`PRAGMA key = "x'${'ab'.repeat(32)}'";`);
    expect(() => keyPragma("x'; drop table txn; --")).toThrow();
  });
});

describe('database key (BAK-10)', () => {
  it('creates a random key once per workspace and deletes it', async () => {
    const vault = new Map<string, string>();
    const secrets: SecretPort = {
      get: async (n) => vault.get(n) ?? null,
      set: async (n, v) => void vault.set(n, v),
      remove: async (n) => void vault.delete(n),
    };
    let calls = 0;
    const random = (n: number) => {
      calls++;
      return Uint8Array.from({ length: n }, (_, i) => (i * 7 + calls) % 256);
    };
    const k1 = await getOrCreateKey(secrets, random, 'ws1');
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(await getOrCreateKey(secrets, random, 'ws1')).toBe(k1);
    expect(calls).toBe(1);
    expect(await getOrCreateKey(secrets, random, 'ws2')).not.toBe(k1);
    await deleteKey(secrets, 'ws1');
    expect(vault.has(keyName('ws1'))).toBe(false);
  });
});
