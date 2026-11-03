import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  burnItems,
  calendarDate as d,
  carryForward,
  computeBudget,
  copyAmounts,
  draftBudget,
  fiftyThirtyTwenty,
  forecast,
  isFixed,
  medianMinor,
  periodContaining,
  periodsBetween,
  projectGoal,
  rec01Cuts,
  rec02Overspend,
  rec03Allocate,
  rec04BareBones,
  rec05Realistic,
  rec07Review,
  shiftPeriod,
  simulatePayoff,
  sinkingFundMonthly,
  spendingPace,
  type PeriodInput,
  type RolloverMode,
} from '../src/index.js';

const MODES: RolloverMode[] = ['carry_surplus', 'carry_deficit', 'carry_both', 'reset'];
const CATS = ['a', 'b', 'c', 'd'];

const month = (i: number) => {
  const p = shiftPeriod({ type: 'monthly' }, d('2026-01-01'), i);
  return { start: p.start, end: p.end };
};

const periodArb = fc.record({
  income: fc.bigInt({ min: 0n, max: 1_000_000n }),
  lines: fc.array(
    fc.record({
      c: fc.constantFrom(...CATS),
      assigned: fc.bigInt({ min: 0n, max: 400_000n }),
      rollover: fc.constantFrom(...MODES),
    }),
    { maxLength: 4 },
  ),
  activity: fc.array(
    fc.record({ c: fc.constantFrom(...CATS, 'e'), v: fc.bigInt({ min: -50_000n, max: 500_000n }) }),
    {
      maxLength: 6,
    },
  ),
  moves: fc.array(
    fc.record({
      from: fc.constantFrom<string | null>(null, ...CATS),
      to: fc.constantFrom<string | null>(null, ...CATS),
      amount: fc.bigInt({ min: 1n, max: 100_000n }),
    }),
    { maxLength: 3 },
  ),
});

type RawPeriod = typeof periodArb extends fc.Arbitrary<infer T> ? T : never;

function toInputs(raw: RawPeriod[]): PeriodInput[] {
  return raw.map((r, i) => {
    const lines = new Map<string, { assigned: bigint; rollover: RolloverMode }>();
    for (const l of r.lines) lines.set(l.c, { assigned: l.assigned, rollover: l.rollover });
    const activity = new Map<string, bigint>();
    for (const a of r.activity) activity.set(a.c, (activity.get(a.c) ?? 0n) + a.v);
    return { ...month(i), income: r.income, lines, activity, moves: r.moves.filter((m) => m.from !== m.to) };
  });
}

describe('computeBudget (04 §8, ADR-0015)', () => {
  it('conserves money: left to assign + Σ available = Σ income − Σ activity, every period', () => {
    fc.assert(
      fc.property(fc.array(periodArb, { minLength: 1, maxLength: 8 }), (raw) => {
        const inputs = toInputs(raw);
        const out = computeBudget(inputs);
        let income = 0n;
        let activity = 0n;
        out.forEach((p, i) => {
          income += inputs[i]!.income;
          for (const v of inputs[i]!.activity.values()) activity += v;
          expect(p.leftToAssign + p.available).toBe(income - activity);
        });
      }),
    );
  });

  it('keeps left to assign consistent with the lines (exit criterion)', () => {
    fc.assert(
      fc.property(fc.array(periodArb, { minLength: 1, maxLength: 6 }), (raw) => {
        for (const p of computeBudget(toInputs(raw))) {
          const lines = [...p.lines.values()];
          const assigned = lines.reduce((s, l) => s + l.assigned, 0n);
          const moved = lines.reduce((s, l) => s + l.moved, 0n);
          expect(p.assigned).toBe(assigned);
          expect(p.movedFromUnassigned).toBe(moved);
          expect(p.leftToAssign).toBe(p.income + p.carriedUnassigned - assigned - moved);
          for (const l of lines) expect(l.available).toBe(l.carriedIn + l.assigned + l.moved - l.activity);
        }
      }),
    );
  });

  it('carries each category per its rollover mode', () => {
    fc.assert(
      fc.property(fc.array(periodArb, { minLength: 2, maxLength: 6 }), (raw) => {
        const out = computeBudget(toInputs(raw));
        for (let i = 1; i < out.length; i++) {
          for (const [c, prev] of out[i - 1]!.lines) {
            const now = out[i]!.lines.get(c);
            const expected = carryForward(prev.available, prev.rollover);
            expect(now?.carriedIn ?? 0n).toBe(expected);
          }
        }
      }),
    );
  });

  it('works the requirements example: overspend not carried returns to left to assign', () => {
    const [oct, nov] = computeBudget([
      {
        ...month(9),
        income: 500_000n,
        lines: new Map([
          ['groceries', { assigned: 60_000n, rollover: 'carry_surplus' }],
          ['dining', { assigned: 20_000n, rollover: 'carry_both' }],
          ['car', { assigned: 10_000n, rollover: 'carry_surplus' }],
        ]),
        activity: new Map([
          ['groceries', 65_000n],
          ['dining', 25_000n],
          ['car', 0n],
        ]),
        moves: [{ from: null, to: 'car', amount: 5_000n }],
      },
      { ...month(10), income: 500_000n, lines: new Map(), activity: new Map(), moves: [] },
    ]);
    expect(oct!.leftToAssign).toBe(500_000n - 90_000n - 5_000n);
    expect(oct!.lines.get('groceries')!.available).toBe(-5_000n);
    expect(oct!.lines.get('car')!.available).toBe(15_000n);
    // Groceries' overspend isn't carried (carry_surplus): it comes out of November's left to assign.
    expect(nov!.lines.get('groceries')!.carriedIn).toBe(0n);
    expect(nov!.lines.get('dining')!.carriedIn).toBe(-5_000n);
    expect(nov!.lines.get('car')!.carriedIn).toBe(15_000n);
    expect(nov!.carriedUnassigned).toBe(405_000n - 5_000n);
    expect(nov!.leftToAssign).toBe(900_000n);
    // Rollover modes persist into periods without lines.
    expect(nov!.lines.get('dining')!.rollover).toBe('carry_both');
  });

  it('rejects unordered periods and bad moves', () => {
    const p = { income: 0n, lines: new Map(), activity: new Map(), moves: [] };
    expect(() =>
      computeBudget([
        { ...month(1), ...p },
        { ...month(0), ...p },
      ]),
    ).toThrow(/ascending/);
    expect(() => computeBudget([{ ...month(0), ...p, moves: [{ from: 'a', to: 'b', amount: 0n }] }])).toThrow(
      /positive/,
    );
  });
});

