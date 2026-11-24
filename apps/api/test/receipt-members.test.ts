/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { AiService } from '../src/ai/ai.service.js';
import { Worker } from '../src/jobs/queue.js';
import { ReceiptJobs } from '../src/receipts/receipt-jobs.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Who a receipt line is for (owner, 2026-11-24; RCP-03, FAM-05): a person's pick, then a receipt-item rule (which may
// check who added the receipt and the line's category), then the member picked by hand for the same item before, then
// whoever added the receipt, then Household. The AI no longer sets it.
const OWNER = 'members-owner@example.test';
const SAM = 'members-sam@example.test';
const NOBODY = 'members-nobody@example.test';

let h: Harness;
let worker: Worker;
let admin: pg.Client;
let owner: Client;
let sam: Client;
let nobody: Client;
let url: (p: string) => string;
let cat: (name: string) => string;
const member: Record<'mansoor' | 'sam' | 'kid', string> = { mansoor: '', sam: '', kid: '' };
let day = 0;

async function upload(email: string, bytes: Uint8Array, fileName: string, path = '/receipts/files') {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: url(path),
    headers: {
      authorization: `Bearer dev:${email}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** A receipt added by `email` with these item lines ("TEXT   1.00 N"), read by the fake AI. */
async function capture(email: string, c: Client, items: string[]) {
  day += 1;
  const text = [
    `CORNER STORE #${day}`,
    `11/${String(day).padStart(2, '0')}/2026 10:00`,
    ...items.map((i) => `${i}   1.00 N`),
    `TOTAL   ${items.length}.00`,
  ].join('\n');
  const f = await upload(email, encodeFakeReceiptImage(text), 'r.png');
  expect(f.status).toBe(201);
  const created = await c.post(url('/receipts'), { fileIds: [f.body.fileId] });
  expect(created.status).toBe(201);
  await worker.drain(['ai']);
  return (await c.get(url(`/receipts/${created.body.id}`))).body;
}

const line = (r: any, rawText: string) => r.lines.find((l: any) => l.rawText === rawText);

/** The review's PATCH: every line sent back as it is, with `patch` applied to the named ones. */
async function review(c: Client, r: any, patch: Record<string, object>) {
  const res = await c.patch(url(`/receipts/${r.id}`), {
    version: r.version,
    lines: r.lines.map((l: any) => ({
      id: l.id,
      rawText: l.rawText,
      lineTotal: l.lineTotal,
      discount: l.discount,
      taxable: l.taxable,
      categoryId: l.categoryId,
      memberId: l.memberId,
      ...(patch[l.rawText] ?? {}),
    })),
  });
  expect(res.status).toBe(200);
  return res.body;
}

const join = async (who: Client, email: string, familyMember?: object) => {
  const invite = await owner.post(url('/sharing/invites'), {
    email,
    role: 'admin',
    ...(familyMember ? { familyMember } : {}),
  });
  expect(invite.status).toBe(201);
  expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', AI_LOCAL_DIRECT: 'true' });
  h.app.get(ReceiptJobs).register();
  worker = h.app.get(Worker);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  owner = h.as(OWNER);
  sam = h.as(SAM);
  nobody = h.as(NOBODY);
  const ws = (
    await owner.post('/v1/workspaces', {
      name: 'Receipt members',
      baseCurrency: 'USD',
      template: 'household',
    })
  ).body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await owner.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name).id;
  await owner.patch(url('/ai/settings'), { allowReceiptImagesToLlm: true });
  // The owner's own member ("Me") is linked to the owner's login when the workspace is made.
  const me = (await owner.get(url('/family-members'))).body.data.find((m: any) => m.relationship === 'self');
  expect((await owner.patch(url(`/family-members/${me.id}`), { name: 'Mansoor' })).status).toBe(200);
  member.mansoor = me.id;
  await join(sam, SAM, { name: 'Sam', relationship: 'spouse_partner' });
  await join(nobody, NOBODY); // a login linked to nobody in the Family list
  const family = (await owner.get(url('/family-members'))).body.data;
  member.sam = family.find((m: any) => m.name === 'Sam').id;
  member.kid = (await owner.post(url('/family-members'), { name: 'Kid', relationship: 'child' })).body.id;
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('the default: whoever added the receipt', () => {
  it('is the member linked to the login that added it', async () => {
    const r = await capture(SAM, sam, ['GV 2% MLK GAL', 'BLUE WIDGET']);
    expect(r.lines.map((l: any) => l.memberId)).toEqual([member.sam, member.sam]);
    expect(line(r, 'GV 2% MLK GAL')).toMatchObject({
      categoryId: cat('Groceries'),
      memberReason: { source: 'adder', explanation: 'Added by Sam', ruleId: null },
    });
  });

  it('is Household when the login is linked to nobody', async () => {
    const r = await capture(NOBODY, nobody, ['GREEN WIDGET']);
    expect(r.lines[0]).toMatchObject({
      memberId: null,
      memberReason: { source: 'household', explanation: 'Household by default' },
    });
  });

  it('covers an order-history import too', async () => {
    const csv = [
      'Website,Order ID,Order Date,Currency,Unit Price,Unit Price Tax,Shipping Charge,Total Owed,Quantity,Product Name',
      'Amazon.com,111-0000009-0000009,2026-10-28T10:00:00Z,USD,3.49,0,0,3.49,1,Bananas organic',
    ].join('\n');
    const res = await upload(SAM, Buffer.from(csv), 'Retail.OrderHistory.1.csv', '/receipts/order-history');
    expect(res.status).toBe(201);
    const r = (await sam.get(url(`/receipts/${res.body.receiptIds[0]}`))).body;
    expect(r.lines[0]).toMatchObject({ memberId: member.sam, memberReason: { source: 'adder' } });
  });
});

describe('the order: a pick, a rule, a hand-picked member for the item, the adder, Household', () => {
  let rule: any;

  it('takes a rule over the item’s hand-picked member, and that over the adder', async () => {
    // Earlier, Mansoor picked Kid by hand for two items.
    const earlier = await capture(OWNER, owner, ['RULE HIST WIDGET', 'HIST WIDGET']);
    expect(line(earlier, 'HIST WIDGET').memberId).toBe(member.mansoor);
    const picked = await review(owner, earlier, {
      'RULE HIST WIDGET': { memberId: member.kid },
      'HIST WIDGET': { memberId: member.kid },
    });
    expect(line(picked, 'HIST WIDGET')).toMatchObject({
      memberId: member.kid,
      memberReason: { source: 'user', explanation: 'Chosen by you' },
    });
    rule = (
      await owner.post(url('/rules'), {
        name: 'Rule widgets are the house’s',
        scope: 'receipt_line',
        conditions: { all: [{ field: 'item_text', op: 'contains', value: 'RULE HIST' }] },
        actions: { household: true },
      })
    ).body;
    expect(rule.actions).toEqual({ household: true });

    const r = await capture(SAM, sam, ['RULE HIST WIDGET', 'HIST WIDGET', 'PLAIN WIDGET']);
    expect(line(r, 'RULE HIST WIDGET')).toMatchObject({
      memberId: null,
      memberReason: { source: 'rule', explanation: 'Rule: Rule widgets are the house’s', ruleId: rule.id },
    });
    expect(line(r, 'HIST WIDGET')).toMatchObject({
      memberId: member.kid,
      memberReason: { source: 'history', explanation: 'As you chose for this item before' },
    });
    expect(line(r, 'PLAIN WIDGET')).toMatchObject({
      memberId: member.sam,
      memberReason: { source: 'adder' },
    });

    // A pick beats them all, and stays through later saves.
    const reviewed = await review(sam, r, { 'RULE HIST WIDGET': { memberId: member.sam } });
    expect(line(reviewed, 'RULE HIST WIDGET')).toMatchObject({
      memberId: member.sam,
      memberReason: { source: 'user' },
    });
    const again = await review(sam, reviewed, { 'RULE HIST WIDGET': { categoryId: cat('Gifts') } });
    expect(line(again, 'RULE HIST WIDGET')).toMatchObject({
      categoryId: cat('Gifts'),
      memberId: member.sam,
      memberReason: { source: 'user' },
    });
  });

  it('reuses a hand pick of Household for the item', async () => {
    const earlier = await capture(OWNER, owner, ['HOUSE WIDGET']);
    await review(owner, earlier, { 'HOUSE WIDGET': { memberId: null } });
    const r = await capture(SAM, sam, ['HOUSE WIDGET']);
    expect(r.lines[0]).toMatchObject({ memberId: null, memberReason: { source: 'history' } });
  });

  it('never reuses a member that came from a default, a rule, or the AI before this change', async () => {
    // Sam's receipt defaulted the item to Sam; the rule made another Household.
    const defaulted = await capture(SAM, sam, ['DEFAULT WIDGET', 'OLD WIDGET']);
    expect(line(defaulted, 'DEFAULT WIDGET')).toMatchObject({
      memberId: member.sam,
      memberReason: { source: 'adder' },
    });
    // A line stored before 2026-11-24 has no reason: its Kid may have been the AI's guess.
    await admin.query(
      `update app.receipt_line set member_id = $1, member_reason = null where receipt_id = $2 and raw_text = 'OLD WIDGET'`,
      [member.kid, defaulted.id],
    );
    const r = await capture(OWNER, owner, ['DEFAULT WIDGET', 'OLD WIDGET']);
    expect(line(r, 'DEFAULT WIDGET')).toMatchObject({
      memberId: member.mansoor,
      memberReason: { source: 'adder' },
    });
    expect(line(r, 'OLD WIDGET')).toMatchObject({
      memberId: member.mansoor,
      memberReason: { source: 'adder' },
    });
  });

  it('leaves a line stored before 2026-11-24 as it is when its receipt is saved', async () => {
    const r = await capture(SAM, sam, ['GV 2% MLK GAL', 'LEGACY WIDGET']);
    await admin.query(
      `update app.receipt_line set member_id = $1, member_reason = null where receipt_id = $2`,
      [member.kid, r.id],
    );
    const before = (await sam.get(url(`/receipts/${r.id}`))).body;
    const saved = await review(sam, before, {});
    // The categorized line keeps Kid; so does the uncategorized one, as it has a member already.
    expect(saved.lines.map((l: any) => [l.memberId, l.memberReason])).toEqual([
      [member.kid, null],
      [member.kid, null],
    ]);
  });
});

describe('"added by" and "category" conditions', () => {
  let rule: any;

  it('make "Mansoor’s groceries are for the household" work', async () => {
    const created = await owner.post(url('/rules'), {
      name: 'Mansoor’s groceries',
      scope: 'receipt_line',
      conditions: {
        all: [
          { field: 'added_by', op: 'in', value: [member.mansoor] },
          { field: 'category', op: 'equals', value: cat('Groceries') },
        ],
      },
      actions: { household: true },
    });
    expect(created.status).toBe(201);
    rule = created.body;
    const mine = await capture(OWNER, owner, ['GV 2% MLK GAL', 'ONN USB-C CHRGR']);
    expect(line(mine, 'GV 2% MLK GAL')).toMatchObject({
      categoryId: cat('Groceries'),
      memberId: null,
      memberReason: { source: 'rule', explanation: 'Rule: Mansoor’s groceries', ruleId: rule.id },
    });
    expect(line(mine, 'ONN USB-C CHRGR')).toMatchObject({
      categoryId: cat('Electronics'),
      memberId: member.mansoor,
      memberReason: { source: 'adder' },
    });
    // Sam's groceries stay Sam's.
    const sams = await capture(SAM, sam, ['GV 2% MLK GAL']);
    expect(sams.lines[0]).toMatchObject({ memberId: member.sam, memberReason: { source: 'adder' } });
  });

  it('follow a category picked in review: the member is decided again', async () => {
    const r = await capture(OWNER, owner, ['MYSTERY WIDGET']);
    expect(r.lines[0]).toMatchObject({ categoryId: null, memberId: member.mansoor });
    const reviewed = await review(owner, r, { 'MYSTERY WIDGET': { categoryId: cat('Groceries') } });
    expect(reviewed.lines[0]).toMatchObject({
      categoryId: cat('Groceries'),
      memberId: null,
      memberReason: { source: 'rule', ruleId: rule.id },
    });
  });

  it('are refused on transaction rules, and a rule that checks the category can’t set it', async () => {
    const make = (body: object) =>
      owner.post(url('/rules'), {
        name: 'x',
        conditions: { all: [] },
        actions: { household: true },
        ...body,
      });
    const addedBy = await make({
      conditions: { all: [{ field: 'added_by', op: 'in', value: [member.sam] }] },
      actions: { categoryId: cat('Groceries') },
    });
    expect(addedBy.status).toBe(422);
    expect(addedBy.body).toMatchObject({ code: 'rule.invalid' });
    expect(addedBy.body.detail).toContain('Only receipt-item rules can check who added the receipt');
    const category = await make({
      scope: 'transaction',
      conditions: { all: [{ field: 'category', op: 'equals', value: cat('Groceries') }] },
      actions: { memberId: member.sam },
    });
    expect(category.status).toBe(422);
    expect(category.body.detail).toContain('Only receipt-item rules can check the category');
    const household = await make({ conditions: { all: [{ field: 'payee', op: 'contains', value: 'x' }] } });
    expect(household.status).toBe(422);
    expect(household.body.detail).toContain('Only receipt-item rules can set Household');
    const circular = await make({
      scope: 'receipt_line',
      conditions: { all: [{ field: 'category', op: 'equals', value: cat('Groceries') }] },
      actions: { categoryId: cat('Gifts') },
    });
    expect(circular.status).toBe(422);
    expect(circular.body.detail).toContain("can't set the category");
    // An existing transaction rule can't take them on by an edit either.
    const txnRule = (
      await owner.post(url('/rules'), {
        name: 'Shell',
        conditions: { all: [{ field: 'payee', op: 'contains', value: 'shell' }] },
        actions: { categoryId: cat('Groceries') },
      })
    ).body;
    const edit = await owner.patch(url(`/rules/${txnRule.id}`), {
      conditions: { all: [{ field: 'added_by', op: 'in', value: [member.sam] }] },
    });
    expect(edit.status).toBe(422);
    // An unknown member or category is refused on a receipt-item rule.
    const unknown = await make({
      scope: 'receipt_line',
      conditions: { all: [{ field: 'added_by', op: 'in', value: ['00000000-0000-4000-8000-000000000000'] }] },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('rule.member_invalid');
  });
});

describe('lines added in review', () => {
  it('decide "For" when it is left out (Automatic), and take Household or a member sent as a pick', async () => {
    const r = await capture(SAM, sam, ['FIRST WIDGET']);
    const res = await sam.patch(url(`/receipts/${r.id}`), {
      version: r.version,
      lines: [
        // The saved line, sent back as the phone does: its member unchanged.
        ...r.lines.map((l: any) => ({
          id: l.id,
          rawText: l.rawText,
          lineTotal: l.lineTotal,
          discount: l.discount,
          taxable: l.taxable,
          categoryId: l.categoryId,
          memberId: l.memberId,
        })),
        { rawText: 'AUTO WIDGET', lineTotal: '100' },
        { rawText: 'HOUSE PICK WIDGET', lineTotal: '100', memberId: null },
        { rawText: 'KID PICK WIDGET', lineTotal: '100', memberId: member.kid },
      ],
    });
    expect(res.status).toBe(200);
    const saved = res.body;
    expect(line(saved, 'FIRST WIDGET')).toMatchObject({
      memberId: member.sam,
      memberReason: { source: 'adder' },
    });
    expect(line(saved, 'AUTO WIDGET')).toMatchObject({
      memberId: member.sam,
      memberReason: { source: 'adder', explanation: 'Added by Sam' },
    });
    expect(line(saved, 'HOUSE PICK WIDGET')).toMatchObject({
      memberId: null,
      memberReason: { source: 'user', explanation: 'Chosen by you' },
    });
    expect(line(saved, 'KID PICK WIDGET')).toMatchObject({
      memberId: member.kid,
      memberReason: { source: 'user' },
    });
    // The Household pick is a hand pick, so the item's next receipt reuses it.
    const next = await capture(OWNER, owner, ['HOUSE PICK WIDGET']);
    expect(next.lines[0]).toMatchObject({ memberId: null, memberReason: { source: 'history' } });
  });
});

describe('"Apply to existing"', () => {
  it('is refused for a receipt-item rule', async () => {
    const rule = (
      await owner.post(url('/rules'), {
        name: 'Gum is the house’s',
        scope: 'receipt_line',
        conditions: { all: [{ field: 'item_text', op: 'contains', value: 'gum' }] },
        actions: { household: true },
      })
    ).body;
    const res = await owner.post(url(`/rules/${rule.id}/apply`));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('rule.apply_receipt_line');
    const queued = await admin.query(
      `select count(*)::int as n from app.job where type = 'rules.apply' and payload->>'ruleId' = $1`,
      [rule.id],
    );
    expect(queued.rows[0].n).toBe(0);
  });
});

describe('the AI', () => {
  it('no longer sets who a line is for, sure or not', async () => {
    const gateway = h.app.get(AiService).gateway;
    const real = gateway.categorize.bind(gateway);
    // The AI says Kid for every line, and is unsure of the second one's category.
    gateway.categorize = (async (...args: Parameters<typeof real>) => {
      const res = await real(...args);
      return res.ok
        ? {
            ...res,
            value: res.value.map((o, i) => ({
              ...o,
              memberId: member.kid,
              ...(i === 1 ? { confidence: 0.6 } : {}),
            })),
          }
        : res;
    }) as typeof gateway.categorize;
    try {
      const r = await capture(NOBODY, nobody, ['BANANAS', 'GV 2% MLK GAL']);
      expect(line(r, 'BANANAS')).toMatchObject({
        categoryId: cat('Groceries'),
        categorization: { step: 'ai' },
        memberId: null,
        memberReason: { source: 'household' },
      });
      expect(line(r, 'GV 2% MLK GAL')).toMatchObject({
        categoryId: null,
        categorization: { step: 'ai', suggested: { categoryId: cat('Groceries'), memberId: null } },
        memberId: null,
      });
    } finally {
      gateway.categorize = real;
    }
  });
});
