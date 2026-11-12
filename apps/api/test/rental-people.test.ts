/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, startOfMonth, todayIn } from '@montra/domain';
import { RentalJobs } from '../src/rentals/rental-jobs.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Tenant details, the people on a lease, lease set-up costs and property contacts (RNT-17..21; ADR-0038).
// Made-up people and numbers only.
const today = todayIn('UTC');
const year = Number(today.slice(0, 4));
const thisMonth = startOfMonth(today);
const lastMonth = startOfMonth(addDays(thisMonth, -1));
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'rental-people@example.test';
const PARTNER = 'rental-people-partner@example.test';

let h: Harness;
let c: Client;
let partner: Client;
let jobs: RentalJobs;
let admin: pg.Client;
let url: (p: string) => string;
let wsId: string;
let userId: string;
let rental: string;
let checking: string;
let cat: (name: string, entity?: string) => string;
const ctx = () => ({ workspaceId: wsId, userId });

const property = async (name: string, entityId = rental) => {
  const res = await c.post(url('/properties'), { entityId, name, type: 'sfh' });
  expect(res.status).toBe(201);
  return res.body;
};
const tenant = async (name: string, over: object = {}, entityId = rental) => {
  const res = await c.post(url('/tenants'), { entityId, name, ...over });
  expect(res.status).toBe(201);
  return res.body;
};
const lease = async (unitId: string, tenantIds: string[], over: object = {}) => {
  const res = await c.post(url('/leases'), {
    unitId,
    tenantIds,
    startDate: lastMonth,
    rent: '180000',
    dueDay: 1,
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body;
};
const contact = async (role: string, companyName: string, over: object = {}, entityId = rental) => {
  const res = await c.post(url('/rental-contacts'), { entityId, role, companyName, ...over });
  expect(res.status).toBe(201);
  return res.body;
};
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

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  jobs = h.app.get(RentalJobs);
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'People', baseCurrency: 'USD', template: 'landlord' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await c.get(url('/entities'))).body.data;
  rental = entities.find((e: any) => e.type === 'rental').id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'People checking',
      kind: 'checking',
      openingBalance: usd('1000000'),
      openingDate: `${year - 2}-12-01`,
      entityId: rental,
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name, entity = rental) => cats.find((x: any) => x.name === name && x.entityId === entity).id;
  userId = (await admin.query(`select id from app.app_user where email = $1`, [EMAIL])).rows[0].id;
  // A partner with no grant on the portfolio.
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('tenant details (RNT-17)', () => {
  it('keeps the details, seals the date of birth and shows it only on a logged reveal', async () => {
    const t = await tenant('Rosa Delgado', {
      email: 'rosa@example.test',
      phone: '555-0100',
      phoneAlt: '555-0101',
      mailingAddress: '12 Elm St, Springfield',
      dateOfBirth: '1990-04-02',
      emergencyName: 'Luis Delgado',
      emergencyRelationship: 'Brother',
      emergencyPhone: '555-0199',
      employer: 'Springfield Clinic',
      monthlyIncome: '650000',
      vehicle: 'Blue Civic, 7ABC123',
    });
    expect(t).toMatchObject({
      phoneAlt: '555-0101',
      mailingAddress: '12 Elm St, Springfield',
      hasDateOfBirth: true,
      emergencyName: 'Luis Delgado',
      emergencyRelationship: 'Brother',
      emergencyPhone: '555-0199',
      employer: 'Springfield Clinic',
      monthlyIncome: '650000',
      vehicle: 'Blue Civic, 7ABC123',
      current: null,
    });
    // The date never travels in a read, and isn't stored in the clear.
    const listed = (await c.get(url(`/tenants?entityId=${rental}`))).body.data;
    expect(JSON.stringify(listed)).not.toContain('1990-04-02');
    expect(JSON.stringify((await c.get(url(`/tenants/${t.id}`))).body)).not.toContain('1990-04-02');
    const raw = (await admin.query(`select birth_date_enc from app.tenant where id = $1`, [t.id])).rows[0];
    expect(Buffer.from(raw.birth_date_enc).toString('latin1')).not.toContain('1990-04-02');
    // No column for an SSN.
    const cols = await admin.query(
      `select column_name from information_schema.columns where table_schema = 'app' and table_name = 'tenant'`,
    );
    expect(cols.rows.map((r: any) => r.column_name).filter((n: string) => /ssn|tin/.test(n))).toEqual([]);

    const shown = await c.post(url(`/tenants/${t.id}/reveal`), {});
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ dateOfBirth: '1990-04-02' });
    const log = await admin.query(
      `select subject_type, subject_id from app.audit_log where workspace_id = $1 and action = 'rental.revealed'`,
      [wsId],
    );
    expect(log.rows).toContainEqual({ subject_type: 'tenant', subject_id: t.id });

    // Editing other fields leaves it; clearing it clears it.
    const edited = await c.patch(url(`/tenants/${t.id}`), {
      employer: 'Shelbyville Clinic',
      version: t.version,
    });
    expect(edited.body).toMatchObject({ employer: 'Shelbyville Clinic', hasDateOfBirth: true });
    const cleared = await c.patch(url(`/tenants/${t.id}`), {
      dateOfBirth: null,
      version: edited.body.version,
    });
    expect(cleared.body.hasDateOfBirth).toBe(false);
    expect((await c.post(url(`/tenants/${t.id}/reveal`), {})).body).toEqual({ dateOfBirth: null });
    // Income is money: minor units, never negative.
    expect(
      (await c.patch(url(`/tenants/${t.id}`), { monthlyIncome: '-1', version: cleared.body.version })).status,
    ).toBe(400);
  });

  it('shows where a tenant lives now, and their leases current first', async () => {
    const t = await tenant('Omar Haddad');
    const old = await property('Haddad Old Flat');
    const home = await property('Haddad House');
    const next = await property('Haddad Next');
    await lease(old.units[0].id, [t.id], { startDate: `${year - 2}-01-01`, endDate: `${year - 2}-12-31` });
    const current = await lease(home.units[0].id, [t.id], { startDate: `${year - 1}-01-01` });
    const upcoming = await lease(next.units[0].id, [t.id], { startDate: addDays(today, 40) });
    // Co-signing someone else's lease shows too, as a co-signer.
    const friend = await tenant('Friend of Omar');
    const elsewhere = await property('Friend Flat');
    const cosigned = await lease(elsewhere.units[0].id, [friend.id], {
      people: [{ role: 'cosigner', tenantId: t.id }],
    });

    const list = (await c.get(url(`/tenants?entityId=${rental}`))).body.data;
    expect(list.find((x: any) => x.id === t.id).current).toEqual({
      leaseId: current.id,
      propertyId: home.id,
      propertyName: 'Haddad House',
      unitId: home.units[0].id,
      unitLabel: 'Main',
    });
    const page = (await c.get(url(`/tenants/${t.id}`))).body;
    expect(page.leases.map((l: any) => [l.leaseId, l.role, l.status])).toEqual([
      [cosigned.id, 'cosigner', 'active'],
      [current.id, 'signer', 'active'],
      [upcoming.id, 'signer', 'upcoming'],
      [expect.any(String), 'signer', 'ended'],
    ]);
    expect(page.leases[1]).toMatchObject({ propertyName: 'Haddad House', unitLabel: 'Main', rent: '180000' });
    // Co-signing doesn't make it their home.
    expect(page.current.leaseId).toBe(current.id);
  });

  it('does not exist for a partner without access to the portfolio', async () => {
    const t = await tenant('Private Person', { dateOfBirth: '1985-01-01' });
    expect((await partner.get(url(`/tenants/${t.id}`))).status).toBe(404);
    expect((await partner.post(url(`/tenants/${t.id}/reveal`), {})).status).toBe(404);
  });
});

