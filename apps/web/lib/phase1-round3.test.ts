import { describe, expect, it } from 'vitest';
import { ApiError, type LedgerAccountDto, type TransactionDto } from '@montra/api-client';
import { errorAction, friendlyMessage, toFormErrors } from './errors';
import { makeFormatters } from './format';
import { groupLedgerAccounts } from './journal';
import { authHeaders, stepUpHref, wsToken } from './session';
import { isFatalSocketError, parseServerMessage, reconnectDelay } from './sync';
import { toEditState } from './transaction-edit';

describe('session modes (ADR-0006)', () => {
  it('sends the dev bearer or only the Kratos session cookie', () => {
    expect(authHeaders('me@example.com', 'dev')).toEqual({ authorization: 'Bearer dev:me@example.com' });
    expect(authHeaders('not-an-email', 'dev')).toEqual({});
    expect(authHeaders('MTY5OTk_abc-DEF=', 'kratos')).toEqual({
      cookie: 'ory_kratos_session=MTY5OTk_abc-DEF=',
    });
    // A cookie value can't smuggle another cookie or header.
    expect(authHeaders('abc; other=1', 'kratos')).toEqual({});
    expect(authHeaders('abc\r\nx-evil: 1', 'kratos')).toEqual({});
    expect(authHeaders(undefined, 'kratos')).toEqual({});
  });

  it('gives a WebSocket token only in dev mode', () => {
    expect(wsToken('me@example.com', 'dev')).toBe('dev:me@example.com');
    expect(wsToken('session', 'kratos')).toBeNull();
    expect(wsToken(undefined, 'dev')).toBeNull();
  });

  it('builds step-up and re-auth links with an absolute return_to (AUTH-04, AUTH-09)', () => {
    expect(stepUpHref('mfa.required', '/w/1/settings?tab=sharing')).toBe(
      `/sign-in?aal=aal2&return_to=${encodeURIComponent('http://localhost:3000/w/1/settings?tab=sharing')}`,
    );
    expect(stepUpHref('reauth.required', 'http://localhost:3000/w/1')).toBe(
      `/sign-in?refresh=true&return_to=${encodeURIComponent('http://localhost:3000/w/1')}`,
    );
    expect(stepUpHref('email.unverified', '/')).toBe('/auth/verification');
    expect(stepUpHref('forbidden', '/')).toBeNull();
  });

  it('turns 403 mfa.required / reauth.required into a message and a link', () => {
    const mfa = new ApiError(403, 'mfa.required', 'x');
    expect(friendlyMessage(mfa)).toBe('Sign in with your second factor to open this workspace.');
    expect(errorAction(mfa, undefined, '/w/1')).toEqual({
      href: `/sign-in?aal=aal2&return_to=${encodeURIComponent('http://localhost:3000/w/1')}`,
      label: 'Verify with your second factor',
    });
    expect(toFormErrors(new ApiError(403, 'reauth.required', 'x')).action?.label).toBe('Confirm it’s you');
    expect(errorAction(new ApiError(403, 'forbidden', 'x'))).toBeUndefined();
    expect(errorAction(new ApiError(409, 'mfa.required', 'x'))).toBeUndefined();
  });
});

describe('realtime client (PLT-06)', () => {
  it('parses only well-formed server messages', () => {
    expect(parseServerMessage('{"type":"subscribed","workspaceId":"w"}')).toEqual({
      type: 'subscribed',
      workspaceId: 'w',
    });
    expect(parseServerMessage('{"type":"changes","workspaceId":"w"}')).toEqual({
      type: 'changes',
      workspaceId: 'w',
    });
    expect(parseServerMessage('{"type":"error","code":"unauthenticated"}')).toEqual({
      type: 'error',
      code: 'unauthenticated',
    });
    expect(parseServerMessage('{"type":"changes"}')).toBeNull();
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseServerMessage('x'.repeat(5000))).toBeNull();
  });

  it('backs off exponentially with jitter, capped at 30 s', () => {
    expect(reconnectDelay(0, () => 1)).toBe(1000);
    expect(reconnectDelay(0, () => 0)).toBe(800);
    expect(reconnectDelay(3, () => 1)).toBe(8000);
    expect(reconnectDelay(20, () => 1)).toBe(30_000);
    expect(isFatalSocketError('unauthenticated')).toBe(true);
    expect(isFatalSocketError('internal')).toBe(false);
  });
});

