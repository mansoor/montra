/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, startOfMonth, todayIn } from '@montra/domain';
import { BusinessJobs } from '../src/business/business-jobs.service.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { RentalJobs } from '../src/rentals/rental-jobs.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Rental properties end to end (RNT-01..14, UP-10; ADR-0018).
const today = todayIn('UTC');
const year = Number(today.slice(0, 4));
const thisMonth = startOfMonth(today);
const lastMonth = startOfMonth(addDays(thisMonth, -1));
const twoMonthsAgo = startOfMonth(addDays(lastMonth, -1));
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'landlord@example.com';

let h: Harness;
let c: Client;
let partner: Client;
let jobs: RentalJobs;
let admin: pg.Client;
let url: (p: string) => string;
let wsId: string;
let userId: string;
let rental: string;
let personal: string;
let checking: string;
let cats: any[];
let cat: (name: string, entity?: string) => string;
const ctx = () => ({ workspaceId: wsId, userId });

const account = async (name: string, entityId: string, kind = 'checking', opening = '1000000') =>
  (
    await c.post(url('/accounts'), {
      name,
      kind,
      openingBalance: usd(opening),
      openingDate: `${year - 2}-12-01`,
      entityId,
    })
  ).body.id as string;
const property = async (name: string, over: object = {}, entityId = rental) => {
  const res = await c.post(url('/properties'), { entityId, name, type: 'sfh', ...over });
  expect(res.status).toBe(201);
  return res.body;
};
const tenant = async (name: string, entityId = rental) =>
  (await c.post(url('/tenants'), { entityId, name })).body;
