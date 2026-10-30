import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildOpeningBalanceEntry,
  buildReversal,
  buildTransactionEntries,
  buildTransferEntries,
  calendarDate,
  entryTotal,
  LedgerError,
  naturalBalance,
  parseDecimal,
  validateEntry,
  type AccountResolver,
  type AccountType,
  type CurrencyCode,
  type EntityRef,
  type JournalEntryDraft,
  type LedgerAccountRef,
  type SystemRole,
} from '../src/index.js';

const D = calendarDate('2026-10-29');

const personal: EntityRef = { id: 'P', type: 'personal', functionalCurrency: 'USD' };
const business: EntityRef = { id: 'B', type: 'business', functionalCurrency: 'USD' };
const entities = new Map([personal, business].map((e) => [e.id, e]));

const acct = (id: string, entityId: string, type: AccountType, currency: CurrencyCode = 'USD'): LedgerAccountRef => ({
  id,
  entityId,
  type,
  currency,
});

const checking = acct('checking', 'P', 'asset');
const savings = acct('savings', 'P', 'asset');
const card = acct('card', 'P', 'liability');
const eurAccount = acct('eur', 'P', 'asset', 'EUR');
const groceries = acct('groceries', 'P', 'expense');
const salary = acct('salary', 'P', 'income');
const bizChecking = acct('biz-checking', 'B', 'asset');
const officeSupplies = acct('office', 'B', 'expense');
const principal = acct('mortgage', 'P', 'liability');
const interest = acct('interest', 'P', 'expense');
const escrow = acct('escrow', 'P', 'asset');

const resolver: AccountResolver = {
  entity: (id) => entities.get(id)!,
  systemAccount: (entityId, role: SystemRole) => ({
    id: `${entityId}:${role}`,
    entityId,
    type: role === 'fx_rounding' || role === 'fx_gain_loss' ? 'expense' : 'equity',
    currency: 'USD',
    systemRole: role,
  }),
  interEntity: (local, remote, flow) => ({
    local: acct(`${local}:clearing:${remote}`, local, 'equity'),
    remote: acct(`${remote}:${flow === 'out' ? 'owner_contribution' : 'owner_draw'}`, remote, 'equity'),
  }),
};

const lines = (e: JournalEntryDraft) => Object.fromEntries(e.postings.map((p) => [p.accountId, p.amount]));

