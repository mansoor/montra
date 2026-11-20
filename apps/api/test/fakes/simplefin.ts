/**
 * An in-process SimpleFIN Bridge for tests (ADR-0055 §12): the claim, `/accounts` in the v2 or v1 shape, its date
 * parameters, `balances-only`, HTTP Basic, and the failures the Bridge can answer with. Everything in it is synthetic,
 * written for the tests; nothing is recorded from a real account, and no test reaches the real service.
 *
 * It listens on 127.0.0.1 over plain http, which the API accepts only with SIMPLEFIN_ALLOW_LOCAL_HTTP=on (refused in
 * production).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

export interface FakeSimpleFinTransaction {
  id: string;
  /** Epoch seconds; 0 while pending. */
  posted: number;
  amount: string;
  description: string;
  pending?: boolean;
  payee?: string;
  memo?: string;
}

export interface FakeSimpleFinAccount {
  id: string;
  connId: string;
  name: string;
  /** ISO 4217, or a URL for a custom currency. */
  currency: string;
  balance: string;
  available?: string;
  balanceDate: number;
  transactions: FakeSimpleFinTransaction[];
}

export interface FakeSimpleFinRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Whether the request carried the right credentials; never the credentials themselves. */
  authorized: boolean;
}

export interface FakeSimpleFin {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** A new setup token, as the Bridge shows one: Base64 of its claim URL. */
  newSetupToken(): string;
  /** The access the claims hand out (one per fake). */
  readonly username: string;
  readonly password: string;
  connections: Array<{ conn_id: string; name: string; org_id: string; org_url: string }>;
  accounts: FakeSimpleFinAccount[];
  /** v2 problems, as the Bridge reports them per connection or account. */
  errlist: Array<{ code: string; msg: string; conn_id?: string; account_id?: string }>;
  /** v1 messages (the Bridge still sends quota warnings here). */
  errors: string[];
  /** Answer `/accounts` the old way: `org` on each account, `errors` only. */
  shape: 'v2' | 'v1';
  /** Answer `/accounts` with this status (402 payment required, 403 revoked, 500…), or null to behave. */
  failWith: number | null;
  /** Wait this long before answering. */
  delayMs: number;
  /** Pad the answer to at least this many bytes, for the size cap. */
  padTo: number;
  /** Drop the connection without answering. */
  hangUp: boolean;
  log: FakeSimpleFinRequest[];
  close(): Promise<void>;
}

const day = (date: string) => Date.parse(`${date}T12:00:00Z`) / 1000;

/** A fake with one connection and two accounts, a few posted rows each, and one pending row. */
export async function startFakeSimpleFin(): Promise<FakeSimpleFin> {
  const claims = new Map<string, boolean>();
  const username = `user${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  let base = '';

  const fake: FakeSimpleFin = {
    url: '',
    username,
    password,
    newSetupToken() {
      const token = randomBytes(16).toString('hex');
      claims.set(token, false);
      return Buffer.from(`${base}/simplefin/claim/${token}`).toString('base64');
    },
    connections: [
      {
        conn_id: 'CONN-1',
        name: 'Example Credit Union',
        org_id: 'ORG-1',
        org_url: 'https://cu.example.test',
      },
    ],
    accounts: [
      {
        id: 'ACT-CHK',
        connId: 'CONN-1',
        name: 'Checking …1234',
        currency: 'USD',
        balance: '1520.75',
        available: '1500.75',
        balanceDate: day('2026-11-19'),
        transactions: [
          {
            id: 'T-1',
            posted: day('2026-11-02'),
            amount: '-40.00',
            description: 'Zelle Payment To SAM EXAMPLE',
          },
          { id: 'T-2', posted: day('2026-11-15'), amount: '2500.00', description: 'ACME CORP PAYROLL' },
          { id: 'T-3', posted: 0, amount: '-12.50', description: 'COFFEE (pending)', pending: true },
        ],
      },
      {
        id: 'ACT-CARD',
        connId: 'CONN-1',
        name: 'Rewards Card …9876',
        currency: 'USD',
        balance: '-310.20',
        balanceDate: day('2026-11-19'),
        transactions: [
          { id: 'C-1', posted: day('2026-11-10'), amount: '-310.20', description: 'GROCERY MART' },
        ],
      },
    ],
    errlist: [],
    errors: [],
    shape: 'v2',
    failWith: null,
    delayMs: 0,
    padTo: 0,
    hangUp: false,
    log: [],
    close: async () => {},
  };

  const authorized = (req: http.IncomingMessage) => {
    const header = String(req.headers.authorization ?? '');
    const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    return header === expected;
  };

  const accountsBody = (q: URLSearchParams) => {
    const from = q.has('start-date') ? Number(q.get('start-date')) : -Infinity;
    const to = q.has('end-date') ? Number(q.get('end-date')) : Infinity;
    const balancesOnly = q.get('balances-only') === '1';
    const withPending = q.get('pending') === '1';
    const accounts = fake.accounts.map((a) => {
      const conn = fake.connections.find((c) => c.conn_id === a.connId);
      const transactions = balancesOnly
        ? undefined
        : a.transactions
            .filter((t) => (t.pending ? withPending || t.posted === 0 : t.posted >= from && t.posted < to))
            .map((t) => ({
              id: t.id,
              posted: t.posted,
              amount: t.amount,
              description: t.description,
              ...(t.pending ? { pending: true } : {}),
              ...(t.payee ? { payee: t.payee } : {}),
              ...(t.memo ? { memo: t.memo } : {}),
            }));
      const common = {
        id: a.id,
        name: a.name,
        currency: a.currency,
        balance: a.balance,
        ...(a.available !== undefined ? { 'available-balance': a.available } : {}),
        'balance-date': a.balanceDate,
        ...(transactions ? { transactions } : {}),
      };
      return fake.shape === 'v2'
        ? { ...common, conn_id: a.connId }
        : { ...common, org: conn ? { id: conn.org_id, name: conn.name, url: conn.org_url } : undefined };
    });
    const body =
      fake.shape === 'v2'
        ? { errlist: fake.errlist, errors: fake.errors, connections: fake.connections, accounts }
        : { errors: fake.errors, accounts };
    let text = JSON.stringify(body);
    if (fake.padTo > text.length)
      text = JSON.stringify({ ...body, padding: 'x'.repeat(fake.padTo - text.length) });
    return text;
  };

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      const u = new URL(req.url ?? '/', base);
      fake.log.push({
        method: req.method ?? '',
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        authorized: authorized(req),
      });
      if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
      if (fake.hangUp) {
        req.socket.destroy();
        return;
      }
      const claim = /^\/simplefin\/claim\/([0-9a-f]+)$/.exec(u.pathname);
      if (claim && req.method === 'POST') {
        const token = claim[1]!;
        if (claims.get(token) !== false) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        claims.set(token, true);
        const access = new URL(`${base}/simplefin`);
        access.username = username;
        access.password = password;
        res.writeHead(200, { 'content-type': 'text/plain' }).end(access.toString());
        return;
      }
      if (u.pathname === '/simplefin/accounts' && req.method === 'GET') {
        if (!authorized(req)) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        if (fake.failWith) {
          res.writeHead(fake.failWith).end('');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(accountsBody(u.searchParams));
        return;
      }
      res.writeHead(404).end('');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.url = base;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
