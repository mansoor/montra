/**
 * When a notification may go out (NOT-03). Quiet hours are local to the user and may run past midnight. Times are instants, because
 * this is about the wall clock rather than a transaction date; nothing here touches money.
 */

export interface QuietHours {
  /** Minutes after local midnight. */
  start: number;
  end: number;
}

const MINUTES_PER_DAY = 1440;

/** The local minute of the day, and the local date, for an instant in a time zone. */
export function localClock(at: Date, timeZone: string): { minutes: number; date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: weekdays.indexOf(get('weekday')) + 1,
  };
}

/** Whether a local minute falls in quiet hours. Start is included, end isn't; the same start and end means none. */
export function inQuietHours(minute: number, quiet: QuietHours): boolean {
  if (quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? minute >= quiet.start && minute < quiet.end
    : minute >= quiet.start || minute < quiet.end;
}

/** The earliest moment this may be delivered: now, or the end of quiet hours. */
export function deliveryTime(now: Date, timeZone: string, quiet: QuietHours | null): Date {
  if (!quiet) return now;
  const { minutes } = localClock(now, timeZone);
  if (!inQuietHours(minutes, quiet)) return now;
  const wait = (quiet.end - minutes + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return new Date(now.getTime() + wait * 60_000);
}

export type ChannelOutcome = 'send' | 'off' | 'capped' | 'none';

/**
 * What to do with one channel of one notification: off by preference, kept in-app past the daily cap, or sent. The cap counts what
 * actually went out today on either channel.
 */
export function channelOutcome(input: {
  enabled: boolean;
  hasDestination: boolean;
  sentToday: number;
  cap: number;
}): ChannelOutcome {
  if (!input.enabled) return 'off';
  if (!input.hasDestination) return 'none';
  return input.sentToday >= input.cap ? 'capped' : 'send';
}