describe('buildTransactionEntries (design 04 §2)', () => {
  it('posts an expense paid from checking', () => {
    const [e] = buildTransactionEntries(
      { date: D, description: 'Groceries', account: checking, amount: -5000n, splits: [{ account: groceries, amount: -5000n }] },
      resolver,
    );
    expect(lines(e!)).toEqual({ checking: -5000n, groceries: 5000n });
    expect(entryTotal(e!)).toBe(5000n);
  });

  it('posts a card purchase as a liability credit', () => {
    const [e] = buildTransactionEntries(
      { date: D, description: 'Shop', account: card, amount: -5000n, splits: [{ account: groceries, amount: -5000n }] },
      resolver,
    );
    expect(lines(e!)).toEqual({ card: -5000n, groceries: 5000n });
    expect(naturalBalance('liability', -5000n)).toBe(5000n);
  });

  it('posts income', () => {
    const [e] = buildTransactionEntries(
      { date: D, description: 'Pay', account: checking, amount: 180000n, splits: [{ account: salary, amount: 180000n }] },
      resolver,
    );
    expect(lines(e!)).toEqual({ checking: 180000n, salary: -180000n });
  });

  it('posts a mortgage payment across principal, interest and escrow (DE-04)', () => {
    const [e] = buildTransactionEntries(
      {
        date: D,
        description: 'Mortgage',
        account: checking,
        amount: -200000n,
        splits: [
          { account: principal, amount: -61000n },
          { account: interest, amount: -94000n },
          { account: escrow, amount: -45000n },
        ],
      },
      resolver,
    );
    expect(lines(e!)).toEqual({ checking: -200000n, mortgage: 61000n, interest: 94000n, escrow: 45000n });
  });

  it('splits across entities with one balanced entry per entity (DE-05, ADR-0005)', () => {
    const entries = buildTransactionEntries(
      {
        date: D,
        description: 'Costco',
        account: card,
        amount: -12000n,
        splits: [
          { account: groceries, amount: -8000n },
          { account: officeSupplies, amount: -4000n },
        ],
      },
      resolver,
    );
    expect(entries).toHaveLength(2);
    const [p, b] = entries;
    expect(p!.entityId).toBe('P');
    expect(lines(p!)).toEqual({ card: -12000n, groceries: 8000n, 'P:clearing:B': 4000n });
    expect(b!.entityId).toBe('B');
    expect(lines(b!)).toEqual({ office: 4000n, 'B:owner_contribution': -4000n });
  });

  it('records money received on behalf of another entity as an owner draw', () => {
    const [, b] = buildTransactionEntries(
      {
        date: D,
        description: 'Client paid into personal account',
        account: checking,
        amount: 30000n,
        splits: [{ account: acct('consulting', 'B', 'income'), amount: 30000n }],
      },
      resolver,
    );
    expect(lines(b!)).toEqual({ consulting: -30000n, 'B:owner_draw': 30000n });
  });

  it('rejects splits that do not sum to the amount', () => {
    expect(() =>
      buildTransactionEntries(
        { date: D, description: 'x', account: checking, amount: -100n, splits: [{ account: groceries, amount: -99n }] },
        resolver,
      ),
    ).toThrow(expect.objectContaining({ code: 'ledger.splits_mismatch' }));
  });

  it('converts a foreign-currency account to functional amounts and settles rounding (CUR-07)', () => {
    // Three €0.01 splits at 1.5 USD/EUR: each rounds to 0.02 (half-even of 0.015), total €0.03 → $0.04 (0.045).
    const [e] = buildTransactionEntries(
      {
        date: D,
        description: 'Paris',
        account: eurAccount,
        amount: -3n,
        fxRate: parseDecimal('1.5'),
        splits: [
          { account: groceries, amount: -1n },
          { account: groceries, amount: -1n, memo: 'b' },
          { account: groceries, amount: -1n, memo: 'c' },
        ],
      },
      resolver,
    );
    const eur = e!.postings.find((p) => p.accountId === 'eur')!;
    expect(eur).toMatchObject({ currency: 'EUR', amount: -3n, functionalAmount: -4n, fxRate: '1.5' });
    expect(e!.postings.find((p) => p.accountId === 'P:fx_rounding')!.functionalAmount).toBe(-2n);
    validateEntry(e!);
  });

  it('every generated entry balances (property, DE-01)', () => {
    const splitAccounts = [groceries, salary, principal, interest, escrow, officeSupplies, savings];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            account: fc.constantFrom(...splitAccounts),
            amount: fc.bigInt({ min: -(10n ** 10n), max: 10n ** 10n }).filter((n) => n !== 0n),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.constantFrom(checking, card),
        (splits, account) => {
          const amount = splits.reduce((a, s) => a + s.amount, 0n);
          if (amount === 0n) return;
          const entries = buildTransactionEntries({ date: D, description: 't', account, amount, splits }, resolver);
          for (const e of entries) {
            expect(e.postings.reduce((a, p) => a + p.functionalAmount, 0n)).toBe(0n);
            expect(e.postings.every((p) => p.accountEntityId === e.entityId)).toBe(true);
          }
        },
      ),
    );
  });

  it('every foreign-currency entry balances after rounding (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -(10n ** 9n), max: -1n }), { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 99_999_999 }),
        (amounts, rateCoeff) => {
          const amount = amounts.reduce((a, b) => a + b, 0n);
          const fxRate = { coefficient: BigInt(rateCoeff), scale: 6 };
          const convertsToZero = amounts.some((a) => (-a * fxRate.coefficient * 2n) / 10n ** 6n <= 1n);
          if (convertsToZero) return; // rejected with ledger.zero_posting; covered by the example test
          const [e] = buildTransactionEntries(
            {
              date: D,
              description: 'fx',
              account: eurAccount,
              amount,
              fxRate,
              splits: amounts.map((a, i) => ({ account: groceries, amount: a, memo: String(i) })),
            },
            resolver,
          );
          expect(e!.postings.reduce((a, p) => a + p.functionalAmount, 0n)).toBe(0n);
          const residual = e!.postings.find((p) => p.accountId === 'P:fx_rounding')?.functionalAmount ?? 0n;
          expect(residual <= BigInt(amounts.length) && residual >= -BigInt(amounts.length)).toBe(true);
        },
      ),
    );
  });
});

