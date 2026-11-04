/**
 * Report screen helpers (RPT-01..04): the URL's filters as a report's filters and back, and a chart's series from report rows. Pure, so
 * a saved report, a shared link and the filter bar all read the same way.
 */
import type { ReportDto, ReportFiltersInput } from '@montra/api-client';

export interface FilterValues {
  from?: string;
  to?: string;
  entityId?: string;
  accountIds?: string;
  categoryIds?: string;
  tags?: string;
  propertyId?: string;
  memberId?: string;
  groupBy?: string;
}

export const FILTER_KEYS = [
  'from',
  'to',
  'entityId',
  'accountIds',
  'categoryIds',
  'tags',
  'propertyId',
  'memberId',
  'groupBy',
] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f-]{36}$/i;
const list = (v: string | undefined, valid: (s: string) => boolean) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && valid(s));

/** Only what's well formed goes to the API: a hand-edited or old link shouldn't produce an error page. */
export function filtersFromParams(sp: Record<string, string | undefined>): ReportFiltersInput {
  const out: ReportFiltersInput = {};
  if (sp.from && DATE.test(sp.from)) out.from = sp.from as ReportFiltersInput['from'];
  if (sp.to && DATE.test(sp.to)) out.to = sp.to as ReportFiltersInput['to'];
  if (sp.entityId && ID.test(sp.entityId)) out.entityId = sp.entityId;
  if (sp.propertyId && ID.test(sp.propertyId)) out.propertyId = sp.propertyId;
  if (sp.memberId && (ID.test(sp.memberId) || sp.memberId === 'household')) out.memberId = sp.memberId;
  const accounts = list(sp.accountIds, (s) => ID.test(s));
  if (accounts.length) out.accountIds = accounts;
  const categories = list(sp.categoryIds, (s) => ID.test(s));
  if (categories.length) out.categoryIds = categories;
  const tags = list(sp.tags, (s) => s.length <= 100);
  if (tags.length) out.tags = tags;
  if (sp.groupBy && ['category', 'payee', 'tag', 'store', 'item'].includes(sp.groupBy)) {
    out.groupBy = sp.groupBy as ReportFiltersInput['groupBy'];
  }
  return out;
}

/** Filters for the URL or a saved report, leaving out what's empty. */
export function filtersToParams(f: FilterValues): URLSearchParams {
  const q = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v) q.set(k, v);
  }
  return q;
}

/** A saved report's filters, which may hold arrays, as the strings the URL uses. */
export function savedToParams(filters: Record<string, unknown>): URLSearchParams {
  const values: FilterValues = {};
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (typeof v === 'string') values[k] = v;
    else if (Array.isArray(v)) values[k] = v.filter((x) => typeof x === 'string').join(',');
  }
  return filtersToParams(values);
}

export interface ChartBar {
  label: string;
  value: bigint;
  key: string;
}

/** A report's first value column as bars, largest stated first, for a simple chart that needs no library. */
export function chartBars(report: Pick<ReportDto, 'chart' | 'rows'>, limit = 12): ChartBar[] {
  const chart = report.chart;
  if (!chart) return [];
  const y = chart.y[0]!;
  return report.rows
    .filter((r) => !r.emphasis && r.cells[y] !== null && r.cells[y] !== undefined)
    .slice(0, limit)
    .map((r) => ({ key: r.key, label: r.cells[chart.x] ?? '', value: BigInt(r.cells[y]!) }));
}

/** A line chart's series from a report's rows: labels and one list of minor-unit strings per column. */
export function chartLines(report: Pick<ReportDto, 'chart' | 'rows'>) {
  const chart = report.chart;
  if (!chart) return null;
  const rows = report.rows.filter((r) => !r.emphasis);
  return {
    labels: rows.map((r) => r.cells[chart.x] ?? ''),
    series: chart.y.map((key) => ({ key, values: rows.map((r) => r.cells[key] ?? '0') })),
  };
}

/** Bar widths as a share of the largest, for drawing only. */
export function barPercent(value: bigint, largest: bigint): number {
  if (largest <= 0n || value <= 0n) return 0;
  return Number((value * 1000n) / largest) / 10;
}

/** Bytes for people. */
export function formatBytes(bytes: string | bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Minutes after midnight as a time input's value, and back. */
export const minutesToTime = (m: number | null): string =>
  m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function timeToMinutes(t: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v < 1440 ? v : null;
}
