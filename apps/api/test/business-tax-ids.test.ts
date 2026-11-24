import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TaxIdSealing } from '../src/business/tax-ids.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// A business's tax account numbers sealed at rest (BIZ-26, migration 0089). Made-up numbers only.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const EMAIL = 'biz-tax-ids@example.test';
const PARTNER = 'biz-tax-ids-partner@example.test';

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let wsId: string;
let url: (p: string) => string;
let biz: string;

const business = async (id = biz) => (await c.get(url(`/businesses/${id}`))).body;
const stored = async (id = biz) =>
  (
    await admin.query(
      `select ein, ein_enc, ein_last4, ftb_entity_id, ftb_entity_id_enc, ftb_entity_id_last4,
              ca_employer_account, ca_employer_account_enc, ca_employer_account_last4,
              cdtfa_permit, cdtfa_permit_enc, cdtfa_permit_last4
         from app.business_profile where entity_id = $1`,
      [id],
    )
  ).rows[0];
const auditText = async () =>
  JSON.stringify(
    (await admin.query(`select action, diff from app.audit_log where workspace_id = $1`, [wsId])).rows,
  );
const reveal = (field: string, id = biz) => c.post(url(`/businesses/${id}/reveal`), { field });

/** The sign-in is 30 minutes old by the time the API looks (AUTH-09). */
async function stale<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

const makeBusiness = async (name: string) =>
  (await c.post(url('/entities'), { type: 'business', name, businessType: 'sole_prop' })).body.id as string;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Sealed numbers', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = await makeBusiness('Cove Candles');
  const invite = await c.post(url('/sharing/invites'), {
    email: PARTNER,
    role: 'partner',
    entityGrants: [{ entityId: biz, access: 'write' }],
  });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.query(`delete from app.job where workspace_id is null and type = 'business.seal_tax_ids'`);
  await admin.end();
  await h.close();
});

describe('writes seal the numbers (BIZ-26)', () => {
  it('stores each number sealed with its last four, and nothing in plain text', async () => {
    const res = await c.patch(url(`/businesses/${biz}`), {
      ein: '12-3456789',
      ftbEntityId: '7654321',
      caEmployerAccount: '123-4567-8',
      cdtfaPermit: '102-345678',
    });
    expect(res.status).toBe(200);
    const row = await stored();
    expect(row).toMatchObject({
      ein: null,
      ein_last4: '6789',
      ftb_entity_id: null,
      ftb_entity_id_last4: '4321',
      ca_employer_account: null,
      ca_employer_account_last4: '5678',
      cdtfa_permit: null,
      cdtfa_permit_last4: '5678',
    });
    for (const [column, full] of [
      ['ein_enc', '123456789'],
      ['ftb_entity_id_enc', '7654321'],
      ['ca_employer_account_enc', '12345678'],
      ['cdtfa_permit_enc', '102-345678'],
    ] as const) {
      expect(Buffer.isBuffer(row[column])).toBe(true);
      expect(row[column].includes(Buffer.from(full))).toBe(false);
    }
  });

  it('reads back masked to the last four, on the business and in payroll', async () => {
    expect((await business()).registrations).toMatchObject({
      einMasked: '••-•••6789',
      ftbEntityIdMasked: '••••4321',
      caEmployerAccountMasked: '••••5678',
      cdtfaPermitMasked: '••••5678',
    });
    expect((await c.get(url(`/payroll/settings?entityId=${biz}`))).body).toMatchObject({
      einMasked: '••-•••6789',
      caEmployerAccountMasked: '••••5678',
    });
  });

  it('changes and clears a number', async () => {
    await c.patch(url(`/businesses/${biz}`), { cdtfaPermit: '999-888777' });
    expect((await stored()).cdtfa_permit_last4).toBe('8777');
    await c.patch(url(`/businesses/${biz}`), { cdtfaPermit: null });
    expect(await stored()).toMatchObject({
      cdtfa_permit: null,
      cdtfa_permit_enc: null,
      cdtfa_permit_last4: null,
    });
    expect((await business()).registrations.cdtfaPermitMasked).toBeNull();
    // Leaving a number out of a change leaves it as it was.
    await c.patch(url(`/businesses/${biz}`), { irsName: 'COVE CANDLES', cdtfaPermit: '102-345678' });
    expect((await stored()).ein_last4).toBe('6789');
  });
});

