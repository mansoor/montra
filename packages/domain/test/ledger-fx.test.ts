import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildRevaluationEntry,
  buildTransactionEntries,
  buildTransferEntries,
  calendarDate,
  parseDecimal,
  transferFxCost,
  unrealizedFx,
  valueAtCarrying,
  type AccountResolver,
  type AccountType,
  type CarryingBalance,
  type CurrencyCode,
  type EntityRef,
  type JournalEntryDraft,
  type LedgerAccountRef,
  type SystemRole,
} from '../src/index.js';

// ADR-0010: carrying value on outflows, realized FX gain/loss, revaluation (design 04 §2.2, CUR-06..08).
const D = calendarDate('2026-11-14');
const personal: EntityRef = { id: 'P', type: 'personal', functionalCurrency: 'USD' };
const acct = (id: string, type: AccountType, currency: CurrencyCode = 'USD'): LedgerAccountRef => ({
  id,
  entityId: 'P',
  type,
  currency,
});
const checking = acct('checking', 'asset');
const eur = acct('eur', 'asset', 'EUR');
const eur2 = acct('eur2', 'asset', 'EUR');
const eurCard = acct('eur-card', 'liability', 'EUR');
const groceries = acct('groceries', 'expense');
const salary = acct('salary', 'income');

const resolver: AccountResolver = {
  entity: () => personal,
  systemAccount: (entityId, role: SystemRole) => ({
    id: `${entityId}:${role}`,
    entityId,
    type: role === 'fx_rounding' || role === 'fx_gain_loss' ? 'expense' : 'equity',
    currency: 'USD',
    systemRole: role,
  }),
  interEntity: () => {
    throw new Error('not used');
  },
};

const line = (e: JournalEntryDraft, id: string) => e.postings.find((p) => p.accountId === id);
const functional = (e: JournalEntryDraft) =>
  Object.fromEntries(e.postings.map((p) => [p.accountId, p.functionalAmount]));

// €1,000.00 bought at 1.05: carried at $1,050.00.
const held: CarryingBalance = { foreign: 100_000n, functional: 105_000n };

const spend = (amount: bigint, rate: string, carrying?: CarryingBalance) =>
  buildTransactionEntries(
    {
      date: D,
      description: 'Spend in EUR',
      account: eur,
      amount,
      fxRate: parseDecimal(rate),
      carrying,
      splits: [{ account: amount < 0n ? groceries : salary, amount }],
    },
    resolver,
  )[0]!;

describe('spending from a foreign-currency account (ADR-0010 §3)', () => {
  it('values the outflow at carrying cost and realizes the gain', () => {
    const e = spend(-10_000n, '1.10', held); // €100 spent while EUR is worth 1.10
    expect(functional(e)).toEqual({ eur: -10_500n, groceries: 11_000n, 'P:fx_gain_loss': -500n });
    expect(line(e, 'eur')).toMatchObject({ amount: -10_000n, fxRate: '1.0500000000' });
  });

  it('realizes a loss when EUR fell since it was bought', () => {
    const e = spend(-10_000n, '1.00', held);
    expect(functional(e)).toEqual({ eur: -10_500n, groceries: 10_000n, 'P:fx_gain_loss': 500n });
  });

  it('values everything at the transaction rate without a carrying balance (unchanged behaviour)', () => {
    expect(functional(spend(-10_000n, '1.10'))).toEqual({ eur: -11_000n, groceries: 11_000n });
  });

  it('closes the account at exactly its functional balance, so €0 is $0', () => {
    // €0.03 carried at $0.04, spent one cent at a time.
    let balance: CarryingBalance = { foreign: 3n, functional: 4n };
    const steps: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const out = line(spend(-1n, '1.50', balance), 'eur')!.functionalAmount;
      steps.push(out);
      balance = { foreign: balance.foreign - 1n, functional: balance.functional + out };
    }
    expect(steps).toEqual([-1n, -2n, -1n]);
    expect(balance).toEqual({ foreign: 0n, functional: 0n });
  });

  it('values only the part that closes the position at carrying cost when it crosses zero', () => {
    // €150 out of €100: €100 at carrying ($105), €50 opens an overdraft at 1.10 ($55).
    const e = spend(-15_000n, '1.10', { foreign: 10_000n, functional: 10_500n });
    expect(functional(e)).toEqual({ eur: -16_000n, groceries: 16_500n, 'P:fx_gain_loss': -500n });
  });

  it('records money arriving at the transaction rate (§2)', () => {
    expect(functional(spend(10_000n, '1.20', held))).toEqual({ eur: 12_000n, salary: -12_000n });
  });
});