const lease = async (unitId: string, tenantIds: string[], over: object = {}) => {
  const res = await c.post(url('/leases'), {
    unitId,
    tenantIds,
    startDate: twoMonthsAgo,
    rent: '150000',
    dueDay: 1,
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body;
};
/** A property, its tenant and a lease, ready for rent. */
const rented = async (name: string, tenantName: string, over: object = {}, entityId = rental) => {
  const p = await property(name, {}, entityId);
  const t = await tenant(tenantName, entityId);
  return { p, t, l: await lease(p.units[0].id, [t.id], over) };
};
const line = async (amount: string, payee: string, date: string = today, accountId = checking) => {
  const res = await c.post(url('/transactions'), {
    date,
    accountId,
    amount: usd(amount),
    payee,
    categoryId: cat(BigInt(amount) > 0n ? 'Other rental income' : 'Repairs'),
  });
  expect(res.status).toBe(201);
  return res.body;
};
const pay = (leaseId: string, amount: string, date: string = today, accountId = checking) =>
  c.post(url(`/leases/${leaseId}/payments`), { accountId, date, amount });
const roll = async (month = lastMonth, entityId = rental) =>
  (await c.get(url(`/rent-roll?entityId=${entityId}&month=${month}`))).body;
const rowOf = async (leaseId: string, month = lastMonth) =>
  (await roll(month)).rows.find((r: any) => r.leaseId === leaseId);
const postings = async (transactionId: string) =>
  (
    await admin.query(
      `select a.name, p.amount_minor::text as amount, p.property_id, p.unit_id
         from app.posting p join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
         join app.ledger_account a on a.id = p.ledger_account_id
        where je.transaction_id = $1 order by p.amount_minor desc`,
      [transactionId],
    )
  ).rows;
const balance = async (id: string) =>
  (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id).balance.amount as string;
/** What the ledger holds in an account, whether or not it's listed among bank accounts. */
const ledgerSum = async (accountId: string) =>
  (
    await admin.query(
      `select coalesce(sum(amount_minor), 0)::text as s from app.posting where ledger_account_id = $1`,
      [accountId],
    )
  ).rows[0].s as string;
const depositsAccount = async (entityId: string) =>
  (
    await admin.query(
      `select id from app.ledger_account where entity_id = $1 and system_role = 'security_deposits_held'`,
      [entityId],
    )
  ).rows[0].id as string;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(ImportJobs).register();
  jobs = h.app.get(RentalJobs);
  c = h.as(EMAIL);
  partner = h.as('rentals-partner@example.com');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Rentals', baseCurrency: 'USD', template: 'landlord' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await c.get(url('/entities'))).body.data;
  rental = entities.find((e: any) => e.type === 'rental').id;
  personal = entities.find((e: any) => e.type === 'personal').id;
  checking = await account('Rental checking', rental);
  cats = (await c.get(url('/categories'))).body.data;
  cat = (name, entity = rental) => cats.find((x: any) => x.name === name && x.entityId === entity).id;
  userId = (await admin.query(`select id from app.app_user where email = $1`, [EMAIL])).rows[0].id;
  const invite = await c.post(url('/sharing/invites'), {
    email: 'rentals-partner@example.com',
    role: 'partner',
  });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('properties and units (RNT-01, RNT-02)', () => {
  it('gives a house its one unit, and a building the units it lists', async () => {
    const house = await property('12 Elm St', { address: '12 Elm St, Austin' });
    expect(house.units.map((u: any) => u.label)).toEqual(['Main']);
    expect(house.units[0].status).toBe('vacant');
    expect(house.ownershipBps).toBe(10000);
    const building = await property('Oak Duplex', {
      type: 'multi_family',
      units: [
        { label: 'A', beds: 2, baths: '1.5', marketRent: '120000' },
        { label: 'B', beds: 3, baths: '2' },
      ],
    });
    expect(building.units.map((u: any) => [u.label, u.baths])).toEqual([
      ['A', '1.5'],
      ['B', '2'],
    ]);
  });

  it('refuses a property outside a rental portfolio', async () => {
    const res = await c.post(url('/properties'), { entityId: personal, name: 'Home', type: 'sfh' });
    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.error?.code).toBe('rental.not_a_portfolio');
  });

  it('shows a unit as under repair only while nobody lives there', async () => {
    const p = await property('Repair House');
    const unit = p.units[0];
    const res = await c.patch(url(`/units/${unit.id}`), { underRepair: true, version: unit.version });
    expect(res.body.units[0].status).toBe('under_repair');
    const t = await tenant('Una Repair');
    await lease(unit.id, [t.id]);
    expect((await c.get(url(`/properties/${p.id}`))).body.units[0].status).toBe('occupied');
  });

  it('does not exist for a partner without access to the portfolio', async () => {
    expect((await partner.get(url(`/properties?entityId=${rental}`))).status).toBe(404);
    const p = await property('Private House');
    expect((await partner.get(url(`/properties/${p.id}`))).status).toBe(404);
    expect((await partner.get(url(`/rent-roll?entityId=${rental}`))).status).toBe(404);
  });

  it('refuses a stale edit', async () => {
    const p = await property('Versioned');
    expect((await c.patch(url(`/properties/${p.id}`), { name: 'New', version: p.version })).status).toBe(200);
    const stale = await c.patch(url(`/properties/${p.id}`), { name: 'Old', version: p.version });
    expect(stale.status).toBe(409);
  });
});

describe('leases and the rent roll (RNT-03, RNT-04)', () => {
  it('writes charges through next month, and shows who pays what', async () => {
    const { l, t } = await rented('Roll House', 'Rita Rollins');
    expect(l).toMatchObject({ status: 'active', propertyName: 'Roll House', rent: '150000' });
    expect(l.tenants).toEqual([{ id: t.id, name: 'Rita Rollins' }]);
    const row = await rowOf(l.id);
    expect(row).toMatchObject({ expected: '150000', paid: '0', open: '150000', tenants: ['Rita Rollins'] });
    expect(row.charges[0]).toMatchObject({ kind: 'rent', periodStart: lastMonth, status: 'late' });
    const next = startOfMonth(addDays(thisMonth, 32));
    expect(await rowOf(l.id, next)).toMatchObject({ expected: '150000' });
    // The month after that isn't written yet.
    expect(await rowOf(l.id, startOfMonth(addDays(next, 32)))).toBeUndefined();
  });

  it('refuses a second lease on the same unit for the same dates, but allows the next one', async () => {
    const { p, t } = await rented('Overlap House', 'Oli Overlap', { endDate: addDays(thisMonth, -1) });
    const clash = await c.post(url('/leases'), {
      unitId: p.units[0].id,
      tenantIds: [t.id],
      startDate: lastMonth,
      rent: '100000',
    });
    expect(clash.status).toBe(422);
    expect(clash.body.code ?? clash.body.error?.code).toBe('lease.overlap');
    await lease(p.units[0].id, [t.id], { startDate: thisMonth });
  });

  it('lists vacant units on the roll', async () => {
    const p = await property('Empty House', { units: [{ label: 'Only', marketRent: '99000' }] });
    const vacant = (await roll(thisMonth)).vacant;
    expect(vacant.find((u: any) => u.unitId === p.units[0].id)).toMatchObject({
      propertyName: 'Empty House',
      marketRent: '99000',
    });
  });

  it('applies payments oldest first, and carries extra as a credit', async () => {
    const { l } = await rented('Fifo House', 'Fay Fifo');
    expect((await pay(l.id, '200000')).status).toBe(201);
    const first = await rowOf(l.id, twoMonthsAgo);
    expect(first).toMatchObject({ paid: '150000', open: '0' });
    expect(first.charges[0].status).toBe('paid');
    const second = await rowOf(l.id, lastMonth);
    expect(second).toMatchObject({ paid: '50000', open: '100000' });
    expect(second.charges[0].status).toBe('late');
    // Everything paid and more: the rest is a credit.
    await pay(l.id, '500000');
    const later = await rowOf(l.id, lastMonth);
    expect(BigInt(later.credit)).toBeGreaterThan(0n);
  });

  it('posts rent to Rents received, tagged to the property and unit, and keeps it managed', async () => {
    const { p, l } = await rented('Tag House', 'Tia Tagg');
    const before = await balance(checking);
    await pay(l.id, '150000');
    const payments = (await c.get(url(`/leases/${l.id}/payments`))).body.data;
    expect(payments).toHaveLength(1);
    const t = payments[0].transactionId;
    expect(await balance(checking)).toBe(String(BigInt(before) + 150000n));
    const lines = await postings(t);
    const income = lines.find((x: any) => x.name === 'Rents received');
    expect(income).toMatchObject({ amount: '-150000', property_id: p.id, unit_id: p.units[0].id });
    const edit = await c.patch(url(`/transactions/${t}`), { categoryId: cat('Other rental income') });
    expect(edit.status).toBe(422);
    expect(edit.body.code ?? edit.body.error?.code).toBe('lease.managed');
    expect((await c.get(url(`/transactions?propertyId=${p.id}`))).body.data.map((x: any) => x.id)).toEqual([
      t,
    ]);
    // Removing a payment entered here removes the money too.
    expect((await c.delete(url(`/leases/${l.id}/payments/${payments[0].id}`))).status).toBe(204);
    expect(await balance(checking)).toBe(before);
    expect((await rowOf(l.id)).paid).toBe('0');
  });

  it('takes over a bank line, and gives it back as it was', async () => {
    const { l } = await rented('Takeover House', 'Theo Takeover');
    const bank = await line('150000', 'ZELLE FROM T TAKEOVER');
    const candidates = (await c.get(url(`/leases/${l.id}/candidates`))).body.data;
    expect(candidates.map((x: any) => x.transactionId)).toContain(bank.id);
    const res = await c.post(url(`/leases/${l.id}/payments`), { transactionId: bank.id });
    expect(res.status).toBe(201);
    const after = (await c.get(url(`/transactions/${bank.id}`))).body;
    expect(after.splits[0].accountId).toBe(cat('Rents received'));
    expect(after.date).toBe(today);
    // A linked line isn't a candidate for anything else.
    expect(
      (await c.get(url(`/leases/${l.id}/candidates`))).body.data.map((x: any) => x.transactionId),
    ).not.toContain(bank.id);
    const [payment] = (await c.get(url(`/leases/${l.id}/payments`))).body.data;
    await c.delete(url(`/leases/${l.id}/payments/${payment.id}`));
    const back = (await c.get(url(`/transactions/${bank.id}`))).body;
    expect(back.splits[0].accountId).toBe(cat('Other rental income'));
    await c.delete(url(`/transactions/${bank.id}`));
  });

  it('ending a lease stops rent after it, keeping what was owed before', async () => {
    const { l } = await rented('Leaving House', 'Lee Leaving');
    const res = await c.patch(url(`/leases/${l.id}`), {
      endedOn: addDays(thisMonth, -1),
      version: l.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ended');
    expect(await rowOf(l.id, thisMonth)).toBeUndefined();
    expect((await rowOf(l.id, lastMonth)).open).toBe('150000');
  });
});

describe('arrears and late fees (RNT-05)', () => {
  it('lists what is late and assesses a fee once per period, capped', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Arrears Portfolio' })).body.id;
    const { l } = await rented(
      'Late House',
      'Lou Late',
      { lateGraceDays: 3, lateFeeFlat: '2500', lateFeeBps: 500, lateFeeCap: '5000' },
      entity,
    );
    const q = url(`/arrears?entityId=${entity}`);
    const before = (await c.get(q)).body;
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({ leaseId: l.id, tenants: ['Lou Late'], feesOwed: '0' });
    const owedBefore = BigInt(before.rows[0].rentOwed);
    expect(owedBefore).toBeGreaterThanOrEqual(300000n);
    const added = await jobs.assessFees(ctx());
    expect(added).toBeGreaterThanOrEqual(2);
    // Run again: nothing new.
    expect(await jobs.assessFees(ctx())).toBe(0);
    const after = (await c.get(q)).body;
    // 25.00 flat + 5% of 1,500.00 = 100.00, capped at 50.00 each.
    const fees = after.rows[0].charges.filter((x: any) => x.kind === 'late_fee');
    expect(fees.every((x: any) => x.amount === '5000')).toBe(true);
    expect(after.rows[0].feesOwed).toBe(String(5000n * BigInt(fees.length)));

    const waived = await c.patch(url(`/rent-charges/${fees[0].id}`), {
      waived: true,
      version: fees[0].version,
    });
    expect(waived.status).toBe(200);
    expect(waived.body.status).toBe('waived');
    await jobs.assessFees(ctx());
    const again = (await c.get(q)).body;
    expect(again.rows[0].feesOwed).toBe(String(5000n * BigInt(fees.length - 1)));
    // A stale edit is refused.
    const stale = await c.patch(url(`/rent-charges/${fees[0].id}`), {
      amount: '1',
      version: fees[0].version,
    });
    expect(stale.status).toBe(409);
  });

  it('charges nothing while rent is paid', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Paid Portfolio' })).body.id;
    const acct = await account('Paid checking', entity);
    const { l } = await rented(
      'Paid House',
      'Pat Paid',
      { startDate: lastMonth, lateFeeFlat: '2500' },
      entity,
    );
    await pay(l.id, '150000', today, acct);
    await jobs.assessFees(ctx());
    const res = (await c.get(url(`/arrears?entityId=${entity}`))).body;
    expect(res.rows).toEqual([]);
    expect(res.total).toBe('0');
  });
});

describe('matching deposits (RNT-04)', () => {
  it('links a line naming the tenant, and remembers the name it came under', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Match Portfolio' })).body.id;
    const acct = await account('Match checking', entity);
    const inner = async (amount: string, payee: string) =>
      (
        await c.post(url('/transactions'), {
          date: today,
          accountId: acct,
          amount: usd(amount),
          payee,
          categoryId: (
            (await c.get(url('/categories'))).body.data.find(
              (x: any) => x.name === 'Other rental income' && x.entityId === entity,
            ) as any
          ).id,
        })
      ).body;
    const a = await rented('Match A', 'Mia Marlowe', { startDate: lastMonth }, entity);
    const b = await rented('Match B', 'Max Bexley', { startDate: lastMonth, rent: '175000' }, entity);
    const named = await inner('120000', 'ZELLE M MARLOWE');
    const exact = await inner('175000', 'ACH CREDIT 8841');
    const unknown = await inner('98765', 'ACH CREDIT 1234');
    expect(await jobs.matchPayments(ctx())).toBeGreaterThanOrEqual(2);
    const paymentsOf = async (id: string) =>
      (await c.get(url(`/leases/${id}/payments`))).body.data.map((p: any) => p.transactionId);
    expect(await paymentsOf(a.l.id)).toEqual([named.id]);
    expect(await paymentsOf(b.l.id)).toEqual([exact.id]);
    const stays = (await c.get(url(`/transactions/${unknown.id}`))).body;
    expect(stays.splits[0].accountId).not.toBe(undefined);
    expect(await paymentsOf(a.l.id)).not.toContain(unknown.id);
    expect(await paymentsOf(b.l.id)).not.toContain(unknown.id);
    const keys = await admin.query(`select payee_keys from app.tenant where id = $1`, [a.t.id]);
    expect(keys.rows[0].payee_keys.length).toBe(1);
    // Running again changes nothing.
    expect(await jobs.matchPayments(ctx())).toBe(0);
    await c.delete(url(`/transactions/${unknown.id}`));
  });

  it('leaves a line alone when two leases could claim it', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Twin Portfolio' })).body.id;
    const acct = await account('Twin checking', entity);
    const a = await rented('Twin A', 'Tom One', { startDate: lastMonth, rent: '133300' }, entity);
    const b = await rented('Twin B', 'Tim Two', { startDate: lastMonth, rent: '133300' }, entity);
    const income = (await c.get(url('/categories'))).body.data.find(
      (x: any) => x.name === 'Other rental income' && x.entityId === entity,
    ).id;
    const t = await c.post(url('/transactions'), {
      date: today,
      accountId: acct,
      amount: usd('133300'),
      payee: 'ACH CREDIT',
      categoryId: income,
    });
    await jobs.matchPayments(ctx());
    expect((await c.get(url(`/leases/${a.l.id}/payments`))).body.data).toEqual([]);
    expect((await c.get(url(`/leases/${b.l.id}/payments`))).body.data).toEqual([]);
    await c.delete(url(`/transactions/${t.body.id}`));
  });
});

