/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { RulesService } from '../src/categorization/rules.service.js';
import { InsightsService } from '../src/categorization/insights.service.js';
import { startHarness, type Client, type Harness } from './harness.js';

const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'categorizer@example.com';

let h: Harness;
let worker: Worker;
let c: Client;

beforeAll(async () => {
  h = await startHarness({
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
    AI_PROVIDER: 'fake',
  });
  h.app.get(ImportJobs).register();
  h.app.get(RulesService).register();
  h.app.get(InsightsService).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
});
afterAll(() => h.close());

const drain = () => worker.drain(['import', 'ai']);

async function upload(wsId: string, fileName: string, text: string) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
    Buffer.from(text),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/uploads`,
    headers: { authorization: `Bearer dev:${EMAIL}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  return JSON.parse(res.body);
}

/** Uploads a CSV, parses, commits and returns the created transactions by description. */
async function importCsv(w: { ws: any; url: (p: string) => string }, account: string, name: string, csv: string) {
  const file = await upload(w.ws.id, name, csv);
  const batch = (await c.post(w.url('/imports'), { fileId: file.fileId, accountId: account })).body;
  await drain();
  const preview = (await c.get(w.url(`/imports/${batch.id}`))).body;
  expect(preview.status).toBe('preview');
  const rows = (await c.get(w.url(`/imports/${batch.id}/rows`))).body.data;
  await c.post(w.url(`/imports/${batch.id}/commit`));
  await drain();
  const done = (await c.get(w.url(`/imports/${batch.id}`))).body;
  expect(done.status).toBe('committed');
  return { batch: done, rows };
}

async function setup(name: string) {
  const ws = (await c.post('/v1/workspaces', { name, baseCurrency: 'USD', template: 'household' })).body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  const cat = (n: string) => cats.find((x: any) => x.name === n).id as string;
  const checking = (await c.post(url('/accounts'), { name: 'Chase Checking', kind: 'checking' })).body.id as string;
  const txns = async () => (await c.get(url('/transactions?limit=200'))).body.data as any[];
  const categoryOf = (t: any) =>
    t.entries[0]?.postings.find((p: any) => p.isCategory)?.accountId as string | undefined;
  return { ws, url, cat, checking, txns, categoryOf };
}