describe('transfers (ADR-0010 §4, CUR-08)', () => {
  it('realizes the gain when EUR is sold back', () => {
    // €100 carried at $105 sells for $112.
    const [e] = buildTransferEntries(
      {
        date: D,
        description: 'Sell EUR',
        from: eur,
        to: checking,
        amountOut: 10_000n,
        amountIn: 11_200n,
        fxRateFrom: parseDecimal('1.12'),
        carryingFrom: held,
      },
      resolver,
    );
    expect(functional(e!)).toEqual({ checking: 11_200n, eur: -10_500n, 'P:fx_gain_loss': -700n });
  });

  it('settles a foreign card at its carrying value; the extra cost is a realized loss', () => {
    // The card owes €500, booked at $525. Paying it costs $560.
    const [e] = buildTransferEntries(
      {
        date: D,
        description: 'Pay EUR card',
        from: checking,
        to: eurCard,
        amountOut: 56_000n,
        amountIn: 50_000n,
        fxRateTo: parseDecimal('1.12'),
        carryingTo: { foreign: -50_000n, functional: -52_500n },
      },
      resolver,
    );
    expect(functional(e!)).toEqual({ 'eur-card': 52_500n, checking: -56_000n, 'P:fx_gain_loss': 3_500n });
  });

  it('moves the carrying value between two accounts in the same foreign currency', () => {
    const [e] = buildTransferEntries(
      {
        date: D,
        description: 'EUR to EUR',
        from: eur,
        to: eur2,
        amountOut: 20_000n,
        fxRateFrom: parseDecimal('1.30'),
        fxRateTo: parseDecimal('1.30'),
        carryingFrom: held,
      },
      resolver,
    );
    expect(functional(e!)).toEqual({ eur2: 21_000n, eur: -21_000n });
  });

  it('measures FX cost against the market rate', () => {
    // $1,100.00 bought €1,000.00 while the market was 1.08.
    expect(transferFxCost(110_000n, { amount: 100_000n, currency: 'EUR' }, 'USD', parseDecimal('1.08'))).toBe(
      2_000n,
    );
    expect(transferFxCost(500n, { amount: 500n, currency: 'USD' }, 'USD', parseDecimal('1'))).toBe(0n);
  });
});

describe('revaluation (ADR-0010 §6, CUR-06)', () => {
  it('reports unrealized FX and can post it at period close', () => {
    expect(unrealizedFx(held, 'EUR', 'USD', parseDecimal('1.10'))).toBe(5_000n);
    const e = buildRevaluationEntry(eur, held, parseDecimal('1.10'), D, resolver)!;
    expect(e.kind).toBe('fx_revaluation');
    expect(e.postings.map((p) => [p.accountId, p.amount, p.functionalAmount])).toEqual([
      ['eur', 0n, 5_000n],
      ['P:fx_gain_loss', -5_000n, -5_000n],
    ]);
    expect(buildRevaluationEntry(eur, held, parseDecimal('1.05'), D, resolver)).toBeNull();
    expect(
      buildRevaluationEntry(checking, { foreign: 1n, functional: 1n }, parseDecimal('2'), D, resolver),
    ).toBeNull();
  });
});

describe('valueAtCarrying', () => {
  it('falls back to the transaction rate when the carrying value has no meaningful rate', () => {
    expect(valueAtCarrying(-100n, { foreign: 1_000n, functional: -50n }, -110n)).toBe(-110n);
    expect(valueAtCarrying(-100n, { foreign: 0n, functional: 0n }, -110n)).toBe(-110n);
  });

  it('keeps the books: whenever the foreign balance is zero, so is the functional one (property)', () => {
    const op = fc.record({
      amount: fc.bigInt({ min: -60_000n, max: 60_000n }).filter((n) => n <= -100n || n >= 100n),
      rate: fc.integer({ min: 500, max: 2_000 }), // 0.500 to 2.000 USD per EUR
    });
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 40 }), (ops) => {
        let balance: CarryingBalance = { foreign: 0n, functional: 0n };
        for (const { amount, rate } of ops) {
          const e = spend(amount, (rate / 1000).toFixed(3), balance);
          const account = line(e, 'eur')!;
          balance = {
            foreign: balance.foreign + amount,
            functional: balance.functional + account.functionalAmount,
          };
          if (balance.foreign === 0n) expect(balance.functional).toBe(0n);
          // The carrying value never takes the opposite sign of the foreign balance.
          expect(balance.functional === 0n || balance.functional > 0n === balance.foreign > 0n).toBe(true);
        }
      }),
    );
  });
});