describe('security deposits (RNT-10)', () => {
  it('holds a deposit as a liability: not income, returned or forfeited', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Deposit Portfolio' })).body.id;
    const acct = await account('Deposit checking', entity);
    const { l } = await rented('Deposit House', 'Dee Deposit', { deposit: '200000' }, entity);
    const liability = await depositsAccount(entity);
    const q = `/leases/${l.id}/deposit-events`;
    const received = await c.post(url(q), {
      kind: 'received_new',
      accountId: acct,
      date: today,
      amount: '200000',
    });
    expect(received.status).toBe(201);
    expect(received.body.depositHeld).toBe('200000');
    expect(await ledgerSum(liability)).toBe('-200000');
    const report = async () => (await c.get(url(`/reports/rental?entityId=${entity}`))).body.portfolio.income;
    expect(await report()).toBe('0');

    const tooMuch = await c.post(url(q), {
      kind: 'returned',
      accountId: acct,
      date: today,
      amount: '200001',
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.code ?? tooMuch.body.error?.code).toBe('deposit.more_than_held');

    const returned = await c.post(url(q), {
      kind: 'returned',
      accountId: acct,
      date: today,
      amount: '150000',
    });
    expect(returned.body.depositHeld).toBe('50000');
    expect(await ledgerSum(liability)).toBe('-50000');
    expect(await balance(acct)).toBe(String(1000000n + 50000n));

    // Forfeited: no cash moves, and what was held becomes income.
    const forfeited = await c.post(url(q), {
      kind: 'forfeited',
      date: today,
      amount: '50000',
      notes: 'Damage',
    });
    expect(forfeited.body.depositHeld).toBe('0');
    expect(await ledgerSum(liability)).toBe('0');
    expect(await balance(acct)).toBe(String(1000000n + 50000n));
    expect(await report()).toBe('50000');
    const event = forfeited.body.depositEvents.find((e: any) => e.kind === 'forfeited');
    // A note is fine; the money side stays with the lease.
    expect((await c.patch(url(`/transactions/${event.transactionId}`), { memo: 'x' })).status).toBe(200);
    const edit = await c.patch(url(`/transactions/${event.transactionId}`), { description: 'y' });
    expect(edit.status).toBe(422);
    expect(edit.body.code ?? edit.body.error?.code).toBe('security_deposit.managed');
    expect((await c.delete(url(`/transactions/${event.transactionId}`))).status).toBe(422);
    // Undo it: held again, income gone.
    const undone = await c.delete(url(`${q}/${event.id}`));
    expect(undone.status).toBe(200);
    expect(undone.body.depositHeld).toBe('50000');
    expect(await report()).toBe('0');
    // What was received can't go while part of it has been returned.
    const first = undone.body.depositEvents.find((e: any) => e.kind === 'received');
    const refused = await c.delete(url(`${q}/${first.id}`));
    expect(refused.status).toBe(422);
    expect(refused.body.code ?? refused.body.error?.code).toBe('deposit.later_events');
  });
});

