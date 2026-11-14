/**
 * Item search on the phone (RCP-09): what was spent on an item ("milk") across receipts, over a period that starts
 * at three months and can be widened. The pure part: periods and their start dates.
 */
import { addMonths, type CalendarDate } from '@montra/domain';

export const ITEM_PERIODS = ['3m', '6m', '1y', '2y', 'all'] as const;
export type ItemPeriod = (typeof ITEM_PERIODS)[number];

const MONTHS: Record<ItemPeriod, number | null> = { '3m': 3, '6m': 6, '1y': 12, '2y': 24, all: null };

/** Before any receipt Montra can hold: "all" searches from here. */
const EVERYTHING = '1970-01-01';

/** The first day the period covers, ending today. */
export function periodFrom(today: CalendarDate, period: ItemPeriod): string {
  const months = MONTHS[period];
  return months === null ? EVERYTHING : addMonths(today, -months);
}

/** The next longer period, or null when the search already covers everything. */
export function widerPeriod(period: ItemPeriod): ItemPeriod | null {
  const i = ITEM_PERIODS.indexOf(period);
  return ITEM_PERIODS[i + 1] ?? null;
}

/** A search box entry worth sending: trimmed, at most 100 characters, or null when empty. */
export function itemQuery(text: string): string | null {
  const q = text.trim().replace(/\s+/g, ' ').slice(0, 100);
  return q ? q : null;
}