describe('periods (BUD-05)', () => {
  it('finds monthly and pay periods', () => {
    expect(periodContaining({ type: 'monthly' }, d('2026-02-14'))).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    const biweekly = { type: 'biweekly' as const, anchor: d('2026-01-02') };
    expect(periodContaining(biweekly, d('2026-01-15'))).toEqual({ start: '2026-01-02', end: '2026-01-15' });
    expect(periodContaining(biweekly, d('2026-01-16'))).toEqual({ start: '2026-01-16', end: '2026-01-29' });
    expect(periodContaining(biweekly, d('2025-12-31'))).toEqual({ start: '2025-12-19', end: '2026-01-01' });
    expect(
      periodsBetween({ type: 'weekly', anchor: d('2026-11-02') }, d('2026-11-03'), d('2026-11-20')).map(
        (p) => p.start,
      ),
    ).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
  });

  it('tiles time without gaps or overlaps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 400 }),
        fc.constantFrom('weekly', 'biweekly', 'monthly'),
        (a, len, type) => {
          const spec = { type: type as 'weekly' | 'biweekly' | 'monthly', anchor: d('2024-03-08') };
          const start = d(new Date(Date.UTC(2020, 0, 1 + a)).toISOString().slice(0, 10));
          const end = d(new Date(Date.UTC(2020, 0, 1 + a + len)).toISOString().slice(0, 10));
          const ps = periodsBetween(spec, start, end);
          expect(ps[0]!.start <= start && ps.at(-1)!.end >= end).toBe(true);
          for (let i = 1; i < ps.length; i++) expect(shiftPeriod(spec, ps[i - 1]!.start, 1)).toEqual(ps[i]);
        },
      ),
    );
  });
});

describe('spendingPace (FLOW-04)', () => {
  const nov = { start: d('2026-11-01'), end: d('2026-11-30') };
  it('compares activity with where the category should be today', () => {
    const p = spendingPace(nov, d('2026-11-10'), 60_000n, 30_000n)!;
    expect(p.expectedByToday).toBe(20_000n);
    expect(p.projected).toBe(90_000n);
    expect(p.status).toBe('over');
    expect(spendingPace(nov, d('2026-11-10'), 60_000n, 20_000n)!.status).toBe('on_track');
    expect(spendingPace(nov, d('2026-11-10'), 60_000n, 10_000n)!.status).toBe('under');
    expect(spendingPace(nov, d('2026-12-01'), 60_000n, 10_000n)).toBeNull();
  });
  it('waits until a fifth of the period has passed before calling overspending', () => {
    // Day 3: one big shop projects far over budget, but it's too early to say.
    expect(spendingPace(nov, d('2026-11-03'), 60_000n, 30_000n)!.status).toBe('on_track');
    expect(spendingPace(nov, d('2026-11-06'), 60_000n, 30_000n)!.status).toBe('over');
  });
  it('can follow a day-of-month pattern', () => {
    const weights = Array.from({ length: 30 }, (_, i) => (i === 0 ? 1 : 0)); // all spent on the 1st (rent)
    expect(spendingPace(nov, d('2026-11-02'), 150_000n, 150_000n, weights)!.expectedByToday).toBe(150_000n);
  });
});