describe('shared expenses (RNT-07)', () => {
  it('splits by percent to the cent, and keeps the total', async () => {
    const a = await property('Alloc A');
    const b = await property('Alloc B');
    const bill = await line('-10001', 'INSURER CO');
    const res = await c.post(url(`/transactions/${bill.id}/allocate`), {
      basis: 'percent',
      targets: [
        { propertyId: a.id, percentBps: 5000 },
        { propertyId: b.id, percentBps: 5000 },
      ],
    });
    expect(res.status).toBe(200);
    const parts = res.body.splits.map((s: any) => [s.propertyId, BigInt(s.amount)]);
    expect(parts.reduce((t: bigint, p: any) => t + p[1], 0n)).toBe(-10001n);
    expect(new Set(parts.map((p: any) => p[0]))).toEqual(new Set([a.id, b.id]));
    const lines = await postings(bill.id);
    expect(lines.filter((l: any) => l.property_id === a.id)).toHaveLength(1);
    expect(lines.filter((l: any) => l.property_id === b.id)).toHaveLength(1);
    expect(await balance(checking)).toBeDefined();
  });

  it('refuses percentages that do not add up, and a property twice', async () => {
    const a = await property('Alloc C');
    const b = await property('Alloc D');
    const bill = await line('-5000', 'INSURER TWO');
    const bad = await c.post(url(`/transactions/${bill.id}/allocate`), {
      basis: 'percent',
      targets: [
        { propertyId: a.id, percentBps: 4000 },
        { propertyId: b.id, percentBps: 5000 },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code ?? bad.body.error?.code).toBe('allocation.percent');
    const twice = await c.post(url(`/transactions/${bill.id}/allocate`), {
      basis: 'units',
      targets: [{ propertyId: a.id }, { propertyId: a.id }],
    });
    expect(twice.status).toBe(422);
  });

  it('uses a saved rule, reading units at the time of use', async () => {
    const a = await property('Alloc E', {
      type: 'multi_family',
      units: [{ label: '1' }, { label: '2' }, { label: '3' }],
    });
    const b = await property('Alloc F');
    const rule = await c.post(url('/allocation-rules'), {
      entityId: rental,
      name: 'By units',
      basis: 'units',
      targets: [{ propertyId: a.id }, { propertyId: b.id }],
    });
    expect(rule.status).toBe(201);
    const bill = await line('-40000', 'LANDSCAPING');
    const res = await c.post(url(`/transactions/${bill.id}/allocate`), { ruleId: rule.body.id });
    const of = (id: string) => BigInt(res.body.splits.find((s: any) => s.propertyId === id).amount);
    expect(of(a.id)).toBe(-30000n);
    expect(of(b.id)).toBe(-10000n);
    expect((await c.delete(url(`/allocation-rules/${rule.body.id}`))).status).toBe(204);
    expect(
      (await c.get(url(`/allocation-rules?entityId=${rental}`))).body.data.map((r: any) => r.id),
    ).not.toContain(rule.body.id);
  });

  it('needs square footage to split by it, and refuses what a lease owns', async () => {
    const a = await property('Alloc G');
    const b = await property('Alloc H', { sqft: 1000 });
    const bill = await line('-1000', 'WATER CO');
    const noSqft = await c.post(url(`/transactions/${bill.id}/allocate`), {
      basis: 'sqft',
      targets: [{ propertyId: a.id }, { propertyId: b.id }],
    });
    expect(noSqft.status).toBe(422);
    expect(noSqft.body.code ?? noSqft.body.error?.code).toBe('allocation.basis');

    const { l } = await rented('Alloc Owned', 'Ann Allocated');
    await pay(l.id, '150000');
    const [payment] = (await c.get(url(`/leases/${l.id}/payments`))).body.data;
    const owned = await c.post(url(`/transactions/${payment.transactionId}/allocate`), {
      basis: 'units',
      targets: [{ propertyId: a.id }, { propertyId: b.id }],
    });
    expect(owned.status).toBe(422);
  });
});

describe('tagging a transaction with a property (RNT-06)', () => {
  it('keeps the property when the category changes, and refuses other books', async () => {
    const p = await property('Tagged House');
    const created = await c.post(url('/transactions'), {
      date: today,
      accountId: checking,
      amount: usd('-2500'),
      payee: 'HARDWARE STORE',
      categoryId: cat('Supplies'),
      propertyId: p.id,
      unitId: p.units[0].id,
    });
    expect(created.status).toBe(201);
    expect(created.body.splits[0]).toMatchObject({ propertyId: p.id, unitId: p.units[0].id });
    const moved = await c.patch(url(`/transactions/${created.body.id}`), { categoryId: cat('Repairs') });
    expect(moved.status).toBe(200);
    expect(moved.body.splits[0]).toMatchObject({ accountId: cat('Repairs'), propertyId: p.id });
    // Moved to other books, the property stays behind rather than refusing the move.
    const elsewhere = await c.post(url('/transactions'), {
      date: today,
      accountId: checking,
      amount: usd('-300'),
      payee: 'MOVED',
      categoryId: cat('Supplies'),
      propertyId: p.id,
    });
    const moves = await c.patch(url(`/transactions/${elsewhere.body.id}`), {
      categoryId: cats.find((x: any) => x.entityId === personal && x.type === 'expense').id,
    });
    expect(moves.status).toBe(200);
    expect(moves.body.splits[0].propertyId).toBeNull();
    const off = await c.patch(url(`/transactions/${created.body.id}`), { propertyId: null });
    expect(off.body.splits[0].propertyId).toBeNull();
    const other = await c.post(url('/transactions'), {
      date: today,
      accountId: await account('Personal checking', personal),
      amount: usd('-500'),
      payee: 'Coffee',
      categoryId: cats.find((x: any) => x.entityId === personal && x.type === 'expense').id,
      propertyId: p.id,
    });
    expect(other.status).toBe(422);
    expect(other.body.code ?? other.body.error?.code).toBe('property.other_books');
  });

  it('applying a rule skips what an owner manages', async () => {
    const { l } = await rented('Rule House', 'Ray Rule');
    await pay(l.id, '150000');
    const rule = await c.post(url('/rules'), {
      name: 'Everything from Ray',
      conditions: { all: [{ field: 'payee', op: 'contains', value: 'Ray Rule' }] },
      actions: { categoryId: cat('Other rental income') },
    });
    expect(rule.status).toBe(201);
    const apply = await c.post(url(`/rules/${rule.body.id}/apply`));
    expect(apply.status).toBeLessThan(300);
    const [payment] = (await c.get(url(`/leases/${l.id}/payments`))).body.data;
    const t = (await c.get(url(`/transactions/${payment.transactionId}`))).body;
    expect(t.splits[0].accountId).toBe(cat('Rents received'));
  });
});

describe('mortgages (RNT-08)', () => {
  let entity: string;
  let acct: string;
  let loanAccount: string;
  let loan: any;
  let prop: any;
  const catIn = async (name: string) =>
    (await c.get(url('/categories'))).body.data.find((x: any) => x.name === name && x.entityId === entity).id;

  beforeAll(async () => {
    entity = (await c.post(url('/entities'), { type: 'rental', name: 'Loan Portfolio' })).body.id;
    acct = await account('Loan checking', entity);
    loanAccount = await account('Elm mortgage', entity, 'mortgage', '20000000');
    prop = await property('Loan House', {}, entity);
  });

  it('refuses an account that is not a loan', async () => {
    const res = await c.post(url('/loans'), {
      propertyId: prop.id,
      loanAccountId: acct,
      name: 'Bad',
      principal: '20000000',
      rateBps: 600,
      termMonths: 360,
      firstPaymentDate: lastMonth,
    });
    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.error?.code).toBe('loan.account');
  });

  it('computes the schedule from its terms', async () => {
    const res = await c.post(url('/loans'), {
      propertyId: prop.id,
      loanAccountId: loanAccount,
      name: 'Elm mortgage',
      principal: '20000000',
      rateBps: 600,
      termMonths: 360,
      firstPaymentDate: lastMonth,
      escrowTaxes: '20000',
      escrowInsurance: '10000',
    });
    expect(res.status).toBe(201);
    loan = res.body;
    expect(loan).toMatchObject({ payment: '119910', totalPayment: '149910', paymentsMade: 0 });
    const rows = (await c.get(url(`/loans/${loan.id}/schedule`))).body.data;
    expect(rows).toHaveLength(360);
    expect(rows[0]).toMatchObject({
      number: 1,
      date: lastMonth,
      interest: '100000',
      principal: '19910',
      escrow: '30000',
    });
    expect(rows[359].balance).toBe('0');
  });

  it('splits a payment into interest, principal and escrow, all tagged to the property', async () => {
    const res = await c.post(url(`/loans/${loan.id}/payments`), {
      number: 1,
      accountId: acct,
      date: lastMonth,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ paymentsMade: 1, scheduledBalance: '19980090' });
    expect(await balance(acct)).toBe(String(1000000n - 149910n));
    expect(await ledgerSum(loanAccount)).toBe(String(-20000000n + 19910n));
    const rows = (await c.get(url(`/loans/${loan.id}/schedule`))).body.data;
    const lines = await postings(rows[0].transactionId);
    const of = (name: string) => lines.find((l: any) => l.name === name);
    expect(of('Mortgage interest')).toMatchObject({ amount: '100000', property_id: prop.id });
    expect(of('Taxes')).toMatchObject({ amount: '20000', property_id: prop.id });
    expect(of('Insurance')).toMatchObject({ amount: '10000', property_id: prop.id });
    const edit = await c.patch(url(`/transactions/${rows[0].transactionId}`), {
      categoryId: await catIn('Repairs'),
    });
    expect(edit.body.code ?? edit.body.error?.code).toBe('loan.managed');
    const twice = await c.post(url(`/loans/${loan.id}/payments`), {
      number: 1,
      accountId: acct,
      date: lastMonth,
    });
    expect(twice.body.code ?? twice.body.error?.code).toBe('loan.already_paid');
  });

  it('needs the exact amount to take over a bank line, and matches it by itself when it is', async () => {
    const add = async (amount: string, payee: string) =>
      (
        await c.post(url('/transactions'), {
          date: thisMonth,
          accountId: acct,
          amount: usd(amount),
          payee,
          categoryId: await catIn('Repairs'),
        })
      ).body;
    const wrong = await add('-149000', 'MORTGAGE CO PMT');
    const refused = await c.post(url(`/loans/${loan.id}/payments`), { number: 2, transactionId: wrong.id });
    expect(refused.status).toBe(422);
    expect(refused.body.code ?? refused.body.error?.code).toBe('loan.amount');
    expect(await jobs.matchPayments(ctx())).toBe(0);
    const right = await add('-149910', 'MORTGAGE CO PMT');
    expect(await jobs.matchPayments(ctx())).toBe(1);
    const row = (await c.get(url(`/loans/${loan.id}/schedule`))).body.data[1];
    expect(row.transactionId).toBe(right.id);
    // Undoing gives the line back as it was.
    const undone = await c.delete(url(`/loans/${loan.id}/payments/2`));
    expect(undone.status).toBe(200);
    expect(undone.body.paymentsMade).toBe(1);
    const back = (await c.get(url(`/transactions/${right.id}`))).body;
    expect(back.splits).toHaveLength(1);
    expect(back.splits[0].accountId).toBe(await catIn('Repairs'));
    await c.delete(url(`/transactions/${right.id}`));
    await c.delete(url(`/transactions/${wrong.id}`));
  });
});

describe('reports (RNT-06, RNT-09, RNT-11, UP-10)', () => {
  let entity: string;
  let acct: string;
  let p: any;
  let q: any;
  const catIn = async (name: string) =>
    (await c.get(url('/categories'))).body.data.find((x: any) => x.name === name && x.entityId === entity).id;
  const spend = async (amount: string, category: string, propertyId: string | null) =>
    (
      await c.post(url('/transactions'), {
        date: today,
        accountId: acct,
        amount: usd(amount),
        payee: 'Vendor',
        categoryId: await catIn(category),
        ...(propertyId ? { propertyId } : {}),
      })
    ).body;
  const from = addDays(today, -364);

  beforeAll(async () => {
    entity = (await c.post(url('/entities'), { type: 'rental', name: 'Report Portfolio' })).body.id;
    acct = await account('Report checking', entity);
    p = await property(
      'Report House',
      {
        currentValue: '20000000',
        cashInvested: '5000000',
        ownershipBps: 5000,
        address: '1 Report Rd',
        units: [{ label: 'Up' }, { label: 'Down' }],
      },
      entity,
    );
    q = await property('Report Flat', {}, entity);
    const t = await tenant('Rae Report', entity);
    const l = await lease(p.units[0].id, [t.id], { startDate: from, rent: '200000' });
    await pay(l.id, '200000', today, acct);
    await spend('-30000', 'Repairs', p.id);
    await spend('-5000', 'Utilities', q.id);
    await spend('-700', 'Advertising', null);
    const loanAccount = await account('Report mortgage', entity, 'mortgage', '10000000');
    const loan = await c.post(url('/loans'), {
      propertyId: p.id,
      loanAccountId: loanAccount,
      name: 'Report mortgage',
      principal: '10000000',
      rateBps: 600,
      termMonths: 360,
      firstPaymentDate: today,
    });
    await c.post(url(`/loans/${loan.body.id}/payments`), { number: 1, accountId: acct, date: today });
    await c.post(url('/depreciation'), {
      propertyId: p.id,
      name: 'Building',
      basis: '27500000',
      inServiceDate: `${year - 1}-01-15`,
      method: 'SL_27_5',
    });
  });

  it('reports NOI, debt service, cash flow and the ratios per property', async () => {
    const r = (await c.get(url(`/reports/rental?entityId=${entity}&from=${from}&to=${today}`))).body;
    const house = r.properties.find((x: any) => x.propertyId === p.id);
    expect(house).toMatchObject({
      income: '200000',
      operatingExpenses: '30000',
      noi: '170000',
      units: 2,
    });
    // 6% on 100,000.00 for a month is 500.00; the level payment is 599.55.
    expect(house.debtService).toBe('59955');
    expect(house.cashFlow).toBe('110045');
    // 1,700 of NOI on a value of 200,000: 0.85%. The range is exactly a year, so nothing is scaled.
    expect(house.capRateBps).toBe(85);
    expect(house.cashOnCashBps).toBe(220);
    // One of two units let for the whole range.
    expect(house.occupancyBps).toBe(5000);
    expect(r.properties.find((x: any) => x.propertyId === q.id)).toMatchObject({
      operatingExpenses: '5000',
      noi: '-5000',
      occupancyBps: 0,
      capRateBps: null,
    });
    expect(r.untagged).toMatchObject({ operatingExpenses: '700' });
    expect(r.portfolio).toMatchObject({ income: '200000', operatingExpenses: '35700', noi: '164300' });
    expect(r.portfolio.debtService).toBe('59955');
  });

  it('files each property on Schedule E, with depreciation and your share', async () => {
    const s = (await c.get(url(`/reports/schedule-e?entityId=${entity}&year=${year}`))).body;
    const house = s.properties.find((x: any) => x.propertyId === p.id);
    const onLine = (code: string) => house.lines.find((l: any) => l.code === code);
    expect(onLine('US_SCH_E_L3').amount).toBe('200000');
    expect(onLine('US_SCH_E_L14').amount).toBe('30000');
    expect(onLine('US_SCH_E_L12').amount).toBe('50000');
    // 275,000.00 over 27.5 years is 10,000.00 a year; last year was its first.
    expect(onLine('US_SCH_E_L18')).toMatchObject({ amount: '1000000', depreciation: '1000000' });
    expect(house).toMatchObject({ income: '200000', expenses: String(30000n + 50000n + 1000000n) });
    expect(house.net).toBe(String(200000n - 1080000n));
    expect(house.yourShare).toBe(String((200000n - 1080000n) / 2n));
    expect(house.lines.some((l: any) => l.code === 'US_SCH_E_L13')).toBe(false);
    // What isn't on a property still shows, so the totals are whole.
    const rest = s.properties.find((x: any) => x.propertyId === null);
    expect(rest.expenses).toBe('700');
    expect(BigInt(s.totalExpenses)).toBe(1080000n + 5000n + 700n);
    expect(s.unmapped).toEqual([]);
  });

  it('keeps an unmapped category in the totals, and says so', async () => {
    const other = await catIn('Commissions');
    await spend('-111', 'Commissions', q.id);
    await admin.query(`update app.ledger_account set tax_line_code = null where id = $1`, [other]);
    const s = (await c.get(url(`/reports/schedule-e?entityId=${entity}&year=${year}`))).body;
    expect(s.unmapped).toEqual([{ categoryId: other, name: 'Commissions', amount: '111' }]);
    const flat = s.properties.find((x: any) => x.propertyId === q.id);
    expect(flat.expenses).toBe('5111');
    await admin.query(`update app.ledger_account set tax_line_code = 'US_SCH_E_L8' where id = $1`, [other]);
  });

  it('exports it, neutralizing text a spreadsheet would run', async () => {
    const evil = await property('=HYPERLINK("x")', {}, entity);
    await spend('-222', 'Supplies', evil.id);
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/exports/schedule-e?entityId=${entity}&year=${year}&format=csv`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(`schedule-e-${year}.csv`);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toContain('Report House,1 Report Rd,3,Rents received,2000.00,50');
    expect(res.body).toContain(`"'=HYPERLINK(""x"")"`);
    const xlsx = await h.app.inject({
      method: 'GET',
      url: url(`/exports/schedule-e?entityId=${entity}&year=${year}&format=xlsx`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('tracks depreciation year by year', async () => {
    const list = (await c.get(url(`/properties/${p.id}/depreciation?year=${year}`))).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ forYear: '1000000', method: 'SL_27_5' });
    // Mid-month in the first year: 11.5 months, then a full year.
    expect(BigInt(list[0].accumulated)).toBe(1000000n + 958333n);
    const added = await c.post(url('/depreciation'), {
      propertyId: q.id,
      name: 'Windows',
      basis: '100000',
      inServiceDate: `${year}-06-10`,
      method: 'SL_39',
    });
    expect(added.status).toBe(201);
    expect((await c.delete(url(`/depreciation/${added.body.id}`))).status).toBe(204);
    expect((await c.delete(url(`/depreciation/${added.body.id}`))).status).toBe(404);
  });

  it('shows the budget against rent, plans and what was spent (RNT-14)', async () => {
    const saved = await c.put(url(`/properties/${p.id}/budget`), {
      capexReservePerUnit: '10000',
      lines: [{ categoryId: await catIn('Repairs'), amount: '25000' }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      units: 2,
      capexReserve: '20000',
      expectedRent: '200000',
      planned: '25000',
      expectedNet: String(200000n - 25000n - 20000n),
    });
    const repairs = saved.body.lines.find((l: any) => l.name === 'Repairs');
    expect(repairs).toMatchObject({ planned: '25000', spent: '30000' });
    // What nobody planned for still shows.
    expect(saved.body.lines.find((l: any) => l.name === 'Mortgage interest')).toMatchObject({ planned: '0' });
    const bad = await c.put(url(`/properties/${p.id}/budget`), {
      capexReservePerUnit: '0',
      lines: [
        {
          categoryId: cats.find((x: any) => x.entityId === personal && x.type === 'expense').id,
          amount: '1',
        },
      ],
    });
    expect(bad.status).toBe(422);
  });
});

describe('capital improvements (RNT-09)', () => {
  it('flags large repairs in code and smaller ones by AI, and capitalizes on accept', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Capital Portfolio' })).body.id;
    const acct = await account('Capital checking', entity);
    const p = await property('Capital House', {}, entity);
    const repairs = (await c.get(url('/categories'))).body.data.find(
      (x: any) => x.name === 'Repairs' && x.entityId === entity,
    ).id;
    const add = async (amount: string, payee: string, tagged = true) =>
      (
        await c.post(url('/transactions'), {
          date: today,
          accountId: acct,
          amount: usd(amount),
          payee,
          categoryId: repairs,
          ...(tagged ? { propertyId: p.id } : {}),
        })
      ).body;
    const big = await add('-300000', 'BIG CONTRACTOR');
    const roof = await add('-120000', 'ACME ROOF REPLACEMENT', false);
    const plumber = await add('-60000', 'PLUMBER CALL OUT');
    const tiny = await add('-40000', 'ROOF PATCH');
    await jobs.flagCapital(ctx());
    expect(await jobs.flagCapital(ctx())).toBe(0);
    const flags = (await c.get(url('/insights'))).body.data.filter(
      (i: any) => i.kind === 'capital_improvement',
    );
    const flagged = flags.map((f: any) => f.transactionId);
    expect(flagged).toEqual(expect.arrayContaining([big.id, roof.id]));
    expect(flagged).not.toContain(plumber.id);
    expect(flagged).not.toContain(tiny.id);
    expect(
      (await partner.get(url('/insights'))).body.data.filter((i: any) => i.kind === 'capital_improvement'),
    ).toEqual([]);

    const roofFlag = flags.find((f: any) => f.transactionId === roof.id);
    const noProperty = await c.post(url(`/insights/${roofFlag.id}/accept`), {});
    expect(noProperty.status).toBe(422);
    expect(noProperty.body.code ?? noProperty.body.error?.code).toBe('capital.property');
    const accepted = await c.post(url(`/insights/${roofFlag.id}/accept`), { propertyId: p.id });
    expect(accepted.status).toBe(200);

    const lines = await postings(roof.id);
    expect(lines.find((l: any) => l.name === 'Capital House improvements')).toMatchObject({
      amount: '120000',
      property_id: p.id,
    });
    const report = (await c.get(url(`/reports/rental?entityId=${entity}`))).body;
    const house = report.properties.find((x: any) => x.propertyId === p.id);
    expect(house.capex).toBe('120000');
    const dep = (await c.get(url(`/properties/${p.id}/depreciation`))).body.data;
    expect(dep[0]).toMatchObject({ basis: '120000', method: 'SL_27_5', transactionId: roof.id });

    // A second improvement uses the same account.
    const bigFlag = flags.find((f: any) => f.transactionId === big.id);
    expect((await c.post(url(`/insights/${bigFlag.id}/accept`), {})).status).toBe(200);
    const again = await postings(big.id);
    expect(again.find((l: any) => l.name === 'Capital House improvements')).toBeDefined();
    const accounts = await admin.query(
      `select count(*)::int as n from app.ledger_account where entity_id = $1 and name = 'Capital House improvements'`,
      [entity],
    );
    expect(accounts.rows[0].n).toBe(1);
  });
});

describe('reminders and maintenance (RNT-12, RNT-13)', () => {
  it('reminds about a lease ending soon, and about what was entered', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Reminder Portfolio' })).body.id;
    const { p, l } = await rented('Reminder House', 'Remy Reminder', { endDate: addDays(today, 30) }, entity);
    await rented('Far House', 'Faye Far', { endDate: addDays(today, 200) }, entity);
    const stored = await c.post(url('/reminders'), {
      entityId: entity,
      propertyId: p.id,
      kind: 'insurance',
      title: 'Renew insurance',
      dueDate: addDays(today, 60),
      leadDays: 30,
    });
    expect(stored.status).toBe(201);
    expect(stored.body).toMatchObject({ active: false, overdue: false });
    const list = (await c.get(url(`/reminders?entityId=${entity}`))).body.data;
    expect(list.map((r: any) => r.kind)).toEqual(['lease_end', 'insurance']);
    expect(list[0]).toMatchObject({ leaseId: l.id, id: null, active: true, title: 'Reminder House · Main' });
    const done = await c.patch(url(`/reminders/${stored.body.id}`), {
      done: true,
      version: stored.body.version,
    });
    expect(done.status).toBe(200);
    expect((await c.get(url(`/reminders?entityId=${entity}`))).body.data).toHaveLength(1);
  });

  it('logs maintenance with its files, served only through a record they are on', async () => {
    const p = await property('Maintenance House');
    const boundary = '----montra';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/iZvQWQAAAABJRU5ErkJggg==',
      'base64',
    );
    const upload = await h.app.inject({
      method: 'POST',
      url: url('/rentals/files'),
      headers: {
        authorization: `Bearer dev:${EMAIL}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="leak.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(upload.statusCode).toBe(201);
    const fileId = JSON.parse(upload.body).fileId;
    const created = await c.post(url('/maintenance'), {
      propertyId: p.id,
      unitId: p.units[0].id,
      issue: 'Leak under sink',
      vendor: 'Plumber',
      cost: '12000',
      reportedOn: today,
      fileIds: [fileId],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'open',
      propertyName: 'Maintenance House',
      unitLabel: 'Main',
    });
    const fileUrl = url(`/rentals/maintenance/${created.body.id}/files/${fileId}`);
    const get = (u: string, email = EMAIL) =>
      h.app.inject({ method: 'GET', url: u, headers: { authorization: `Bearer dev:${email}` } });
    const served = await get(fileUrl);
    expect(served.statusCode).toBe(200);
    expect(served.headers['cache-control']).toContain('no-store');
    expect(served.rawPayload.equals(png)).toBe(true);
    // Not through a record it isn't on, nor for someone who can't read the record.
    const other = await c.post(url('/maintenance'), { propertyId: p.id, issue: 'Other', reportedOn: today });
    expect((await get(url(`/rentals/maintenance/${other.body.id}/files/${fileId}`))).statusCode).toBe(404);
    expect((await get(fileUrl, 'rentals-partner@example.com')).statusCode).toBe(404);

    const done = await c.patch(url(`/maintenance/${created.body.id}`), {
      status: 'done',
      completedOn: today,
      version: created.body.version,
    });
    expect(done.body).toMatchObject({ status: 'done', completedOn: today });
    const stale = await c.patch(url(`/maintenance/${created.body.id}`), {
      notes: 'x',
      version: created.body.version,
    });
    expect(stale.status).toBe(409);
    const elsewhere = await property('Elsewhere');
    const wrongUnit = await c.post(url('/maintenance'), {
      propertyId: p.id,
      unitId: elsewhere.units[0].id,
      issue: 'Wrong',
      reportedOn: today,
    });
    expect(wrongUnit.status).toBe(422);
    const list = (await c.get(url(`/maintenance?entityId=${rental}&propertyId=${p.id}`))).body.data;
    expect(list.map((m: any) => m.issue)).toEqual(expect.arrayContaining(['Leak under sink', 'Other']));
  });
});

describe('the forecast and calendar (RNT-04, RNT-08, RNT-12)', () => {
  it('shows rent, late rent, mortgage payments, lease ends and reminders', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Calendar Portfolio' })).body.id;
    await account('Calendar checking', entity);
    const next = startOfMonth(addDays(thisMonth, 32));
    const end = addDays(startOfMonth(addDays(next, 32)), -1);
    const { p } = await rented(
      'Calendar House',
      'Cal Endar',
      { startDate: lastMonth, rent: '111100', endDate: addDays(next, 10) },
      entity,
    );
    const loanAccount = await account('Calendar mortgage', entity, 'mortgage', '10000000');
    await c.post(url('/loans'), {
      propertyId: p.id,
      loanAccountId: loanAccount,
      name: 'Calendar mortgage',
      principal: '10000000',
      rateBps: 600,
      termMonths: 360,
      firstPaymentDate: next,
    });
    await c.post(url('/reminders'), {
      entityId: entity,
      propertyId: p.id,
      kind: 'inspection',
      title: 'Boiler inspection',
      dueDate: next,
    });
    const items = (await c.get(url(`/calendar?from=${lastMonth}&to=${end}&entityId=${entity}`))).body.items;
    const of = (kind: string) => items.filter((i: any) => i.kind === kind);
    expect(of('rent').map((i: any) => [i.date, i.amount, i.status])[0]).toEqual([
      lastMonth,
      '111100',
      'overdue',
    ]);
    expect(of('rent').find((i: any) => i.date === next)).toMatchObject({
      amount: '111100',
      status: 'upcoming',
    });
    expect(of('mortgage')[0]).toMatchObject({ date: next, amount: '-59955', name: 'Calendar mortgage' });
    expect(of('lease_end')[0]).toMatchObject({ date: addDays(next, 10), name: 'Calendar House · Main' });
    expect(of('reminder')[0]).toMatchObject({ date: next, name: 'Boiler inspection' });
    // Overdue rent stays on the month it was due, not every later one.
    const later = (await c.get(url(`/calendar?from=${next}&to=${end}&entityId=${entity}`))).body.items;
    expect(later.filter((i: any) => i.kind === 'rent').map((i: any) => i.date)).toEqual([next]);

    const forecast = (await c.get(url(`/flow/forecast?days=90&entityId=${entity}`))).body;
    const planned = forecast.accounts.flatMap((a: any) => a.items);
    const rentLines = planned.filter((i: any) => i.name === 'Calendar House · Main');
    expect(rentLines.some((i: any) => i.kind === 'rent' && i.amount === '111100')).toBe(true);
    expect(planned.some((i: any) => i.kind === 'mortgage' && i.name === 'Calendar mortgage')).toBe(true);
  });
});

