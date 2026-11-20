/**
 * SimpleFIN's limits as Montra keeps them (ADR-0055 §5), and the rules that follow from them, as pure functions. The
 * numbers are the API's settings (SIMPLEFIN_*), so when SimpleFIN changes a limit only the setting changes.
 */
import { addDays, type CalendarDate } from '@montra/domain';
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
