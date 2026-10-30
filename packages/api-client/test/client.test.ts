import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../src/index.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, contentType = 'application/json') {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe('ApiClient', () => {
  it('builds URLs, unwraps list envelopes and adds headers', async () => {
    const f = fakeFetch(200, { data: [{ id: 'w1' }] });
    const client = new ApiClient({
      baseUrl: 'http://api/',
      fetch: f.impl,
      headers: () => ({ authorization: 'Bearer dev:a@b.co' }),
    });
    await expect(client.listWorkspaces()).resolves.toEqual([{ id: 'w1' }]);
    expect(f.calls[0]!.url).toBe('http://api/v1/workspaces');
    expect(header(f.calls[0]!, 'authorization')).toBe('Bearer dev:a@b.co');
    expect(header(f.calls[0]!, 'idempotency-key')).toBeUndefined();
  });

  it('encodes query parameters and path segments', async () => {
    const f = fakeFetch(200, { view: 'simple', data: [] });
    const client = new ApiClient({ baseUrl: '/api', fetch: f.impl });
    await client.register('w 1', 'a/2', 'simple');
    expect(f.calls[0]!.url).toBe('/api/v1/workspaces/w%201/accounts/a%2F2/register?view=simple');
    const g = fakeFetch(200, { data: [] });
    await new ApiClient({ baseUrl: '/api', fetch: g.impl }).listTransactions('w', {
      from: '2026-10-01',
      limit: 5,
    });
    expect(g.calls[0]!.url).toBe('/api/v1/workspaces/w/transactions?from=2026-10-01&limit=5');
  });

  it('sends JSON bodies with an idempotency key on POST', async () => {
    const f = fakeFetch(201, { id: 't1' });
    const client = new ApiClient({ baseUrl: '/api', fetch: f.impl, idempotencyKey: () => 'key-12345678' });
    await client.createTransaction('w', {
      date: '2026-10-29',
      accountId: '00000000-0000-7000-8000-000000000001',
      amount: { amount: '-500', currency: 'USD' },
    });
    const call = f.calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(header(call, 'idempotency-key')).toBe('key-12345678');
    expect(header(call, 'content-type')).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toMatchObject({ amount: { amount: '-500' } });
  });

  it('turns problem+json into ApiError with field errors', async () => {
    const f = fakeFetch(
      400,
      {
        type: 'x',
        title: 'Bad request',
        status: 400,
        code: 'validation_failed',
        detail: 'The request is invalid',
        errors: [{ path: 'amount.amount', message: 'Amount must be an integer number of minor units' }],
      },
      'application/problem+json',
    );
    const client = new ApiClient({ baseUrl: '/api', fetch: f.impl });
    const err = await client.createAccount('w', { name: 'x', kind: 'checking' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(400);
    expect(e.code).toBe('validation_failed');
    expect(e.fieldErrors()).toEqual({ 'amount.amount': 'Amount must be an integer number of minor units' });
  });

  it('sends If-Match on transaction edits and maps 412 to version.mismatch', async () => {
    const f = fakeFetch(200, { id: 't1', version: '3' });
    const client = new ApiClient({ baseUrl: '/api', fetch: f.impl });
    await client.updateTransaction('w', 't1', '2', { payee: 'Shell' });
    expect(f.calls[0]!.init.method).toBe('PATCH');
    expect(header(f.calls[0]!, 'if-match')).toBe('"v2"');
    expect(header(f.calls[0]!, 'idempotency-key')).toBeUndefined();

    const problem = fakeFetch(
      412,
      { type: 'x', title: 'Precondition failed', status: 412, code: 'version.mismatch', detail: 'changed' },
      'application/problem+json',
    );
    const e1 = await new ApiClient({ baseUrl: '/api', fetch: problem.impl })
      .updateTransaction('w', 't1', '1', {})
      .catch((e: ApiError) => e);
    expect(e1).toMatchObject({ status: 412, code: 'version.mismatch' });
    const bare = fakeFetch(412, undefined, 'text/plain');
    const e2 = await new ApiClient({ baseUrl: '/api', fetch: bare.impl })
      .deleteTransaction('w', 't1', '1')
      .catch((e: ApiError) => e);
    expect(e2).toMatchObject({ status: 412, code: 'version.mismatch' });
  });

  it('passes list filters and DELETE bodies', async () => {
    const f = fakeFetch(200, { data: [] });
    const client = new ApiClient({ baseUrl: '/api', fetch: f.impl });
    await client.listTransactions('w', { status: 'scheduled', reviewState: undefined, accountId: 'a1' });
    expect(f.calls[0]!.url).toBe('/api/v1/workspaces/w/transactions?status=scheduled&accountId=a1');
    await client.listAccounts('w', { include: 'all' });
    expect(f.calls[1]!.url).toBe('/api/v1/workspaces/w/accounts?include=all');
    await client.unlockPeriod('w', 'e1', 'Fixing a misposted bill');
    expect(f.calls[2]!.init.method).toBe('DELETE');
    expect(JSON.parse(f.calls[2]!.init.body as string)).toEqual({ note: 'Fixing a misposted bill' });
    await client.setGrants('w', 'u1', [{ entityId: 'e1', access: 'read' }]);
    expect(f.calls[3]!.init.method).toBe('PUT');
    expect(f.calls[3]!.url).toBe('/api/v1/workspaces/w/sharing/members/u1/grants');
    await client.syncChanges('w', '42');
    expect(f.calls[4]!.url).toBe('/api/v1/workspaces/w/sync/changes?since=42');
    await client.acceptInvite('tok_en-123');
    expect(f.calls[5]!.url).toBe('/api/v1/invites/tok_en-123/accept');
  });

  it('covers trash, journal list, chart of accounts, sync head and sessions', async () => {
    const f = fakeFetch(200, { data: [], latestSeq: '77', changes: [], hasMore: false });
    const client = new ApiClient({ baseUrl: '/api', fetch: f.impl });
    await client.listTransactions('w', { trash: true, limit: 10 });
    expect(f.calls[0]!.url).toBe('/api/v1/workspaces/w/transactions?trash=true&limit=10');
    await client.listTransactions('w', { trash: false });
    expect(f.calls[1]!.url).toBe('/api/v1/workspaces/w/transactions');
    await client.listJournalEntries('w', { entityId: 'e1', kind: 'manual' });
    expect(f.calls[2]!.url).toBe('/api/v1/workspaces/w/journal-entries?entityId=e1&kind=manual');
    await client.listLedgerAccounts('w', 'e1');
    expect(f.calls[3]!.url).toBe('/api/v1/workspaces/w/ledger-accounts?entityId=e1');
    await expect(client.syncHead('w')).resolves.toBe('77');
    expect(f.calls[4]!.url).toBe('/api/v1/workspaces/w/sync/changes?head=true');
    await client.revokeSession('s 1');
    expect(f.calls[5]!).toMatchObject({ url: '/api/v1/me/sessions/s%201', init: { method: 'DELETE' } });
  });

  it('reports non-problem failures and network errors', async () => {
    const f = fakeFetch(502, undefined, 'text/plain');
    const e1 = await new ApiClient({ baseUrl: '/api', fetch: f.impl })
      .listWorkspaces()
      .catch((e: ApiError) => e);
    expect(e1).toMatchObject({ status: 502, code: 'http_502' });
    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const e2 = await new ApiClient({ baseUrl: '/api', fetch: broken })
      .listWorkspaces()
      .catch((e: ApiError) => e);
    expect(e2).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('sends uploads as multipart FormData without a JSON content type', async () => {
    const f = fakeFetch(201, { fileId: 'f1' });
    const client = new ApiClient({ baseUrl: '/api', fetch: f.impl });
    await client.uploadFile('w1', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'stmt.csv');
    const call = f.calls[0]!;
    expect(call.url).toBe('/api/v1/workspaces/w1/uploads');
    expect(call.init.body).toBeInstanceOf(FormData);
    expect((call.init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(((call.init.body as FormData).get('file') as File).name).toBe('stmt.csv');
    expect(header(call, 'content-type')).toBeUndefined();
    expect(header(call, 'idempotency-key')).toBeDefined();
  });

  it('pages import rows and drives commit, undo and reconciliation', async () => {
    const f = fakeFetch(200, { data: [], nextCursor: null });
    const client = new ApiClient({ baseUrl: '/api', fetch: f.impl });
    await client.listImportRows('w1', 'b1', { status: 'probable_duplicate', cursor: 200, limit: 100 });
    await client.commitImport('w1', 'b1');
    await client.setImportMapping('w1', 'b1', {
      mapping: {
        headerRow: 0,
        dataStart: 1,
        date: 0,
        dateFormat: 'MM/DD/YYYY',
        description: [1],
        amount: 2,
        sign: 'normal',
        decimal: '.',
      },
      saveProfile: false,
    });
    await client.setCleared('w1', 'r1', { clear: ['p1'] });
    expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/v1/workspaces/w1/imports/b1/rows?status=probable_duplicate&cursor=200&limit=100',
      'POST /api/v1/workspaces/w1/imports/b1/commit',
      'PUT /api/v1/workspaces/w1/imports/b1/mapping',
      'POST /api/v1/workspaces/w1/reconciliations/r1/cleared',
    ]);
    expect(header(f.calls[2]!, 'content-type')).toBe('application/json');
    expect(JSON.parse(f.calls[2]!.init.body as string).saveProfile).toBe(false);
  });
});