describe('people on a lease (RNT-18)', () => {
  it('keeps co-signers and occupants apart from the tenants who sign and pay', async () => {
    const p = await property('Roles House');
    const signer = await tenant('Grace Kim');
    const guarantor = await tenant('Daniel Okafor', { phone: '555-0142', email: 'daniel@example.test' });
    const l = await lease(p.units[0].id, [signer.id], {
      people: [
        { role: 'cosigner', tenantId: guarantor.id, relationship: 'Uncle' },
        { role: 'cosigner', name: 'Ava Stone', phone: '555-0177', email: 'ava@example.test' },
        { role: 'occupant', name: 'Mina Kim', relationship: 'Daughter', dateOfBirth: '2015-06-01' },
      ],
    });
    expect(l.tenants).toEqual([{ id: signer.id, name: 'Grace Kim' }]);
    expect(l.people.map((x: any) => [x.role, x.name, x.relationship])).toEqual([
      ['cosigner', 'Daniel Okafor', 'Uncle'],
      ['cosigner', 'Ava Stone', null],
      ['occupant', 'Mina Kim', 'Daughter'],
    ]);
    // A tenant co-signer's details come from the tenant record.
    expect(l.people[0]).toMatchObject({
      tenantId: guarantor.id,
      phone: '555-0142',
      email: 'daniel@example.test',
    });
    const occupant = l.people[2];
    expect(occupant.hasDateOfBirth).toBe(true);
    expect(JSON.stringify(l)).not.toContain('2015-06-01');
    expect((await c.post(url(`/lease-people/${occupant.id}/reveal`), {})).body).toEqual({
      dateOfBirth: '2015-06-01',
    });

    // Only the signer is a payer: the rent roll and arrears name only them.
    const roll = (await c.get(url(`/rent-roll?entityId=${rental}&month=${lastMonth}`))).body;
    expect(roll.rows.find((r: any) => r.leaseId === l.id).tenants).toEqual(['Grace Kim']);
    const arrears = (await c.get(url(`/arrears?entityId=${rental}`))).body;
    expect(arrears.rows.find((r: any) => r.leaseId === l.id).tenants).toEqual(['Grace Kim']);

    // A line naming the co-signer isn't rent from this lease.
    const line = await c.post(url('/transactions'), {
      date: today,
      accountId: checking,
      amount: usd('41234'),
      payee: 'ZELLE DANIEL OKAFOR',
      categoryId: cat('Other rental income'),
    });
    await jobs.matchPayments(ctx());
    const payments = (await c.get(url(`/leases/${l.id}/payments`))).body.data;
    expect(payments.map((x: any) => x.transactionId)).not.toContain(line.body.id);
    const keys = await admin.query(`select payee_keys from app.tenant where id = $1`, [guarantor.id]);
    expect(keys.rows[0].payee_keys).toEqual([]);
  });

  it('refuses a co-signer who also signs, an occupant who is a tenant, and a person twice', async () => {
    const p = await property('Rules House');
    const a = await tenant('Signer Sam');
    const b = await tenant('Cosigner Cal');
    const both = await c.post(url('/leases'), {
      unitId: p.units[0].id,
      tenantIds: [a.id],
      startDate: lastMonth,
      rent: '100000',
      people: [{ role: 'cosigner', tenantId: a.id }],
    });
    expect(both.status).toBe(422);
    expect(both.body.code).toBe('lease.person_is_signer');
    const occupantTenant = await c.post(url('/leases'), {
      unitId: p.units[0].id,
      tenantIds: [a.id],
      startDate: lastMonth,
      rent: '100000',
      people: [{ role: 'occupant', tenantId: b.id }],
    });
    expect(occupantTenant.status).toBe(400);
    const l = await lease(p.units[0].id, [a.id], { people: [{ role: 'cosigner', tenantId: b.id }] });
    const again = await c.post(url(`/leases/${l.id}/people`), { role: 'cosigner', tenantId: b.id });
    expect(again.body.code).toBe('lease.person_twice');
    // Making the co-signer sign too is refused.
    const signs = await c.patch(url(`/leases/${l.id}`), { tenantIds: [a.id, b.id], version: l.version });
    expect(signs.status).toBe(422);
    expect(signs.body.code).toBe('lease.person_is_signer');
    // The tenants alone can change, too.
    const c2 = await tenant('Second Signer');
    const both2 = await c.patch(url(`/leases/${l.id}`), { tenantIds: [a.id, c2.id], version: l.version });
    expect(both2.status).toBe(200);
    expect(both2.body.tenants.map((x: any) => x.name)).toEqual(['Second Signer', 'Signer Sam']);
    expect(both2.body.version).toBe(l.version + 1);

    // Added, edited and removed on the lease.
    const added = await c.post(url(`/leases/${l.id}/people`), {
      role: 'occupant',
      name: 'Pat',
      relationship: 'Partner',
    });
    expect(added.status).toBe(201);
    const pat = added.body.people.find((x: any) => x.name === 'Pat');
    const edited = await c.patch(url(`/lease-people/${pat.id}`), {
      relationship: 'Spouse',
      version: pat.version,
    });
    expect(edited.body.people.find((x: any) => x.id === pat.id).relationship).toBe('Spouse');
    expect((await c.delete(url(`/lease-people/${pat.id}`))).status).toBe(204);
    expect((await c.get(url(`/leases/${l.id}`))).body.people.map((x: any) => x.name)).toEqual([
      'Cosigner Cal',
    ]);
  });
});

