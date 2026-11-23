import { describe, expect, it, vi } from 'vitest';
import type { ImportBatchDto } from '@montra/schemas';
import { createApi } from '../src/api/client';
import { isBusy, localDay, STATEMENT_TONE, statementRows } from '../src/features/statements';

const counts = (over: Partial<ImportBatchDto['counts']> = {}): ImportBatchDto['counts'] => ({
  read: 0,
  new: 0,
  duplicate: 0,
  probableDuplicate: 0,
  match: 0,
  error: 0,
  skipped: 0,
  added: 0,
  matched: 0,
  failed: 0,
  transfers: 0,
  ...over,
});

/** A local time, so the day the row shows doesn't depend on where the tests run. */
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h, 30).toISOString();

const batch = (
  id: string,
  status: ImportBatchDto['status'],
  createdAt: string,
  over: Partial<Pick<ImportBatchDto, 'accountId' | 'counts' | 'fileName'>> = {},
) => ({
  id,
  fileName: `${id}.csv`,
  accountId: 'chk',
  status,
  counts: counts(),
  createdAt,
  ...over,
});

const names = new Map([['chk', 'Everyday checking']]);

describe('statementRows', () => {
  it('lists the newest import first', () => {
    const rows = statementRows(
      [
        batch('old', 'committed', at(2026, 9, 1)),
        batch('new', 'committed', at(2026, 11, 12)),
        batch('mid', 'committed', at(2026, 10, 3)),
      ],
      names,
    );
    expect(rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('shows the file, its account, the day it was imported and how many rows it added', () => {
    const [row] = statementRows(
      [batch('b1', 'committed', at(2026, 11, 12, 23), { counts: counts({ read: 40, added: 37 }) })],
      names,
    );
    expect(row).toEqual({
      id: 'b1',
      fileName: 'b1.csv',
      accountName: 'Everyday checking',
      importedOn: '2026-11-12',
      statusKey: 'imports.status.committed',
      tone: 'good',
      count: { key: 'mobile.statements.rows_added', count: 37 },
      busy: false,
    });
  });

  it('leaves the account out when this phone does not know it', () => {
    const [row] = statementRows([batch('b1', 'failed', at(2026, 11, 1), { accountId: 'gone' })], names);
    expect(row!.accountName).toBeNull();
    expect(row!.tone).toBe('bad');
    expect(row!.count).toBeNull();
  });

  it('counts rows read while a statement waits to be mapped or checked, and nothing once undone', () => {
    const rows = statementRows(
      [
        batch('p', 'preview', at(2026, 11, 3), { counts: counts({ read: 12 }) }),
        batch('m', 'needs_mapping', at(2026, 11, 2), { counts: counts({ read: 0 }) }),
        batch('u', 'undone', at(2026, 11, 1), { counts: counts({ read: 9, added: 9 }) }),
      ],
      names,
    );
    expect(rows.map((r) => r.count)).toEqual([{ key: 'mobile.statements.rows_read', count: 12 }, null, null]);
    expect(rows.map((r) => r.tone)).toEqual(['warn', 'warn', 'muted']);
  });

  it('marks statements the server is still working on', () => {
    const rows = statementRows(
      [batch('a', 'parsing', at(2026, 11, 2)), batch('b', 'committed', at(2026, 11, 1))],
      names,
    );
    expect(rows.map((r) => r.busy)).toEqual([true, false]);
  });
});

describe('statement status', () => {
  it('has a tone for every status, as the web history does', () => {
    expect(STATEMENT_TONE).toEqual({
      uploaded: 'muted',
      parsing: 'muted',
      needs_mapping: 'warn',
      preview: 'warn',
      committing: 'muted',
      committed: 'good',
      failed: 'bad',
      undone: 'muted',
      discarded: 'muted',
    });
    expect(['uploaded', 'parsing', 'committing'].every((s) => isBusy(s as ImportBatchDto['status']))).toBe(
      true,
    );
    expect(isBusy('preview')).toBe(false);
  });

  it('reads the day in the phone time zone', () => {
    expect(localDay(at(2026, 1, 5, 0))).toBe('2026-01-05');
    expect(localDay(at(2026, 12, 31, 23))).toBe('2026-12-31');
  });
});

describe('the API client', () => {
  const stub = () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchFn);
    return fetchFn;
  };

  it('lists imports for the workspace, or for one account', async () => {
    const fetchFn = stub();
    const api = createApi({ baseUrl: 'http://api', token: async () => 't' });
    expect(await api.listImports('w1')).toEqual([]);
    await api.listImports('w1', 'a 1');
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      'http://api/v1/workspaces/w1/imports',
      'http://api/v1/workspaces/w1/imports?accountId=a%201',
    ]);
    expect(fetchFn.mock.calls[0]![1]?.method).toBe('GET');
    vi.unstubAllGlobals();
  });
});