describe('goals (BUD-07, BUD-08)', () => {
  it('rounds sinking-fund contributions up, so the target is always met', () => {
    expect(sinkingFundMonthly(120_000n, 0n, d('2026-11-03'), d('2027-01-15'))).toBe(40_000n);
    expect(sinkingFundMonthly(100_000n, 0n, d('2026-11-03'), d('2027-01-15'))).toBe(33_334n);
    expect(sinkingFundMonthly(100_000n, 100_000n, d('2026-11-03'), d('2027-01-15'))).toBe(0n);
    expect(sinkingFundMonthly(100_000n, 0n, d('2026-11-03'), d('2026-01-15'))).toBe(100_000n);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.integer({ min: 0, max: 60 }),
        (target, saved, m) => {
          const due = shiftPeriod({ type: 'monthly' }, d('2026-11-01'), m).start;
          const monthly = sinkingFundMonthly(target, saved, d('2026-11-03'), due);
          const months = BigInt(m + 1);
          const remaining = target - saved;
          if (remaining <= 0n) expect(monthly).toBe(0n);
          else {
            expect(monthly * months >= remaining).toBe(true);
            expect((monthly - 1n) * months < remaining).toBe(true);
          }
        },
      ),
    );
  });

  it('projects completion from the average contribution', () => {
    const g = projectGoal(
      1_000_000n,
      400_000n,
      [100_000n, 100_000n, 100_000n],
      d('2026-11-03'),
      d('2027-06-01'),
    );
    expect(g).toEqual({
      monthlyAverage: 100_000n,
      projectedCompletion: '2027-05-01',
      percent: 40,
      onTrack: true,
    });
    expect(projectGoal(1_000_000n, 400_000n, [], d('2026-11-03')).projectedCompletion).toBeNull();
    expect(projectGoal(null, 5n, [1n], d('2026-11-03')).percent).toBeNull();
  });

  it('simulates snowball and avalanche payoff', () => {
    const debts = [
      { id: 'card', balance: 500_000n, rateBps: 2499, minPayment: 15_000n },
      { id: 'car', balance: 1_200_000n, rateBps: 599, minPayment: 30_000n },
      { id: 'store', balance: 80_000n, rateBps: 1299, minPayment: 2_500n },
    ];
    const snow = simulatePayoff(debts, 20_000n, 'snowball');
    const aval = simulatePayoff(debts, 20_000n, 'avalanche');
    expect(snow.monthlyPayment).toBe(67_500n);
    expect(snow.months).not.toBeNull();
    expect(aval.months).not.toBeNull();
    // Snowball clears the smallest balance first; avalanche pays less interest.
    const first = (p: typeof snow) => [...p.debts].sort((a, b) => a.months! - b.months!)[0]!.id;
    expect(first(snow)).toBe('store');
    expect(aval.totalInterest! <= snow.totalInterest!).toBe(true);
    // Payments below the interest never finish.
    expect(
      simulatePayoff(
        [{ id: 'x', balance: 1_000_000n, rateBps: 3000, minPayment: 1_000n }],
        0n,
        'avalanche',
        120,
      ).months,
    ).toBeNull();
  });
});

