/**
 * Date format detection and parsing for statement columns (IMP-03). Formats are tried over the whole column;
 * day/month order is decided by values above 12 and, failing that, by which order gives monotonic dates.
 * Statements that print dates without a year (`10/02`) take it from the statement's dates (`StatementDates`).
 */
import { fromParts, isCalendarDate, parts, toEpochDay, type CalendarDate } from '@montra/domain';

export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYYMMDD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'MM/DD/YY',
  'DD/MM/YY',
  'DD.MM.YY',
  'D MMM YYYY',
  'MMM D YYYY',
  'DD-MMM-YY',
  'DD-MMM-YYYY',
  'MM/DD',
  'DD/MM',
] as const;
export type DateFormatId = (typeof DATE_FORMATS)[number];

/**
 * Where a statement's transactions fall: its period, or only its end (the closing date, or the upload day as a last
 * resort). A date printed without a year takes the year that puts it nearest this range, so on a statement running
 * from December into January the December dates get the earlier year. Without `start` the range is the year to `end`.
 */
export interface StatementDates {
  start?: CalendarDate | null;
  end: CalendarDate;
}

const MAX_DAYS_OUTSIDE = 183;

/** Stands in for the statement while only the format is being detected: a leap year, so 02/29 is a valid day. */
const DETECTION_DATES: StatementDates = { end: fromParts(2024, 12, 31) };

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  // German / French / Spanish abbreviations seen in exports
  mär: 3,
  mrz: 3,
  mai: 5,
  okt: 10,
  dez: 12,
  janv: 1,
  févr: 2,
  avr: 4,
  juil: 7,
  déc: 12,
  ene: 1,
  abr: 4,
  ago: 8,
  dic: 12,
};

const year2 = (yy: number) => (yy < 70 ? 2000 + yy : 1900 + yy);

function safe(y: number, m: number, d: number): CalendarDate | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isCalendarDate(s) && y >= 1990 && y <= 2100 ? fromParts(y, m, d) : null;
}

/** Strips a trailing time ("2026-01-05 14:03:22", "01/05/2026 2:03 PM") and surrounding quotes. */
const datePart = (s: string) =>
  s
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(AM|PM|Z|[+-]\d{2}:?\d{2})?$/i, '');

type Part = 'y' | 'yy' | 'm' | 'd' | 'mon';

/** Each format as a pattern plus the meaning of its capture groups. */
const PATTERNS: Record<DateFormatId, [RegExp, Part[]]> = {
  'YYYY-MM-DD': [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, ['y', 'm', 'd']],
  'YYYY/MM/DD': [/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, ['y', 'm', 'd']],
  YYYYMMDD: [/^(\d{4})(\d{2})(\d{2})$/, ['y', 'm', 'd']],
  'MM/DD/YYYY': [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, ['m', 'd', 'y']],
  'DD/MM/YYYY': [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, ['d', 'm', 'y']],
  'MM-DD-YYYY': [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, ['m', 'd', 'y']],
  'DD-MM-YYYY': [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, ['d', 'm', 'y']],
  'DD.MM.YYYY': [/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, ['d', 'm', 'y']],
  'MM/DD/YY': [/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, ['m', 'd', 'yy']],
  'DD/MM/YY': [/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, ['d', 'm', 'yy']],
  'DD.MM.YY': [/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/, ['d', 'm', 'yy']],
  'D MMM YYYY': [/^(\d{1,2})\.?\s+([a-zäéû]{3,5})\.?,?\s+(\d{4})$/i, ['d', 'mon', 'y']],
  'MMM D YYYY': [/^([a-zäéû]{3,5})\.?\s+(\d{1,2}),?\s+(\d{4})$/i, ['mon', 'd', 'y']],
  'DD-MMM-YY': [/^(\d{1,2})[- ]([a-zäéû]{3,5})[- ](\d{2})$/i, ['d', 'mon', 'yy']],
  'DD-MMM-YYYY': [/^(\d{1,2})[- ]([a-zäéû]{3,5})[- ](\d{4})$/i, ['d', 'mon', 'y']],
  'MM/DD': [/^(\d{1,2})\/(\d{1,2})$/, ['m', 'd']],
  'DD/MM': [/^(\d{1,2})\/(\d{1,2})$/, ['d', 'm']],
};

