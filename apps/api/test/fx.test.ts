/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calendarDate, decimalToString } from '@montra/domain';
import { CONFIG, type AppConfig } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { Worker } from '../src/jobs/queue.js';
import { FxRatesService, nextDailyRun } from '../src/fx/fx.service.js';
import { parseEcbXml, parseOxrJson, type HttpGet } from '../src/fx/sources.js';
import { fixtureHttp, fxFixture as fixture } from './fx-fixtures.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let c: Client;
let admin: pg.Client;
let config: AppConfig;
let wsUrl: (p: string) => string;
const EMAIL = 'traveller@example.com';

const service = (http: HttpGet, overrides: Partial<AppConfig> = {}) =>
  new FxRatesService(h.app.get(Db), { ...config, OXR_APP_ID: 'test-app-id', ...overrides }, http);
const systemJobs = async () =>
  (
    await admin.query<{ status: string; run_after: Date; result: any; error: string | null }>(
      `select status, run_after, result, error from app.job where workspace_id is null and type = 'fx.daily' order by created_at`,
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  config = h.app.get(CONFIG);
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Trips', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsUrl = (p) => `/v1/workspaces/${ws.id}${p}`;
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('rate sources (CUR-05)', () => {
  it('parses ECB reference rates and drops what it cannot trust', () => {
    const rows = parseEcbXml(fixture('eurofxref-hist-90d.xml'));
    expect(rows).toHaveLength(12); // 3 days × 4 currencies; ZZZ and the malformed SEK rate are dropped
    expect(rows[0]).toEqual({ date: '2026-10-30', base: 'EUR', quote: 'USD', rate: '1.0912' });
    expect(rows.some((r) => r.quote === 'ZZZ' || r.quote === 'SEK')).toBe(false);
  });

  it('parses Open Exchange Rates into decimal strings, skipping the base and bad values', () => {
    const rows = parseOxrJson(fixture('oxr-latest.json'));
    expect(rows).toEqual([
      { date: '2026-10-30', base: 'USD', quote: 'AED', rate: '3.6725' },
      { date: '2026-10-30', base: 'USD', quote: 'EUR', rate: '0.916422' },
      { date: '2026-10-30', base: 'USD', quote: 'JPY', rate: '149.7615' },
    ]);
  });

  it('runs daily at 16:00 UTC, after ECB publishes', () => {
    expect(nextDailyRun(new Date('2026-10-30T09:00:00Z')).toISOString()).toBe('2026-10-30T16:00:00.000Z');
    expect(nextDailyRun(new Date('2026-10-30T16:00:00Z')).toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });
});

describe('the fx.daily job (ADR-0014)', () => {
  beforeEach(async () => {
    await admin.query(`delete from app.job where workspace_id is null and type like 'fx.%'`);
  });

  it('loads ECB and OXR rates, then queues the next run', async () => {
    const http = fixtureHttp();
    const worker = h.app.get(Worker);
    service(http.get).register(worker);
    const fx = service(http.get);
    const first = await fx.schedule(new Date(Date.now() - 1000));
    expect(await fx.schedule(new Date(Date.now() - 500))).toBe(first); // one queued run per type
    expect(await worker.drain(['schedule'])).toBe(1);

    const jobs = await systemJobs();
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'queued']);
    expect(jobs[0]!.result).toMatchObject({ ecb: 12, oxr: 3 });
    expect(jobs[1]!.run_after.getUTCHours()).toBe(16);
    expect(http.urls.map((u) => u.replace(/app_id=[^&]+/, 'app_id=…'))).toEqual([
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',
      'https://openexchangerates.org/api/latest.json?app_id=…',
    ]);
  });

  it('rewrites nothing when the rates are unchanged', async () => {
    const http = fixtureHttp();
    await service(http.get).refresh('daily');
    expect(await service(http.get).refresh('daily')).toMatchObject({ ecb: 12, oxr: 3, changed: 0 });
  });

  it('keeps ECB rates when OXR fails, and fails (to retry) when ECB does', async () => {
    expect(await service(fixtureHttp({ oxr: true }).get).refresh('daily')).toMatchObject({
      ecb: 12,
      oxr: null,
      oxrError: 'Open Exchange Rates returned HTTP 503',
    });
    await expect(service(fixtureHttp({ ecb: true }).get).refresh('daily')).rejects.toThrow(/HTTP 503/);
  });

  it('skips OXR without an app id, and backfills ECB history on request', async () => {
    const http = fixtureHttp();
    expect(await service(http.get, { OXR_APP_ID: undefined }).refresh('full')).toMatchObject({
      ecb: 5,
      oxr: null,
    });
    expect(http.urls).toEqual(['https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml']);
    expect((await c.get(wsUrl('/fx/rates?base=EUR&quote=GBP&date=1999-01-04'))).body.rate).toBe('0.7111');
  });
});

describe('GET /fx/rates (CUR-05)', () => {
  beforeAll(async () => {
    await service(fixtureHttp().get).refresh('daily');
  });
  const rate = (q: string) => c.get(wsUrl(`/fx/rates?${q}`));

  it('returns direct ECB rates as published', async () => {
    expect((await rate('base=EUR&quote=USD&date=2026-10-30')).body).toEqual({
      base: 'EUR',
      quote: 'USD',
      rate: '1.0912',
      rateDate: '2026-10-30',
      requestedDate: '2026-10-30',
      source: 'ecb',
      cross: false,
    });
  });

  it('derives inverse and cross rates through EUR', async () => {
    expect((await rate('base=USD&quote=EUR&date=2026-10-29')).body).toMatchObject({
      rate: '0.9176837662',
      cross: false,
    });
    expect((await rate('base=usd&quote=jpy&date=2026-10-30')).body).toMatchObject({
      base: 'USD',
      quote: 'JPY',
      rate: '149.7617302053',
      cross: true,
    });
  });

  it('uses the latest rate within a week on weekends and holidays', async () => {
    expect((await rate('base=EUR&quote=USD&date=2026-11-01')).body).toMatchObject({
      rate: '1.0912',
      rateDate: '2026-10-30',
      requestedDate: '2026-11-01',
    });
    const stale = await rate('base=EUR&quote=USD&date=2026-11-07');
    expect(stale.status).toBe(404);
    expect(stale.body.code).toBe('fx.no_rate');
  });

  it('falls back to OXR for currencies ECB does not publish', async () => {
    expect((await rate('base=EUR&quote=AED&date=2026-10-30')).body).toMatchObject({
      rate: '4.0074332567',
      source: 'oxr',
      cross: true,
    });
  });

  it('answers 1 for the same currency, and rejects bad input and outsiders', async () => {
    expect((await rate('base=USD&quote=USD&date=2026-10-30')).body.rate).toBe('1');
    expect((await rate('base=USD&quote=XYZ&date=2026-10-30')).status).toBe(400);
    expect((await rate('base=USD&quote=EUR&date=2026-13-01')).status).toBe(400);
    expect(
      (await h.as('stranger@example.com').get(wsUrl('/fx/rates?base=EUR&quote=USD&date=2026-10-30'))).status,
    ).toBe(403);
  });

  it('serves receipt matching from one preloaded table', async () => {
    const db = h.app.get(Db);
    const table = await db.run({}, (trx) =>
      service(fixtureHttp().get).table(
        trx,
        ['EUR', 'JPY'],
        calendarDate('2026-10-28'),
        calendarDate('2026-10-30'),
      ),
    );
    expect(decimalToString(table.lookup('EUR', 'JPY', calendarDate('2026-10-28'))!)).toBe('162.8');
    expect(table.lookup('EUR', 'GBP', calendarDate('2026-10-28'))).toBeNull(); // GBP was not loaded
  });
});
