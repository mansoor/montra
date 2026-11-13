import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';

/**
 * How many failed attempts each kind of key may have (AUTH-08, ADR-0042). A key counts failures inside a window; at
 * `maxFailures` it locks for `lockMs`. After `delayAfter` failures every further attempt waits a little longer before
 * it reaches Kratos, so guessing slows down well before the lock.
 */
export interface Rule {
  name: RuleName;
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  delayAfter: number;
}

export type RuleName = 'account' | 'address' | 'second_factor' | 'code' | 'email_send' | 'sign_up';

const MIN = 60_000;

export const RULES: Record<RuleName, Rule> = {
  /** Wrong passwords for one email, from anywhere. */
  account: { name: 'account', maxFailures: 10, windowMs: 15 * MIN, lockMs: 15 * MIN, delayAfter: 5 },
  /** Wrong passwords from one address, for any email (credential stuffing). Offices share an address, so it's higher. */
  address: { name: 'address', maxFailures: 30, windowMs: 15 * MIN, lockMs: 15 * MIN, delayAfter: 15 },
  /** Wrong authenticator or recovery codes for one signed-in session. */
  second_factor: {
    name: 'second_factor',
    maxFailures: 5,
    windowMs: 15 * MIN,
    lockMs: 15 * MIN,
    delayAfter: 3,
  },
  /** Wrong emailed codes (recovery, verification) from one address. */
  code: { name: 'code', maxFailures: 10, windowMs: 15 * MIN, lockMs: 15 * MIN, delayAfter: 5 },
  /** Recovery and verification emails asked for from one address, sent or not: keeps the courier from being a spammer. */
  email_send: { name: 'email_send', maxFailures: 10, windowMs: 60 * MIN, lockMs: 60 * MIN, delayAfter: 10 },
  /** Sign-up attempts from one address. */
  sign_up: { name: 'sign_up', maxFailures: 20, windowMs: 60 * MIN, lockMs: 60 * MIN, delayAfter: 20 },
};

export interface Bucket {
  failures: number;
  windowStarted: Date;
  lockedUntil: Date | null;
}

/** Seconds left on a lock, or 0. */
export function lockedFor(bucket: Bucket | undefined, now: Date): number {
  if (!bucket?.lockedUntil || bucket.lockedUntil <= now) return 0;
  return Math.ceil((bucket.lockedUntil.getTime() - now.getTime()) / 1000);
}

/** Failures that still count: none once the window has passed (and any lock has ended). */
export function liveFailures(bucket: Bucket | undefined, rule: Rule, now: Date): number {
  if (!bucket) return 0;
  if (lockedFor(bucket, now) > 0) return bucket.failures;
  return now.getTime() - bucket.windowStarted.getTime() >= rule.windowMs ? 0 : bucket.failures;
}

/** How long to hold the next attempt: 1 s after `delayAfter` failures, doubling, at most 8 s. */
export function delayFor(failures: number, rule: Rule): number {
  if (failures < rule.delayAfter) return 0;
  return Math.min(1000 * 2 ** (failures - rule.delayAfter), 8000);
}

/** The bucket after one more failure, and whether this failure started a lock. */
export function afterFailure(
  bucket: Bucket | undefined,
  rule: Rule,
  now: Date,
): { bucket: Bucket; locked: boolean } {
  const live = liveFailures(bucket, rule, now);
  const failures = live + 1;
  const windowStarted = live === 0 || !bucket ? now : bucket.windowStarted;
  const wasLocked = lockedFor(bucket, now) > 0;
  const lock = failures >= rule.maxFailures;
  const lockedUntil = lock
    ? new Date(Math.max(bucket?.lockedUntil?.getTime() ?? 0, now.getTime() + rule.lockMs))
    : null;
  return { bucket: { failures, windowStarted, lockedUntil }, locked: lock && !wasLocked };
}

/** Keys are HMACs, so the table holds no email address, IP address or session token (ADR-0042). */
export function keyOf(secret: string, rule: RuleName, value: string): string {
  return `${rule}:${createHmac('sha256', secret).update(`${rule}\0${value}`).digest('base64url')}`;
}

/** The counters, kept in Postgres so every gateway instance sees the same numbers. */
export class ThrottleStore {
  constructor(private readonly db: Db) {}

  async get(keys: string[]): Promise<Map<string, Bucket>> {
    if (!keys.length) return new Map();
    const rows = await this.db.run({}, (trx) =>
      trx
        .selectFrom('app.auth_throttle')
        .select(['key', 'failures', 'window_started', 'locked_until'])
        .where('key', 'in', keys)
        .execute(),
    );
    return new Map(
      rows.map((r) => [
        r.key,
        { failures: r.failures, windowStarted: r.window_started, lockedUntil: r.locked_until },
      ]),
    );
  }

  /** Counts one failure under a row lock, so concurrent attempts can't both slip under the limit. */
  async fail(key: string, rule: Rule, now: Date): Promise<{ bucket: Bucket; locked: boolean }> {
    return this.db.run({}, async (trx) => {
      await trx
        .insertInto('app.auth_throttle')
        .values({ key, failures: 0, window_started: now })
        .onConflict((oc) => oc.column('key').doNothing())
        .execute();
      const row = await trx
        .selectFrom('app.auth_throttle')
        .select(['failures', 'window_started', 'locked_until'])
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const prior = row.failures
        ? { failures: row.failures, windowStarted: row.window_started, lockedUntil: row.locked_until }
        : undefined;
      const next = afterFailure(prior, rule, now);
      await trx
        .updateTable('app.auth_throttle')
        .set({
          failures: next.bucket.failures,
          window_started: next.bucket.windowStarted,
          locked_until: next.bucket.lockedUntil,
          updated_at: now,
        })
        .where('key', '=', key)
        .execute();
      return next;
    });
  }

  async clear(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.db.run({}, (trx) => trx.deleteFrom('app.auth_throttle').where('key', 'in', keys).execute());
  }

  /** Drops rows whose window and lock are long over. */
  async prune(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 3 * 60 * MIN);
    const res = await this.db.run({}, (trx) =>
      trx
        .deleteFrom('app.auth_throttle')
        .where('updated_at', '<', cutoff)
        .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<', now)]))
        .executeTakeFirst(),
    );
    return Number(res.numDeletedRows);
  }

  /** Records the lockout on the account, if the email has one. True when it does (send the alert). */
  async noteLockout(email: string, detail: Record<string, unknown>): Promise<boolean> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{
        found: boolean;
      }>`select app.note_sign_in_lockout(${email}, ${JSON.stringify(detail)}::jsonb) as found`.execute(trx),
    );
    return rows[0]?.found === true;
  }
}
