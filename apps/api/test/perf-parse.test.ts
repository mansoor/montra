/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';
import { seedWorkspace, type SeededWorkspace } from './perf-seed.js';

// NFR-07: a 5,000-row import parses in under 10 s. "Parse" is everything from upload to rows ready for review: reading
// the file, the mapping, dedupe against what the account already holds, matching, transfer pairing and the
// categorization pipeline (rules, history, merchants and the AI, fake here). Unlike perf-commit's five repeated payees,
// this file looks like a real statement: many payees, card payments, rules, and a workspace with other accounts whose
// postings are transfer candidates. The budget is the requirement's own rate, 2 ms a row. PERF_PARSE_ROWS and
// PERF_PARSE_SEED change the sizes for a local benchmark.
const ROWS = Number(process.env.PERF_PARSE_ROWS ?? 5000);
const SEED = Number(process.env.PERF_PARSE_SEED ?? 10_000);
const BUDGET_MS_PER_ROW = 2;

let h: Harness;
let c: Client;
let w: SeededWorkspace;

const STEMS = [
  'TRADER JOES',
  'WHOLE FOODS',
  'SAFEWAY',
  'SHELL OIL',
  'CHEVRON',
  'NETFLIX.COM',
  'SPOTIFY USA',
  'BLUE BOTTLE',
  'STARBUCKS STORE',
  'AMZN MKTP US',
  'UBER TRIP',
  'LYFT RIDE',
  'CVS PHARMACY',
  'WALGREENS',
  'HOME DEPOT',
  'TARGET',
  'COSTCO WHSE',
  'PG&E WEB ONLINE',
  'COMCAST CABLE',
  'ACME PAYROLL',
];
const CITIES = ['SEATTLE WA', 'SAN FRANCISCO CA', 'PORTLAND OR', 'AUSTIN TX', 'DENVER CO'];

/** One statement line: mostly card purchases at ~1,000 distinct local shops and chains, some payments and pay. */
function line(i: number, today: string): string {
  const d = addDays(today as never, -Math.floor((i * 180) / ROWS));
  const n = (i * 7919) % 20_000;
  if (i % 50 === 7)
    return `${d},"ONLINE PAYMENT TO CARD XXXX${1000 + (i % 3)} CONF# ${i}",-${(500 + n) / 100}`;
  if (i % 40 === 3) return `${d},"ACME PAYROLL DIR DEP ${i}",${(n * 20) / 100 + 2500}`;
  const shop =
    i % 3 === 0 ? `PAYEE ${i % 400}` : `${STEMS[i % STEMS.length]} ${i % 50 === 1 ? '' : `#${i % 997}`}`;
  return `${d},"SQ *${shop} ${CITIES[i % CITIES.length]}",-${(500 + n) / 100}`;
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-perf-')) });
  h.app.get(ImportJobs).register();
  c = h.as('perf-parse@example.com');
  w = await seedWorkspace(c, SEED);
  const cats: any[] = (await c.get(w.url('/categories'))).body.data;
  const cat = (name: string) => cats.find((x) => x.entityId === w.personalId && x.name === name).id as string;
  // A few rules, as a household that has used the app for a while has.
  for (const [value, name] of [
    ['netflix', 'Subscriptions'],
    ['spotify', 'Subscriptions'],
    ['payroll', 'Salary'],
    ['shell', 'Fuel'],
    ['chevron', 'Fuel'],
  ] as const)
    await c.post(w.url('/rules'), {
      name: value,
      conditions: { all: [{ field: 'payee', op: 'contains', value }] },
      actions: { categoryId: cat(name) },
    });
}, 600_000);
afterAll(() => h.close());

describe('import parse throughput (NFR-07)', () => {
  it(`parses a ${ROWS}-row statement`, async () => {
    const today = todayIn('UTC');
    const accounts: any[] = (await c.get(w.url('/accounts'))).body.data;
    const checking = accounts.find((a) => a.name === 'Checking').id as string;
    // The card the payments go to, named by its last 4 digits.
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const card = accounts.find((a) => a.name === 'Visa').id as string;
    await admin.query(`update app.bank_account set last4 = '1001' where ledger_account_id = $1`, [card]);
    const lines = ['Date,Description,Amount'];
    for (let i = 0; i < ROWS; i++) lines.push(line(i, today));
    const boundary = '----perf';
    const up = await h.app.inject({
      method: 'POST',
      url: w.url('/uploads'),
      headers: {
        authorization: 'Bearer dev:perf-parse@example.com',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.csv"\r\n\r\n`,
        ),
        Buffer.from(lines.join('\n')),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    const fileId = JSON.parse(up.body).fileId as string;
    // An earlier import of this account covered the last month, so probable duplicates are looked for there.
    await admin.query(
      `insert into app.import_batch (workspace_id, entity_id, ledger_account_id, file_name, file_type, status, currency,
                                     min_date, max_date, committed_at, file_id)
       select workspace_id, entity_id, id, 'earlier.csv', 'csv', 'committed', 'USD', $2::date, $3::date, now(), $4
         from app.ledger_account where id = $1`,
      [checking, addDays(today, -30), today, fileId],
    );
    const batch = (await c.post(w.url('/imports'), { fileId, accountId: checking })).body;
    const t = performance.now();
    await h.app.get(Worker).drain();
    const parseMs = performance.now() - t;
    const done = (await c.get(w.url(`/imports/${batch.id}`))).body;
    expect(done.status).toBe('preview');
    // Same results before and after a change: PERF_PARSE_DUMP=<file> writes every row's outcome with ids replaced by
    // stable labels (transactions by date, text and amounts; accounts, categories, entities and rules by name). Dedupe
    // keys hash the account's id, which is new on every run, so they're left out; the ordinal they hash is kept.
    if (process.env.PERF_PARSE_DUMP) {
      const labels = new Map<string, string>();
      for (const r of (
        await admin.query(
          `select t.id, t.txn_date::text || '|' || coalesce(t.description, '') || '|' || coalesce(
                    (select string_agg(p.amount_minor::text, ',' order by p.line_no) from app.journal_entry je
                       join app.posting p on p.journal_entry_id = je.id where je.transaction_id = t.id), '') as label
             from app.transaction t where t.workspace_id = $1
           union all select id, 'acct:' || name from app.ledger_account where workspace_id = $1
           union all select id, 'entity:' || name from app.entity where workspace_id = $1
           union all select id, 'rule:' || name from app.rule where workspace_id = $1`,
          [w.workspaceId],
        )
      ).rows)
        labels.set(r.id, r.label);
      const rows = (
        await admin.query(
          `select row_no, status, ordinal, score, suggestion, category_id, member_id,
                  match_transaction_id, duplicate_of_transaction_id, normalized_desc, payee_raw, txn_date::text,
                  amount_minor::text
             from app.import_row where import_batch_id = $1 order by row_no`,
          [batch.id],
        )
      ).rows;
      const text = JSON.stringify(rows, null, 1).replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        (id) => labels.get(id) ?? id,
      );
      writeFileSync(process.env.PERF_PARSE_DUMP, text);
    }
    await admin.end();
    process.stdout.write(`[perf] ${ROWS} rows on ${SEED} transactions: parse ${parseMs.toFixed(0)} ms\n`);
    expect(parseMs).toBeLessThan(ROWS * BUDGET_MS_PER_ROW);
  }, 600_000);
});
