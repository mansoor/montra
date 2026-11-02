import { isCalendarDate, isCurrencyCode } from '@montra/domain';

/**
 * FX rate sources (CUR-05, ADR-0014). Rates are stored as published: ECB quotes every currency against EUR,
 * Open Exchange Rates against USD. Parsing is strict; a row that doesn't look right is dropped, never guessed.
 */
export interface FxRow {
  date: string;
  base: string;
  quote: string;
  /** Decimal string as published, e.g. "1.0912". */
  rate: string;
}

export type FxSourceId = 'ecb' | 'oxr';

/** The subset of `fetch` the sources use, so tests can serve recorded files. */
export type HttpGet = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const RATE = /^\d{1,10}(\.\d{1,10})?$/;

/**
 * Parses an ECB euro reference-rate file (`eurofxref-daily.xml`, `-hist-90d.xml`, `-hist.xml`):
 * `<Cube time="YYYY-MM-DD"><Cube currency="USD" rate="1.0912"/>…</Cube>`.
 */
export function parseEcbXml(xml: string): FxRow[] {
  const rows: FxRow[] = [];
  const day = /<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>([\s\S]*?)<\/Cube>/g;
  const quote = /<Cube\s+currency=["']([A-Z]{3})["']\s+rate=["']([0-9.]+)["']\s*\/>/g;
  for (const [, date, body] of xml.matchAll(day)) {
    if (!isCalendarDate(date!)) continue;
    for (const [, currency, rate] of body!.matchAll(quote)) {
      if (currency === 'EUR' || !isCurrencyCode(currency!) || !RATE.test(rate!) || Number(rate) <= 0)
        continue;
      rows.push({ date: date!, base: 'EUR', quote: currency!, rate: rate! });
    }
  }
  return rows;
}

/**
 * Parses an Open Exchange Rates response (`latest.json`, `historical/YYYY-MM-DD.json`):
 * `{ timestamp, base: "USD", rates: { EUR: 0.9164, … } }`. Rates arrive as JSON numbers; they are written
 * back as decimal strings with at most 10 places (OXR publishes 6).
 */
export function parseOxrJson(json: string, date?: string): FxRow[] {
  const body = JSON.parse(json) as { timestamp?: number; base?: string; rates?: Record<string, unknown> };
  const base = body.base;
  if (!base || !isCurrencyCode(base) || !body.rates) return [];
  const day = date ?? (body.timestamp ? new Date(body.timestamp * 1000).toISOString().slice(0, 10) : null);
  if (!day || !isCalendarDate(day)) return [];
  const rows: FxRow[] = [];
  for (const [quote, value] of Object.entries(body.rates)) {
    if (quote === base || !isCurrencyCode(quote) || typeof value !== 'number' || !(value > 0)) continue;
    const rate = trimDecimal(value.toFixed(10));
    if (RATE.test(rate)) rows.push({ date: day, base, quote, rate });
  }
  return rows;
}

const trimDecimal = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

export const ECB_FILES = {
  daily: 'eurofxref-daily.xml',
  recent: 'eurofxref-hist-90d.xml',
  full: 'eurofxref-hist.xml',
} as const;

export async function fetchEcb(
  get: HttpGet,
  baseUrl: string,
  file: keyof typeof ECB_FILES,
): Promise<FxRow[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/${ECB_FILES[file]}`;
  const res = await get(url);
  if (!res.ok) throw new Error(`ECB ${ECB_FILES[file]} returned HTTP ${res.status}`);
  return parseEcbXml(await res.text());
}

/** Latest OXR rates. The app id is a credential: it goes in the query string OXR requires, never in logs. */
export async function fetchOxrLatest(get: HttpGet, baseUrl: string, appId: string): Promise<FxRow[]> {
  const res = await get(`${baseUrl.replace(/\/$/, '')}/latest.json?app_id=${encodeURIComponent(appId)}`);
  if (!res.ok) throw new Error(`Open Exchange Rates returned HTTP ${res.status}`);
  return parseOxrJson(await res.text());
}
