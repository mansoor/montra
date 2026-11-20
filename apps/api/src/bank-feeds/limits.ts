/**
 * SimpleFIN's limits as Montra keeps them (ADR-0055 §5), and the rules that follow from them, as pure functions. The
 * numbers are the API's settings (SIMPLEFIN_*), so when SimpleFIN changes a limit only the setting changes.
 */
import { addDays, todayIn, type CalendarDate } from '@montra/domain';
import type { AppConfig } from '../config.js';

export interface SimpleFinLimits {
  /** Hosts Montra may claim a token at and fetch from. */
  allowedHosts: readonly string[];
  /** Development and tests: a stand-in on this machine over plain http. Never in production. */
  allowLocalHttp: boolean;
  /** Requests Montra makes per feed per UTC day, at most. */
  requestsPerDay: number;
  /** The longest range one request asks for, in days; also how far back a first sync reaches. */
  maxWindowDays: number;
  /** Days each sync goes back over the last. */
  overlapDays: number;
  /** Scheduled syncs per feed per day. */
  syncsPerDay: number;
  /** The least time between two Sync now presses for one feed. */
  syncNowMinutes: number;
  timeoutMs: number;
  maxResponseBytes: number;
}

export function simpleFinLimits(config: AppConfig): SimpleFinLimits {
  return {
    allowedHosts: config.SIMPLEFIN_ALLOWED_HOSTS,
    allowLocalHttp: config.SIMPLEFIN_ALLOW_LOCAL_HTTP,
    requestsPerDay: config.SIMPLEFIN_REQUESTS_PER_DAY,
    maxWindowDays: config.SIMPLEFIN_MAX_WINDOW_DAYS,
    overlapDays: config.SIMPLEFIN_OVERLAP_DAYS,
    syncsPerDay: config.SIMPLEFIN_SYNCS_PER_DAY,
    syncNowMinutes: config.SIMPLEFIN_SYNC_NOW_MINUTES,
    timeoutMs: config.SIMPLEFIN_TIMEOUT_SECONDS * 1000,
    maxResponseBytes: config.SIMPLEFIN_MAX_RESPONSE_BYTES,
  };
}

/**
 * The earliest date a feed can bring, today: one request runs up to tomorrow (exclusive) and may span at most
 * `maxWindowDays`, so it starts no earlier than `maxWindowDays - 1` days ago.
 */
export function earliestStart(
  today: CalendarDate,
  limits: Pick<SimpleFinLimits, 'maxWindowDays'>,
): CalendarDate {
  return addDays(today, -(limits.maxWindowDays - 1));
}

/**
 * §5, owner's answer 2: the start date offered when linking. The day after the account's latest transaction, so the
 * feed never re-imports a period already in the account; at most `maxWindowDays` back; never after today.
 */
export function defaultStartDate(
  latestTransaction: CalendarDate | null,
  today: CalendarDate,
  limits: Pick<SimpleFinLimits, 'maxWindowDays'>,
): CalendarDate {
  const earliest = earliestStart(today, limits);
  if (latestTransaction === null) return earliest;
  const next = addDays(latestTransaction, 1);
  if (next < earliest) return earliest;
  return next > today ? today : next;
}

/** Why a start date an owner picked can't be used, or null when it can. */
export function startDateProblem(
  chosen: CalendarDate,
  today: CalendarDate,
  limits: Pick<SimpleFinLimits, 'maxWindowDays'>,
): 'too_early' | 'in_future' | null {
  if (chosen > today) return 'in_future';
  if (chosen < earliestStart(today, limits)) return 'too_early';
  return null;
}

/** What a sync knows about one linked account. */
export interface WindowAccount {
  startDate: CalendarDate;
  /** The latest date imported or waiting in preview; null before the first sync. */
  syncedThrough: CalendarDate | null;
}

/** One request's range: `from` on or after, `to` before (as SimpleFIN's `start-date` and `end-date`). */
export interface SyncWindow {
  from: CalendarDate;
  to: CalendarDate;
  /** Some account last synced longer ago than one request reaches: the days between are left for an upload (§5). */
  gap: boolean;
}

/**
 * §5: one request for all linked accounts, from the earliest any of them needs (its cursor less the overlap, never
 * before its start date) to tomorrow, never longer than `maxWindowDays`. Null with no account to sync.
 */
export function syncWindow(
  accounts: readonly WindowAccount[],
  today: CalendarDate,
  limits: Pick<SimpleFinLimits, 'maxWindowDays' | 'overlapDays'>,
): SyncWindow | null {
  const due = accounts.filter((a) => a.startDate <= today);
  if (!due.length) return null;
  const needs = due.map((a) => {
    if (a.syncedThrough === null) return a.startDate;
    const back = addDays(a.syncedThrough, -limits.overlapDays);
    return back < a.startDate ? a.startDate : back;
  });
  const wanted = needs.reduce((min, d) => (d < min ? d : min));
  const earliest = earliestStart(today, limits);
  // A gap only when the days between are new to the account: the overlap reaching back further is not a gap.
  const gap = due.some((a) => {
    const firstNew = a.syncedThrough === null ? a.startDate : addDays(a.syncedThrough, 1);
    return firstNew < earliest;
  });
  return { from: wanted < earliest ? earliest : wanted, to: addDays(today, 1), gap };
}

/** The UTC day a request counts against. */
export function utcDay(now: Date): CalendarDate {
  return now.toISOString().slice(0, 10) as CalendarDate;
}

/** §5: requests left today for a feed, from its counter (which belongs to `requestsDay`, a UTC date). */
export function requestsLeft(
  counter: { requestsDay: CalendarDate | null; requestsToday: number },
  now: Date,
  limits: Pick<SimpleFinLimits, 'requestsPerDay'>,
): number {
  const used = counter.requestsDay === utcDay(now) ? counter.requestsToday : 0;
  return Math.max(0, limits.requestsPerDay - used);
}

/** When Sync now may be pressed again, or null when it may now. */
export function syncNowAfter(
  lastManual: Date | null,
  now: Date,
  limits: Pick<SimpleFinLimits, 'syncNowMinutes'>,
): Date | null {
  if (!lastManual) return null;
  const next = new Date(lastManual.getTime() + limits.syncNowMinutes * 60_000);
  return next > now ? next : null;
}

/** Local wall time minus UTC, in milliseconds, at instant `t` in `timeZone`. */
function offsetAt(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - t;
}

/**
 * The instant `minute` minutes after local midnight of `date` in `timeZone`. A time a daylight-saving change skips
 * lands just after it; one it repeats takes the first.
 */
export function zonedInstant(date: CalendarDate, minute: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, minute);
  const first = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(first, timeZone));
}

/**
 * §5: the next scheduled sync after `now`: `syncMinute` minutes after the workspace's local midnight (a random minute
 * of the early morning, chosen at connect), then every 24 hours / SIMPLEFIN_SYNCS_PER_DAY.
 */
export function nextSyncAt(
  now: Date,
  timeZone: string,
  syncMinute: number,
  limits: Pick<SimpleFinLimits, 'syncsPerDay'>,
): Date {
  const step = Math.floor(1440 / limits.syncsPerDay);
  const today = todayIn(timeZone, now);
  let best: Date | null = null;
  for (const day of [addDays(today, -1), today, addDays(today, 1)]) {
    for (let k = 0; k < limits.syncsPerDay; k++) {
      const at = zonedInstant(day, syncMinute + k * step, timeZone);
      if (at > now && (!best || at < best)) best = at;
    }
  }
  return best ?? new Date(now.getTime() + 86_400_000);
}

/** The start of the next UTC day: when a feed held at its daily limit may ask again (§5). */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
