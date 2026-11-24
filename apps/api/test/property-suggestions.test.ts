/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { Worker } from '../src/jobs/queue.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// AI-02: the rental property and unit suggested for a line, in the pipeline's order, and learned per payee.
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'property-suggest@example.com';

let h: Harness;
let c: Client;
let admin: pg.Client;
let worker: Worker;
let url: (p: string) => string;
let wsId: string;
let rental: string;
let checking: string;
let cat: (name: string) => string;
let elm: any;
let oak: any;
let unit2b: string;

const upload = async (fileName: string, text: string) => {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/uploads`,
    headers: {
      authorization: `Bearer dev:${EMAIL}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
      Buffer.from(text),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  return JSON.parse(res.body);
};
const entry = async (body: object) => {
  const res = await c.post(url('/transactions'), { date: today, accountId: checking, ...body });
  expect(res.status).toBe(201);
  return res.body;
};
/** The property and unit on each of a transaction's category postings. */
const tags = async (transactionId: string) =>
  (
    await admin.query(
      `select p.property_id, p.unit_id
         from app.posting p join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
         join app.ledger_account a on a.id = p.ledger_account_id
        where je.transaction_id = $1 and (a.is_category or a.system_role like 'uncategorized%')`,
      [transactionId],
    )
  ).rows.map((r) => [r.property_id, r.unit_id]);
const learned = async (payeeKey: string) =>
  (
    await admin.query(
      `select property_id, unit_id, count from app.payee_property
        where workspace_id = $1 and payee_key = $2 and count > 0 order by property_id, unit_id`,
      [wsId, payeeKey],
    )
  ).rows.map((r) => [r.property_id, r.unit_id, r.count]);
const reviewItem = async (transactionId: string) =>
  (await c.get(url('/review?limit=500'))).body.items.find((i: any) => i.transactionId === transactionId);