describe('lease set-up costs (RNT-19)', () => {
  it('posts a broker fee to Commissions and legal fees to Legal & professional, tagged to the property', async () => {
    const p = await property('Fees House');
    const t = await tenant('Fee Tenant');
    const broker = await contact('broker', 'Bay Realty', { contactPerson: 'Jo Agent' });
    const lawyer = await contact('attorney', 'Lane & Lane');
    // The broker on a lease must be a broker.
    const wrong = await c.post(url('/leases'), {
      unitId: p.units[0].id,
      tenantIds: [t.id],
      startDate: lastMonth,
      rent: '200000',
      brokerContactId: lawyer.id,
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('lease.broker');
    const l = await lease(p.units[0].id, [t.id], { rent: '200000', brokerContactId: broker.id });
    expect(l).toMatchObject({ brokerContactId: broker.id, brokerName: 'Bay Realty', costs: [] });

    // A broker's fee paid from the account.
    const withFee = await c.post(url(`/leases/${l.id}/costs`), {
      kind: 'broker_fee',
      contactId: broker.id,
      accountId: checking,
      date: lastMonth,
      amount: '200000',
    });
    expect(withFee.status).toBe(201);
    const fee = withFee.body.costs[0];
    expect(fee).toMatchObject({
      kind: 'broker_fee',
      amount: '200000',
      date: lastMonth,
      contactName: 'Bay Realty',
    });
    expect(await postings(fee.transactionId)).toContainEqual({
      name: 'Commissions',
      amount: '200000',
      property_id: p.id,
      unit_id: p.units[0].id,
    });
    const txn = (await c.get(url(`/transactions/${fee.transactionId}`))).body;
    expect(txn).toMatchObject({ managedBy: 'lease', payee: 'Bay Realty' });
    expect(
      (await c.patch(url(`/transactions/${fee.transactionId}`), { categoryId: cat('Repairs') })).status,
    ).toBe(422);

    // Legal fees from a bank line already in the books.
    const line = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('-45000'),
        payee: 'LANE AND LANE LLP',
        categoryId: cat('Repairs'),
      })
    ).body;
    const withLegal = await c.post(url(`/leases/${l.id}/costs`), {
      kind: 'legal_fee',
      contactId: lawyer.id,
      transactionId: line.id,
      notes: 'Lease review',
    });
    expect(withLegal.status).toBe(201);
    const legal = withLegal.body.costs.find((x: any) => x.kind === 'legal_fee');
    expect(legal).toMatchObject({
      amount: '45000',
      date: today,
      transactionId: line.id,
      notes: 'Lease review',
    });
    expect(await postings(line.id)).toContainEqual({
      name: 'Legal & professional',
      amount: '45000',
      property_id: p.id,
      unit_id: p.units[0].id,
    });
    // Money in can't be a fee.
    const income = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('5000'),
        payee: 'REFUND',
        categoryId: cat('Other rental income'),
      })
    ).body;
    expect(
      (await c.post(url(`/leases/${l.id}/costs`), { kind: 'legal_fee', transactionId: income.id })).body.code,
    ).toBe('payment.wrong_direction');

    // On Schedule E, lines 8 and 10 of this property.
    const s = (
      await c.get(url(`/reports/schedule-e?entityId=${rental}&year=${Number(lastMonth.slice(0, 4))}`))
    ).body;
    const house = s.properties.find((x: any) => x.propertyId === p.id);
    const onLine = (code: string) => house.lines.find((x: any) => x.code === code)?.amount;
    expect(onLine('US_SCH_E_L8')).toBe('200000');
    if (lastMonth.slice(0, 4) === today.slice(0, 4)) expect(onLine('US_SCH_E_L10')).toBe('45000');

    // Removing gives the bank line back as it was, and voids the one the fee created.
    expect((await c.delete(url(`/leases/${l.id}/costs/${legal.id}`))).status).toBe(204);
    const back = (await c.get(url(`/transactions/${line.id}`))).body;
    expect(back).toMatchObject({ managedBy: null });
    expect(back.splits[0].accountId).toBe(cat('Repairs'));
    expect((await c.delete(url(`/leases/${l.id}/costs/${fee.id}`))).status).toBe(204);
    const voided = await admin.query(`select status from app.transaction where id = $1`, [fee.transactionId]);
    expect(voided.rows[0].status).toBe('void');
    expect((await c.get(url(`/leases/${l.id}`))).body.costs).toEqual([]);
  });
});

