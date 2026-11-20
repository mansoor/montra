/**
 * SimpleFIN's protocol, read strictly (ADR-0055 §1; simplefin.org/protocol.html, "2.0.0-draft"): the setup token, the
 * access URL it is claimed for, the `/accounts` request and its answer in v2 and the older v1 shape. Pure functions:
 * the adapter that makes the requests (through the address guard, §9) comes with connecting (PR 2).
 *
 * Amounts are read exactly in the account's currency: more decimals than it has makes that row an error, never a
 * rounding. Pending rows are dropped (owner's answer 3). Messages are sanitized before anyone sees them.
 */
import { asCurrencyCode, isCurrencyCode, parseMoney, type CalendarDate } from '@montra/domain';
import type { SimpleFinLimits } from './limits.js';
import {
  BankFeedError,
  type FeedAccount,
  type FeedInstitution,
  type FeedProblem,
  type FeedProblemCode,
  type FeedSnapshot,
  type FeedTransaction,
} from './provider.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Why Montra won't send anything to this URL, or null when it may (§9): https to an allowed host, nothing else. */
export function urlProblem(
  url: URL,
  limits: Pick<SimpleFinLimits, 'allowedHosts' | 'allowLocalHttp'>,
): string | null {
  const host = url.hostname.toLowerCase();
  if (limits.allowLocalHttp && LOOPBACK.has(host) && (url.protocol === 'http:' || url.protocol === 'https:'))
    return null;
  if (url.protocol !== 'https:') return 'not https';
  if (url.port && url.port !== '443') return 'not the usual port';
  if (!limits.allowedHosts.includes(host)) return 'not an allowed host';
  return null;
}

/**
 * The setup token the person pasted: Base64 (or base64url) of the claim URL. Refused when it isn't one, or points
 * anywhere but an allowed host, before anything is sent. The token is never stored or logged.
 */
export function decodeSetupToken(
  token: string,
  limits: Pick<SimpleFinLimits, 'allowedHosts' | 'allowLocalHttp'>,
): URL {
  const compact = token.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.length > 4000)
    throw new BankFeedError('invalid_token', 'not base64');
  const text = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BankFeedError('invalid_token', 'not a url');
  }
  if (url.username || url.password || url.hash)
    throw new BankFeedError('invalid_token', 'unexpected url parts');
  const problem = urlProblem(url, limits);
  if (problem) throw new BankFeedError('not_allowed_host', problem);
  return url;
}

/** The access URL, split: where to send requests (no credentials in it) and the credentials for HTTP Basic. */
export interface SimpleFinAccess {
  /** Origin and path, e.g. `https://bridge.simplefin.org/simplefin`; never the user or password. */
  base: string;
  host: string;
  username: string;
  password: string;
}

/** The access URL the claim answers with, `https://<user>:<password>@<host>/simplefin`, checked as the claim URL is. */
export function parseAccessUrl(
  text: string,
  limits: Pick<SimpleFinLimits, 'allowedHosts' | 'allowLocalHttp'>,
): SimpleFinAccess {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new BankFeedError('bad_response', 'access not a url');
  }
  if (!url.username || !url.password || url.search || url.hash)
    throw new BankFeedError('bad_response', 'access url shape');
  const problem = urlProblem(url, limits);
  if (problem) throw new BankFeedError('not_allowed_host', problem);
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new BankFeedError('bad_response', 'access credentials');
  }
  return {
    base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    host: url.hostname.toLowerCase(),
    username,
    password,
  };
}

/** A CalendarDate's start, as SimpleFIN's epoch seconds (UTC). */
export function toEpoch(date: CalendarDate): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

/** SimpleFIN's epoch seconds as a CalendarDate in UTC (§1; the live run checks the zone), or null when unset. */
export function fromEpoch(value: unknown): CalendarDate | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const d = new Date(Math.trunc(value) * 1000);
  return Number.isNaN(d.getTime()) ? null : (d.toISOString().slice(0, 10) as CalendarDate);
}

/**
 * `GET {base}/accounts`'s query (v2). `start-date` is on or after, `end-date` before; `pending` is never asked for.
 * With `balancesOnly`, no transactions.
 */
export function accountsQuery(q: { from?: CalendarDate; to?: CalendarDate; balancesOnly?: boolean }): string {
  const p = new URLSearchParams({ version: '2' });
  if (q.from) p.set('start-date', String(toEpoch(q.from)));
  if (q.to) p.set('end-date', String(toEpoch(q.to)));
  if (q.balancesOnly) p.set('balances-only', '1');
  return p.toString();
}

/** Control, direction-changing and zero-width characters: never shown from a provider's text. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
/** Control characters, refused in an id. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f]/;

/**
 * Text from the provider as Montra shows it: no markup, no control or direction characters, no credentials in a
 * URL, one line, at most `max` characters.
 */