beforeAll(async () => {
  h = await startHarness({
    AI_PROVIDER: 'fake',
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
  });
  h.app.get(ImportJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Two houses', baseCurrency: 'USD', template: 'landlord' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  rental = (await c.get(url('/entities'))).body.data.find((e: any) => e.type === 'rental').id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Rental checking',
      kind: 'checking',
      openingBalance: usd('1000000'),
      openingDate: addDays(today, -60),
      entityId: rental,
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === rental).id;
  elm = (
    await c.post(url('/properties'), {
      entityId: rental,
      name: 'Elm duplex',
      address: '12 Elm Street, Austin, TX',
      type: 'multi_family',
      units: [{ label: '1A' }, { label: '2B' }],
    })
  ).body;
  unit2b = elm.units.find((u: any) => u.label === '2B').id;
  oak = (
    await c.post(url('/properties'), {
      entityId: rental,
      name: 'Oak cottage',
      address: '40 Oak Ave, Austin, TX',
      type: 'sfh',
    })
  ).body;
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('property and unit suggestions (AI-02)', () => {
  it('suggests the property a payee was learned for, and applies it once the history is strong', async () => {
    // Bob works at Elm: two lines filed there by hand.
    for (let i = 0; i < 2; i++)
      await entry({
        amount: usd('-12000'),
        payee: 'Bob Handyman',
        categoryId: cat('Repairs'),
        propertyId: elm.id,
      });
    expect(await learned('BOB HANDYMAN')).toEqual([[elm.id, null, 2]]);

    // Two lines aren't enough to apply it: Review offers Elm.
    const weak = await entry({ amount: usd('-9000'), payee: 'Bob Handyman' });
    expect(weak.reviewState).toBe('needs_review');
    expect(await tags(weak.id)).toEqual([[null, null]]);
    const offered = await reviewItem(weak.id);
    expect(offered.propertyId).toBeNull();
    expect(offered.categorization.property).toMatchObject({
      propertyId: elm.id,
      unitId: null,
      label: 'Elm duplex',
      step: 'history',
      applied: false,
    });
    expect(offered.categorization.property.explanation).toBe('Like 2 past transactions at Elm duplex');

    // Accepting it puts Elm on the line and counts once more for Bob.
    const accepted = await c.post(url('/review/accept'), { transactionIds: [weak.id] });
    expect(accepted.body).toMatchObject({ accepted: 1 });
    expect(await tags(weak.id)).toEqual([[elm.id, null]]);
    expect(await learned('BOB HANDYMAN')).toEqual([[elm.id, null, 3]]);

    // With five, the history is sure enough to apply on its own.
    for (let i = 0; i < 2; i++)
      await entry({
        amount: usd('-12000'),
        payee: 'Bob Handyman',
        categoryId: cat('Repairs'),
        propertyId: elm.id,
      });
    const sure = await entry({ amount: usd('-9000'), payee: 'Bob Handyman' });
    expect(await tags(sure.id)).toEqual([[elm.id, null]]);
    expect(sure.categorization.property).toMatchObject({
      propertyId: elm.id,
      step: 'history',
      applied: true,
    });
  });

  it('picks the property and the unit from an address and a unit number in the description', async () => {
    const t = await entry({
      amount: usd('-15000'),
      payee: 'Ace Locksmith',
      description: 'ACE LOCKSMITH 12 ELM ST APT 2B AUSTIN',
    });
    expect(t.categorization.property).toMatchObject({
      propertyId: elm.id,
      unitId: unit2b,
      label: 'Elm duplex, 2B',
      step: 'text',
      confidence: 0.9,
      applied: true,
    });
    expect(await tags(t.id)).toEqual([[elm.id, unit2b]]);
  });

  it('asks AI (the fake provider) when nothing else knows, with no address sent', async () => {
    const t = await entry({
      amount: usd('-30000'),
      payee: 'Gutter Pros',
      description: 'GUTTER PROS COTTAGE JOB',
    });
    expect(t.categorization.property).toMatchObject({ propertyId: oak.id, step: 'ai', applied: true });
    expect(await tags(t.id)).toEqual([[oak.id, null]]);
    const sent = await admin.query(
      `select count(*)::int as n from app.ai_event where workspace_id = $1 and task = 'suggest_property'`,
      [wsId],
    );
    expect(sent.rows[0].n).toBeGreaterThan(0);
  });

  it('suggests on import rows too, and a category with a property only suggested waits in Review', async () => {
    const rule = await c.post(url('/rules'), {
      name: 'Acme → Repairs',
      conditions: { all: [{ field: 'description', op: 'contains', value: 'acme gutters', ci: true }] },
      actions: { categoryId: cat('Repairs') },
    });
    expect(rule.status).toBe(201);
    await c.patch(url('/ai/settings'), { propertyThreshold: 0.85 });
    const day = `${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)}`;
    const csv = [
      'Date,Description,Amount',
      `${day},ACME GUTTERS 40 OAK AVE,-82.10`,
      `${day},ACME GUTTERS APT 1A,-61.00`,
    ].join('\n');
    const file = await upload('rental.csv', csv);
    const batch = (await c.post(url('/imports'), { fileId: file.fileId, accountId: checking })).body;
    await worker.drain(['import', 'ai']);
    await c.post(url(`/imports/${batch.id}/commit`));
    await worker.drain(['import', 'ai']);
    const txns = (await c.get(url('/transactions?limit=200'))).body.data as any[];
    const byDesc = (d: string) => txns.find((t) => t.description === d);
    // The address is sure enough: category and property both applied.
    const oakLine = byDesc('ACME GUTTERS 40 OAK AVE');
    expect(oakLine.reviewState).toBe('auto_applied');
    expect(oakLine.categorization.property).toMatchObject({
      propertyId: oak.id,
      step: 'text',
      applied: true,
    });
    expect(await tags(oakLine.id)).toEqual([[oak.id, null]]);
    // A unit on its own is less sure: the category is applied, and the line waits in Review for its property.
    const unitLine = byDesc('ACME GUTTERS APT 1A');
    const unit1a = elm.units.find((u: any) => u.label === '1A').id;
    expect(unitLine.reviewState).toBe('needs_review');
    expect(unitLine.categorization.property).toMatchObject({
      propertyId: elm.id,
      unitId: unit1a,
      step: 'text',
      confidence: 0.8,
      applied: false,
    });
    expect(await tags(unitLine.id)).toEqual([[null, null]]);
    const item = await reviewItem(unitLine.id);
    expect(item).toMatchObject({ categoryId: cat('Repairs'), propertyId: null, unitId: null });
    await c.post(url('/review/accept'), { transactionIds: [unitLine.id] });
    expect(await tags(unitLine.id)).toEqual([[elm.id, unit1a]]);
    await c.patch(url('/ai/settings'), { propertyThreshold: 0.8 });
  });

  it('never overrides a property someone set, or a lease that took the line', async () => {
    // Set by hand with the entry: the address in the text doesn't move it.
    const mine = await entry({
      amount: usd('-5000'),
      payee: 'Ace Locksmith',
      description: 'ACE LOCKSMITH 12 ELM ST APT 2B',
      propertyId: oak.id,
    });
    expect(mine.categorization?.property ?? null).toBeNull();
    expect(await tags(mine.id)).toEqual([[oak.id, null]]);

    // Rent that names Elm in its text, offered for Elm in Review; then recorded as rent for Oak's lease.
    const tenant = (await c.post(url('/tenants'), { entityId: rental, name: 'Zed Tenant' })).body;
    const lease = (
      await c.post(url('/leases'), {
        unitId: oak.units[0].id,
        tenantIds: [tenant.id],
        startDate: addDays(today, -40),
        rent: '150000',
        dueDay: 1,
      })
    ).body;
    await c.patch(url('/ai/settings'), { propertyThreshold: 0.99 });
    const rent = await entry({
      amount: usd('150000'),
      payee: 'Zelle Zed',
      description: 'ZELLE ZED 12 ELM ST',
    });
    expect(rent.categorization.property).toMatchObject({ propertyId: elm.id, applied: false });
    const linked = await c.post(url(`/leases/${lease.id}/payments`), { transactionId: rent.id });
    expect(linked.status).toBe(201);
    await c.post(url('/review/accept'), { transactionIds: [rent.id] });
    const rentTags = await tags(rent.id);
    expect(rentTags.length).toBeGreaterThan(0);
    expect(rentTags.every(([p]) => p === oak.id)).toBe(true);
    await c.patch(url('/ai/settings'), { propertyThreshold: 0.8 });
  });

  it('learns a correction for the payee: the next line is no longer sure of the old property', async () => {
    await c.patch(url('/ai/settings'), { propertyThreshold: 0.99 });
    const one = await entry({
      amount: usd('-4000'),
      payee: 'Pat Painter',
      description: 'PAT PAINTER 12 ELM ST',
    });
    expect(one.categorization.property).toMatchObject({ propertyId: elm.id, applied: false });
    // The person says it was Oak: a correction.
    const resolved = await c.post(url(`/review/${one.id}/resolve`), {
      categoryId: cat('Repairs'),
      propertyId: oak.id,
    });
    expect(resolved.status).toBe(200);
    expect(await tags(one.id)).toEqual([[oak.id, null]]);
    expect(await learned('PAT PAINTER')).toEqual([[oak.id, null, 1]]);
    const again = (await c.get(url(`/transactions/${one.id}`))).body;
    expect(again.categorization.property).toMatchObject({ propertyId: elm.id, applied: false });

    // Once more by hand, and the payee's next line is offered Oak from its history.
    await c.patch(url('/ai/settings'), { propertyThreshold: 0.8 });
    await entry({
      amount: usd('-4000'),
      payee: 'Pat Painter',
      categoryId: cat('Repairs'),
      propertyId: oak.id,
    });
    expect(await learned('PAT PAINTER')).toEqual([[oak.id, null, 2]]);
    const three = await entry({ amount: usd('-4000'), payee: 'Pat Painter', description: 'PAT PAINTER' });
    expect(three.categorization.property).toMatchObject({
      propertyId: oak.id,
      step: 'history',
      applied: false,
    });

    // Choosing a property on the transaction counts it for the payee.
    const edited = await c.patch(url(`/transactions/${three.id}`), { propertyId: elm.id, unitId: unit2b });
    expect(edited.status).toBe(200);
    expect(await tags(three.id)).toEqual([[elm.id, unit2b]]);
    const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
    expect(sorted(await learned('PAT PAINTER'))).toEqual(
      sorted([
        [elm.id, unit2b, 1],
        [oak.id, null, 2],
      ]),
    );
  });

  it('keeps the threshold as a setting', async () => {
    const s = (await c.get(url('/ai/settings'))).body;
    expect(s.propertyThreshold).toBe(0.8);
    const bad = await c.patch(url('/ai/settings'), { propertyThreshold: 1.5 });
    expect(bad.status).toBe(400);
  });
});
