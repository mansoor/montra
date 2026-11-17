/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Tax forms received (ADR-0052 PR 1): typing a form in, changing and deleting it, waivers, and the owner's setting
// that lets accountants see members' forms (TAX-01, TAX-02, TAX-08).
const OWNER = 'tax-owner@example.test';
const ADMIN = 'tax-admin@example.test';
const MEMBER = 'tax-member@example.test';
const CPA = 'tax-cpa@example.test';

let h: Harness;
let db: pg.Client;
let owner: Client;
let admin: Client;
let member: Client;
let cpa: Client;
let wsId: string;
let url: (p: string) => string;
let personal: string;
let checking: string;
let savings: string;
let sam: string;
let alex: string;
let acme: string;

const join = async (who: Client, body: object) => {
  const invite = await owner.post(url('/sharing/invites'), body);
  expect(invite.status).toBe(201);
  expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
};

const W2 = {
  kind: 'w2',
  taxYear: 2025,
  issuerName: 'Acme Corp',
  issuerEin: '12-3456789',
  personTinLast4: '6789',
  boxes: {
    box1: '008512034',
    box2: '1204500',
    box12: [{ code: 'D', amount: '500000' }],
    states: [{ state: 'CA', box16: '8512034', box17: '512300' }],
  },
};

const formsIn = async (c: Client, year = 2025) => {
  const res = await c.get(url(`/tax-forms?year=${year}`));
  expect(res.status).toBe(200);
  return res.body.forms as any[];
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  owner = h.as(OWNER);
  admin = h.as(ADMIN);
  member = h.as(MEMBER);
  cpa = h.as(CPA);
  wsId = (await owner.post('/v1/workspaces', { name: 'Taxes', baseCurrency: 'USD', template: 'hybrid' })).body
    .id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  const entities = (await owner.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  checking = (await owner.post(url('/accounts'), { name: 'Checking', kind: 'checking', entityId: personal }))
    .body.id;
  savings = (await owner.post(url('/accounts'), { name: 'Savings', kind: 'savings', entityId: personal }))
    .body.id;
  sam = (await owner.post(url('/family-members'), { name: 'Sam', relationship: 'spouse_partner' })).body.id;
  alex = (await owner.post(url('/family-members'), { name: 'Alex', relationship: 'child' })).body.id;
  await join(admin, { email: ADMIN, role: 'admin' });
  await join(member, { email: MEMBER, role: 'member', familyMember: { id: sam } });
  await join(cpa, { email: CPA, role: 'accountant' });
  // The accountant keeps the household's personal books, read only.
  const cpaId = (await owner.get(url('/sharing/members'))).body.data.find((m: any) => m.email === CPA).userId;
  expect(
    (
      await owner.put(url(`/sharing/members/${cpaId}/grants`), {
        grants: [{ entityId: personal, access: 'read' }],
      })
    ).status,
  ).toBe(200);
  const employer = await owner.post(url('/employers'), {
    memberId: sam,
    name: 'Acme Corp',
    payFrequency: 'monthly',
    depositAccountId: checking,
  });
  expect(employer.status).toBe(201);
  acme = employer.body.id;
});
afterAll(async () => {
  await db.end();
  await h.close();
});

