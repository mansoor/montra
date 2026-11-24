/**
 * The filters the Transactions, Review and Receipts lists share: a date window, merchant words, an amount range and
 * money in or out (plus account and category on Transactions). They live in the URL, so a filtered list can be
 * bookmarked, shared and reached with the back button. Pure, so the server pages and the filter bar read them the same.
 */
import { addDays, addMonths, calendarDate, isCalendarDate, todayIn, type CalendarDate } from '@montra/domain';
import { parseAmountInput } from './money';

export const RANGE_PRESETS = ['7d', '30d', '60d', '90d', '6m', '1y', 'all'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type Range = RangePreset | 'custom';
/** A list opens on the last 90 days unless the person chose another window. */
export const DEFAULT_RANGE: RangePreset = '90d';

export type ListScreen = 'transactions' | 'review' | 'receipts';

export interface ListFilters {
  range: Range;
  /** Custom range only; either side may be open. */
  from?: CalendarDate;
  to?: CalendarDate;
  merchant?: string;
  /** Receipts only: words anywhere on the receipt, the merchant or the text read off it (RCP-10). */
  text?: string;
  /** The amounts as typed, in the workspace currency's major units ("20", "99.50"). */
  min?: string;
  max?: string;
  dir?: 'in' | 'out';
  /** Transactions only. */
  account?: string;
  category?: string;
}

/** The URL keys the filter bar owns; anything else in the query (tabs, drill-downs) is left alone. */
export const FILTER_PARAMS = [
  'range',
  'from',
  'to',
  'merchant',
  'text',
  'min',
  'max',
  'dir',
  'account',
  'category',
] as const;

const ID = /^[0-9a-f-]{36}$/i;
const AMOUNT = /^[\d.,\s]{1,24}$/;

type Params = URLSearchParams | Record<string, string | string[] | undefined>;
const getter = (sp: Params) => (k: string) => {
  const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
};

/**
 * The filters in a URL. Only what is well formed is kept, so an old or hand-edited link shows a list, not an error.
 * `explicit` says whether the link names a window; when it doesn't, the person's remembered window applies. A `from` or
 * `to` without a `range` (a drill-down from a report) is a custom range.
 */
export function parseListFilters(sp: Params): { filters: ListFilters; explicit: boolean } {
  const get = getter(sp);
  const from = get('from');
  const to = get('to');
  const f: ListFilters = { range: DEFAULT_RANGE };
  if (from && isCalendarDate(from)) f.from = calendarDate(from);
  if (to && isCalendarDate(to)) f.to = calendarDate(to);
  const range = get('range');
  let explicit = true;
  if (range && (RANGE_PRESETS as readonly string[]).includes(range)) f.range = range as RangePreset;
  else if (range === 'custom' || f.from || f.to) f.range = 'custom';
  else explicit = false;
  if (f.range !== 'custom') {
    delete f.from;
    delete f.to;
  }
  const merchant = get('merchant');
  if (merchant) f.merchant = merchant.slice(0, 100);
  const text = get('text');
  if (text) f.text = text.slice(0, 200);
  const min = get('min');
  if (min && AMOUNT.test(min)) f.min = min;
  const max = get('max');
  if (max && AMOUNT.test(max)) f.max = max;
  const dir = get('dir');
  if (dir === 'in' || dir === 'out') f.dir = dir;
  const account = get('account');
  if (account && ID.test(account)) f.account = account;
  const category = get('category');
  if (category && ID.test(category)) f.category = category;
  return { filters: f, explicit };
}

/**
 * The filters as URL params, on top of the other params in `base` (a tab, a drill-down). The window is always written,
 * so a shared link opens on the same window whatever the reader's own choice is.
 */
export function listFiltersToParams(f: ListFilters, base?: URLSearchParams): URLSearchParams {
  const q = new URLSearchParams(base);
  for (const k of FILTER_PARAMS) q.delete(k);
  q.set('range', f.range);
  if (f.range === 'custom') {
    if (f.from) q.set('from', f.from);
    if (f.to) q.set('to', f.to);
  }
  if (f.merchant) q.set('merchant', f.merchant);
  if (f.text) q.set('text', f.text);
  if (f.min) q.set('min', f.min);
  if (f.max) q.set('max', f.max);
  if (f.dir) q.set('dir', f.dir);
  if (f.account) q.set('account', f.account);
  if (f.category) q.set('category', f.category);
  return q;
}

/**
 * The first day of a preset window ending today: the last 7 days are today and the 6 before it; the last 6 months
 * start the day after the same date 6 months ago (a month end clamps: 31 Aug → 28 Feb → from 1 Mar). There is no end,
 * so scheduled and future-dated items still show.
 */
export function presetStart(preset: RangePreset, today: CalendarDate): CalendarDate | undefined {
  switch (preset) {
    case '7d':
      return addDays(today, -6);
    case '30d':
      return addDays(today, -29);
    case '60d':
      return addDays(today, -59);
    case '90d':
      return addDays(today, -89);
    case '6m':
      return addDays(addMonths(today, -6), 1);
    case '1y':
      return addDays(addMonths(today, -12), 1);
    case 'all':
      return undefined;
  }
}

/** The dates to ask the API for. "Today" is the workspace's (TZ-01), not the browser's or the server's. */
export function listWindow(
  f: ListFilters,
  timeZone: string,
  now: Date = new Date(),
): { from?: CalendarDate; to?: CalendarDate } {
  if (f.range === 'custom') return { ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}) };
  const from = presetStart(f.range, todayIn(timeZone, now));
  return from ? { from } : {};
}