describe('HOA dues and home warranty (RNT-20)', () => {
  it('are on Schedule E line 19 in new books, and added once to existing ones', async () => {
    const cats = (await c.get(url('/categories'))).body.data.filter((x: any) => x.entityId === rental);
    expect(cats.find((x: any) => x.name === 'HOA dues')).toMatchObject({ taxLineCode: 'US_SCH_E_L19' });
    expect(cats.find((x: any) => x.name === 'Home warranty')).toMatchObject({ taxLineCode: 'US_SCH_E_L19' });
    // Books made from the template already have them: nothing to add.
    const add = async (entityId: string) =>
      (await admin.query(`select app.add_rental_categories($1, $2) as n`, [wsId, entityId])).rows[0]
        .n as number;
    expect(await add(rental)).toBe(0);

    // Books from before: neither category, and one the owner made as "hoa Dues".
    const older = (await c.post(url('/entities'), { type: 'rental', name: 'Older Portfolio' })).body.id;
    await admin.query(
      `delete from app.ledger_account where entity_id = $1 and name in ('HOA dues', 'Home warranty')`,
      [older],
    );
    await admin.query(
      `insert into app.ledger_account (workspace_id, entity_id, type, subtype, name, currency, is_category)
       values ($1, $2, 'expense', 'category', 'hoa Dues', 'USD', true)`,
      [wsId, older],
    );
    expect(await add(older)).toBe(1);
    expect(await add(older)).toBe(0);
    const after = await admin.query(
      `select a.name, a.tax_line_code, g.kind from app.ledger_account a
         left join app.category_group g on g.id = a.category_group_id
        where a.entity_id = $1 and lower(a.name) in ('hoa dues', 'home warranty') order by a.name`,
      [older],
    );
    expect(after.rows).toEqual([
      { name: 'hoa Dues', tax_line_code: null, kind: null },
      { name: 'Home warranty', tax_line_code: 'US_SCH_E_L19', kind: 'rental' },
    ]);
    // Only rental books get them.
    const personal = (await c.get(url('/entities'))).body.data.find((e: any) => e.type === 'personal').id;
    expect(await add(personal)).toBe(0);
  });

  it('files HOA dues tagged to a property on line 19', async () => {
    const p = await property('Condo With HOA');
    const res = await c.post(url('/transactions'), {
      date: today,
      accountId: checking,
      amount: usd('-32000'),
      payee: 'SUNNY ACRES HOA',
      categoryId: cat('HOA dues'),
      propertyId: p.id,
    });
    expect(res.status).toBe(201);
    const s = (await c.get(url(`/reports/schedule-e?entityId=${rental}&year=${year}`))).body;
    const condo = s.properties.find((x: any) => x.propertyId === p.id);
    expect(condo.lines.find((x: any) => x.code === 'US_SCH_E_L19')).toMatchObject({ amount: '32000' });
    expect(s.unmapped).toEqual([]);
  });
});