describe('typing a form in (TAX-01)', () => {
  let w2: any;

  it('keeps a W-2 matched to its employer, for the employer’s person', async () => {
    const res = await owner.post(url('/tax-forms'), { ...W2, targets: [{ employerId: acme }] });
    expect(res.status).toBe(201);
    w2 = res.body;
    expect(w2).toMatchObject({
      kind: 'w2',
      taxYear: 2025,
      source: 'typed',
      issuerEin: '123456789',
      personTinLast4: '6789',
      personMemberId: sam,
      entityId: personal,
      targets: [{ employerId: acme, accountId: null }],
      // Typed in and matched: the reading is the person's.
      status: 'confirmed',
      reason: null,
      version: 1,
    });
    // Stored canonical: leading zeros dropped, blank boxes left out.
    expect(w2.boxes).toEqual({ ...W2.boxes, box1: '8512034' });
    expect((await formsIn(owner)).map((f) => f.id)).toEqual([w2.id]);
    expect(await formsIn(owner, 2024)).toEqual([]);
    expect((await owner.get(url(`/tax-forms/${w2.id}`))).body).toEqual(w2);
  });

  it('refuses boxes that aren’t the kind’s, and matches that don’t fit', async () => {
    const wrongBox = await owner.post(url('/tax-forms'), { ...W2, boxes: { box1a: '100' } });
    expect(wrongBox.status).toBe(400);
    const decimals = await owner.post(url('/tax-forms'), { ...W2, boxes: { box1: '85120.34' } });
    expect(decimals.status).toBe(400);
    const account = await owner.post(url('/tax-forms'), { ...W2, targets: [{ accountId: checking }] });
    expect(account).toMatchObject({ status: 422, body: { code: 'tax_form.target_kind' } });
    const someoneElse = await owner.post(url('/tax-forms'), {
      ...W2,
      personMemberId: alex,
      targets: [{ employerId: acme }],
    });
    expect(someoneElse).toMatchObject({ status: 422, body: { code: 'tax_form.person_conflict' } });
  });

  it('puts a form without a match or a person in Review until it has both', async () => {
    const res = await owner.post(url('/tax-forms'), {
      kind: '1099_int',
      taxYear: 2025,
      issuerName: 'First Bank',
      accountLast4: '4321',
      boxes: { box1: '4107' },
    });
    expect(res.body).toMatchObject({ status: 'review', reason: 'no_match', personMemberId: null });
    const matched = await owner.patch(url(`/tax-forms/${res.body.id}`), {
      targets: [{ accountId: checking }, { accountId: savings }],
      version: 1,
    });
    expect(matched.body).toMatchObject({ status: 'review', reason: 'no_person', version: 2 });
    expect(matched.body.targets).toHaveLength(2);
    // An edit made against an old version is refused.
    const stale = await owner.patch(url(`/tax-forms/${res.body.id}`), { personMemberId: alex, version: 1 });
    expect(stale.status).toBe(409);
    const done = await owner.patch(url(`/tax-forms/${res.body.id}`), {
      personMemberId: alex,
      boxes: { box1: '4107', box3: '1200' },
      version: 2,
    });
    expect(done.body).toMatchObject({
      status: 'confirmed',
      personMemberId: alex,
      boxes: { box1: '4107', box3: '1200' },
      targets: [{ accountId: checking }, { accountId: savings }],
    });
    const badBoxes = await owner.patch(url(`/tax-forms/${res.body.id}`), {
      boxes: { box1a: '1' },
      version: 3,
    });
    expect(badBoxes).toMatchObject({ status: 422, body: { code: 'tax_form.boxes' } });
  });

  it('marks the form a corrected one replaces as superseded', async () => {
    const corrected = await owner.post(url('/tax-forms'), {
      ...W2,
      corrected: true,
      supersedesId: w2.id,
      targets: [{ employerId: acme }],
      boxes: { ...W2.boxes, box1: '8612034' },
    });
    expect(corrected.status).toBe(201);
    expect((await owner.get(url(`/tax-forms/${w2.id}`))).body.status).toBe('superseded');
  });
});