describe('tiny conversions', () => {
  it('rejects a split that converts to zero instead of posting a one-legged entry', () => {
    expect(() =>
      buildTransactionEntries(
        {
          date: D,
          description: 'dust',
          account: eurAccount,
          amount: -1n,
          fxRate: parseDecimal('0.001'),
          splits: [{ account: groceries, amount: -1n }],
        },
        resolver,
      ),
    ).toThrow(expect.objectContaining({ code: 'ledger.zero_posting' }));
  });
});

describe('buildTransferEntries (DE-03, TXN-04)', () => {
  it('moves money between accounts in one entry', () => {
    const [e] = buildTransferEntries({ date: D, description: 'Save', from: checking, to: savings, amountOut: 50000n }, resolver);
    expect(e!.kind).toBe('transfer');
    expect(lines(e!)).toEqual({ savings: 50000n, checking: -50000n });
  });

  it('pays a credit card', () => {
    const [e] = buildTransferEntries({ date: D, description: 'Pay card', from: checking, to: card, amountOut: 120000n }, resolver);
    expect(lines(e!)).toEqual({ card: 120000n, checking: -120000n });
  });

  it('records FX cost on a cross-currency transfer (CUR-08)', () => {
    // $1,100.00 buys €1,000.00; EUR valued at 1.08 → $1,080.00; $20.00 FX cost.
    const [e] = buildTransferEntries(
      {
        date: D,
        description: 'Buy EUR',
        from: checking,
        to: eurAccount,
        amountOut: 110000n,
        amountIn: 100000n,
        fxRateTo: parseDecimal('1.08'),
      },
      resolver,
    );
    expect(e!.postings.find((p) => p.accountId === 'eur')).toMatchObject({ amount: 100000n, functionalAmount: 108000n });
    expect(e!.postings.find((p) => p.accountId === 'P:fx_gain_loss')!.functionalAmount).toBe(2000n);
  });

  it('transfers across entities as owner contribution', () => {
    const [p, b] = buildTransferEntries(
      { date: D, description: 'Fund business', from: checking, to: bizChecking, amountOut: 100000n },
      resolver,
    );
    expect(lines(p!)).toEqual({ 'P:clearing:B': 100000n, checking: -100000n });
    expect(lines(b!)).toEqual({ 'biz-checking': 100000n, 'B:owner_contribution': -100000n });
  });

  it('requires both amounts across currencies', () => {
    expect(() => buildTransferEntries({ date: D, description: 'x', from: checking, to: eurAccount, amountOut: 1n }, resolver)).toThrow(
      LedgerError,
    );
  });
});

describe('opening balances and reversals', () => {
  it('posts opening balances against equity (ACC-05)', () => {
    expect(lines(buildOpeningBalanceEntry(checking, 100000n, D, resolver))).toEqual({
      checking: 100000n,
      'P:opening_balance_equity': -100000n,
    });
    expect(lines(buildOpeningBalanceEntry(card, -50000n, D, resolver))).toEqual({
      card: -50000n,
      'P:opening_balance_equity': 50000n,
    });
  });

  it('reverses an entry line by line (DE-10)', () => {
    const [e] = buildTransactionEntries(
      { date: D, description: 'Groceries', account: checking, amount: -5000n, splits: [{ account: groceries, amount: -5000n }] },
      resolver,
    );
    const r = buildReversal(e!, calendarDate('2026-11-01'));
    expect(r.kind).toBe('reversal');
    expect(lines(r)).toEqual({ checking: 5000n, groceries: -5000n });
  });

  it('validateEntry rejects unbalanced and one-legged entries', () => {
    const base = { entityId: 'P', functionalCurrency: 'USD' as const, entryDate: D, kind: 'manual' as const, description: 'x' };
    const post = (accountId: string, amount: bigint, lineNo: number) => ({
      lineNo,
      accountId,
      accountEntityId: 'P',
      currency: 'USD' as const,
      amount,
      functionalAmount: amount,
      fxRate: null,
    });
    expect(() => validateEntry({ ...base, postings: [post('a', 1n, 1)] })).toThrow(
      expect.objectContaining({ code: 'ledger.too_few_postings' }),
    );
    expect(() => validateEntry({ ...base, postings: [post('a', 1n, 1), post('b', -2n, 2)] })).toThrow(
      expect.objectContaining({ code: 'ledger.unbalanced' }),
    );
  });
});