describe('Show (BIZ-26)', () => {
  it('unseals one number after a recent sign-in, and logs which', async () => {
    const before = Number(
      (
        await admin.query(
          `select count(*) from app.audit_log where workspace_id = $1 and action = 'business.revealed'`,
          [wsId],
        )
      ).rows[0].count,
    );
    const refused = await stale(() => reveal('ein'));
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('reauth.required');
    expect(JSON.stringify(refused.body)).not.toContain('3456789');

    for (const [field, value] of [
      ['ein', '123456789'],
      ['ftbEntityId', '7654321'],
      ['caEmployerAccount', '12345678'],
      ['cdtfaPermit', '102-345678'],
    ]) {
      const res = await reveal(field!);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ field, value });
    }
    const { rows } = await admin.query(
      `select actor_user_id is not null as by_someone, diff from app.audit_log
        where workspace_id = $1 and action = 'business.revealed' order by id`,
      [wsId],
    );
    expect(rows.length - before).toBe(4);
    expect(rows.slice(before).map((r) => r.diff.field)).toEqual([
      'ein',
      'ftbEntityId',
      'caEmployerAccount',
      'cdtfaPermit',
    ]);
    expect(rows.every((r) => r.by_someone)).toBe(true);
  });

  it('is for someone who can read the business', async () => {
    const res = await partner.post(url(`/businesses/${biz}/reveal`), { field: 'ein' });
    expect(res.status).toBe(200);
    const other = h.as('biz-tax-ids-stranger@example.test');
    const res2 = await other.post(url(`/businesses/${biz}/reveal`), { field: 'ein' });
    expect([403, 404]).toContain(res2.status);
    expect(JSON.stringify(res2.body)).not.toContain('3456789');
  });

  it('never puts a full number in a read, an error or the audit log', async () => {
    const reads = JSON.stringify([
      await business(),
      (await c.get(url('/businesses'))).body,
      (await c.get(url(`/payroll/settings?entityId=${biz}`))).body,
      (await c.get(url(`/payroll/taxes?entityId=${biz}&year=2026`))).body,
    ]);
    // An error from a change that carries a number.
    const bad = await c.patch(url(`/businesses/${biz}`), { ein: '12-3456789', naicsCode: 'retail' });
    expect(bad.status).toBe(400);
    const tooLong = await c.patch(url(`/businesses/${biz}`), { cdtfaPermit: `102-345678${'9'.repeat(30)}` });
    expect(tooLong.status).toBe(400);
    const text = reads + JSON.stringify(bad.body) + JSON.stringify(tooLong.body) + (await auditText());
    for (const full of ['123456789', '12-3456789', '7654321', '12345678', '123-4567-8', '102-345678']) {
      expect(text).not.toContain(full);
    }
    // What changed is still recorded, without the numbers.
    const { rows } = await admin.query(
      `select diff from app.audit_log where workspace_id = $1 and action = 'business_profile.update'
          and diff ? 'ein_enc'`,
      [wsId],
    );
    expect(rows[0].diff.ein_enc).toBe('[redacted]');
    expect(rows[0].diff.ein_last4).toEqual([null, '6789']);
  });
});

describe('filing outputs still get the full numbers (ADR-0034)', () => {
  it('fills the worksheets and the year-end employer in full', async () => {
    const w941 = (await c.get(url(`/payroll/worksheets/941?entityId=${biz}&year=2026&quarter=4`))).body;
    expect(w941.employer).toMatchObject({ ein: '12-3456789' });
    const de9 = (await c.get(url(`/payroll/worksheets/de9?entityId=${biz}&year=2026&quarter=4`))).body;
    expect(de9.employer.caEmployerAccount).toBe('123-4567-8');
    const yearEnd = (await c.get(url(`/payroll/year-end?entityId=${biz}&year=2026`))).body;
    expect(yearEnd.employer).toMatchObject({ ein: '12-3456789', caEmployerAccount: '123-4567-8' });
  });
});