describe('who sees and handles a form (TAX-08, §8.4)', () => {
  it('lets a member handle their own forms only', async () => {
    const mine = await formsIn(member);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((f) => f.personMemberId === sam)).toBe(true);
    const own = await member.post(url('/tax-forms'), {
      kind: '1099_div',
      taxYear: 2025,
      issuerName: 'Brokerage',
      personMemberId: sam,
      boxes: { box1a: '12500' },
    });
    expect(own.status).toBe(201);
    const theirs = await member.post(url('/tax-forms'), {
      kind: '1099_div',
      taxYear: 2025,
      personMemberId: alex,
      boxes: {},
    });
    expect(theirs.status).toBe(403);
  });

  it('shows an accountant members’ forms only once the owner turns the setting on, and audits it', async () => {
    expect(await formsIn(cpa)).toEqual([]);
    expect((await cpa.get(url(''))).body.accountantSeesTaxForms).toBe(false);

    const on = await owner.put(url('/accountant-tax-forms'), { accountantSeesTaxForms: true });
    expect(on).toMatchObject({ status: 200, body: { accountantSeesTaxForms: true } });
    expect((await cpa.get(url(''))).body.accountantSeesTaxForms).toBe(true);
    const seen = await formsIn(cpa);
    expect(seen.length).toBe((await formsIn(owner)).length);

    // Setting it to what it is already changes nothing and writes nothing.
    expect((await owner.put(url('/accountant-tax-forms'), { accountantSeesTaxForms: true })).status).toBe(
      200,
    );
    expect((await owner.put(url('/accountant-tax-forms'), { accountantSeesTaxForms: false })).status).toBe(
      200,
    );
    expect(await formsIn(cpa)).toEqual([]);

    const ownerId = (await owner.get('/v1/me')).body.id;
    const audit = await db.query(
      `select actor_user_id, subject_type, subject_id, diff from app.audit_log
        where workspace_id = $1 and action = 'workspace.accountant_tax_forms_changed' order by id`,
      [wsId],
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: ownerId,
        subject_type: 'workspace',
        subject_id: wsId,
        diff: { accountantSeesTaxForms: [false, true] },
      },
      {
        actor_user_id: ownerId,
        subject_type: 'workspace',
        subject_id: wsId,
        diff: { accountantSeesTaxForms: [true, false] },
      },
    ]);
  });

  it('lets only the owner change the setting', async () => {
    for (const c of [admin, cpa, member]) {
      const res = await c.put(url('/accountant-tax-forms'), { accountantSeesTaxForms: true });
      expect(res.status).toBe(403);
    }
    expect((await owner.get(url(''))).body.accountantSeesTaxForms).toBe(false);
  });
});

describe('deleting and waivers', () => {
  it('moves a form to the Trash and back', async () => {
    const form = (
      await owner.post(url('/tax-forms'), {
        kind: '1098',
        taxYear: 2025,
        issuerName: 'Home Lender',
        personMemberId: sam,
        boxes: { box1: '1234567', box3: '2021-06-15' },
      })
    ).body;
    expect((await owner.delete(url(`/tax-forms/${form.id}`))).status).toBe(204);
    expect((await formsIn(owner)).some((f) => f.id === form.id)).toBe(false);
    const trash = (await owner.get(url('/trash'))).body.data;
    expect(trash).toContainEqual(
      expect.objectContaining({ kind: 'tax_form', id: form.id, title: 'Home Lender' }),
    );
    expect((await owner.post(url(`/trash/tax_form/${form.id}/restore`))).status).toBe(204);
    expect((await formsIn(owner)).some((f) => f.id === form.id)).toBe(true);
  });

  it('records an expected form that won’t come, once', async () => {
    const w2 = await owner.post(url('/tax-forms/waivers'), {
      taxYear: 2024,
      kind: 'w2',
      employerId: acme,
      reason: 'not_issued',
      note: 'Left in January',
    });
    expect(w2.status).toBe(201);
    expect(w2.body).toMatchObject({ kind: 'w2', employerId: acme, personMemberId: sam, entityId: personal });
    const again = await owner.post(url('/tax-forms/waivers'), {
      taxYear: 2024,
      kind: 'w2',
      employerId: acme,
      reason: 'other',
    });
    expect(again.status).toBe(409);
    const year = (await owner.get(url('/tax-forms?year=2024'))).body;
    expect(year).toMatchObject({
      year: 2024,
      forms: [],
      waivers: [{ id: w2.body.id, reason: 'not_issued' }],
    });
    // The member it's for sees it; deleting it is theirs to do too.
    expect((await member.get(url('/tax-forms?year=2024'))).body.waivers).toHaveLength(1);
    expect((await member.delete(url(`/tax-forms/waivers/${w2.body.id}`))).status).toBe(204);
    expect((await owner.get(url('/tax-forms?year=2024'))).body.waivers).toEqual([]);

    const interest = await owner.post(url('/tax-forms/waivers'), {
      taxYear: 2024,
      kind: '1099_int',
      accountId: savings,
      reason: 'combined',
    });
    expect(interest.body).toMatchObject({ accountId: savings, personMemberId: null });
  });
});