describe('draft and copy (BUD-02, BUD-09) and 50/30/20', () => {
  it('drafts medians and recognizes fixed bills', () => {
    expect(medianMinor([3n, 1n, 2n])).toBe(2n);
    expect(medianMinor([1n, 4n])).toBe(3n);
    expect(isFixed([150_000n, 150_000n, 151_000n])).toBe(true);
    expect(isFixed([20_000n, 45_000n, 31_000n])).toBe(false);
    expect(
      draftBudget([
        { categoryId: 'rent', history: [150_000n, 150_000n, 150_000n] },
        { categoryId: 'food', history: [52_000n, 61_000n, 48_000n] },
        { categoryId: 'gym', history: [0n, 0n, 0n], recurringMonthly: 4_500n },
        { categoryId: 'none', history: [0n] },
      ]),
    ).toEqual([
      { categoryId: 'rent', suggested: 150_000n, fixed: true, source: 'history' },
      { categoryId: 'food', suggested: 52_000n, fixed: false, source: 'history' },
      { categoryId: 'gym', suggested: 4_500n, fixed: true, source: 'recurring' },
    ]);
  });

  it('copies last month or the 3-month average', () => {
    const previous = {
      assigned: new Map([
        ['a', 100n],
        ['b', 0n],
      ]),
      activity: [new Map([['a', 90n]]), new Map([['a', 120n]]), new Map([['c', 30n]])],
    };
    expect(copyAmounts('last', previous)).toEqual(new Map([['a', 100n]]));
    expect(copyAmounts('avg3', previous)).toEqual(
      new Map([
        ['a', 70n],
        ['c', 10n],
      ]),
    );
  });

  it('splits by group kind', () => {
    const s = fiftyThirtyTwenty(
      400_000n,
      new Map([
        ['fixed', 150_000n],
        ['daily', 50_000n],
        ['fun', 120_000n],
        ['savings', 60_000n],
        ['debt', 20_000n],
      ]),
    );
    expect(s.percents).toEqual({ needs: 50, wants: 30, savings: 20 });
  });
});

describe('forecast (FLOW-03)', () => {
  it('finds the first low-balance day and its drivers', () => {
    const items = [
      {
        date: d('2026-11-05'),
        accountId: 'chk',
        amount: -150_000n,
        kind: 'recurring' as const,
        name: 'Rent',
        sourceId: null,
      },
      {
        date: d('2026-11-15'),
        accountId: 'chk',
        amount: 300_000n,
        kind: 'income' as const,
        name: 'Salary',
        sourceId: null,
      },
      {
        date: d('2026-11-03'),
        accountId: 'chk',
        amount: -10_000n,
        kind: 'recurring' as const,
        name: 'Phone',
        sourceId: null,
      },
      ...burnItems('chk', 30_000n, d('2026-11-01'), 30),
    ];
    const [f] = forecast([{ accountId: 'chk', start: 160_000n, threshold: 0n }], items, d('2026-11-01'), 30);
    expect(f!.balances).toHaveLength(30);
    expect(f!.balances[0]).toBe(159_000n);
    expect(f!.lowBalance!.date).toBe('2026-11-05');
    expect(f!.lowBalance!.drivers.map((x) => x.name)).toEqual(['Rent', 'Phone']);
    expect(f!.balances.at(-1)).toBe(160_000n - 150_000n + 300_000n - 10_000n - 30_000n);
  });

  it('spreads burn exactly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 8n }), fc.integer({ min: 1, max: 90 }), (total, days) => {
        const items = burnItems('a', total, d('2026-01-01'), days);
        expect(items.reduce((s, i) => s - i.amount, 0n)).toBe(total);
      }),
    );
  });
});

