import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';
import { homeRequests, seedWorkspace, type SeededWorkspace } from './perf-seed.js';

// NFR-07: the dashboard loads in under 2 s (p95) with 50,000 transactions. This measures the API work behind the
// Home page; PERF_TRANSACTIONS overrides the size for a local benchmark. The page's own rendering is measured
// separately (docs/STATUS.md), so the API gets a tighter budget than the page: 1.5 s, leaving 0.5 s for the rest.
const COUNT = Number(process.env.PERF_TRANSACTIONS ?? 50_000);
const ROUNDS = 25;
const BUDGET_MS = 1500;

let h: Harness;
let c: Client;
let w: SeededWorkspace;

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
const report = (line: string) => process.stdout.write(`[perf] ${line}\n`);

async function measure(rounds: number, fn: () => Promise<unknown>) {
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  return { p95: p95(times), max: Math.max(...times), first: times[0]! };
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('perf-dashboard@example.com');
  const t = performance.now();
  w = await seedWorkspace(c, COUNT);
  report(`seeded ${COUNT} transactions in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}, 600_000);
afterAll(() => h.close());

describe(`dashboard with ${COUNT} transactions (NFR-07)`, () => {
  it('the seed is consistent: account balances from the read model equal the postings', async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const { rows } = await admin.query<{ id: string; total: string }>(
      `select ledger_account_id as id, sum(amount_minor)::text as total
         from app.posting where workspace_id = $1 group by 1`,
      [w.workspaceId],
    );
    await admin.end();
    const posted = new Map(rows.map((r) => [r.id, BigInt(r.total)]));
    const accounts = (await c.get(w.url('/accounts'))).body.data as {
      id: string;
      type: string;
      balance: { amount: string };
    }[];
    expect(accounts.length).toBe(5);
    for (const a of accounts) {
      const natural = a.type === 'liability' ? -(posted.get(a.id) ?? 0n) : (posted.get(a.id) ?? 0n);
      expect(BigInt(a.balance.amount), a.id).toBe(natural);
    }
    const d = await c.get(w.url('/dashboard'));
    expect(d.status).toBe(200);
    expect(BigInt(d.body.spent.amount)).toBeGreaterThan(0n);
    expect((await c.get(w.url('/transactions?limit=10'))).body.data).toHaveLength(10);
  });

  it('serves the Home page requests within budget', async () => {
    const paths = homeRequests(w.url);
    for (const path of paths) expect((await c.get(path)).status).toBe(200);
    const m = await measure(ROUNDS, () => Promise.all(paths.map((p) => c.get(p))));
    report(
      `home (6 parallel requests): p95 ${m.p95.toFixed(0)} ms, max ${m.max.toFixed(0)} ms, first ${m.first.toFixed(0)} ms`,
    );
    expect(m.p95).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('reports each request alone, and the other planning screens', async () => {
    for (const [name, path] of [
      ['workspace', w.url('')],
      ['accounts', w.url('/accounts')],
      ['transactions', w.url('/transactions?limit=10')],
      ['categories', w.url('/categories')],
      ['dashboard', w.url('/dashboard')],
      ['budget period', w.url(`/budgets/${w.budgetId}/periods/current`)],
      ['goals', w.url('/goals')],
      ['forecast 90d', w.url('/flow/forecast?days=90')],
      ['sankey', w.url('/flow/sankey')],
      ['calendar', w.url('/calendar')],
      ['net worth', w.url('/net-worth?months=12')],
    ] as const) {
      const m = await measure(8, () => c.get(path));
      report(`${name.padEnd(14)} p95 ${m.p95.toFixed(0).padStart(5)} ms`);
      // No screen may be slow enough to break the page budget on its own.
      expect(m.p95, name).toBeLessThan(2000);
    }
  }, 300_000);
});
