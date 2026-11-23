import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildRevaluationEntry,
  buildTransactionEntries,
  buildTransferEntries,
  calendarDate,
  decimalToString,
  parseDecimal,
  transferEffectiveRate,
  transferFxCost,
  transferFxQuote,
  translationAdjustment,
  translationAdjustments,
  unrealizedFx,
  unrealizedFxIn,
  valueAtCarrying,
  type AccountResolver,
  type AccountType,
  type CarryingBalance,
  type CalendarDate,
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

  it('quotes a transfer against the market: effective rate, cost and its share (CUR-08)', () => {
    const usd = (amount: bigint) => ({ amount, currency: 'USD' as CurrencyCode });
    const eur = (amount: bigint) => ({ amount, currency: 'EUR' as CurrencyCode });
    // $1,100.00 → €1,000.00: 0.909… EUR per USD; at 1.08 the euros are worth $1,080.00, so $20.00 (1.82%).
    expect(decimalToString(transferEffectiveRate(usd(110_000n), eur(100_000n)))).toBe('0.9090909091');
    const one = parseDecimal('1');
    expect(
      transferFxQuote(usd(110_000n), eur(100_000n), 'USD', { sent: one, received: parseDecimal('1.08') }),
    ).toEqual({ sentValue: 110_000n, cost: 2_000n, costBps: 182n });
    // Better than market: negative.
    expect(
      transferFxQuote(usd(100_000n), eur(100_000n), 'USD', { sent: one, received: parseDecimal('1.08') }),
    ).toEqual({ sentValue: 100_000n, cost: -8_000n, costBps: -800n });
    // Euros → yen in USD books: both legs at market. €100.00 at 1.10 = $110.00; ¥15,000 at 0.0072 = $108.00.
    const jpy = { amount: 15_000n, currency: 'JPY' as CurrencyCode };
    expect(decimalToString(transferEffectiveRate(eur(10_000n), jpy))).toBe('150.0000000000');
    expect(
      transferFxQuote(eur(10_000n), jpy, 'USD', {
        sent: parseDecimal('1.10'),
        received: parseDecimal('0.0072'),
      }),
    ).toEqual({ sentValue: 11_000n, cost: 200n, costBps: 182n });
    expect(() => transferEffectiveRate(usd(0n), eur(1n))).toThrow(RangeError);
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

describe('unrealized FX in a report currency (CUR-06)', () => {
  it("is the revalued balance less its carrying value, in the books' currency", () => {
    // €1,000.00 carried at $1,050.00 is worth $1,100.00 at 1.10, and $1,000.00 at 1.00.
    expect(unrealizedFxIn(held, 'EUR', 'USD', parseDecimal('1.10'), 'USD', null)).toBe(5_000n);
    expect(unrealizedFxIn(held, 'EUR', 'USD', parseDecimal('1.00'), 'USD', null)).toBe(-5_000n);
  });

  it('is a loss on a foreign debt when that currency gets stronger', () => {
    // A €200.00 card balance (a credit) carried at $210.00 is $220.00 owed at 1.10.
    const owed: CarryingBalance = { foreign: -20_000n, functional: -21_000n };
    expect(unrealizedFxIn(owed, 'EUR', 'USD', parseDecimal('1.10'), 'USD', null)).toBe(-1_000n);
  });

  it('translates the gain when the report is in another currency', () => {
    // Books in CAD: €1,000.00 carried at C$1,500.00 is worth C$1,550.00 at 1.55; C$50.00 is $35.00 at 0.70.
    const cad: CarryingBalance = { foreign: 100_000n, functional: 150_000n };
    expect(unrealizedFxIn(cad, 'EUR', 'CAD', parseDecimal('1.55'), 'USD', parseDecimal('0.70'))).toBe(3_500n);
  });

  it("is zero in the books' own currency, and null without a rate", () => {
    expect(unrealizedFxIn({ foreign: 500n, functional: 500n }, 'USD', 'USD', null, 'EUR', null)).toBe(0n);
    expect(unrealizedFxIn(held, 'EUR', 'USD', null, 'USD', null)).toBeNull();
    expect(unrealizedFxIn(held, 'EUR', 'CAD', parseDecimal('1.55'), 'USD', null)).toBeNull();
  });
});

describe('translation adjustment (ADR-0010 §7)', () => {
  // Books in EUR inside a USD workspace. Rates are dollars per euro.
  const r = (x: string) => parseDecimal(x);
  const rates: Record<string, string> = {
    '2026-01-01': '1.10',
    '2026-01-31': '1.11',
    '2026-02-10': '1.12',
    '2026-03-05': '1.08',
    '2026-03-31': '1.15',
  };
  const rateOn = (d: CalendarDate) => (rates[d] ? r(rates[d]) : null);
  const movements = [
    { date: calendarDate('2026-01-01'), amount: 100_000n }, // €1,000.00 paid in: $1,100.00
    { date: calendarDate('2026-02-10'), amount: 50_000n }, // €500.00 earned: $560.00
    { date: calendarDate('2026-03-05'), amount: -20_000n }, // €200.00 spent: $216.00
  ];

  it('is the closing-rate net assets less the opening translated net assets and income at transaction rates', () => {
    // From the start: €1,300.00 at 1.15 is $1,495.00; the history at its own rates is $1,444.00.
    const fromStart = translationAdjustment(
      'EUR',
      'USD',
      { netAssets: 0n, translated: 0n },
      movements.map((m) => ({ amount: m.amount, rate: rateOn(m.date) })),
      r('1.15'),
    );
    expect(fromStart).toBe(149_500n - (110_000n + 56_000n - 21_600n));
    expect(fromStart).toBe(5_100n);
    // For February and March: €1,000.00 opened at 1.11 ($1,110.00), then $560.00 − $216.00 at their own rates.
    const period = translationAdjustment(
      'EUR',
      'USD',
      { netAssets: 100_000n, translated: 111_000n },
      [
        { amount: 50_000n, rate: r('1.12') },
        { amount: -20_000n, rate: r('1.08') },
      ],
      r('1.15'),
    );
    expect(period).toBe(149_500n - (111_000n + 56_000n - 21_600n));
    expect(period).toBe(4_100n);
    // January's $10.00 (€1,000.00 from 1.10 to 1.11) plus the period's $41.00 is the cumulative $51.00.
    expect(
      translationAdjustment(
        'EUR',
        'USD',
        { netAssets: 0n, translated: 0n },
        [movements[0]!].map((m) => ({
          amount: m.amount,
          rate: rateOn(m.date),
        })),
        r('1.11'),
      ),
    ).toBe(1_000n);
  });

  it('is zero when the rate never moves', () => {
    const flat = movements.map((m) => ({ amount: m.amount, rate: r('1.10') }));
    expect(translationAdjustment('EUR', 'USD', { netAssets: 0n, translated: 0n }, flat, r('1.10'))).toBe(0n);
    const at = translationAdjustments('EUR', 'USD', movements, [calendarDate('2026-03-31')], () => r('1.10'));
    expect(at.get(calendarDate('2026-03-31'))).toBe(0n);
  });

  it('rolls forward over each date, the same as working it out from the start', () => {
    const at = translationAdjustments(
      'EUR',
      'USD',
      movements,
      [calendarDate('2026-03-31'), calendarDate('2025-12-31'), calendarDate('2026-01-31')],
      rateOn,
    );
    expect(at.get(calendarDate('2025-12-31'))).toBe(0n);
    expect(at.get(calendarDate('2026-01-31'))).toBe(1_000n);
    expect(at.get(calendarDate('2026-03-31'))).toBe(5_100n);
  });

  it('keeps what translation made after the money has gone', () => {
    // €100.00 in at 1.10 ($110.00) and out at 1.20 ($120.00): nothing held, a $10.00 adjustment, no closing rate needed.
    const at = translationAdjustment(
      'EUR',
      'USD',
      { netAssets: 0n, translated: 0n },
      [
        { amount: 10_000n, rate: r('1.10') },
        { amount: -10_000n, rate: r('1.20') },
      ],
      null,
    );
    expect(at).toBe(1_000n);
  });

  it("is zero in the report's own currency, and null without a rate it needs", () => {
    expect(translationAdjustment('USD', 'USD', { netAssets: 500n, translated: 0n }, [], null)).toBe(0n);
    expect(
      translationAdjustment(
        'EUR',
        'USD',
        { netAssets: 0n, translated: 0n },
        [{ amount: 1n, rate: null }],
        r('1.1'),
      ),
    ).toBeNull();
    expect(
      translationAdjustment(
        'EUR',
        'USD',
        { netAssets: 0n, translated: 0n },
        [{ amount: 1n, rate: r('1.1') }],
        null,
      ),
    ).toBeNull();
    // A date before the gap is still known; every date after it isn't.
    const gap = translationAdjustments(
      'EUR',
      'USD',
      [...movements, { date: calendarDate('2026-02-20'), amount: 1_000n }],
      [calendarDate('2026-01-31'), calendarDate('2026-03-31')],
      rateOn,
    );
    expect(gap.get(calendarDate('2026-01-31'))).toBe(1_000n);
    expect(gap.get(calendarDate('2026-03-31'))).toBeNull();
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
