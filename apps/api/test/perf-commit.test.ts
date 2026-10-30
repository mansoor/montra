import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-perf-')) });
  h.app.get(ImportJobs).register();
});
afterAll(() => h.close());

describe('import throughput', () => {
  // 300 rows in CI; PERF_ROWS=1000 (or more) for a local benchmark. Budget: 30 ms per committed row.
  const ROWS = Number(process.env.PERF_ROWS ?? 300);
  it(`parses and commits a ${ROWS}-row statement within budget`, async () => {
    const c = h.as('perf@example.com');
    const ws = (await c.post('/v1/workspaces', { name: 'Perf', baseCurrency: 'USD' })).body;
    const acct = (await c.post(`/v1/workspaces/${ws.id}/accounts`, { name: 'Checking', kind: 'checking' }))
      .body.id;
    const lines = ['Date,Description,Amount'];
    for (let i = 0; i < ROWS; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 5) * 86_400_000).toISOString().slice(0, 10);
      lines.push(
        `${d},"${['TRADER JOES #1', 'SHELL OIL 123', 'NETFLIX.COM', 'ACME PAYROLL', 'BLUE BOTTLE'][i % 5]} ${i}",${i % 5 === 3 ? '2500.00' : '-12.34'}`,
      );
    }
    const boundary = '----perf';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.csv"\r\n\r\n`),
      Buffer.from(lines.join('\n')),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await h.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws.id}/uploads`,
      headers: {
        authorization: 'Bearer dev:perf@example.com',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    const batch = (
      await c.post(`/v1/workspaces/${ws.id}/imports`, { fileId: JSON.parse(up.body).fileId, accountId: acct })
    ).body;
    const worker = h.app.get(Worker);
    let t = performance.now();
    await worker.drain();
    const parseMs = performance.now() - t;
    await c.post(`/v1/workspaces/${ws.id}/imports/${batch.id}/commit`);
    t = performance.now();
    await worker.drain();
    const commitMs = performance.now() - t;
    const done = (await c.get(`/v1/workspaces/${ws.id}/imports/${batch.id}`)).body;
    expect(done.counts.added).toBe(ROWS);
    expect(commitMs).toBeLessThan(ROWS * 30);
    console.log(`${ROWS} rows: parse ${parseMs.toFixed(0)} ms, commit ${commitMs.toFixed(0)} ms`);
  }, 300_000);
});
