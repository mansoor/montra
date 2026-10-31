import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import {
  FetchTransport,
  MemoryStore,
  TransportError,
  applyPatchToLocal,
  foldIntoCreate,
  groupsOf,
  mergePatches,
  projectCreate,
  projectTransaction,
} from '../src/index.js';
import { ACCOUNT, CATEGORIES, makeDto } from './fake-server.js';

const D = calendarDate('2026-10-30');

describe('projection', () => {
  it('projects single categories, the uncategorized account and suggestions', () => {
    const cat = projectTransaction(makeDto({ id: 'a', categoryId: 'cat-dining' }), CATEGORIES);
    expect(cat).toMatchObject({
      categoryId: 'cat-dining',
      categoryName: 'Dining out',
      amount: '-1000',
      pending: false,
    });
    const unc = projectTransaction(makeDto({ id: 'b', suggestedCategoryId: 'cat-groceries' }), CATEGORIES);
    expect(unc).toMatchObject({
      categoryId: null,
      reviewState: 'needs_review',
      suggestedCategoryId: 'cat-groceries',
      confidence: 0.7,
    });
  });

  it('applies patches like the server (categorizing a review item marks it reviewed)', () => {
    const local = projectTransaction(makeDto({ id: 'b' }), CATEGORIES);
    const next = applyPatchToLocal(local, { categoryId: 'cat-household', memo: 'm' }, CATEGORIES);
    expect(next).toMatchObject({
      categoryId: 'cat-household',
      categoryName: 'Household',
      memo: 'm',
      reviewState: 'reviewed',
    });
    expect(local.memo).toBeNull(); // pure
  });

  it('maps patches to field groups and merges them', () => {
    expect(groupsOf({ memo: 'x', categoryId: 'c', payee: 'p' }).sort()).toEqual(['ledger', 'memo', 'payee']);
    expect(groupsOf({ tags: [] })).toEqual(['tags']);
    expect(mergePatches({ categoryId: 'a', memo: 'm' }, { splits: [] })).toEqual({ memo: 'm', splits: [] });
    const created = projectCreate(
      'n',
      { date: D, accountId: ACCOUNT, amount: { amount: '-5', currency: 'USD' }, payee: 'P' },
      CATEGORIES,
    );
    expect(created).toMatchObject({ reviewState: 'needs_review', server: null, pending: true });
    expect(
      foldIntoCreate(
        { date: D, accountId: ACCOUNT, amount: { amount: '-5', currency: 'USD' }, payee: 'P', memo: 'x' },
        { payee: null, memo: null, categoryId: 'cat-dining' },
      ),
    ).toEqual({
      date: D,
      accountId: ACCOUNT,
      amount: { amount: '-5', currency: 'USD' },
      categoryId: 'cat-dining',
    });
  });
});

describe('MemoryStore', () => {
  it('lists date desc, id desc with filters and keyset paging, and rolls back failed transactions', async () => {
    const s = new MemoryStore();
    const row = (id: string, date: string, payee: string) => ({
      ...projectTransaction(makeDto({ id, date, payee })),
    });
    await s.putTransactions([
      row('a', '2026-10-01', 'Alpha'),
      row('b', '2026-10-02', 'Beta'),
      row('c', '2026-10-02', 'Gamma'),
    ]);
    expect((await s.listTransactions({})).map((t) => t.id)).toEqual(['c', 'b', 'a']);
    expect((await s.listTransactions({ search: 'gam' })).map((t) => t.id)).toEqual(['c']);
    expect(
      (await s.listTransactions({ before: { date: '2026-10-02', id: 'c' }, limit: 1 })).map((t) => t.id),
    ).toEqual(['b']);
    await expect(
      s.transaction(async () => {
        await s.removeTransactions(['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await s.getTransaction('a')).not.toBeNull();
  });
});

describe('FetchTransport', () => {
  it('sends the bearer token and maps errors to retryable or not', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    let next = respond(200, { results: [], latestSeq: '3' });
    const t = new FetchTransport({
      baseUrl: 'https://api.example.com/',
      workspaceId: 'ws1',
      token: async () => 'tok',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return next;
      },
    });
    await t.push({ ops: [] as never });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/workspaces/ws1/sync/push');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');

    next = respond(503, { code: 'unavailable', detail: 'down' });
    const e1 = await t.pull({ since: '5', days: 30 }).catch((e) => e);
    expect(calls[1]!.url).toContain('since=5&days=30');
    expect(e1).toBeInstanceOf(TransportError);
    expect(e1).toMatchObject({ status: 503, code: 'unavailable', retryable: true });
    next = respond(422, { code: 'validation', detail: 'bad' });
    expect(await t.pull({ since: '0' }).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'validation',
    });

    const offline = new FetchTransport({
      baseUrl: 'https://x',
      workspaceId: 'w',
      token: async () => null,
      fetch: async () => {
        throw new TypeError('Network request failed');
      },
    });
    expect(await offline.pull({ since: '0' }).catch((e) => e)).toMatchObject({
      status: 0,
      code: 'network',
      retryable: true,
    });
  });
});