/**
 * The year for a month and day printed without one: the one nearest the statement's dates (ties: `end`'s year).
 * Null when every year puts it more than half a year away (29 February, far from a leap year).
 */
export function withYear(month: number, day: number, dates: StatementDates): CalendarDate | null {
  const end = toEpochDay(dates.end);
  const start = dates.start && dates.start <= dates.end ? toEpochDay(dates.start) : end - 365;
  const year = parts(dates.end).year;
  let best: CalendarDate | null = null;
  let bestDistance = Infinity;
  for (const y of [year, year - 1, year + 1]) {
    const date = safe(y, month, day);
    if (!date) continue;
    const e = toEpochDay(date);
    const distance = e < start ? start - e : e > end ? e - end : 0;
    if (distance < bestDistance) {
      best = date;
      bestDistance = distance;
    }
  }
  return bestDistance <= MAX_DAYS_OUTSIDE ? best : null;
}

/**
 * Parses one date cell. A format without a year (`MM/DD`) needs the statement's dates; without them it reads
 * nothing rather than guess a year.
 */
export function parseDate(
  input: string,
  format: DateFormatId,
  dates?: StatementDates | null,
): CalendarDate | null {
  const [re, order] = PATTERNS[format];
  const m = re.exec(datePart(input));
  if (!m) return null;
  let y = 0;
  let mo = 0;
  let d = 0;
  for (const [i, part] of order.entries()) {
    const v = m[i + 1]!;
    if (part === 'y') y = Number(v);
    else if (part === 'yy') y = year2(Number(v));
    else if (part === 'm') mo = Number(v);
    else if (part === 'd') d = Number(v);
    else mo = MONTHS[v.toLowerCase().replace('.', '')] ?? 0;
  }
  if (!order.includes('y') && !order.includes('yy')) return dates ? withYear(mo, d, dates) : null;
  return safe(y, mo, d);
}

export interface DateDetection {
  format: DateFormatId;
  /** Share of non-empty values that parse. */
  rate: number;
  /** True when day/month order could not be decided from the data. */
  ambiguous: boolean;
}

/**
 * Picks the format that parses the most values. MM/DD vs DD/MM: any first part > 12 means DD first and any
 * second part > 12 means MM first; otherwise the order that keeps the dates monotonic wins, then `preferDayFirst`.
 * Formats without a year are tried against `dates` when given, else against a stand-in year.
 */
export function detectDateFormat(
  values: string[],
  preferDayFirst = false,
  dates?: StatementDates | null,
): DateDetection | null {
  const sample = values
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 500);
  if (sample.length === 0) return null;
  const scored = DATE_FORMATS.map((f) => ({
    f,
    ok: sample.map((v) => parseDate(v, f, dates ?? DETECTION_DATES)),
  }))
    .map(({ f, ok }) => ({ f, ok, rate: ok.filter(Boolean).length / sample.length }))
    .filter((x) => x.rate > 0);
  if (scored.length === 0) return null;
  const bestRate = Math.max(...scored.map((s) => s.rate));
  const top = scored.filter((s) => s.rate === bestRate);
  if (top.length === 1) return { format: top[0]!.f, rate: bestRate, ambiguous: false };
  // Several formats parse everything: only day/month order differs. Prefer the one with monotonic dates.
  const monotonic = (dates: (CalendarDate | null)[]) => {
    const days = dates.filter(Boolean).map((d) => toEpochDay(d!));
    let up = 0;
    let down = 0;
    for (let i = 1; i < days.length; i++) {
      if (days[i]! > days[i - 1]!) up++;
      else if (days[i]! < days[i - 1]!) down++;
    }
    return Math.max(up, down) - Math.min(up, down);
  };
  const ranked = top
    .map((t) => ({ ...t, mono: monotonic(t.ok) }))
    .sort(
      (a, b) =>
        b.mono - a.mono ||
        (preferDayFirst ? dayFirstRank(a.f) - dayFirstRank(b.f) : dayFirstRank(b.f) - dayFirstRank(a.f)),
    );
  const ambiguous = ranked.length > 1 && ranked[0]!.mono === ranked[1]!.mono;
  return { format: ranked[0]!.f, rate: bestRate, ambiguous };
}

const dayFirstRank = (f: DateFormatId) => (f.startsWith('DD') || f.startsWith('D ') ? 0 : 1);
