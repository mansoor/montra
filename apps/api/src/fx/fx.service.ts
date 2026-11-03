import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { DbContext, Trx } from '@montra/db';
import {
  addDays,
  decimalToString,
  divideDecimal,
  parseDecimal,
  type CalendarDate,
  type CurrencyCode,
  type Decimal,
} from '@montra/domain';
import type { FxRateDto } from '@montra/schemas';
import { unprocessable } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import type { Worker } from '../jobs/queue.js';
import { fetchEcb, fetchOxrLatest, type FxRow, type FxSourceId, type HttpGet } from './sources.js';

export const FX_HTTP = Symbol('FX_HTTP');

/** Sources in order of preference, and the currency each one quotes against. */
const SOURCES: readonly { id: FxSourceId; base: string }[] = [
  { id: 'ecb', base: 'EUR' },
  { id: 'oxr', base: 'USD' },
];
/** Weekends and holidays have no reference rate: use the latest one published within this many days. */
export const FX_LOOKBACK_DAYS = 7;
const RATE_SCALE = 10;
const CHUNK = 2_000;

export interface FxRefreshResult extends Record<string, unknown> {
  ecb: number;
  oxr: number | null;
  /** Rows inserted or changed (unchanged rows are not rewritten). */
  changed: number;
  oxrError?: string;
}

/** Rates loaded for a window, answering lookups without further queries (receipt matching, posting). */
export class RateTable {
  constructor(private readonly legs: ReadonlyMap<string, string>) {}

  /** Units of `quote` per one `base` on `date`, or the latest earlier day within the lookback. */
  get(base: string, quote: string, date: CalendarDate): FxRateDto | null {
    if (base === quote) {
      return { base, quote, rate: '1', rateDate: date, requestedDate: date, source: 'ecb', cross: false };
    }
    for (let back = 0; back <= FX_LOOKBACK_DAYS; back++) {
      const day = addDays(date, -back);
      for (const s of SOURCES) {
        const from = base === s.base ? '1' : this.legs.get(`${s.id}|${day}|${base}`);
        const to = quote === s.base ? '1' : this.legs.get(`${s.id}|${day}|${quote}`);
        if (!from || !to) continue;
        const rate =
          base === s.base
            ? to
            : trim(decimalToString(divideDecimal(parseDecimal(to), parseDecimal(from), RATE_SCALE)));
        return {
          base,
          quote,
          rate,
          rateDate: day,
          requestedDate: date,
          source: s.id,
          cross: base !== s.base && quote !== s.base,
        };
      }
    }
    return null;
  }

  /** The `RateLookup` shape `@montra/importers` uses for receipt matching. */
  lookup = (from: CurrencyCode, to: CurrencyCode, date: CalendarDate): Decimal | null => {
    const r = this.get(from, to, date);
    return r ? parseDecimal(r.rate) : null;
  };
}

/**
 * Daily and historical exchange rates (CUR-05, ADR-0014): loads ECB (and Open Exchange Rates when
 * `OXR_APP_ID` is set) into `ref.fx_rate`, and answers rate lookups with cross rates and a weekend lookback.
 */
@Injectable()
export class FxRatesService {
  private readonly logger = new Logger('FxRates');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FX_HTTP) private readonly http: HttpGet,
  ) {}

  /**
   * Fetches and stores rates. `daily` loads ECB's last 90 days (so missed days fill themselves in) plus
   * OXR's latest; `full` loads ECB's history since 1999. ECB failing fails the run (the job retries);
   * OXR failing is reported and ECB rates are still stored.
   */
  async refresh(mode: 'daily' | 'full'): Promise<FxRefreshResult> {
    const ecb = await fetchEcb(this.http, this.config.FX_ECB_URL, mode === 'full' ? 'full' : 'recent');
    let oxr: FxRow[] | null = null;
    let oxrError: string | undefined;
    if (this.config.OXR_APP_ID) {
      try {
        oxr = await fetchOxrLatest(this.http, this.config.OXR_URL, this.config.OXR_APP_ID);
      } catch (err) {
        oxrError = (err as Error).message;
        this.logger.warn(`Open Exchange Rates refresh failed: ${oxrError}`);
      }
    }
    const changed = (await this.store('ecb', ecb)) + (oxr ? await this.store('oxr', oxr) : 0);
    return { ecb: ecb.length, oxr: oxr?.length ?? null, changed, ...(oxrError ? { oxrError } : {}) };
  }

  private async store(source: FxSourceId, rows: readonly FxRow[]): Promise<number> {
    let changed = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = JSON.stringify(rows.slice(i, i + CHUNK));
      changed += await this.db.run({}, async (trx) => {
        const { rows: r } = await sql<{
          n: number;
        }>`select app.upsert_fx_rates(${source}, ${chunk}::jsonb) as n`.execute(trx);
        return r[0]!.n;
      });
    }
    return changed;
  }

  /** Loads every stored rate needed for `currencies` between `start` and `end` (plus the lookback). */
  async table(
    trx: Trx,
    currencies: readonly string[],
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<RateTable> {
    // A source's own base has no row in that source, but it is a quote in the others (USD in ECB, EUR in OXR).
    const quotes = [...new Set(currencies)];
    const legs = new Map<string, string>();
    if (quotes.length > 0) {
      const rows = await trx
        .selectFrom('ref.fx_rate')
        .select(['rate_date', 'quote', 'rate', 'source'])
        .where('quote', 'in', quotes)
        .where('rate_date', '>=', addDays(start, -FX_LOOKBACK_DAYS))
        .where('rate_date', '<=', end)
        .where((eb) => eb.or(SOURCES.map((s) => eb.and([eb('source', '=', s.id), eb('base', '=', s.base)]))))
        .execute();
      for (const r of rows) legs.set(`${r.source}|${r.rate_date}|${r.quote}`, trim(r.rate));
    }
    return new RateTable(legs);
  }

  /** The day's reference rate as a decimal, or a 422 asking the user to enter one (CUR-05). */
  async requireRate(trx: Trx, from: string, to: string, date: CalendarDate): Promise<Decimal> {
    const rate = (await this.table(trx, [from, to], date, date)).get(from, to, date);
    if (!rate) {
      throw unprocessable('fx.no_rate', `No ${from}→${to} rate is available for ${date}; enter the rate`);
    }
    return parseDecimal(rate.rate);
  }

  /** One rate for the API (CUR-05). */
  rate(ctx: DbContext, base: string, quote: string, date: CalendarDate): Promise<FxRateDto | null> {
    return this.db.run(ctx, async (trx) =>
      (await this.table(trx, [base, quote], date, date)).get(base, quote, date),
    );
  }

  /** Registers the jobs on the worker's `schedule` queue. */
  register(worker: Worker): void {
    worker.register('fx.daily', async () => {
      // Schedule the next run first, so a failing source can't stop the daily cycle.
      await this.schedule(nextDailyRun(new Date()));
      return this.refresh('daily');
    });
    worker.register('fx.backfill', () => this.refresh('full'));
  }

  /** Makes sure a daily refresh is queued; `at` defaults to now (worker start-up catches up at once). */
  async schedule(at: Date = new Date()): Promise<string> {
    return this.db.run({}, async (trx) => {
      const { rows } = await sql<{
        id: string;
      }>`select app.schedule_system_job('schedule', 'fx.daily', ${at}) as id`.execute(trx);
      return rows[0]!.id;
    });
  }
}

/** ECB publishes around 16:00 CET; the daily run is at 16:00 UTC, the next day if that time has passed. */
export function nextDailyRun(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** "1.0912000000" → "1.0912" (numeric(20, 10) comes back zero-padded). */
const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