describe('recommendation rules (REC-01..08)', () => {
  it('REC-01 cuts flexible categories to their floors until the budget balances', () => {
    const r = rec01Cuts(-30_000n, [
      { categoryId: 'fun', kind: 'fun', assigned: 20_000n, floor: 5_000n, priority: 0, usageRatio: 0.5 },
      { categoryId: 'food', kind: 'daily', assigned: 60_000n, floor: 45_000n, priority: 0, usageRatio: 0.9 },
      { categoryId: 'rent', kind: 'fixed', assigned: 150_000n, floor: 0n, priority: 0, usageRatio: 1 },
    ])!;
    expect(r.cuts).toEqual([
      { kind: 'assign', categoryId: 'fun', from: 20_000n, to: 5_000n },
      { kind: 'assign', categoryId: 'food', from: 60_000n, to: 45_000n },
    ]);
    expect(r.uncovered).toBe(0n);
    expect(rec01Cuts(0n, [])).toBeNull();
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 7n }),
        fc.array(
          fc.record({ a: fc.bigInt({ min: 0n, max: 10n ** 6n }), f: fc.bigInt({ min: 0n, max: 10n ** 6n }) }),
          { maxLength: 6 },
        ),
        (deficit, cs) => {
          const r = rec01Cuts(
            -deficit,
            cs.map((c, i) => ({
              categoryId: `c${i}`,
              kind: 'daily' as const,
              assigned: c.a,
              floor: c.f,
              priority: 0,
              usageRatio: 1,
            })),
          )!;
          const slack = cs.reduce((s, c) => s + (c.a > c.f ? c.a - c.f : 0n), 0n);
          expect(r.covered).toBe(deficit < slack ? deficit : slack);
          for (const cut of r.cuts) expect(cut.to >= cs[Number(cut.categoryId.slice(1))]!.f).toBe(true);
        },
      ),
    );
  });

  it('REC-02 proposes moves from categories with spare money and a daily reduction', () => {
    const nov = { start: d('2026-11-01'), end: d('2026-11-30') };
    const pace = spendingPace(nov, d('2026-11-10'), 60_000n, 30_000n);
    const r = rec02Overspend(
      { categoryId: 'food', kind: 'daily', assigned: 60_000n, available: 30_000n, pace },
      [
        {
          categoryId: 'fun',
          kind: 'fun',
          assigned: 40_000n,
          available: 38_000n,
          pace: spendingPace(nov, d('2026-11-10'), 40_000n, 2_000n),
        },
        { categoryId: 'rent', kind: 'fixed', assigned: 150_000n, available: 150_000n, pace: null },
      ],
    )!;
    expect(r.overspend).toBe(30_000n);
    expect(r.daysLeft).toBe(20);
    expect(r.perDayReduction).toBe(1_500n);
    expect(r.moves).toEqual([{ kind: 'move', from: 'fun', to: 'food', amount: 30_000n }]);
  });

  it('REC-03 allocates a surplus by priority', () => {
    const r = rec03Allocate(550_000n, 500_000n, {
      emergencyFund: { goalId: 'ef', categoryId: 'efc', gap: 20_000n },
      debts: [
        { goalId: null, categoryId: 'cardc', accountId: 'card', rateBps: 2499, balance: 25_000n },
        { goalId: null, categoryId: 'carc', accountId: 'car', rateBps: 450, balance: 900_000n },
      ],
      goals: [{ goalId: 'trip', categoryId: 'tripc', gap: 100_000n, due: '2027-06-01' }],
      funCategoryId: 'fun',
    })!;
    expect(r.allocations).toEqual([
      { target: 'emergency_fund', id: 'ef', categoryId: 'efc', amount: 20_000n },
      { target: 'debt', id: 'card', categoryId: 'cardc', amount: 25_000n },
      { target: 'goal', id: 'trip', categoryId: 'tripc', amount: 5_000n },
    ]);
    expect(rec03Allocate(1n, 2n, {})).toBeNull();
  });

  it('REC-04 builds a bare-bones budget', () => {
    expect(
      rec04BareBones([
        { categoryId: 'rent', kind: 'fixed', assigned: 150_000n, floor: 0n },
        { categoryId: 'food', kind: 'daily', assigned: 60_000n, floor: 40_000n },
        { categoryId: 'fun', kind: 'fun', assigned: 20_000n, floor: 0n },
        { categoryId: 'card', kind: 'debt', assigned: 50_000n, floor: 15_000n },
      ]),
    ).toEqual({
      cuts: [
        { kind: 'assign', categoryId: 'food', from: 60_000n, to: 40_000n },
        { kind: 'assign', categoryId: 'fun', from: 20_000n, to: 0n },
        { kind: 'assign', categoryId: 'card', from: 50_000n, to: 15_000n },
      ],
      saves: 75_000n,
    });
  });

  it('REC-05 suggests a realistic amount after three off months', () => {
    const h = (a: bigint, x: bigint) => ({ assigned: a, activity: x });
    expect(rec05Realistic([h(30_000n, 45_000n), h(30_000n, 41_000n), h(30_000n, 50_000n)])).toEqual({
      direction: 'over',
      suggested: 45_000n,
    });
    expect(rec05Realistic([h(30_000n, 45_000n), h(30_000n, 31_000n), h(30_000n, 50_000n)])).toBeNull();
    expect(rec05Realistic([h(30_000n, 10_000n), h(30_000n, 12_000n)])).toBeNull();
  });

  it('REC-07 reviews the month', () => {
    const r = rec07Review(500_000n, [
      { categoryId: 'food', kind: 'daily', assigned: 60_000n, activity: 72_000n },
      { categoryId: 'fun', kind: 'fun', assigned: 20_000n, activity: 5_000n },
      { categoryId: 'subs', kind: 'fixed', assigned: 4_000n, activity: 5_500n },
      { categoryId: 'save', kind: 'savings', assigned: 50_000n, activity: 50_000n },
    ]);
    expect(r.spent).toBe(82_500n);
    expect(r.saved).toBe(417_500n);
    expect(r.leaks).toEqual([
      { categoryId: 'food', overBy: 12_000n },
      { categoryId: 'subs', overBy: 1_500n },
    ]);
    expect(r.wentWell).toEqual([{ categoryId: 'fun', under: 15_000n }]);
  });
});
