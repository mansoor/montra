/**
 * SimpleFIN Bridge behind the bank feed port (ADR-0055 §1, §3, §7). The secret Montra seals is the access URL itself;
 * it is split into a request URL and an HTTP Basic header for every request, so the credentials never travel in a
 * URL, and nothing here logs or puts them in an error.
 */
import type { CalendarDate } from '@montra/domain';
import type { SimpleFinLimits } from './limits.js';
import { BankFeedError, type BankFeedProvider, type FeedHealth, type FeedSnapshot } from './provider.js';
import {
  accountsQuery,
  decodeSetupToken,
  parseAccessUrl,
  parseAccounts,
  type SimpleFinAccess,
} from './simplefin.js';
import type { FeedResponse, FeedTransport } from './transport.js';

type HostLimits = Pick<SimpleFinLimits, 'allowedHosts' | 'allowLocalHttp'>;

export class SimpleFinProvider implements BankFeedProvider {
  readonly kind = 'simplefin' as const;

  constructor(
    private readonly transport: FeedTransport,
    private readonly limits: HostLimits,
  ) {}

  /**
   * Claims the setup token once (§3). A 403 means it was already claimed or never existed: the person is told it may
   * be compromised. Never retried here.
   */
  async connect(input: { setupToken: string }): Promise<{ secret: string; host: string }> {
    const claimUrl = decodeSetupToken(input.setupToken, this.limits);
    const res = await this.transport.send({ method: 'POST', url: claimUrl });
    if (res.status === 403) throw new BankFeedError('token_used');
    if (res.status !== 200) throw new BankFeedError('bad_response', `claim ${res.status}`);
    const text = res.body.toString('utf8').trim();
    const access = parseAccessUrl(text, this.limits);
    return { secret: text, host: access.host };
  }

  listAccounts(secret: string): Promise<FeedSnapshot> {
    return this.accounts(secret, { balancesOnly: true });
  }

  fetchTransactions(secret: string, q: { from: CalendarDate; to: CalendarDate }): Promise<FeedSnapshot> {
    return this.accounts(secret, q);
  }

  async health(secret: string): Promise<FeedHealth> {
    const snap = await this.listAccounts(secret);
    return { ok: true, problems: snap.problems };
  }

  private async accounts(
    secret: string,
    q: { from?: CalendarDate; to?: CalendarDate; balancesOnly?: boolean },
  ): Promise<FeedSnapshot> {
    const access = this.access(secret);
    const res = await this.transport.send({
      method: 'GET',
      url: new URL(`${access.base}/accounts?${accountsQuery(q)}`),
      headers: { authorization: basic(access) },
    });
    return parseAnswer(res);
  }

  /** The sealed access URL, read again; a stored one that no longer reads is the feed's problem, not a crash. */
  private access(secret: string): SimpleFinAccess {
    try {
      return parseAccessUrl(secret, this.limits);
    } catch (e) {
      throw e instanceof BankFeedError && e.code === 'not_allowed_host'
        ? e
        : new BankFeedError('revoked', 'access');
    }
  }
}

const basic = (a: SimpleFinAccess) =>
  `Basic ${Buffer.from(`${a.username}:${a.password}`, 'utf8').toString('base64')}`;

/** §7: `/accounts`' statuses, then its body. */
function parseAnswer(res: FeedResponse): FeedSnapshot {
  if (res.status === 403) throw new BankFeedError('revoked');
  if (res.status === 402) throw new BankFeedError('payment_required');
  if (res.status !== 200)
    throw new BankFeedError(res.status >= 500 ? 'unreachable' : 'bad_response', String(res.status));
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new BankFeedError('bad_response', 'not json');
  }
  return parseAccounts(body);
}
