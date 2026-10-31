import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import type { SyncPullResponse } from '@montra/schemas';
import { SyncEngine, MemoryStore, backoffMs, type SyncEvent, type SyncTransport } from '../src/index.js';
import { ACCOUNT, CATEGORIES, FakeClock, FakeServer, idGen, makeDto } from './fake-server.js';

const D = calendarDate('2026-10-30');

const usd = (amount: string) => ({ amount, currency: 'USD' as const });

function setup(opts: { transport?: SyncTransport } = {}) {
  const clock = new FakeClock();
  const server = new FakeServer(clock.now);
  const store = new MemoryStore();
  const events: SyncEvent[] = [];
  const engine = new SyncEngine({
    store,
    transport: opts.transport ?? server,
    now: clock.now,
    newId: idGen(),
    onEvent: (e) => events.push(e),
  });
  return { clock, server, store, engine, events };
}

/** Local writes kick a background sync; tests drive sync explicitly, so start offline. */
async function offline<T>(engine: SyncEngine, fn: () => Promise<T>): Promise<T> {
  engine.setOnline(false);
  const r = await fn();
  engine.setOnline(true);
  return r;
}

describe('bootstrap', () => {
  it('pages through a bootstrap, replaces reference data and drops stale rows', async () => {
    const pages: SyncPullResponse[] = [
      {
        latestSeq: '10',
        hasMore: true,
        full: true,
        transactions: [makeDto({ id: 't1' })],
        removedTransactions: [],
        accounts: [],
        categories: CATEGORIES,
        members: [],
        entities: [],
        reviewCount: 2,
      },
      {
        latestSeq: '20',
        hasMore: false,
        full: false,
        transactions: [makeDto({ id: 't2', categoryId: 'cat-dining' })],
        removedTransactions: [],
        accounts: [],
        categories: [],
        members: [],
        entities: [],
        reviewCount: 1,
      },
    ];
    const calls: string[] = [];
    const transport: SyncTransport = {
      pull: async (p) => {
        calls.push(p.since);
        return pages.shift()!;
      },
      push: async () => ({ results: [], latestSeq: '0' }),
    };
    const { engine, store } = setup({ transport });
    await store.putTransactions([
      { ...(await import('../src/index.js')).projectTransaction(makeDto({ id: 'old' })) },
    ]);
    await engine.bootstrap();
    expect(calls).toEqual(['0', '10']);
    expect((await store.listTransactions({})).map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(await store.getReference('categories')).toHaveLength(3);
    const state = await engine.state();
    expect(state).toMatchObject({ latestSeq: '20', reviewCount: 1, pending: 0 });
    const t2 = await store.getTransaction('t2');
    expect(t2).toMatchObject({ categoryId: 'cat-dining', categoryName: 'Dining out', pending: false });
    expect((await store.getTransaction('t1'))!.categoryId).toBeNull(); // uncategorized system account
  });
});

describe('outbox', () => {
  it('creates offline, then pushes with the client id', async () => {
    const { engine, store, server } = setup();
    await engine.bootstrap();
    const local = await offline(engine, () =>
      engine.createTransaction({
        date: D,
        accountId: ACCOUNT,
        amount: usd('-450'),
        payee: 'Cafe',
        categoryId: 'cat-dining',
      }),
    );
    expect(local).toMatchObject({
      pending: true,
      version: '0',
      categoryName: 'Dining out',
      reviewState: 'reviewed',
    });
    expect(server.pushCalls).toBe(0);
    expect((await engine.state()).pending).toBe(1);

    await engine.sync();
    expect(server.get(local.id)).not.toBeNull();
    const row = await store.getTransaction(local.id);
    expect(row).toMatchObject({ pending: false, version: '1' });
    expect(row!.server?.id).toBe(local.id);
    expect(await store.outbox()).toHaveLength(0);
  });

  it('replays an op whose response was lost without applying it twice', async () => {
    const { engine, store, server, clock } = setup();
    await engine.bootstrap();
    const local = await offline(engine, () =>
      engine.createTransaction({ date: D, accountId: ACCOUNT, amount: usd('-100'), payee: 'Kiosk' }),
    );
    server.failNextPush = 'after'; // applied on the server, response lost
    await engine.sync();
    expect(server.count()).toBe(1);
    expect((await store.outbox())[0]).toMatchObject({ status: 'pending', attempts: 1 });

    clock.advance(backoffMs(1));
    await engine.sync();
    expect(server.received.map((o) => o.opId)).toHaveLength(2);
    expect(server.received[0]!.opId).toBe(server.received[1]!.opId);
    expect(server.count()).toBe(1);
    expect(await store.outbox()).toHaveLength(0);
    // The pull after the push brings the server copy.
    expect(await store.getTransaction(local.id)).toMatchObject({ pending: false, version: '1' });
  });

  it('coalesces edits and folds edits into an unpushed create', async () => {
    const { engine, store, server } = setup();
    server.seed({ id: 't1', payee: 'Shop', categoryId: 'cat-groceries' });
    await engine.bootstrap();
    await offline(engine, async () => {
      await engine.updateTransaction('t1', { memo: 'one' });
      await engine.updateTransaction('t1', { payee: 'Corner shop' });
      await engine.updateTransaction('t1', { memo: 'two' });
    });
    const out = await store.outbox();
    expect(out).toHaveLength(1);
    expect(out[0]!.op).toMatchObject({
      kind: 'transaction.update',
      baseVersion: '1',
      data: { memo: 'two', payee: 'Corner shop' },
    });

    const created = await offline(engine, () =>
      engine.createTransaction({ date: D, accountId: ACCOUNT, amount: usd('-200'), payee: 'Bakery' }),
    );
    await offline(engine, () =>
      engine.updateTransaction(created.id, { categoryId: 'cat-groceries', memo: 'bread' }),
    );
    const ops = (await store.outbox()).filter((o) => o.op.id === created.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toMatchObject({
      kind: 'transaction.create',
      data: { categoryId: 'cat-groceries', memo: 'bread' },
    });

    await engine.sync();
    expect(server.get('t1')).toMatchObject({ memo: 'two', payee: 'Corner shop' });
    expect(server.get(created.id)).toMatchObject({ memo: 'bread' });
    expect(server.received.map((o) => o.kind)).toEqual(['transaction.update', 'transaction.create']);
  });

  it('keeps a pending edit on top of a newer server copy from a pull', async () => {
    const { engine, store, server } = setup();
    server.seed({ id: 't1', payee: 'Shop', categoryId: 'cat-groceries' });
    await engine.bootstrap();
    await offline(engine, () => engine.updateTransaction('t1', { memo: 'from phone' }));
    server.edit('t1', { payee: 'Renamed on web' });
    server.failPushAlways = true; // push keeps failing; the pull still runs
    await engine.sync();
    const row = await store.getTransaction('t1');
    expect(row).toMatchObject({ payee: 'Renamed on web', memo: 'from phone', pending: true });
    expect(row!.server?.version).toBe('2');
  });

  it('records a conflict notice when the server keeps a later change', async () => {
    const { engine, store, server, clock, events } = setup();
    server.seed({ id: 't1', memo: 'start', categoryId: 'cat-groceries' });
    await engine.bootstrap();
    await offline(engine, () => engine.updateTransaction('t1', { memo: 'phone' }));
    clock.advance(60_000);
    server.edit('t1', { memo: 'web, later' });
    await engine.sync();
    const conflicts = await store.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflicts).toEqual([expect.objectContaining({ group: 'memo', winner: 'server' })]);
    expect(events.some((e) => e.type === 'conflict')).toBe(true);
    expect(await store.getTransaction('t1')).toMatchObject({ memo: 'web, later', pending: false });
  });

  it('turns rejected ops into drafts; discarding restores the server copy or drops the create', async () => {
    const { engine, store, server } = setup();
    server.seed({ id: 't1', categoryId: 'cat-groceries' });
    await engine.bootstrap();
    const bad = await offline(engine, () =>
      engine.createTransaction({ date: D, accountId: 'acct-gone', amount: usd('-100') }),
    );
    await offline(engine, () => engine.updateTransaction('t1', { categoryId: 'cat-unknown' }));
    await engine.sync();
    const state = await engine.state();
    expect(state).toMatchObject({ drafts: 2, pending: 0 });
    const drafts = await store.outbox();
    expect(drafts.every((d) => d.status === 'draft' && d.error)).toBe(true);
    expect(await store.getTransaction(bad.id)).toMatchObject({ pending: true });

    // Retrying a draft after an edit pushes a fixed version.
    const updateDraft = drafts.find((d) => d.op.kind === 'transaction.update')!;
    await offline(engine, () => engine.retryDraft(updateDraft.op.opId, { categoryId: 'cat-household' }));
    expect((await store.outbox()).find((d) => d.op.opId === updateDraft.op.opId)!.status).toBe('pending');
    await engine.discardDraft(updateDraft.op.opId);
    expect(await store.getTransaction('t1')).toMatchObject({ categoryId: 'cat-groceries', pending: false });

    const createDraft = drafts.find((d) => d.op.kind === 'transaction.create')!;
    await engine.discardDraft(createDraft.op.opId);
    expect(await store.getTransaction(bad.id)).toBeNull();
    expect(await store.outbox()).toHaveLength(0);
  });

  it('backs off after network failures and retries when the delay has passed', async () => {
    const { engine, store, server, clock } = setup();
    await engine.bootstrap();
    await offline(engine, () =>
      engine.createTransaction({ date: D, accountId: ACCOUNT, amount: usd('-100') }),
    );
    server.failNextPush = 'before';
    await engine.sync();
    const [item] = await store.outbox();
    expect(item).toMatchObject({ attempts: 1, status: 'pending' });
    expect(Date.parse(item!.nextAttemptAt!)).toBe(clock.t + 2000);

    await engine.sync();
    expect(server.pushCalls).toBe(1); // still waiting
    clock.advance(2000);
    await engine.sync();
    expect(server.pushCalls).toBe(2);
    expect(await store.outbox()).toHaveLength(0);
    expect(backoffMs(20)).toBe(5 * 60_000);
  });

  it('deleting a create that was never pushed never reaches the server', async () => {
    const { engine, store, server } = setup();
    await engine.bootstrap();
    const t = await offline(engine, () =>
      engine.createTransaction({ date: D, accountId: ACCOUNT, amount: usd('-100') }),
    );
    await offline(engine, () => engine.updateTransaction(t.id, { memo: 'x' }));
    await offline(engine, () => engine.deleteTransaction(t.id));
    expect(await store.outbox()).toHaveLength(0);
    expect(await store.getTransaction(t.id)).toBeNull();
    await engine.sync();
    expect(server.received).toHaveLength(0);
  });

  it('deletes and reviews synced rows through the outbox', async () => {
    const { engine, store, server } = setup();
    server.seed({ id: 'gone' });
    server.seed({ id: 'review-me', suggestedCategoryId: 'cat-dining' });
    server.seed({ id: 'resolve-me' });
    await engine.bootstrap();
    await offline(engine, async () => {
      await engine.deleteTransaction('gone');
      await engine.acceptReview('review-me');
      await engine.resolveReview('resolve-me', 'cat-household');
    });
    expect(await store.getTransaction('gone')).toBeNull();
    expect(await store.getTransaction('review-me')).toMatchObject({
      reviewState: 'reviewed',
      categoryId: 'cat-dining',
      pending: true,
    });
    await engine.sync();
    expect(server.get('gone')).toBeNull();
    expect(server.get('review-me')).toMatchObject({ reviewState: 'reviewed' });
    expect(await store.getTransaction('resolve-me')).toMatchObject({
      categoryId: 'cat-household',
      reviewState: 'reviewed',
      pending: false,
    });
  });

  it('pulls removals and coalesces concurrent sync calls', async () => {
    const { engine, store, server } = setup();
    server.seed({ id: 't1' });
    server.seed({ id: 't2' });
    await engine.bootstrap();
    server.remove('t1');
    const before = server.pullCalls;
    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
    expect(server.pullCalls - before).toBeLessThanOrEqual(2);
    expect(await store.getTransaction('t1')).toBeNull();
    expect(await store.getTransaction('t2')).not.toBeNull();
  });

  it('does nothing while offline and wipes everything on sign-out', async () => {
    const { engine, store, server } = setup();
    server.seed({ id: 't1' });
    await engine.bootstrap();
    engine.setOnline(false);
    await engine.sync();
    expect(server.pushCalls).toBe(0);
    await engine.createTransaction({ date: D, accountId: ACCOUNT, amount: usd('-1') });
    await engine.signOut();
    expect(await store.listTransactions({})).toEqual([]);
    expect(await store.outbox()).toEqual([]);
    expect(await store.getMeta('latestSeq')).toBeNull();
  });
});
