/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, fromParts, parts, startOfMonth, statementCycle, todayIn } from '@montra/domain';
import { Db } from '../src/db/database.js';
import { startHarness, type Client, type Harness } from './harness.js';

// The calendar by book (FLOW-05), as Google Calendar's calendars: every item carries its book, each book has a
// colour, and each person keeps their own list of hidden books on the server.
const today = todayIn('UTC');
const to = addDays(today, 70);
const year = Number(today.slice(0, 4));
const usd = (amount: string) => ({ amount, currency: 'USD' });
const statementDay = Number(addDays(today, -3).slice(8));
const dueDay = Number(addDays(today, 15).slice(8));
const the20th = (n: number) => {
  const m = parts(addMonths(today, n));
  return fromParts(m.year, m.month, 20);
};

let h: Harness;
let c: Client;
let member: Client;
let url: (p: string) => string;
let wsId: string;
let personal: string;
let biz: string;
let rental: string;
/** sourceId → the book its calendar items belong to. */
const bookOf = new Map<string, string>();

const account = async (name: string, entityId: string, extra: object = {}) => {
  const res = await c.post(url('/accounts'), {
    name,
    kind: 'checking',
    openingBalance: usd('5000000'),
    openingDate: addDays(the20th(-5), -1),
    entityId,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const created = (res: { status: number; body: any }, entityId: string) => {
  expect(res.status).toBe(201);
  bookOf.set(res.body.id, entityId);
  return res.body;
};
const calendar = async (from: string, until: string, entityId?: string) => {
  const res = await c.get(
    url(`/calendar?from=${from}&to=${until}${entityId ? `&entityId=${entityId}` : ''}`),
  );
  expect(res.status).toBe(200);
  return res.body.items as any[];
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('calendar-books@example.test');
  member = h.as('calendar-member@example.test');
  const ws = (
    await c.post('/v1/workspaces', {
      name: 'Calendar books',
      baseCurrency: 'USD',
      template: 'hybrid',
      businessName: 'Studio',
      rentalName: 'Flats',
    })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  personal = ws.entities.find((e: any) => e.type === 'personal').id;
  biz = ws.entities.find((e: any) => e.type === 'business').id;
  rental = ws.entities.find((e: any) => e.type === 'rental').id;
  const cats = (await c.get(url('/categories'))).body.data;
  const cat = (name: string, entityId: string) =>
    cats.find((x: any) => x.name === name && x.entityId === entityId).id as string;

  const checking = await account('Checking', personal);
  const bizChecking = await account('Studio checking', biz);
  const rentalChecking = await account('Flats checking', rental);

  // Personal: a recurring bill (materialized and beyond), money owed, a card, a goal.
  created(
    await c.post(url('/recurring'), {
      name: 'Gym',
      accountId: checking,
      amount: usd('-5000'),
      payee: 'Gym',
      categoryId: cat('Utilities', personal),
      cadence: 'monthly',
      startDate: addDays(today, 3),
    }),
    personal,
  );
  created(
    await c.post(url('/accounts'), {
      name: 'Owed to Sam',
      kind: 'liability',
      institution: 'Sam',
      openingBalance: usd('40000'),
      openingDate: addDays(today, -5),
      dueDate: addDays(today, 10),
      entityId: personal,
    }),
    personal,
  );
  const card = created(
    await c.post(url('/accounts'), {
      name: 'Visa',
      kind: 'credit_card',
      creditLimit: '500000',
      openingDate: addDays(statementCycle(today, statementDay, dueDay).lastClose, -20),
      statementDay,
      dueDay,
      entityId: personal,
    }),
    personal,
  );
  expect(
    (
      await c.post(url('/transactions'), {
        date: today,
        accountId: card.id,
        amount: usd('-7000'),
        payee: 'Shop',
      })
    ).status,
  ).toBe(201);
  created(
    await c.post(url('/goals'), {
      entityId: personal,
      name: 'Car insurance',
      type: 'sinking_fund',
      target: '120000',
      dueDate: addDays(today, 20),
    }),
    personal,
  );

  // Business: a payday, an invoice, a bill, and a biller estimated from three payments.
  created(
    await c.post(url('/expected-income'), {
      entityId: biz,
      name: 'Retainer',
      sourceType: 'business',
      amount: '300000',
      currency: 'USD',
      cadence: 'monthly',
      nextDate: addDays(today, 5),
      accountId: bizChecking,
      payee: 'CLIENT CO',
    }),
    biz,
  );
  const customer = (await c.post(url('/parties'), { entityId: biz, kind: 'customer', name: 'Bluebird' }))
    .body;
  const vendor = (await c.post(url('/parties'), { entityId: biz, kind: 'vendor', name: 'Print Shop' })).body;
  const draft = (
    await c.post(url('/invoices'), {
      entityId: biz,
      partyId: customer.id,
      issueDate: today,
      dueDate: addDays(today, 14),
      lines: [{ description: 'Design', quantity: '1', unitPrice: '90000' }],
    })
  ).body;
  const sent = await c.post(url(`/invoices/${draft.id}/send`), { version: draft.version, email: false });
  expect(sent.status).toBe(200);
  bookOf.set(draft.id, biz);
  created(
    await c.post(url('/bills'), {
      entityId: biz,
      partyId: vendor.id,
      reference: 'PS-1',
      billDate: today,
      dueDate: addDays(today, 7),
      amount: '18000',
      expenseAccountId: cat('Supplies', biz),
    }),
    biz,
  );
  for (const n of [-3, -2, -1]) {
    const paid = await c.post(url('/transactions'), {
      date: addDays(the20th(n), -1),
      accountId: bizChecking,
      amount: usd('-8500'),
      payee: 'POWER CO WEB PAYMENT',
      categoryId: cat('Utilities', biz),
    });
    expect(paid.status).toBe(201);
  }
  created(
    await c.post(url('/billers'), { categoryId: cat('Utilities', biz), name: 'Power Co', dueDay: 20 }),
    biz,
  );

  // Rental: rent and the lease's end, a reminder, a mortgage, and a tax rate so its tax dates show.
  const property = (await c.post(url('/properties'), { entityId: rental, name: 'Oak House', type: 'sfh' }))
    .body;
  const tenant = (await c.post(url('/tenants'), { entityId: rental, name: 'Tess Tenant' })).body;
  created(
    await c.post(url('/leases'), {
      unitId: property.units[0].id,
      tenantIds: [tenant.id],
      startDate: startOfMonth(addMonths(today, -2)),
      endDate: addDays(today, 40),
      rent: '150000',
      dueDay: 1,
    }),
    rental,
  );
  created(
    await c.post(url('/reminders'), {
      entityId: rental,
      propertyId: property.id,
      kind: 'insurance',
      title: 'Renew insurance',
      dueDate: addDays(today, 20),
      leadDays: 30,
    }),
    rental,
  );
  created(
    await c.post(url('/loans'), {
      name: 'Oak mortgage',
      newAccount: { kind: 'mortgage', entityId: rental },
      principal: '20000000',
      rateBps: 600,
      termMonths: 360,
      firstPaymentDate: addDays(today, 4),
      balanceAsOf: today,
      payingAccountId: rentalChecking,
    }),
    rental,
  );
  expect((await c.patch(url(`/businesses/${rental}`), { taxRateBps: 2000 })).status).toBe(200);
  // Estimated-tax dates name the book itself.
  for (const e of [personal, biz, rental]) bookOf.set(e, e);

  // A member: writes the personal books only, so sees no business or rental books.
  const invite = await c.post(url('/sharing/invites'), {
    email: 'calendar-member@example.test',
    role: 'member',
  });
  expect(invite.status).toBe(201);
  expect((await member.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
});
afterAll(() => h.close());

describe('calendar items carry their book (FLOW-05)', () => {
  it('names the right book on every item, from every source', async () => {
    const items = await calendar(today, to);
    const kinds = new Set(items.map((i) => i.kind));
    for (const k of [
      'bill',
      'payday',
      'card_due',
      'goal_due',
      'invoice',
      'rent',
      'mortgage',
      'lease_end',
      'reminder',
    ]) {
      expect(kinds, k).toContain(k);
    }
    // Scheduled from the recurring bill (materialized) and beyond it, a business bill and a biller's estimate.
    expect(items.filter((i) => i.kind === 'bill').map((i) => i.name)).toEqual(
      expect.arrayContaining(['Gym', 'Owed to Sam', 'Print Shop', 'Power Co']),
    );
    expect(items.filter((i) => i.name === 'Gym').length).toBeGreaterThanOrEqual(2);
    for (const i of items) {
      expect(bookOf.has(i.sourceId), `${i.kind} ${i.name}`).toBe(true);
      expect(i.entityId, `${i.kind} ${i.name}`).toBe(bookOf.get(i.sourceId));
    }
    // All three books are on it.
    expect(new Set(items.map((i) => i.entityId))).toEqual(new Set([personal, biz, rental]));
  });

  it('names the book on estimated-tax dates, a business’s and a rental’s', async () => {
    // The fourth payment for this year falls due in January.
    const items = (await calendar(`${year + 1}-01-01`, `${year + 1}-01-31`)).filter(
      (i) => i.kind === 'tax_due',
    );
    expect(items.map((i) => i.entityId).sort()).toEqual([biz, rental].sort());
  });

  it('still filters by one book, the same items as before', async () => {
    const all = await calendar(today, to);
    for (const e of [personal, biz, rental]) {
      const one = await calendar(today, to, e);
      expect(one.length).toBeGreaterThan(0);
      expect(one).toEqual(all.filter((i) => i.entityId === e));
    }
  });

  it('carries the book on Home’s upcoming list too', async () => {
    const dash = (await c.get(url('/dashboard'))).body;
    expect(dash.upcoming.length).toBeGreaterThan(0);
    for (const i of dash.upcoming) expect(i.entityId).toBe(bookOf.get(i.sourceId));
  });
});

describe('book colours (FLOW-05)', () => {
  const books = async (who: Client = c) =>
    (await who.get(`/v1/workspaces/${wsId}`)).body.entities as { id: string; color: string | null }[];

  it('start unpicked, take a colour in lower case, and go back to the palette with null', async () => {
    expect((await books()).map((e) => e.color)).toEqual([null, null, null]);
    const set = await c.patch(url(`/entities/${biz}`), { color: '#AABBCC' });
    expect(set.status).toBe(200);
    expect(set.body.color).toBe('#aabbcc');
    expect((await books()).find((e) => e.id === biz)!.color).toBe('#aabbcc');
    expect((await c.get(url('/entities'))).body.data.find((e: any) => e.id === biz).color).toBe('#aabbcc');
    const cleared = await c.patch(url(`/entities/${biz}`), { color: null });
    expect(cleared.body.color).toBeNull();
  });

  it('can be set on the personal books, whose other details stay fixed', async () => {
    const set = await c.patch(url(`/entities/${personal}`), { color: '#123456' });
    expect(set.status).toBe(200);
    expect(set.body.color).toBe('#123456');
    expect((await c.patch(url(`/entities/${personal}`), { name: 'Mine', color: '#123456' })).status).toBe(
      404,
    );
  });

  it('refuses anything but #rrggbb, and anyone but owners and admins', async () => {
    for (const color of ['red', '#12345', '#1234567', 'aabbcc', '#ggg000']) {
      expect((await c.patch(url(`/entities/${rental}`), { color })).status, color).toBe(400);
    }
    expect((await member.patch(url(`/entities/${personal}`), { color: '#000000' })).status).toBe(403);
  });
});

describe('hidden books, per person (FLOW-05)', () => {
  const get = async (who: Client = c) => {
    const res = await who.get(url('/calendar/books'));
    expect(res.status).toBe(200);
    return res.body.hiddenEntityIds as string[];
  };
  const put = (hiddenEntityIds: unknown, who: Client = c) =>
    who.put(url('/calendar/books'), { hiddenEntityIds });

  it('round-trips, dropping ids that aren’t books', async () => {
    expect(await get()).toEqual([]);
    const res = await put([rental, biz, biz, '00000000-0000-4000-8000-000000000000']);
    expect(res.status).toBe(200);
    expect(res.body.hiddenEntityIds).toEqual([rental, biz]);
    expect(await get()).toEqual([rental, biz]);
    // The calendar itself still returns every book: the clients hide what's hidden.
    expect(new Set((await calendar(today, to)).map((i) => i.entityId))).toEqual(
      new Set([personal, biz, rental]),
    );
  });

  it('refuses what isn’t a list of ids', async () => {
    expect((await put(['nope'])).status).toBe(400);
    expect((await put(rental)).status).toBe(400);
    expect((await c.put(url('/calendar/books'), {})).status).toBe(400);
  });

  it('keeps each person’s choice to themselves, and only books they can see', async () => {
    expect(await get(member)).toEqual([]);
    const theirs = await put([personal, biz, rental], member);
    expect(theirs.status).toBe(200);
    // A member sees only the personal books: the others are dropped.
    expect(theirs.body.hiddenEntityIds).toEqual([personal]);
    expect(await get(member)).toEqual([personal]);
    expect(await get()).toEqual([rental, biz]);

    // RLS: each sees only their own row, and can't write another's.
    const db = h.app.get(Db);
    const memberId = (await member.get('/v1/me')).body.id as string;
    const ownerId = (await c.get('/v1/me')).body.id as string;
    const rows = await db.run({ workspaceId: wsId, userId: memberId }, (trx) =>
      trx.selectFrom('app.calendar_book_pref').select(['user_id', 'hidden_entity_ids']).execute(),
    );
    expect(rows).toEqual([{ user_id: memberId, hidden_entity_ids: [personal] }]);
    await expect(
      db.run({ workspaceId: wsId, userId: memberId }, (trx) =>
        trx
          .updateTable('app.calendar_book_pref')
          .set({ hidden_entity_ids: [] })
          .where('user_id', '=', ownerId)
          .executeTakeFirst(),
      ),
    ).resolves.toMatchObject({ numUpdatedRows: 0n });
    await expect(
      db.run({ workspaceId: wsId, userId: memberId }, (trx) =>
        trx
          .insertInto('app.calendar_book_pref')
          .values({ workspace_id: wsId, user_id: ownerId, hidden_entity_ids: [] })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await get()).toEqual([rental, biz]);
  });

  it('ignores an archived book, and remembers it if the book comes back', async () => {
    expect((await c.patch(url(`/entities/${rental}`), { archived: true })).status).toBe(200);
    expect(await get()).toEqual([biz]);
    expect((await c.patch(url(`/entities/${rental}`), { archived: false })).status).toBe(200);
    expect(await get()).toEqual([rental, biz]);
  });
});
