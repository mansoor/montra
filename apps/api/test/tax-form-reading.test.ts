/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskTaxFormText } from '@montra/ai-gateway';
import { renderFormPdf } from '../src/payroll/form-pdf.js';
import { w2Doc } from '../src/payroll/year-end-pdf.js';
import { TaxFormReading, type TaxFormTextResult } from '../src/tax-forms/tax-form-reading.js';
import { ADMIN_URL } from './env.js';
import { pdfTextPages } from './fakes/pdf-text.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Tax forms read from files (ADR-0052 PR 3; TAX-01 upload, TAX-02, TAX-03, TAX-08): the upload, the job chain, the
// automatic rules of §4, duplicates and corrected forms, and a W-2 rendered by payroll's year-end PDF read back to the
// same boxes. There's no doc-worker here: `docWorker` below hands on what `taxform.read` would (its masking and
// identifiers are pytest's, apps/doc-worker/tests/test_taxform.py), and the fake provider reads the text.
const OWNER = 'reading-owner@example.test';
const MEMBER = 'reading-member@example.test';
const CPA = 'reading-cpa@example.test';

let h: Harness;
let db: pg.Client;
let owner: Client;
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

const usd = (amount: string) => ({ amount, currency: 'USD' });
const join = async (who: Client, body: object) => {
  const invite = await owner.post(url('/sharing/invites'), body);
  expect(invite.status).toBe(201);
  expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
};

/** What the doc-worker's `taxform.read` hands on for these pages of text: masked text, titles and identifiers. */
function docWorker(pages: string[]): TaxFormTextResult {
  return {
    kind: 'taxform_text',
    pageCount: pages.length,
    textLayer: true,
    ocrEngine: null,
    error: null,
    pages: pages.map((text, i) => {
      const kinds: [RegExp, string][] = [
        [/\bForm\s+W-2c?\b/i, 'w2'],
        [/\b1099-INT\b/i, '1099_int'],
        [/\b1099-DIV\b/i, '1099_div'],
        [/\bForm\s+1098\b/i, '1098'],
      ];
      return {
        page: i + 1,
        text: maskTaxFormText(text, []),
        forms: text
          .split('\n')
          .flatMap((line) => kinds.filter(([re]) => re.test(line)).map(([, kind]) => kind))
          .map((kind) => ({ kind: kind as 'w2', corrected: /CORRECTED|W-2c/.test(text), taxYear: 2025 })),
        copiesDropped: 0,
        identifiers: {
          personTinLast4: /(?:XXX-XX-|\d{3}-\d{2}-)(\d{4})\b/.exec(text)?.[1] ?? null,
          issuerEin: /\b(\d{2})-(\d{7})\b/.exec(text)?.slice(1, 3).join('') ?? null,
          issuerTinLast4: null,
          accountLast4: /Account number\D*(\d{4})\b/.exec(text)?.[1] ?? null,
        },
      };
    }),
  };
}

