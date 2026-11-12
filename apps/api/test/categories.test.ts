/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Category management (ACC-08..12; ADR-0040): add, rename, move, archive and unarchive; Miscellaneous by default.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'categories@example.test';
const VIEWER = 'categories-viewer@example.test';

let h: Harness;
let c: Client;
let viewer: Client;
let admin: pg.Client;
let url: (p: string) => string;
let personal: string;
let business: string;
let checking: string;

const categories = async (query = '') => (await c.get(url(`/categories${query}`))).body.data as any[];
const groups = async (entityId: string) =>
  (await c.get(url(`/category-groups?entityId=${entityId}`))).body.data as any[];
const create = (body: object) => c.post(url('/categories'), body);
const categoryOf = (t: any) =>
  t.entries[0]?.postings.find((p: any) => p.isCategory)?.accountId as string | undefined;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  viewer = h.as(VIEWER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Categories', baseCurrency: 'USD', template: 'hybrid' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await c.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  business = entities.find((e: any) => e.type === 'business').id;
  checking = (
    await c.post(url('/accounts'), { name: 'Everyday checking', kind: 'checking', entityId: personal })
  ).body.id;
  const invite = await c.post(url('/sharing/invites'), { email: VIEWER, role: 'viewer' });
  await viewer.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('Miscellaneous (ACC-12)', () => {
  it('is a personal spending category in Daily living from the start', async () => {
    const misc = (await categories()).filter((x) => x.name === 'Miscellaneous');
    expect(misc).toEqual([
      expect.objectContaining({ entityId: personal, type: 'expense', group: 'Daily living', fixed: false }),
    ]);
  });
});

describe('adding categories (ACC-08)', () => {
  it('adds one to the group chosen, or the usual group for its kind', async () => {
    const fun = (await groups(personal)).find((g) => g.name === 'Fun');
    const pets = await create({ entityId: personal, name: '  Pets  ', type: 'expense', groupId: fun.id });
    expect(pets.status).toBe(201);
    expect(pets.body).toMatchObject({
      name: 'Pets',
      group: 'Fun',
      groupId: fun.id,
      archived: false,
      taxLineCode: null,
    });

    const bags = await create({ entityId: personal, name: 'Bag fees', type: 'expense' });
    expect(bags.body.group).toBe('Daily living');
    const side = await create({ entityId: personal, name: 'Side gigs', type: 'income' });
    expect(side.body.group).toBe('Income');
    // It is in the list every client reads, sorted at the end of its group.
    const daily = (await categories(`?entityId=${personal}`)).filter((x) => x.group === 'Daily living');
    expect(daily.at(-1).name).toBe('Bag fees');
  });

  it('gives business categories the Schedule C "other" lines unless one is chosen', async () => {
    const postage = await create({ entityId: business, name: 'Postage', type: 'expense' });
    expect(postage.body).toMatchObject({ group: 'Business expenses', taxLineCode: 'US_SCH_C_L27A' });
    const royalties = await create({ entityId: business, name: 'Royalties', type: 'income' });
    expect(royalties.body.taxLineCode).toBe('US_SCH_C_L6');
    const ads = await create({
      entityId: business,
      name: 'Sponsorships',
      type: 'expense',
      taxLineCode: 'US_SCH_C_L8',
    });
    expect(ads.body.taxLineCode).toBe('US_SCH_C_L8');
    expect(
      (await create({ entityId: business, name: 'Bogus', type: 'expense', taxLineCode: 'NOPE' })).status,
    ).toBe(422);
  });

  it('refuses a name already used in the same books and kind, whatever the case', async () => {
    const again = await create({ entityId: personal, name: 'groceries', type: 'expense' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('category.exists');
    // The same name is fine as income, or in other books.
    expect((await create({ entityId: business, name: 'Groceries', type: 'expense' })).status).toBe(201);
  });

  it('keeps income and spending categories in their own groups', async () => {
    const income = (await groups(personal)).find((g) => g.kind === 'income');
    const res = await create({ entityId: personal, name: 'Lottery', type: 'expense', groupId: income.id });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('category.group_type');
    const otherBooks = (await groups(business))[0];
    expect(
      (await create({ entityId: personal, name: 'Lottery', type: 'expense', groupId: otherBooks.id })).status,
    ).toBe(422);
  });

  it('lets a viewer read the categories but not add or change them', async () => {
    expect((await viewer.get(url('/categories'))).status).toBe(200);
    const res = await viewer.post(url('/categories'), {
      entityId: personal,
      name: 'Sneaky',
      type: 'expense',
    });
    expect(res.status).toBe(403);
    const pets = (await categories()).find((x) => x.name === 'Pets');
    expect((await viewer.patch(url(`/categories/${pets.id}`), { name: 'Animals' })).status).toBe(403);
  });
});

describe('renaming, moving and archiving (ACC-09, ACC-10)', () => {
  it('renames and moves a category, but not into a clash', async () => {
    const pets = (await categories()).find((x) => x.name === 'Pets');
    const renamed = await c.patch(url(`/categories/${pets.id}`), { name: 'Pet care' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Pet care');
    const daily = (await groups(personal)).find((g) => g.name === 'Daily living');
    const moved = await c.patch(url(`/categories/${pets.id}`), { groupId: daily.id });
    expect(moved.body.group).toBe('Daily living');
    const clash = await c.patch(url(`/categories/${pets.id}`), { name: 'HOUSEHOLD' });
    expect(clash.status).toBe(409);
  });

  it('leaves built-in categories alone', async () => {
    const uncategorized = (await categories()).find(
      (x) => x.name === 'Uncategorized expense' && x.entityId === personal,
    );
    expect(uncategorized.fixed).toBe(true);
    const res = await c.patch(url(`/categories/${uncategorized.id}`), { archived: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('category.fixed');
  });

  it('archives a category: gone from the list and suggestions, kept on its transactions, and back on unarchive', async () => {
    const misc = (await categories()).find((x) => x.name === 'Miscellaneous');
    const rule = await c.post(url('/rules'), {
      name: 'Bag fee',
      conditions: { all: [{ field: 'payee', op: 'contains', value: 'bag fee' }] },
      actions: { categoryId: misc.id },
    });
    expect(rule.status).toBe(201);
    const first = await c.post(url('/transactions'), {
      date: '2026-10-02',
      accountId: checking,
      amount: usd('-25'),
      payee: 'Corner Market bag fee',
    });
    expect(first.status).toBe(201);
    expect(categoryOf(first.body)).toBe(misc.id);
    expect(first.body.categorization).toMatchObject({ step: 'rule' });

    const archived = await c.patch(url(`/categories/${misc.id}`), { archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);
    expect((await categories()).some((x) => x.id === misc.id)).toBe(false);
    expect((await categories('?include=archived')).find((x) => x.id === misc.id).archived).toBe(true);
    // The phone's sync carries the change: the category list no longer has it.
    const pull = (await c.get(url('/sync/pull?since=0'))).body;
    expect(pull.categories.some((x: any) => x.id === misc.id)).toBe(false);

    // Its rule pauses, and its history doesn't suggest it: the next bag fee isn't filed under it.
    const second = await c.post(url('/transactions'), {
      date: '2026-10-09',
      accountId: checking,
      amount: usd('-25'),
      payee: 'Corner Market bag fee',
    });
    expect(second.status).toBe(201);
    expect(categoryOf(second.body)).not.toBe(misc.id);
    expect(second.body.categorization?.step).not.toBe('rule');
    // The earlier transaction keeps it.
    expect(categoryOf((await c.get(url(`/transactions/${first.body.id}`))).body)).toBe(misc.id);

    // A new category can't take an archived one's name; unarchiving brings it back.
    const reuse = await create({ entityId: personal, name: 'miscellaneous', type: 'expense' });
    expect(reuse.status).toBe(409);
    expect(reuse.body.code).toBe('category.archived_exists');
    const back = await c.patch(url(`/categories/${misc.id}`), { archived: false });
    expect(back.body.archived).toBe(false);
    expect((await categories()).some((x) => x.id === misc.id)).toBe(true);
  });

  it('refuses an empty change', async () => {
    const pets = (await categories()).find((x) => x.name === 'Pet care');
    expect((await c.patch(url(`/categories/${pets.id}`), {})).status).toBe(400);
  });
});

describe('the Miscellaneous migration (ACC-12)', () => {
  it('adds it once to personal books made before it, and not where one of that name exists', async () => {
    const ws = (
      await c.post('/v1/workspaces', { name: 'Older books', baseCurrency: 'USD', template: 'household' })
    ).body;
    const entity = (await c.get(`/v1/workspaces/${ws.id}/entities`)).body.data.find(
      (e: any) => e.type === 'personal',
    ).id;
    const add = async () =>
      (await admin.query(`select app.add_miscellaneous_category($1, $2) as n`, [ws.id, entity])).rows[0]
        .n as number;
    // Made from the template: already there.
    expect(await add()).toBe(0);

    // Books from before 0040 had none.
    await admin.query(`delete from app.ledger_account where entity_id = $1 and name = 'Miscellaneous'`, [
      entity,
    ]);
    expect(await add()).toBe(1);
    expect(await add()).toBe(0);
    const misc = (await c.get(`/v1/workspaces/${ws.id}/categories?entityId=${entity}`)).body.data.filter(
      (x: any) => x.name === 'Miscellaneous',
    );
    expect(misc).toEqual([expect.objectContaining({ group: 'Daily living', type: 'expense' })]);

    // One the owner made themselves, in any case, is kept and not doubled.
    await admin.query(
      `update app.ledger_account set name = 'MISCELLANEOUS' where entity_id = $1 and name = 'Miscellaneous'`,
      [entity],
    );
    expect(await add()).toBe(0);
  });
});
