import { describe, expect, it } from 'vitest';
import {
  allocateShared,
  amortize,
  applyRentPayments,
  calendarDate,
  capRateBps,
  cashOnCashBps,
  depreciationForYear,
  lateFee,
  leaseExpiryWindow,
  loanPaymentDate,
  matchRentDeposits,
  monthlyPayment,
  occupancyBps,
  occupiedDays,
  payerMatchesTenant,
  rentPeriods,
  type ChargeInput,
  type DepositLine,
  type OpenLease,
} from '../src/index.js';

const d = calendarDate;

describe('rentPeriods', () => {
  const lease = (start: string, end: string | null = null, dueDay = 1, endedOn: string | null = null) => ({
    start: d(start),
    end: end ? d(end) : null,
    endedOn: endedOn ? d(endedOn) : null,
    dueDay,
  });

  it('charges once a month on the due day, through the date given', () => {
    expect(rentPeriods(lease('2026-01-01'), d('2026-03-15')).map((p) => p.due)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  it('uses the last day of a short month', () => {
    const p = rentPeriods(lease('2026-01-01', null, 31), d('2026-04-30'));
    expect(p.map((x) => x.due)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(rentPeriods(lease('2028-02-01', null, 31), d('2028-02-29')).map((x) => x.due)).toEqual([
      '2028-02-29',
    ]);
  });

  it('charges a lease that starts after the due day on its first day', () => {
    const p = rentPeriods(lease('2026-03-15'), d('2026-05-01'));
    expect(p).toEqual([
      { periodStart: '2026-03-01', due: '2026-03-15' },
      { periodStart: '2026-04-01', due: '2026-04-01' },
      { periodStart: '2026-05-01', due: '2026-05-01' },
    ]);
  });

  it('stops at the end of the lease, or at move-out', () => {
    expect(rentPeriods(lease('2026-01-01', '2026-02-28'), d('2026-12-31'))).toHaveLength(2);
    expect(rentPeriods(lease('2026-01-01', '2026-12-31', 1, '2026-02-10'), d('2026-12-31'))).toHaveLength(2);
    expect(rentPeriods(lease('2026-01-01'), d('2025-12-31'))).toEqual([]);
  });
});

describe('lateFee', () => {
  it('adds a flat fee and a percentage, up to the cap', () => {
    expect(lateFee({ graceDays: 5, flat: 5000n, bps: 0, cap: null }, 150000n)).toBe(5000n);
    expect(lateFee({ graceDays: 5, flat: 0n, bps: 500, cap: null }, 150000n)).toBe(7500n);
    expect(lateFee({ graceDays: 5, flat: 2500n, bps: 500, cap: 7500n }, 150000n)).toBe(7500n);
    expect(lateFee({ graceDays: 5, flat: 0n, bps: 0, cap: null }, 150000n)).toBe(0n);
  });
});

describe('applyRentPayments', () => {
  const rent = (id: string, due: string, amount = 1000n): ChargeInput => ({
    id,
    kind: 'rent',
    due: d(due),
    amount,
    waived: false,
  });
  const today = d('2026-03-10');
  const statuses = (paid: bigint, charges: ChargeInput[]) =>
    applyRentPayments(charges, paid, today, 5).charges.map((c) => [c.id, c.status, c.open]);

  it('pays the oldest first, whatever order the money came in', () => {
    expect(statuses(1500n, [rent('feb', '2026-02-01'), rent('jan', '2026-01-01')])).toEqual([
      ['jan', 'paid', 0n],
      ['feb', 'late', 500n],
    ]);
  });

  it('tells due from late by the grace days', () => {
    const c = [rent('mar', '2026-03-08'), rent('apr', '2026-04-01')];
    expect(statuses(0n, c)).toEqual([
      ['mar', 'due', 1000n],
      ['apr', 'upcoming', 1000n],
    ]);
    expect(statuses(0n, [rent('feb', '2026-03-05')])[0]![1]).toBe('due'); // 5 days: still in grace
    expect(statuses(0n, [rent('feb', '2026-03-04')])[0]![1]).toBe('late'); // 6 days
    expect(statuses(200n, [rent('mar', '2026-03-08')])[0]![1]).toBe('partial');
  });

  it('counts the days late, and a waived charge owes nothing', () => {
    const res = applyRentPayments([rent('jan', '2026-03-01')], 0n, today, 5);
    expect(res.charges[0]!.daysLate).toBe(9);
    const waived = applyRentPayments(
      [{ ...rent('jan', '2026-01-01'), waived: true }, rent('feb', '2026-02-01')],
      1000n,
      today,
      5,
    );
    expect(waived.charges.map((c) => [c.status, c.paid])).toEqual([
      ['waived', 0n],
      ['paid', 1000n],
    ]);
  });

  it('applies rent before its own late fee, and keeps what is left as a credit', () => {
    const fee: ChargeInput = {
      id: 'fee',
      kind: 'late_fee',
      due: d('2026-01-01'),
      amount: 50n,
      waived: false,
    };
    const res = applyRentPayments([fee, rent('jan', '2026-01-01')], 1020n, today, 5);
    expect(res.charges.map((c) => [c.id, c.paid])).toEqual([
      ['jan', 1000n],
      ['fee', 20n],
    ]);
    expect(applyRentPayments([rent('jan', '2026-01-01')], 2500n, today, 5).credit).toBe(1500n);
  });
});

describe('payerMatchesTenant', () => {
  it('needs the surname, in any case, among noise', () => {
    expect(payerMatchesTenant('ZELLE FROM MARIA GARCIA 8831', 'Maria Garcia')).toBe(true);
    expect(payerMatchesTenant('ACH CREDIT GARCIA M', 'Maria Garcia')).toBe(true);
    expect(payerMatchesTenant('MARIA LOPEZ', 'Maria Garcia')).toBe(false);
  });

  it('is not fooled by generic words or part of a word', () => {
    expect(payerMatchesTenant('RENT PAYMENT', 'Payment Rent')).toBe(false);
    expect(payerMatchesTenant('GARCIAS TACOS', 'Maria Garcia')).toBe(false);
    expect(payerMatchesTenant('ANYTHING', '   ')).toBe(false);
  });
});

describe('matchRentDeposits', () => {
  const lease = (id: string, tenant: string, rent = 150000n, over: Partial<OpenLease> = {}): OpenLease => ({
    id,
    tenantNames: [tenant],
    payeeKeys: [],
    openCharges: [{ open: rent, due: d('2026-03-01') }],
    depositOwed: 0n,
    start: d('2025-01-01'),
    ...over,
  });
  const line = (id: string, amount: bigint, payer = 'ACH DEPOSIT', date = '2026-03-02'): DepositLine => ({
    id,
    amount,
    payer,
    payeeKey: null,
    date: d(date),
  });

  it('links a line naming the tenant, for any amount', () => {
    expect(matchRentDeposits([lease('a', 'Maria Garcia')], [line('p', 50000n, 'ZELLE GARCIA')])).toEqual([
      { leaseId: 'a', depositId: 'p', kind: 'rent' },
    ]);
  });

  it('links the exact rent only when nothing competes', () => {
    expect(matchRentDeposits([lease('a', 'A Smith')], [line('p', 150000n)])).toEqual([
      { leaseId: 'a', depositId: 'p', kind: 'rent' },
    ]);
    expect(matchRentDeposits([lease('a', 'A Smith'), lease('b', 'B Jones')], [line('p', 150000n)])).toEqual(
      [],
    );
    expect(matchRentDeposits([lease('a', 'A Smith')], [line('p', 150000n), line('q', 150000n)])).toEqual([]);
  });

  it('a name settles it between two leases at the same rent', () => {
    const res = matchRentDeposits(
      [lease('a', 'A Smith'), lease('b', 'B Jones')],
      [line('p', 150000n, 'JONES B'), line('q', 150000n)],
    );
    expect(res).toEqual([
      { leaseId: 'b', depositId: 'p', kind: 'rent' },
      { leaseId: 'a', depositId: 'q', kind: 'rent' },
    ]);
  });

  it('never guesses a partial payment from the amount alone', () => {
    expect(matchRentDeposits([lease('a', 'A Smith')], [line('p', 50000n)])).toEqual([]);
  });

  it('respects the window', () => {
    expect(matchRentDeposits([lease('a', 'A Smith')], [line('p', 150000n, 'SMITH', '2026-02-20')])).toEqual(
      [],
    );
    expect(matchRentDeposits([lease('a', 'A Smith')], [line('p', 150000n, 'SMITH', '2026-04-05')])).toEqual(
      [],
    );
    expect(
      matchRentDeposits([lease('a', 'A Smith')], [line('p', 150000n, 'SMITH', '2026-02-24')]),
    ).toHaveLength(1);
  });

  it('remembers a name a past payment came under', () => {
    const l = lease('a', 'A Smith', 150000n, { payeeKeys: ['acme property pay'] });
    const res = matchRentDeposits(
      [l],
      [{ ...line('p', 40000n, 'ACME PROPERTY PAY'), payeeKey: 'acme property pay' }],
    );
    expect(res).toEqual([{ leaseId: 'a', depositId: 'p', kind: 'rent' }]);
  });

  it('takes a security deposit first, even when it equals a month of rent', () => {
    const l = lease('a', 'Maria Garcia', 150000n, { depositOwed: 150000n, start: d('2026-03-01') });
    const res = matchRentDeposits(
      [l],
      [line('dep', 150000n, 'GARCIA', '2026-02-25'), line('rent', 150000n, 'GARCIA', '2026-03-01')],
    );
    expect(res).toEqual([
      { leaseId: 'a', depositId: 'dep', kind: 'security_deposit' },
      { leaseId: 'a', depositId: 'rent', kind: 'rent' },
    ]);
  });

  it('a nameless deposit of that size goes to the deposit, and rent waits', () => {
    const l = lease('a', 'A Smith', 150000n, { depositOwed: 150000n, start: d('2026-03-01') });
    expect(matchRentDeposits([l], [line('p', 150000n)])).toEqual([
      { leaseId: 'a', depositId: 'p', kind: 'security_deposit' },
    ]);
  });
});

describe('allocateShared', () => {
  it('adds up to the cent and keeps the sign', () => {
    expect(allocateShared(100n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(allocateShared(-10000n, [3n, 1n])).toEqual([-7500n, -2500n]);
  });
});

describe('monthlyPayment and amortize', () => {
  const loan = { principal: 20000000n, rateBps: 600, termMonths: 360 };

  it('matches the published payment for a 30-year loan', () => {
    // $200,000 at 6% over 30 years is $1,199.10 a month.
    expect(monthlyPayment(loan)).toBe(119910n);
    // $100,000 at 4.5% over 15 years is $764.99.
    expect(monthlyPayment({ principal: 10000000n, rateBps: 450, termMonths: 180 })).toBe(76499n);
  });

  it('splits the first payment into interest and principal', () => {
    const rows = amortize(loan, d('2026-02-01'));
    expect(rows[0]).toMatchObject({ number: 1, date: '2026-02-01', interest: 100000n, principal: 19910n });
    expect(rows[1]!.interest).toBeLessThan(rows[0]!.interest);
  });

  it('pays off exactly, however the rounding fell', () => {
    for (const l of [
      loan,
      { principal: 12345678n, rateBps: 725, termMonths: 240 },
      { principal: 100n, rateBps: 300, termMonths: 7 },
    ]) {
      const rows = amortize(l, d('2026-01-31'));
      expect(rows.reduce((t, r) => t + r.principal, 0n)).toBe(l.principal);
      expect(rows.at(-1)!.balance).toBe(0n);
      expect(rows.every((r) => r.principal >= 0n && r.payment === r.principal + r.interest)).toBe(true);
    }
  });

  it('handles a zero rate', () => {
    const rows = amortize({ principal: 1000n, rateBps: 0, termMonths: 3 }, d('2026-01-01'));
    expect(rows.map((r) => r.principal)).toEqual([334n, 334n, 332n]);
    expect(rows.every((r) => r.interest === 0n)).toBe(true);
  });

  it('keeps the payment day through short months', () => {
    expect(loanPaymentDate(d('2026-01-31'), 2)).toBe('2026-02-28');
    expect(loanPaymentDate(d('2026-01-31'), 3)).toBe('2026-03-31');
    expect(loanPaymentDate(d('2026-12-15'), 2)).toBe('2027-01-15');
  });
});

describe('depreciationForYear', () => {
  it('matches the IRS mid-month table for 27.5 years', () => {
    const basis = 10000000n;
    // Table A-6, placed in service in January: 3.485% the first year, 3.636% after.
    expect(depreciationForYear(basis, d('2026-01-15'), 2026, 'SL_27_5')).toBe(348485n);
    expect(depreciationForYear(basis, d('2026-01-15'), 2027, 'SL_27_5')).toBe(363636n);
    // Placed in service in July: 1.667% the first year.
    expect(depreciationForYear(basis, d('2026-07-01'), 2026, 'SL_27_5')).toBe(166667n);
    expect(depreciationForYear(basis, d('2026-12-20'), 2026, 'SL_27_5')).toBe(15152n);
  });

  it('matches 39 years for non-residential', () => {
    // 2.564% a year. Within a cent: taking differences of the running total is what makes the years add up.
    const year = depreciationForYear(10000000n, d('2026-01-15'), 2027, 'SL_39');
    expect(year >= 256410n && year <= 256411n).toBe(true);
  });

  it('is nothing before service, adds up to the basis, and stops', () => {
    const basis = 12345677n;
    const start = d('2026-05-10');
    expect(depreciationForYear(basis, start, 2025, 'SL_27_5')).toBe(0n);
    let total = 0n;
    for (let y = 2026; y <= 2060; y++) total += depreciationForYear(basis, start, y, 'SL_27_5');
    expect(total).toBe(basis);
    expect(depreciationForYear(basis, start, 2060, 'SL_27_5')).toBe(0n);
  });
});

describe('returns', () => {
  it('computes cap rate and cash-on-cash, undefined without the figure', () => {
    expect(capRateBps(1200000n, 20000000n)).toBe(600);
    expect(capRateBps(1200000n, null)).toBeNull();
    expect(capRateBps(1200000n, 0n)).toBeNull();
    expect(cashOnCashBps(500000n, 5000000n)).toBe(1000);
    expect(cashOnCashBps(-500000n, 5000000n)).toBe(-1000);
    expect(cashOnCashBps(500000n, null)).toBeNull();
  });
});

describe('occupancy', () => {
  const from = d('2026-01-01');
  const to = d('2026-01-31');

  it('counts both ends, clips to the range, and never counts an overlap twice', () => {
    expect(occupiedDays([{ start: from, end: to }], from, to)).toBe(31);
    expect(occupiedDays([{ start: d('2025-06-01'), end: null }], from, to)).toBe(31);
    expect(occupiedDays([{ start: d('2026-01-11'), end: d('2026-01-20') }], from, to)).toBe(10);
    expect(
      occupiedDays(
        [
          { start: d('2026-01-01'), end: d('2026-01-15') },
          { start: d('2026-01-10'), end: d('2026-01-20') },
        ],
        from,
        to,
      ),
    ).toBe(20);
    expect(occupiedDays([{ start: d('2026-02-01'), end: null }], from, to)).toBe(0);
  });

  it('gives a share of all unit-days', () => {
    expect(occupancyBps(31, 2, from, to)).toBe(5000);
    expect(occupancyBps(62, 2, from, to)).toBe(10000);
    expect(occupancyBps(0, 0, from, to)).toBeNull();
  });
});

describe('leaseExpiryWindow', () => {
  const today = d('2026-03-01');

  it('gives the 60 and 30 day reminders', () => {
    expect(leaseExpiryWindow(d('2026-06-30'), today)).toBeNull();
    expect(leaseExpiryWindow(d('2026-04-30'), today)).toBe(60);
    expect(leaseExpiryWindow(d('2026-03-31'), today)).toBe(30);
    expect(leaseExpiryWindow(d('2026-03-01'), today)).toBe(30);
    expect(leaseExpiryWindow(d('2026-02-28'), today)).toBeNull();
  });
});