describe('locale formatting (CUR-10, TZ-05)', () => {
  it('formats dates in the chosen format without time-zone shifts', () => {
    expect(makeFormatters('en-US', 'DD/MM/YYYY').date('2026-01-02')).toBe('02/01/2026');
    expect(makeFormatters('en-US', null).date('2026-01-02')).toBe('Jan 2, 2026');
    expect(makeFormatters('de-DE', 'DD.MM.YYYY').date('2026-12-31')).toBe('31.12.2026');
    expect(makeFormatters('en-US', 'bogus').date('2026-01-02')).toBe('Jan 2, 2026');
    expect(makeFormatters('en-US').date('not a date')).toBe('not a date');
  });

  it('formats money in the user locale', () => {
    expect(makeFormatters('en-US').money(123456n, 'USD')).toBe('$1,234.56');
    expect(makeFormatters('de-DE').money('123456', 'EUR')).toBe('1.234,56 €');
    expect(makeFormatters('en-US').money(-500n, 'USD', { accounting: true })).toBe('($5.00)');
  });
});

describe('closed contract gaps', () => {
  it('edits a scheduled occurrence from its stored accountId and splits (no postings yet)', () => {
    const t: TransactionDto = {
      id: 't',
      date: '2026-11-01',
      payee: 'Oak Street Apartments',
      description: '',
      status: 'scheduled',
      reviewState: 'reviewed',
      source: 'recurring',
      version: '1',
      memo: null,
      tags: [],
      recurringItemId: 'r',
      accountId: 'chk',
      splits: [
        { accountId: 'rent', amount: '-120000', memberId: null, memo: null },
        { accountId: 'office', amount: '-30000', memberId: 'm1', memo: 'desk' },
      ],
      amount: { amount: '-150000', currency: 'USD' },
      entries: [],
    };
    expect(toEditState(t, new Set(['chk']))).toMatchObject({
      accountId: 'chk',
      direction: 'expense',
      amount: '1500.00',
      mode: 'splits',
      memberId: '',
      ledgerEditable: true,
      splits: [
        { accountId: 'rent', amount: '1200.00' },
        { accountId: 'office', amount: '300.00', memo: 'desk' },
      ],
    });
    expect(toEditState({ ...t, splits: [t.splits![0]!] }, new Set())).toMatchObject({
      mode: 'category',
      categoryId: 'rent',
    });
  });

  it('groups the full chart (including system accounts) by type for manual journals', () => {
    const a = (
      id: string,
      type: LedgerAccountDto['type'],
      over: Partial<LedgerAccountDto> = {},
    ): LedgerAccountDto => ({
      id,
      entityId: 'P',
      type,
      subtype: 'general',
      name: id,
      currency: 'USD',
      isCategory: type === 'income' || type === 'expense',
      systemRole: null,
      counterpartyEntityId: null,
      taxLineCode: null,
      archived: false,
      ...over,
    });
    const groups = groupLedgerAccounts(
      [
        a('Groceries', 'expense'),
        a('Opening balance equity', 'equity', { systemRole: 'opening_balance_equity' }),
        a('Checking', 'asset'),
        a('Visa', 'liability'),
        a('Old', 'asset', { archived: true }),
        a('Biz', 'asset', { entityId: 'B' }),
        a('Euro', 'asset', { currency: 'EUR' }),
      ],
      'P',
      'USD',
    );
    expect(groups.map((g) => [g.type, g.accounts.map((x) => x.name)])).toEqual([
      ['asset', ['Checking']],
      ['liability', ['Visa']],
      ['equity', ['Opening balance equity']],
      ['expense', ['Groceries']],
    ]);
  });
});