async function upload(
  files: { name: string; bytes: Uint8Array }[],
  who: string = OWNER,
  fields: Record<string, string> = { year: '2025' },
) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(f.bytes),
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const res = await h.app.inject({
    method: 'POST',
    url: url('/tax-forms/files'),
    headers: {
      authorization: `Bearer dev:${who}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat(parts),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** A small PDF: these bytes are only stored and hashed here; the text comes from `docWorker`. */
const pdfBytes = (label: string) => new TextEncoder().encode(`%PDF-1.4\n% ${label}\n%%EOF\n`);

/** Plays the doc-worker for one form: its job succeeds with `result`, and the follow-up runs here. */
async function read(formId: string, result: TaxFormTextResult) {
  const { rows } = await db.query(
    `select workspace_id, created_by, then_job from app.job where type = 'taxform.read' and payload->>'formId' = $1`,
    [formId],
  );
  expect(rows).toHaveLength(1);
  await db.query(
    `update app.job set status = 'cancelled' where type = 'taxform.read' and payload->>'formId' = $1`,
    [formId],
  );
  return h.app.get(TaxFormReading).match({
    workspace_id: rows[0].workspace_id,
    created_by: rows[0].created_by,
    payload: { ...rows[0].then_job.payload, previousResult: result },
  } as any);
}

const get = async (id: string, who = owner) => (await who.get(url(`/tax-forms/${id}`))).body;

/** One month's pay at Acme, as the round-trip W-2 adds them up. */
const payslip = async (payDate: string) => {
  const p = (await owner.post(url('/payslips'), { employerId: acme, payDate })).body;
  const filled = await owner.patch(url(`/payslips/${p.id}`), {
    version: p.version,
    net: '348750',
    lines: [
      { section: 'earning', code: 'salary', label: 'Salary', amount: '500000' },
      { section: 'pre_tax', code: '401k', label: '401(k)', amount: '30000' },
      { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '62000' },
      { section: 'tax', code: 'state_tax', label: 'California income tax', amount: '21000' },
      { section: 'tax', code: 'social_security', label: 'Social Security', amount: '31000' },
      { section: 'tax', code: 'medicare', label: 'Medicare', amount: '7250' },
    ],
  });
  expect(filled.status).toBe(200);
  expect(
    (await owner.post(url(`/payslips/${p.id}/confirm`), { version: filled.body.version })).body.status,
  ).toBe('posted');
};

const INT_TEXT = (interest: string, extra: string[] = []) =>
  [
    'Form 1099-INT Interest Income 2025',
    ...extra,
    "PAYER'S name, street address, city or town, state, ZIP code",
    'First Example Bank',
    "PAYER'S TIN 34-5678901",
    "RECIPIENT'S TIN XXX-XX-4321",
    "RECIPIENT'S name",
    'MEMBER_3',
    'Account number (see instructions) 4471',
    `1 Interest income ${interest}`,
  ].join('\n');

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(TaxFormReading).register();
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  owner = h.as(OWNER);
  member = h.as(MEMBER);
  cpa = h.as(CPA);
  wsId = (await owner.post('/v1/workspaces', { name: 'Reading', baseCurrency: 'USD', template: 'household' }))
    .body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  personal = (await owner.get(url('/entities'))).body.data.find((e: any) => e.type === 'personal').id;
  const account = async (body: object) => {
    const res = await owner.post(url('/accounts'), {
      entityId: personal,
      openingDate: '2024-01-01',
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  checking = await account({ name: 'Checking', kind: 'checking', openingBalance: usd('5000000') });
  savings = await account({
    name: 'Savings',
    kind: 'savings',
    last4: '4471',
    institution: 'First Example Bank',
  });
  // Pseudonyms follow the order members were made: the owner's own member is MEMBER_1, Sam MEMBER_2, Alex MEMBER_3.
  sam = (await owner.post(url('/family-members'), { name: 'Sam', relationship: 'spouse_partner' })).body.id;
  alex = (await owner.post(url('/family-members'), { name: 'Alex', relationship: 'child' })).body.id;
  await join(member, { email: MEMBER, role: 'member', familyMember: { id: sam } });
  await join(cpa, { email: CPA, role: 'accountant' });
  const cpaId = (await owner.get(url('/sharing/members'))).body.data.find((m: any) => m.email === CPA).userId;
  await owner.put(url(`/sharing/members/${cpaId}/grants`), {
    grants: [{ entityId: personal, access: 'write' }],
  });
  acme = (
    await owner.post(url('/employers'), {
      memberId: sam,
      name: 'Acme Corp',
      payFrequency: 'monthly',
      depositAccountId: checking,
    })
  ).body.id;
  await owner.post(url('/employers'), {
    memberId: alex,
    name: 'Corner Cafe',
    payFrequency: 'monthly',
    depositAccountId: checking,
  });
  for (const d of ['2025-01-31', '2025-02-28', '2025-03-31']) await payslip(d);
  const interest = (await owner.get(url('/categories'))).body.data.find(
    (c: any) => c.name === 'Interest income',
  );
  await owner.post(url('/transactions'), {
    date: '2025-06-30',
    accountId: savings,
    amount: usd('41207'),
    payee: 'Interest paid',
    categoryId: interest.id,
  });
});
afterAll(async () => {
  await db.end();
  await h.close();
});

describe('uploading (TAX-01, TAX-02)', () => {
  it('takes several files at once, each read in the background by the doc-worker, then the AI', async () => {
    const res = await upload([
      { name: 'w2-acme.pdf', bytes: pdfBytes('w2') },
      { name: 'bank.pdf', bytes: pdfBytes('bank') },
    ]);
    expect(res.status).toBe(202);
    expect(res.body.files.map((f: any) => [f.fileName, f.status])).toEqual([
      ['w2-acme.pdf', 'reading'],
      ['bank.pdf', 'reading'],
    ]);
    const form = await get(res.body.files[0].formId);
    expect(form).toMatchObject({
      status: 'reading',
      source: 'upload',
      taxYear: 2025,
      result: { state: 'reading', review: false },
      reading: { fileNames: ['w2-acme.pdf'], kindKnown: false, boxesRead: false, problem: null },
    });
    expect(form.fileIds).toHaveLength(1);
    const { rows } = await db.query(
      `select queue, payload, then_job from app.job where type = 'taxform.read' and payload->>'formId' = $1`,
      [form.id],
    );
    // The doc-worker gets the stored file and the names to replace with tokens; the follow-up is the Node match.
    expect(rows[0].queue).toBe('doc');
    expect(rows[0].payload.members).toEqual([
      { name: 'Me', token: 'MEMBER_1' },
      { name: 'Sam', token: 'MEMBER_2' },
      { name: 'Alex', token: 'MEMBER_3' },
    ]);
    expect(rows[0].then_job).toMatchObject({ queue: 'ai', type: 'tax_form.match' });
    // Kept out of the year's Review until it's read.
    expect((await owner.get(url('/tax-forms/review'))).body.data.map((f: any) => f.id)).not.toContain(
      form.id,
    );
    for (const f of res.body.files)
      expect((await owner.delete(url(`/tax-forms/${f.formId}`))).status).toBe(204);
  });

  it('refuses the same file twice with the form made from it, and files that aren’t PDFs or photos', async () => {
    const bytes = pdfBytes('twice');
    const first = await upload([{ name: 'a.pdf', bytes }]);
    const again = await upload([
      { name: 'b.pdf', bytes },
      { name: 'c.pdf', bytes: pdfBytes('new') },
    ]);
    expect(again.body.files).toEqual([
      { fileName: 'b.pdf', status: 'duplicate', formId: first.body.files[0].formId },
      { fileName: 'c.pdf', status: 'reading', formId: expect.any(String) },
    ]);
    const gif = await upload([{ name: 'x.gif', bytes: new TextEncoder().encode('GIF89a') }]);
    expect(gif).toMatchObject({ status: 415, body: { code: 'tax_form.unsupported_type' } });
    for (const id of [first.body.files[0].formId, again.body.files[1].formId])
      await owner.delete(url(`/tax-forms/${id}`));
  });
});

describe('a W-2 rendered by payroll is read back to the same boxes (round trip)', () => {
  let w2: any;

  it('reads every box the year-end PDF prints, matches Acme and Sam, and is confirmed by the books', async () => {
    const bytes = await renderFormPdf(
      w2Doc({
        year: 2025,
        copy: 'B',
        employer: {
          name: 'Acme Corp',
          address: '100 Industrial Way\nSpringfield, CA 90210',
          tin: '12-3456789',
          caAccount: '123-4567-8',
        },
        employee: { name: 'Sam', address: '12 Elm Street\nSpringfield, CA 90211', tin: 'XXX-XX-6789' },
        boxes: {
          box1: 1410000n,
          box2: 186000n,
          box3: 1500000n,
          box4: 93000n,
          box5: 1500000n,
          box6: 21750n,
          box12D: 90000n,
          retirementPlan: true,
          caSdi: 10000n,
          caWages: 1410000n,
          caTax: 63000n,
        },
        state: 'CA',
      }),
    );
    const res = await upload([{ name: 'acme-w2.pdf', bytes }]);
    const id = res.body.files[0].formId;
    // The doc-worker's job would replace Sam's name with MEMBER_1; here the gateway does it on the way out.
    expect(await read(id, docWorker(await pdfTextPages(bytes)))).toMatchObject({ forms: 1, read: true });
    w2 = await get(id);
    expect(w2.boxes).toEqual({
      box1: '1410000',
      box2: '186000',
      box3: '1500000',
      box4: '93000',
      box5: '1500000',
      box6: '21750',
      box12: [{ code: 'D', amount: '90000' }],
      box13: { retirementPlan: true },
      box14: [{ label: 'CASDI', amount: '10000' }],
      states: [{ state: 'CA', box16: '1410000', box17: '63000' }],
    });
    expect(w2).toMatchObject({
      kind: 'w2',
      taxYear: 2025,
      issuerName: 'Acme Corp',
      issuerEin: '123456789',
      personTinLast4: '6789',
      accountLast4: null,
      targets: [{ employerId: acme, accountId: null }],
      personMemberId: sam,
      pages: [1],
      // Every check box agrees with the payslips: confirmed by that match, with no one to confirm it.
      status: 'confirmed',
      confirmedBy: null,
      result: { state: 'matches', review: false },
      reading: {
        kindKnown: true,
        boxesRead: true,
        problem: null,
        confirmedBy: 'books',
        match: { automatic: true, reason: 'Matched: Acme Corp is Sam’s only employer with payslips in 2025' },
      },
    });
    // The masked reading is cleared once it's confirmed (§8.5).
    const { rows } = await db.query('select reading from app.tax_form where id = $1', [id]);
    expect(rows[0].reading).toBeNull();
  });

  it('learns the EIN and the last four digits, so next year’s W-2 is matched from memory', async () => {
    const { rows } = await db.query(
      `select kind, signal, confirmations from app.match_memory where workspace_id = $1 order by kind`,
      [wsId],
    );
    expect(rows).toEqual([
      { kind: 'tax_issuer', signal: 'w2:ein:123456789', confirmations: 1 },
      { kind: 'tax_person', signal: expect.stringMatching(/^tin4:[\w-]{20,}$/), confirmations: 1 },
    ]);
    // A 2026 W-2 from the same EIN, with no payslips that year: no clear candidate, but the memory knows it.
    const res = await upload([{ name: 'acme-2026.pdf', bytes: pdfBytes('2026') }], OWNER, { year: '2026' });
    const id = res.body.files[0].formId;
    await read(
      id,
      docWorker([
        [
          'Form W-2 Wage and Tax Statement 2026',
          'b Employer identification number (EIN) 12-3456789',
          "c Employer's name, address, and ZIP code",
          'ACME CORPORATION',
          'a Employee social security number XXX-XX-6789',
          '1 Wages, tips, other compensation 60,000.00',
        ].join('\n'),
      ]),
    );
    const next = await get(id);
    expect(next).toMatchObject({
      taxYear: 2026,
      targets: [{ employerId: acme }],
      personMemberId: sam,
      reading: {
        match: { automatic: true, reason: 'Matched as before: forms from this issuer went to Acme Corp' },
      },
      // No payslips in 2026: not tracked, so the reading waits for a person to confirm it, outside Review.
      status: 'review',
      reason: null,
      result: { state: 'not_tracked', review: false },
    });
    const confirmed = await owner.post(url(`/tax-forms/${id}/confirm`), { version: next.version });
    expect(confirmed.body).toMatchObject({ status: 'confirmed', reading: { confirmedBy: 'person' } });
    expect(confirmed.body.confirmedBy).toBeTruthy();
  });
});

describe('1099s: the account by its last four, the person by the token, copies and corrections (TAX-03)', () => {
  let first: any;

  it('matches the only account ending 4471 with interest, for the person the token names', async () => {
    const res = await upload([{ name: 'bank-1099.pdf', bytes: pdfBytes('int') }]);
    await read(res.body.files[0].formId, docWorker([INT_TEXT('412.07')]));
    first = await get(res.body.files[0].formId);
    expect(first).toMatchObject({
      kind: '1099_int',
      issuerEin: '345678901',
      accountLast4: '4471',
      personTinLast4: '4321',
      personMemberId: alex,
      targets: [{ accountId: savings }],
      status: 'confirmed',
      reading: {
        confirmedBy: 'books',
        match: {
          automatic: true,
          reason: 'Matched: Savings is the only account ending 4471 with interest in 2025',
        },
      },
    });
  });

  it('puts a second copy of the same form in Review as a probable copy, until it’s confirmed as its own', async () => {
    const res = await upload([{ name: 'bank-again.pdf', bytes: pdfBytes('int-again') }]);
    await read(res.body.files[0].formId, docWorker([INT_TEXT('412.07')]));
    const copy = await get(res.body.files[0].formId);
    expect(copy).toMatchObject({
      status: 'review',
      reason: 'probable_copy',
      result: { state: 'probable_copy', review: true },
      reading: { copyOfId: first.id },
    });
    expect((await owner.get(url('/tax-forms/review'))).body.data.map((f: any) => f.id)).toContain(copy.id);
    expect((await owner.delete(url(`/tax-forms/${copy.id}`))).status).toBe(204);
  });

  it('a CORRECTED form replaces the one it corrects', async () => {
    const res = await upload([{ name: 'bank-corrected.pdf', bytes: pdfBytes('int-corrected') }]);
    await read(res.body.files[0].formId, docWorker([INT_TEXT('437.07', ['X CORRECTED'])]));
    const corrected = await get(res.body.files[0].formId);
    expect(corrected).toMatchObject({ corrected: true, supersedesId: first.id });
    // The books say $412.07: the corrected figure differs, and it's in Review for that.
    expect(corrected).toMatchObject({ status: 'review', reason: 'differs', result: { state: 'differs' } });
    expect(await get(first.id)).toMatchObject({ status: 'superseded', result: { state: 'superseded' } });
  });

  it('makes one form per section of a consolidated 1099, on the same file', async () => {
    const res = await upload([{ name: 'consolidated.pdf', bytes: pdfBytes('consolidated') }]);
    const id = res.body.files[0].formId;
    const text = [
      'Sample Brokerage LLC 2025 Consolidated Form 1099',
      "PAYER'S name: Sample Brokerage LLC",
      "RECIPIENT'S name: MEMBER_2",
      'Form 1099-DIV Dividends and Distributions 2025',
      '1a Total ordinary dividends 2,104.55',
      'Form 1099-INT Interest Income 2025',
      '1 Interest income 18.42',
    ].join('\n');
    expect(
      await read(id, docWorker([text, 'Form 1099-B Proceeds 2025\n1d Proceeds 10,000.00'])),
    ).toMatchObject({
      forms: 2,
    });
    const fileId = (await get(id)).fileIds[0];
    const forms = (await owner.get(url('/tax-forms?year=2025'))).body.forms.filter((f: any) =>
      f.fileIds.includes(fileId),
    );
    expect(forms.map((f: any) => [f.kind, f.issuerName, f.personMemberId, f.pages])).toEqual([
      ['1099_div', 'Sample Brokerage LLC', sam, [1]],
      ['1099_int', 'Sample Brokerage LLC', sam, [1]],
    ]);
    // No account at Sample Brokerage: waiting for a match, with nothing to suggest.
    expect(forms.map((f: any) => [f.reason, f.result.state])).toEqual([
      ['no_match', 'needs_match'],
      ['no_match', 'needs_match'],
    ]);
  });
});

describe('the person, and who may match (§4)', () => {
  it('never guesses when the reading names one member and the employer another', async () => {
    const res = await upload([{ name: 'conflict.pdf', bytes: pdfBytes('conflict') }]);
    await read(
      res.body.files[0].formId,
      docWorker([
        [
          'Form W-2 Wage and Tax Statement 2025',
          "c Employer's name, address, and ZIP code",
          'Acme Corp',
          "e Employee's name",
          'MEMBER_3',
          '1 Wages, tips, other compensation 15,000.00',
        ].join('\n'),
      ]),
    );
    const form = await get(res.body.files[0].formId);
    expect(form).toMatchObject({
      targets: [],
      personMemberId: null,
      reason: 'person_conflict',
      result: { state: 'person_conflict', review: true },
    });
    // Acme is still offered; picking it settles whose it is.
    expect(form.reading.match.candidates[0]).toMatchObject({ employerId: acme, name: 'Acme Corp' });
    const picked = await owner.patch(url(`/tax-forms/${form.id}`), {
      targets: [{ employerId: acme }],
      version: form.version,
    });
    expect(picked.body).toMatchObject({ personMemberId: sam, reason: 'differs' });
  });

  it('doesn’t match a W-2 to an employer for an accountant, even with one clear candidate', async () => {
    const res = await upload([{ name: 'cpa-w2.pdf', bytes: pdfBytes('cpa') }], CPA);
    expect(res.status).toBe(202);
    await read(
      res.body.files[0].formId,
      docWorker([
        ['Form W-2 Wage and Tax Statement 2025', "c Employer's name", 'Acme Corp', '1 Wages 14,100.00'].join(
          '\n',
        ),
      ]),
    );
    const form = await get(res.body.files[0].formId, cpa);
    expect(form).toMatchObject({ targets: [], reason: 'no_match', reading: { match: { candidates: [] } } });
  });
});

describe('when the form can’t be read (§6)', () => {
  it('with AI off, waits in Review with the kinds its titles name, to be typed in', async () => {
    await owner.patch(url('/ai/settings'), { mode: 'off' });
    const res = await upload([{ name: 'off.pdf', bytes: pdfBytes('off') }]);
    await read(res.body.files[0].formId, docWorker([INT_TEXT('412.07')]));
    await owner.patch(url('/ai/settings'), { mode: 'builtin' });
    const form = await get(res.body.files[0].formId);
    expect(form).toMatchObject({
      kind: '1099_int',
      boxes: {},
      status: 'review',
      reason: 'unread',
      accountLast4: '4471',
      result: { state: 'unread', review: true },
      reading: { kindKnown: true, boxesRead: false, problem: 'ai_unavailable' },
    });
    // Typing the box in settles it: it matches the books, so it's confirmed.
    const typed = await owner.patch(url(`/tax-forms/${form.id}`), {
      boxes: { box1: '41207' },
      targets: [{ accountId: savings }],
      personMemberId: alex,
      version: form.version,
    });
    expect(typed.body).toMatchObject({
      status: 'confirmed',
      reason: null,
      reading: { confirmedBy: 'books' },
    });
  });

  it('a file the doc-worker couldn’t read: the person says which form it is', async () => {
    const res = await upload([{ name: 'blurry.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) }]);
    const id = res.body.files[0].formId;
    await read(id, {
      kind: 'taxform_text',
      pages: [],
      pageCount: 0,
      textLayer: false,
      ocrEngine: null,
      error: { code: 'taxform.empty', message: 'no text could be read from this file' },
    });
    const form = await get(id);
    expect(form).toMatchObject({
      reason: 'unread',
      reading: { kindKnown: false, problem: 'unreadable' },
    });
    const typed = await owner.patch(url(`/tax-forms/${id}`), {
      kind: '1099_div',
      boxes: { box1a: '1250' },
      version: form.version,
    });
    expect(typed.body).toMatchObject({ kind: '1099_div', reason: 'no_match', reading: { kindKnown: true } });
  });

  it('a reading whose job failed is shown as one to type in, and can be', async () => {
    const res = await upload([{ name: 'failed.pdf', bytes: pdfBytes('failed') }]);
    const id = res.body.files[0].formId;
    const reading = await get(id);
    expect(reading.result.state).toBe('reading');
    const early = await owner.patch(url(`/tax-forms/${id}`), { boxes: {}, version: reading.version });
    expect(early).toMatchObject({ status: 409, body: { code: 'tax_form.reading' } });
    await db.query(
      `update app.job set status = 'failed' where type = 'taxform.read' and payload->>'formId' = $1`,
      [id],
    );
    const failed = await get(id);
    expect(failed).toMatchObject({
      result: { state: 'unread', review: true },
      reading: { problem: 'failed' },
    });
    expect((await owner.get(url('/tax-forms/review'))).body.data.map((f: any) => f.id)).toContain(id);
    const typed = await owner.patch(url(`/tax-forms/${id}`), {
      kind: '1098',
      boxes: { box1: '100000' },
      version: failed.version,
    });
    expect(typed.body).toMatchObject({ status: 'review', kind: '1098', reason: 'no_match' });
  });
});

describe('the files and what the jobs keep (TAX-08)', () => {
  it('serves the original only through the form, and logs each look', async () => {
    const res = await upload([{ name: 'view.pdf', bytes: pdfBytes('view') }]);
    const form = await get(res.body.files[0].formId);
    const file = await h.app.inject({
      method: 'GET',
      url: url(`/tax-forms/${form.id}/files/${form.fileIds[0]}`),
      headers: { authorization: `Bearer dev:${OWNER}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.body).toContain('% view');
    const { rows } = await db.query(
      `select action, subject_id from app.audit_log where workspace_id = $1 and action = 'tax_form.file_viewed'`,
      [wsId],
    );
    expect(rows).toEqual([{ action: 'tax_form.file_viewed', subject_id: form.id }]);
    // The member (Sam) can't read a form not yet theirs that someone else uploaded.
    const theirs = await h.app.inject({
      method: 'GET',
      url: url(`/tax-forms/${form.id}/files/${form.fileIds[0]}`),
      headers: { authorization: `Bearer dev:${MEMBER}` },
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('keeps the masked text out of GET jobs/:id', async () => {
    const res = await upload([{ name: 'jobs.pdf', bytes: pdfBytes('jobs') }]);
    const id = res.body.files[0].formId;
    const { rows } = await db.query(
      `select id from app.job where type = 'taxform.read' and payload->>'formId' = $1`,
      [id],
    );
    await db.query(`update app.job set status = 'succeeded', result = $2 where id = $1`, [
      rows[0].id,
      JSON.stringify(docWorker([INT_TEXT('412.07')])),
    ]);
    const job = await owner.get(url(`/jobs/${rows[0].id}`));
    expect(job.status).toBe(200);
    expect(job.body).toMatchObject({ type: 'taxform.read', status: 'succeeded', result: null });
  });
});