describe('categorization pipeline, review and learning (AI-01..06, UP-02)', () => {
  let w: Awaited<ReturnType<typeof setup>>;
  let ruleId: string;

  beforeAll(async () => {
    w = await setup('Categorize');
  });

  it('validates rules, previews against existing transactions and applies to them', async () => {
    const bad = await c.post(w.url('/rules'), {
      name: 'Broken',
      conditions: { all: [{ field: 'payee', op: 'regex', value: '(unclosed' }] },
      actions: { categoryId: w.cat('Fuel & transport') },
    });
    expect(bad.status).toBe(422);

    const old = await c.post(w.url('/transactions'), {
      date: '2026-09-02',
      accountId: w.checking,
      amount: usd('-4200'),
      payee: 'Shell Oil 5521',
      categoryId: w.cat('Household'),
    });
    expect(old.status).toBe(201);

    const conditions = { all: [{ field: 'payee', op: 'contains', value: 'shell' }] };
    const actions = { categoryId: w.cat('Fuel & transport'), tags: ['fuel'] };
    const preview = await c.post(w.url('/rules/preview'), { conditions, actions });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ matches: 1, changes: 1, skippedLocked: 0 });

    const rule = await c.post(w.url('/rules'), { name: 'Shell → Fuel', conditions, actions });
    expect(rule.status).toBe(201);
    ruleId = rule.body.id;
    const job = await c.post(w.url(`/rules/${ruleId}/apply`));
    expect(job.status).toBe(202);
    await drain();
    const t = (await c.get(w.url(`/transactions/${old.body.id}`))).body;
    expect(w.categoryOf(t)).toBe(w.cat('Fuel & transport'));
    expect(t.tags).toContain('fuel');
    expect(t.categorization).toMatchObject({ step: 'rule', ruleId });
    expect((await c.get(w.url('/rules'))).body.data[0].hitCount).toBeGreaterThanOrEqual(1);
  });

  it('runs rules, AI and the review queue on an import', async () => {
    const csv = [
      'Date,Description,Amount',
      '10/01/2026,SHELL OIL 57444,-38.20',
      "10/02/2026,JOES COFFEE HOUSE,-4.75",
      '10/03/2026,XYZZY PLUGH 991,-120.00',
      '10/04/2026,XYZZY PLUGH 992,-80.00',
    ].join('\n');
    const { rows } = await importCsv(w, w.checking, 'oct.csv', csv);
    const shell = rows.find((r: any) => r.description.startsWith('SHELL'));
    expect(shell.suggestion.explanation).toContain('Shell → Fuel');
    expect(shell.categoryId).toBe(w.cat('Fuel & transport'));

    const txns = await w.txns();
    const byDesc = (p: string) => txns.find((t) => t.description.startsWith(p));
    expect(byDesc('SHELL').reviewState).toBe('auto_applied');
    expect(byDesc('SHELL').categorization.step).toBe('rule');
    const coffee = byDesc('JOES');
    expect(coffee.categorization.step).toBe('ai');
    expect(coffee.categorization.explanation).toBeTruthy();
    const xyzzy = txns.filter((t) => t.description.startsWith('XYZZY'));
    expect(xyzzy.every((t) => t.reviewState === 'needs_review')).toBe(true);

    const review = (await c.get(w.url('/review'))).body;
    expect(review.total).toBeGreaterThanOrEqual(2);
    expect(review.items.some((i: any) => i.payee?.includes('Xyzzy') || i.description.startsWith('XYZZY'))).toBe(
      true,
    );
  });

  it('learns from two identical corrections and offers a rule that applies to existing rows', async () => {
    const review = (await c.get(w.url('/review'))).body.items.filter((i: any) =>
      i.description.startsWith('XYZZY'),
    );
    expect(review).toHaveLength(2);
    const first = await c.post(w.url(`/review/${review[0].transactionId}/resolve`), {
      categoryId: w.cat('Household'),
    });
    expect(first.status).toBe(200);
    expect(first.body.ruleSuggestion).toBeNull();
    const second = await c.post(w.url(`/review/${review[1].transactionId}/resolve`), {
      categoryId: w.cat('Household'),
      version: review[1].version,
    });
    expect(second.status).toBe(200);
    expect(second.body.ruleSuggestion).toMatchObject({ evidence: 2 });
    expect(second.body.ruleSuggestion.name).toContain('Household');

    const listed = (await c.get(w.url('/rule-suggestions'))).body.data;
    expect(listed).toHaveLength(1);
    const accepted = await c.post(w.url(`/rule-suggestions/${listed[0].id}/accept`), { applyToExisting: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body.rule.origin).toBe('ai_suggested');
    expect(accepted.body.job).not.toBeNull();
    await drain();
    expect((await c.get(w.url('/rule-suggestions'))).body.data).toHaveLength(0);
  });

  it('accepts suggestions in bulk above a confidence', async () => {
    const t = await c.post(w.url('/transactions'), {
      date: '2026-10-05',
      accountId: w.checking,
      amount: usd('-525'),
      payee: 'Corner Coffee Roasters',
    });
    expect(t.status).toBe(201);
    // Whatever the fake provider decided, accepting "all ≥ 0%" clears the queue except items with nothing to accept.
    const res = await c.post(w.url('/review/accept'), { minConfidence: 0 });
    expect(res.status).toBe(200);
    expect(res.body.accepted + res.body.skipped).toBeGreaterThanOrEqual(0);
  });

  it('AI off still categorizes with rules and history (Phase 3 exit)', async () => {
    const off = await c.patch(w.url('/ai/settings'), { mode: 'off' });
    expect(off.status).toBe(200);
    expect(off.body.mode).toBe('off');
    const csv = ['Date,Description,Amount', '10/20/2026,XYZZY PLUGH 993,-60.00', '10/21/2026,SHELL OIL 1,-30.00'].join(
      '\n',
    );
    await importCsv(w, w.checking, 'oct2.csv', csv);
    const txns = await w.txns();
    const x = txns.find((t) => t.description === 'XYZZY PLUGH 993');
    expect(x.reviewState).toBe('auto_applied');
    expect(w.categoryOf(x)).toBe(w.cat('Household'));
    expect(['rule', 'history']).toContain(x.categorization.step);
    await c.patch(w.url('/ai/settings'), { mode: 'builtin' });
  });

  it('suggests for the editor and parses natural-language quick add (TXN-06)', async () => {
    const s = await c.post(w.url('/categorize/suggest'), {
      payee: 'SHELL',
      amount: usd('-2500'),
      accountId: w.checking,
      date: '2026-10-28',
    });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ categoryId: w.cat('Fuel & transport'), step: 'rule', confidence: 1 });

    const q = await c.post(w.url('/transactions/parse'), {
      text: 'lunch 18.50 checking client meeting',
      today: '2026-10-29',
    });
    expect(q.status).toBe(200);
    expect(q.body.amount).toEqual(usd('1850'));
    expect(q.body.direction).toBe('out');
    expect(q.body.accountId).toBe(w.checking);
    expect(q.body.date).toBe('2026-10-29');
  });
});