describe('tax set-aside for a portfolio (REC-09)', () => {
  it('estimates on your share after depreciation, and notes it only when a rate is set', async () => {
    const entity = (await c.post(url('/entities'), { type: 'rental', name: 'Tax Portfolio' })).body.id;
    const acct = await account('Tax checking', entity);
    const savings = await account('Tax savings', entity, 'savings', '0');
    const p = await property('Tax House', { ownershipBps: 5000 }, entity);
    const t = await tenant('Tess Tax', entity);
    const l = await lease(p.units[0].id, [t.id], { startDate: thisMonth, rent: '1000000' });
    await pay(l.id, '1000000', today, acct);
    const none = (await c.get(url(`/tax/estimates?entityId=${entity}`))).body;
    expect(none).toMatchObject({ rateBps: null, target: '0' });
    // Half of 10,000.00.
    expect(none.ytdProfit).toBe('500000');

    const business = h.app.get(BusinessJobs);
    const notes = async () =>
      (await c.get(url('/recommendations?status=open'))).body.data.filter((r: any) => r.entityId === entity);
    await business.notes(ctx());
    expect(await notes()).toEqual([]);

    const set = await c.patch(url(`/businesses/${entity}`), {
      taxRateBps: 2000,
      defaultDepositAccountId: acct,
      taxSavingsAccountId: savings,
    });
    expect(set.status).toBe(200);
    const est = (await c.get(url(`/tax/estimates?entityId=${entity}`))).body;
    expect(est).toMatchObject({ rateBps: 2000, target: '100000', toSetAside: '100000' });
    await business.notes(ctx());
    const [note] = await notes();
    expect(note.title).toBe("Set aside for Tax Portfolio's taxes");
    const accepted = await c.post(url(`/recommendations/${note.id}/accept`), {});
    expect(accepted.status).toBe(200);
    expect(await balance(savings)).toBe('100000');
    expect((await c.get(url(`/tax/estimates?entityId=${entity}`))).body.toSetAside).toBe('0');

    // Depreciation lowers it, as it does on Schedule E: half of a year's 10,000.00 so far, at most.
    await c.post(url('/depreciation'), {
      propertyId: p.id,
      name: 'Building',
      basis: '27500000',
      inServiceDate: `${year - 1}-01-15`,
      method: 'SL_27_5',
    });
    const lower = (await c.get(url(`/tax/estimates?entityId=${entity}`))).body;
    expect(BigInt(lower.ytdProfit)).toBeLessThanOrEqual(500000n);
  });

  it('is not offered on personal books', async () => {
    expect((await c.get(url(`/tax/estimates?entityId=${personal}`))).status).toBe(422);
  });
});