describe('property contacts (RNT-21)', () => {
  it('keeps one contact for several properties, and edits and removes it', async () => {
    const a = await property('Contact House A');
    const b = await property('Contact House B');
    const insurer = await contact('insurance', 'Acme Mutual', {
      contactPerson: 'Lee Broker',
      website: 'acme-mutual.example',
      email: 'claims@acme-mutual.example',
      phone: '800-555-0100',
      accountNumber: 'POL-778812',
      notes: 'Renews in March',
      propertyIds: [a.id, b.id],
    });
    expect(insurer).toMatchObject({ role: 'insurance', accountNumber: 'POL-778812', archived: false });
    expect([...insurer.propertyIds].sort()).toEqual([a.id, b.id].sort());
    const power = await contact('electricity', 'City Power', { phone: '800-555-0123', propertyIds: [a.id] });
    const forA = (await c.get(url(`/rental-contacts?entityId=${rental}&propertyId=${a.id}`))).body.data;
    expect(forA.map((x: any) => x.companyName).sort()).toEqual(['Acme Mutual', 'City Power']);
    const forB = (await c.get(url(`/rental-contacts?entityId=${rental}&propertyId=${b.id}`))).body.data;
    expect(forB.map((x: any) => x.companyName)).toEqual(['Acme Mutual']);
    const brokers = (await c.get(url(`/rental-contacts?entityId=${rental}&role=electricity`))).body.data;
    expect(brokers.map((x: any) => x.id)).toContain(power.id);

    // A web address with any scheme but http or https is refused.
    expect(
      (
        await c.post(url('/rental-contacts'), {
          entityId: rental,
          role: 'other',
          companyName: 'X',
          website: 'javascript:alert(1)',
        })
      ).status,
    ).toBe(400);
    expect(
      (await c.post(url('/rental-contacts'), { entityId: rental, role: 'nope', companyName: 'X' })).status,
    ).toBe(400);
    // Properties of other books aren't linked.
    const other = (await c.post(url('/entities'), { type: 'rental', name: 'Other Books' })).body.id;
    const foreign = await property('Foreign House', other);
    const refused = await c.post(url('/rental-contacts'), {
      entityId: rental,
      role: 'gas',
      companyName: 'Gas Co',
      propertyIds: [foreign.id],
    });
    expect(refused.body.code).toBe('rental.contact_property');

    const moved = await c.patch(url(`/rental-contacts/${insurer.id}`), {
      propertyIds: [b.id],
      phone: '800-555-0199',
      version: insurer.version,
    });
    expect(moved.body).toMatchObject({ propertyIds: [b.id], phone: '800-555-0199' });
    expect(
      (await c.patch(url(`/rental-contacts/${insurer.id}`), { notes: 'x', version: insurer.version })).status,
    ).toBe(409);
    const archived = await c.patch(url(`/rental-contacts/${insurer.id}`), {
      archived: true,
      version: moved.body.version,
    });
    expect(archived.body.archived).toBe(true);
    expect(
      (await c.get(url(`/rental-contacts?entityId=${rental}`))).body.data.map((x: any) => x.id),
    ).not.toContain(insurer.id);
    expect(
      (await c.get(url(`/rental-contacts?entityId=${rental}&archived=true`))).body.data.map((x: any) => x.id),
    ).toContain(insurer.id);

    // Nobody without access to the portfolio sees its contacts.
    expect((await partner.get(url(`/rental-contacts?entityId=${rental}`))).status).toBe(404);
    expect(
      (await partner.patch(url(`/rental-contacts/${power.id}`), { notes: 'x', version: power.version }))
        .status,
    ).toBe(404);
    expect((await c.delete(url(`/rental-contacts/${insurer.id}`))).status).toBe(204);
    expect(
      (await c.get(url(`/rental-contacts?entityId=${rental}&archived=true`))).body.data.map((x: any) => x.id),
    ).not.toContain(insurer.id);
  });

  it('names a contact as the maintenance vendor, and keeps the name when the contact goes', async () => {
    const p = await property('Leaky House');
    const plumber = await contact('handyman', 'Pipe Pros', { propertyIds: [p.id] });
    const res = await c.post(url('/maintenance'), {
      propertyId: p.id,
      issue: 'Kitchen leak',
      contactId: plumber.id,
      reportedOn: today,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ contactId: plumber.id, contactName: 'Pipe Pros', vendor: null });
    // Free text still works, and so does switching.
    const other = await c.post(url('/maintenance'), {
      propertyId: p.id,
      issue: 'Gutter',
      vendor: 'Neighbor Bob',
      reportedOn: today,
    });
    expect(other.body).toMatchObject({ contactId: null, vendor: 'Neighbor Bob' });
    // A contact of other books is refused.
    const elsewhere = (await c.post(url('/entities'), { type: 'rental', name: 'Elsewhere Books' })).body.id;
    const stranger = await contact('handyman', 'Stranger Fixes', {}, elsewhere);
    expect(
      (
        await c.patch(url(`/maintenance/${other.body.id}`), {
          contactId: stranger.id,
          version: other.body.version,
        })
      ).body.code,
    ).toBe('rental.contact');

    expect((await c.delete(url(`/rental-contacts/${plumber.id}`))).status).toBe(204);
    const list = (await c.get(url(`/maintenance?entityId=${rental}&propertyId=${p.id}`))).body.data;
    expect(list.find((x: any) => x.id === res.body.id)).toMatchObject({
      contactId: null,
      contactName: null,
      vendor: 'Pipe Pros',
    });
  });

  it('clears a deleted broker from its lease', async () => {
    const p = await property('Broker Gone House');
    const t = await tenant('Broker Gone Tenant');
    const broker = await contact('broker', 'Gone Realty');
    const l = await lease(p.units[0].id, [t.id], { brokerContactId: broker.id });
    expect((await c.delete(url(`/rental-contacts/${broker.id}`))).status).toBe(204);
    expect((await c.get(url(`/leases/${l.id}`))).body).toMatchObject({
      brokerContactId: null,
      brokerName: null,
    });
  });
});