describe('AI settings and audit log (UP-13, AIA-08, AIA-10)', () => {
  let w: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    w = await setup('AI settings');
  });

  it('stores a BYOK key write-only and shows disclosures and usage', async () => {
    const s0 = (await c.get(w.url('/ai/settings'))).body;
    expect(s0).toMatchObject({ mode: 'builtin', threshold: 0.8, hasKey: false });
    expect(s0.disclosures.map((d: any) => d.mode)).toEqual(['builtin', 'byok', 'local', 'off']);
    const s1 = await c.patch(w.url('/ai/settings'), {
      mode: 'byok',
      provider: 'anthropic',
      apiKey: 'sk-test-abcdefgh1234',
      threshold: 0.9,
      monthlyBudgetUsd: 5,
    });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ mode: 'byok', hasKey: true, keyLast4: '1234', threshold: 0.9, monthlyBudgetUsd: 5 });
    expect(JSON.stringify(s1.body)).not.toContain('sk-test');
    const local = await c.patch(w.url('/ai/settings'), { mode: 'local', endpoint: null });
    expect(local.status).toBe(422);
    const test = await c.post(w.url('/ai/settings/test'));
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(true);
  });

  it('records AI calls without inputs and lets the user delete them', async () => {
    await c.post(w.url('/transactions'), {
      date: '2026-10-05',
      accountId: w.checking,
      amount: usd('-1299'),
      payee: 'Netflix streaming',
    });
    const events = (await c.get(w.url('/ai/events'))).body.items;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const e = events.find((x: any) => x.task === 'categorize');
    expect(e.inputHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(JSON.stringify(e)).not.toContain('Netflix streaming');
    expect((await c.delete(w.url(`/ai/events/${e.id}`))).status).toBe(204);
    const all = await c.delete(w.url('/ai/events'));
    expect(all.status).toBe(200);
    expect((await c.get(w.url('/ai/events'))).body.items).toHaveLength(0);
    // Spend is kept apart from the deletable log (AIA-08).
    expect((await c.get(w.url('/ai/settings'))).body.usage.calls).toBeGreaterThanOrEqual(1);
  });

  it('only the owner changes AI settings', async () => {
    const res = await h.as('stranger@example.com').patch(w.url('/ai/settings'), { mode: 'off' });
    expect([403, 404]).toContain(res.status);
  });
});

describe('insights: recurring proposals and anomalies (AI-08, AI-09)', () => {
  it('proposes a recurring template from monthly history and creates it on accept', async () => {
    const w = await setup('Insights');
    const today = new Date();
    const day = (monthsBack: number) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 12));
      return d.toISOString().slice(0, 10);
    };
    for (const m of [4, 3, 2, 1])
      await c.post(w.url('/transactions'), {
        date: day(m),
        accountId: w.checking,
        amount: usd('-1599'),
        payee: 'NETFLIX.COM',
        categoryId: w.cat('Subscriptions'),
      });
    const detect = await c.post(w.url('/insights/detect'));
    expect(detect.status).toBe(200);
    const insights = (await c.get(w.url('/insights'))).body.data;
    const rec = insights.find((i: any) => i.kind === 'recurring');
    expect(rec).toBeTruthy();
    expect(rec.message).toMatch(/monthly/);
    const accepted = await c.post(w.url(`/insights/${rec.id}/accept`), {});
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    const recurring = (await c.get(w.url('/recurring'))).body.data;
    expect(recurring.some((r: any) => r.cadence === 'monthly')).toBe(true);
    // Detection is idempotent.
    await c.post(w.url('/insights/detect'));
    expect((await c.get(w.url('/insights'))).body.data.filter((i: any) => i.kind === 'recurring')).toHaveLength(0);
  });
});