export function sanitize(value: unknown, max = 300): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\/\/[^/\s@]*@/g, '//')
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const AMOUNT_RE = /^[+-]?\d{1,15}(\.\d{1,12})?$/;

/** A numeric string in the account's currency, exactly, or null when it can't be read without rounding. */
export function readAmount(value: unknown, currency: string): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!AMOUNT_RE.test(text)) return null;
  try {
    return parseMoney(text.replace(/^\+/, ''), currency).amount;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = sanitize(v, max);
  return s.length ? s : null;
};
const ident = (v: unknown): string | null =>
  typeof v === 'string' && v.length >= 1 && v.length <= 200 && !CONTROL_CHAR.test(v) ? v : null;

/** §7: SimpleFIN's v2 error codes, as Montra's problems. */
export function problemCode(code: string): FeedProblemCode {
  if (code === 'con.auth') return 'reauth_needed';
  if (code.startsWith('act.missingdata')) return 'missing_data';
  if (code.startsWith('act.')) return 'account_failed';
  return 'unknown';
}

/**
 * `/accounts`' answer as a provider-neutral snapshot. Reads v2 (`connections`, `errlist`) and tolerates v1 (`org` per
 * account, `errors` as strings, which the Bridge still uses for quota warnings). Anything that isn't the expected
 * shape at the top is `bad_response`; a bad account or row is skipped, not fatal.
 */
export function parseAccounts(body: unknown): FeedSnapshot {
  if (!isObject(body) || !Array.isArray(body.accounts))
    throw new BankFeedError('bad_response', 'no accounts');
  const institutions = new Map<string, FeedInstitution>();
  for (const c of Array.isArray(body.connections) ? body.connections : []) {
    if (!isObject(c)) continue;
    const id = ident(c.conn_id);
    if (!id) continue;
    institutions.set(id, {
      id,
      name: str(c.name, 200) ?? id,
      url: typeof c.org_url === 'string' ? sanitize(c.org_url, 300) || null : null,
    });
  }

  const problems: FeedProblem[] = [];
  for (const e of Array.isArray(body.errlist) ? body.errlist : []) {
    if (!isObject(e) || typeof e.code !== 'string') continue;
    problems.push({
      code: problemCode(e.code),
      message: sanitize(e.msg),
      institutionId: ident(e.conn_id),
      accountId: ident(e.account_id),
    });
  }
  for (const e of Array.isArray(body.errors) ? body.errors : []) {
    if (typeof e !== 'string') continue;
    const message = sanitize(e);
    problems.push({
      code: /quota|limit|too many/i.test(message) ? 'quota_warning' : 'unknown',
      message,
      institutionId: null,
      accountId: null,
    });
  }

  let droppedPending = 0;
  const accounts: FeedAccount[] = [];
  for (const a of body.accounts) {
    if (!isObject(a)) continue;
    const id = ident(a.id);
    if (!id) continue;
    // v2 names the connection; v1 carries the organization on the account.
    let institutionId = ident(a.conn_id);
    if (!institutionId && isObject(a.org)) {
      const org = a.org;
      institutionId = ident(org.id) ?? ident(org.domain) ?? ident(org.name);
      if (institutionId && !institutions.has(institutionId))
        institutions.set(institutionId, {
          id: institutionId,
          name: str(org.name, 200) ?? institutionId,
          url: typeof org.url === 'string' ? sanitize(org.url, 300) || null : null,
        });
    }
    const code = typeof a.currency === 'string' ? a.currency.trim().toUpperCase() : '';
    const currency = /^[A-Z]{3}$/.test(code) && isCurrencyCode(code) ? asCurrencyCode(code) : null;

    const transactions: FeedTransaction[] = [];
    let rowErrors = 0;
    for (const t of Array.isArray(a.transactions) ? a.transactions : []) {
      if (!isObject(t)) {
        rowErrors++;
        continue;
      }
      const date = fromEpoch(t.posted);
      if (t.pending === true || date === null) {
        droppedPending++;
        continue;
      }
      const tid = ident(t.id);
      const amount = currency ? readAmount(t.amount, currency) : null;
      if (!tid || amount === null) {
        rowErrors++;
        continue;
      }
      transactions.push({
        id: tid,
        date,
        amount,
        description: str(t.description, 500) ?? '',
        payee: str(t.payee, 200),
        memo: str(t.memo, 500),
      });
    }
    accounts.push({
      id,
      institutionId,
      name: str(a.name, 200) ?? id,
      currency,
      balance: currency ? readAmount(a.balance, currency) : null,
      available: currency ? readAmount(a['available-balance'], currency) : null,
      balanceDate: fromEpoch(a['balance-date']),
      transactions,
      rowErrors,
    });
  }
  return { institutions: [...institutions.values()], accounts, problems, droppedPending };
}