/** Whether what was typed in an amount field can go in the URL and to the API: digits and separators, a valid amount. */
export const isAmountText = (input: string, currency: string, locale?: string): boolean =>
  AMOUNT.test(input.trim()) && amountBound(input, currency, locale) !== undefined;

/** An amount as typed, as unsigned minor units for the API; undefined when it isn't a valid amount. */
export function amountBound(
  input: string | undefined,
  currency: string,
  locale?: string,
): string | undefined {
  if (!input) return undefined;
  const parsed = parseAmountInput(input, currency, locale);
  if (!parsed.ok) return undefined;
  return (parsed.minor < 0n ? -parsed.minor : parsed.minor).toString();
}

/** The query the list APIs take for these filters (the screen adds its own, such as a tab). */
export function listApiQuery(
  f: ListFilters,
  ws: { timeZone: string; currency: string; locale?: string },
  now: Date = new Date(),
): {
  from?: CalendarDate;
  to?: CalendarDate;
  merchant?: string;
  amountMin?: string;
  amountMax?: string;
  direction?: 'in' | 'out';
} {
  const amountMin = amountBound(f.min, ws.currency, ws.locale);
  const amountMax = amountBound(f.max, ws.currency, ws.locale);
  return {
    ...listWindow(f, ws.timeZone, now),
    ...(f.merchant ? { merchant: f.merchant } : {}),
    ...(amountMin ? { amountMin } : {}),
    ...(amountMax ? { amountMax } : {}),
    ...(f.dir ? { direction: f.dir } : {}),
  };
}

/** The window one step wider: the next preset up, or all time. A custom range loses its start. */
export function widen(f: ListFilters): ListFilters | null {
  if (f.range === 'custom') return f.from ? { ...f, from: undefined } : null;
  const i = RANGE_PRESETS.indexOf(f.range);
  if (f.range === 'all') return null;
  return { ...f, range: RANGE_PRESETS[i + 1]! };
}

/** Whether anything beyond the window narrows the list (what "Clear all" and the chips are for). */
export const hasFilters = (f: ListFilters): boolean =>
  f.range === 'custom' || Boolean(f.merchant || f.text || f.min || f.max || f.dir || f.account || f.category);

/** The filters gone, keeping the window (a custom range goes back to the default). */
export const clearFilters = (f: ListFilters): ListFilters => ({
  range: f.range === 'custom' ? DEFAULT_RANGE : f.range,
});

export type ChipKey = 'dates' | 'merchant' | 'text' | 'amount' | 'dir' | 'account' | 'category';

/** The active filters, one chip each, in the order the bar shows them. */
export function activeChips(f: ListFilters): ChipKey[] {
  const out: ChipKey[] = [];
  if (f.range === 'custom' && (f.from || f.to)) out.push('dates');
  if (f.merchant) out.push('merchant');
  if (f.text) out.push('text');
  if (f.min || f.max) out.push('amount');
  if (f.dir) out.push('dir');
  if (f.account) out.push('account');
  if (f.category) out.push('category');
  return out;
}

/** One filter removed. */
export function withoutChip(f: ListFilters, chip: ChipKey): ListFilters {
  switch (chip) {
    case 'dates':
      return { ...f, range: DEFAULT_RANGE, from: undefined, to: undefined };
    case 'amount':
      return { ...f, min: undefined, max: undefined };
    default:
      return { ...f, [chip]: undefined };
  }
}

// ----- The remembered window (this browser, as the theme and the sidebar are) -------------------------------------

const storageKey = (screen: ListScreen) => `montra.listWindow.${screen}`;

export function readStoredRange(screen: ListScreen): RangePreset | null {
  try {
    const v = localStorage.getItem(storageKey(screen));
    return v && (RANGE_PRESETS as readonly string[]).includes(v) ? (v as RangePreset) : null;
  } catch {
    return null;
  }
}

export function storeRange(screen: ListScreen, range: RangePreset): void {
  try {
    if (range === DEFAULT_RANGE) localStorage.removeItem(storageKey(screen));
    else localStorage.setItem(storageKey(screen), range);
  } catch {
    // Private mode or blocked storage: the window applies to this page only.
  }
}