describe('sealing what was stored in plain text (migration 0089)', () => {
  let old: string;
  let other: string;

  it('seals and clears the plain numbers, and is safe to run again', async () => {
    old = await makeBusiness('Plain Old Co');
    other = await makeBusiness('Half Done Co');
    // As 0037 and the API before 0089 left them: plain text, nothing sealed.
    await admin.query(
      `insert into app.business_profile (workspace_id, entity_id, ein, ftb_entity_id, ca_employer_account, cdtfa_permit)
       values ($1, $2, '555667777', 'FTB-4242', '87654321', 'SR-12-3333')`,
      [wsId, old],
    );
    // One sealed already, with a plain value an older API task wrote since: the plain one is the newer.
    await c.patch(url(`/businesses/${other}`), { ein: '11-1111111', caEmployerAccount: '222-2222-2' });
    await admin.query(`update app.business_profile set ein = '333334444' where entity_id = $1`, [other]);

    // Until the job runs, reads use the plain values, masked; Show and filing get them in full.
    expect((await business(old)).registrations).toMatchObject({
      einMasked: '••-•••7777',
      ftbEntityIdMasked: '••••4242',
      cdtfaPermitMasked: '••••3333',
    });
    expect((await business(other)).registrations.einMasked).toBe('••-•••4444');
    expect((await reveal('ein', other)).body.value).toBe('333334444');

    const sealing = h.app.get(TaxIdSealing);
    const first = await sealing.run();
    expect(first.sealed).toBeGreaterThanOrEqual(2);
    expect(first.more).toBe(false);

    expect(await stored(old)).toMatchObject({
      ein: null,
      ein_last4: '7777',
      ftb_entity_id: null,
      ftb_entity_id_last4: '4242',
      ca_employer_account: null,
      ca_employer_account_last4: '4321',
      cdtfa_permit: null,
      cdtfa_permit_last4: '3333',
    });
    expect((await stored(old)).ein_enc).not.toBeNull();
    expect(await stored(other)).toMatchObject({
      ein: null,
      ein_last4: '4444',
      ca_employer_account_last4: '2222',
    });
    expect((await business(old)).registrations).toMatchObject({
      einMasked: '••-•••7777',
      caEmployerAccountMasked: '••••4321',
    });
    expect((await reveal('ein', old)).body.value).toBe('555667777');
    expect((await reveal('cdtfaPermit', old)).body.value).toBe('SR-12-3333');
    expect((await reveal('ein', other)).body.value).toBe('333334444');
    expect((await reveal('caEmployerAccount', other)).body.value).toBe('22222222');
    const w = (await c.get(url(`/payroll/worksheets/941?entityId=${old}&year=2026&quarter=1`))).body;
    expect(w.employer.ein).toBe('55-5667777');

    // Nothing is left in plain text, and a second run finds nothing to do.
    const { rows } = await admin.query(`select count(*)::int as n from app.tax_ids_to_seal(1000)`);
    expect(rows[0].n).toBe(0);
    expect(await sealing.run()).toEqual({ sealed: 0, skipped: 0, more: false });
    expect(await stored(old)).toMatchObject({ ein: null, ein_last4: '7777' });
    // The job's own changes left no number in the audit log.
    const text = await auditText();
    for (const full of ['555667777', 'FTB-4242', '87654321', 'SR-12-3333', '333334444']) {
      expect(text).not.toContain(full);
    }
  });

  it('stops when its time is up and leaves the rest for the next run', async () => {
    await admin.query(`update app.business_profile set ein = '666778888' where entity_id = $1`, [old]);
    const sealing = h.app.get(TaxIdSealing);
    expect(await sealing.run(-1)).toMatchObject({ sealed: 0, more: true });
    expect((await stored(old)).ein).toBe('666778888');
    expect((await sealing.run()).sealed).toBeGreaterThanOrEqual(1);
    expect(await stored(old)).toMatchObject({ ein: null, ein_last4: '8888' });
  });

  it('redacts numbers already in the audit log and clears payroll’s old copies', async () => {
    await admin.query(
      `insert into app.payroll_settings (workspace_id, entity_id, ein, ca_employer_account)
       values ($1, $2, '999001111', '76543210')`,
      [wsId, old],
    );
    await admin.query(
      `insert into app.audit_log (workspace_id, action, subject_type, subject_id, diff)
       values ($1, 'business_profile.update', 'business_profile', $2,
               '{"ein": ["999001111", "999002222"], "irs_name": ["A", "B"]}'),
              ($1, 'business_profile.insert', 'business_profile', $2,
               '{"ein": "999003333", "cdtfa_permit": null, "legal_name": "X"}')`,
      [wsId, old],
    );
    const sql = readFileSync(
      new URL('../../../packages/db/migrations/0089_seal_tax_ids.sql', import.meta.url),
      'utf8',
    );
    const statement = (start: string) => sql.slice(sql.indexOf(start), sql.indexOf(';', sql.indexOf(start)));
    await admin.query(statement('update app.audit_log'));
    await admin.query(statement('update app.payroll_settings'));

    const { rows } = await admin.query(
      `select diff from app.audit_log where workspace_id = $1 and subject_id = $2
          and (diff -> 'irs_name' = '["A", "B"]' or diff ->> 'legal_name' = 'X') order by action desc`,
      [wsId, old],
    );
    expect(rows.map((r) => r.diff)).toEqual([
      { ein: '[redacted]', irs_name: ['A', 'B'] },
      { ein: '[redacted]', cdtfa_permit: null, legal_name: 'X' },
    ]);
    expect(await auditText()).not.toContain('99900');
    const ps = await admin.query(
      `select ein, ca_employer_account from app.payroll_settings where entity_id = $1`,
      [old],
    );
    expect(ps.rows).toEqual([{ ein: null, ca_employer_account: null }]);
  });
});
