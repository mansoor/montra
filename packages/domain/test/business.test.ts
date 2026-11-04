import { describe, expect, it } from 'vitest';
import {
  allocatePayment,
  autoMatch,
  calendarDate,
  canPay,
  estimatedTaxPeriods,
  invoiceLineAmounts,
  invoiceStatus,
  invoiceTotals,
  marginBps,
  mileageDeduction,
  mileageRateOn,
  taxSetAside,
  taxSetAsideTarget,
  type OpenItem,
  type PaymentCandidate,
} from '../src/index.js';

const d = calendarDate;

describe('invoice arithmetic', () => {
  it('multiplies quantity by price and rounds half up', () => {
    expect(invoiceLineAmounts({ quantityMilli: 1500n, unitPrice: 12500n, taxRateBps: 0 })).toEqual({
      amount: 18750n,
      tax: 0n,
    });
    // 3 × $0.333 is not a thing we can bill; 0.333 of $1.00 rounds to 33 cents.
    expect(invoiceLineAmounts({ quantityMilli: 333n, unitPrice: 100n, taxRateBps: 0 }).amount).toBe(33n);
    expect(invoiceLineAmounts({ quantityMilli: 1000n, unitPrice: 1050n, taxRateBps: 825 }).tax).toBe(87n);
  });

  it('totals tax line by line, as it prints', () => {
    const t = invoiceTotals([
      { quantityMilli: 1000n, unitPrice: 10000n, taxRateBps: 825 },
      { quantityMilli: 2000n, unitPrice: 2550n, taxRateBps: 0 },
    ]);
    expect(t).toEqual({ subtotal: 15100n, tax: 825n, total: 15925n });
  });

  describe('status', () => {
    const today = d('2026-11-10');
    const status = (paid: bigint, due = '2026-11-20', stored: 'draft' | 'sent' | 'void' = 'sent') =>
      invoiceStatus(stored, 10000n, paid, d(due), today);

    it('follows payments and the date', () => {
      expect(status(0n, '2026-11-20', 'draft')).toBe('draft');
      expect(status(0n, '2026-11-20', 'void')).toBe('void');
      expect(status(0n)).toBe('sent');
      expect(status(4000n)).toBe('partial');
      expect(status(10000n)).toBe('paid');
    });

    it('is overdue only after the due date, and paid wins', () => {
      expect(status(0n, '2026-11-10')).toBe('sent');
      expect(status(0n, '2026-11-09')).toBe('overdue');
      expect(status(4000n, '2026-11-09')).toBe('overdue');
      expect(status(10000n, '2026-11-09')).toBe('paid');
    });
  });
});

describe('allocatePayment', () => {
  const parts = [
    { key: 'design', weight: 33333n },
    { key: 'hosting', weight: 33333n },
    { key: 'tax', weight: 33334n },
  ];
  const sum = (s: { amount: bigint }[]) => s.reduce((t, x) => t + x.amount, 0n);

  it('splits one payment exactly', () => {
    const s = allocatePayment(parts, 0n, 100000n);
    expect(s.map((x) => x.amount)).toEqual([33333n, 33333n, 33334n]);
  });

  it('adds up to the invoice however the payments fall', () => {
    for (const pays of [
      [1n, 99999n],
      [33333n, 33333n, 33334n],
      [7n, 11n, 13n, 99969n],
      [50000n, 49999n, 1n],
    ]) {
      const totals = new Map<string, bigint>();
      let paid = 0n;
      for (const p of pays) {
        const split = allocatePayment(parts, paid, p);
        expect(sum(split)).toBe(p);
        for (const x of split) totals.set(x.key, (totals.get(x.key) ?? 0n) + x.amount);
        paid += p;
      }
      expect([totals.get('design'), totals.get('hosting'), totals.get('tax')]).toEqual([
        33333n,
        33333n,
        33334n,
      ]);
    }
  });
});

describe('autoMatch', () => {
  const invoice = (id: string, open: bigint, reference: string | null = null): OpenItem => ({
    id,
    open,
    from: d('2026-10-01'),
    to: d('2026-12-30'),
    reference,
  });
  const pay = (id: string, amount: bigint, text = 'ACH DEPOSIT', date = '2026-10-15'): PaymentCandidate => ({
    id,
    amount,
    text,
    date: d(date),
  });

  it('links the one exact pair', () => {
    expect(autoMatch([invoice('a', 5000n)], [pay('p', 5000n)])).toEqual([{ itemId: 'a', paymentId: 'p' }]);
  });

  it('leaves it to the user when two invoices or two deposits could fit', () => {
    expect(autoMatch([invoice('a', 5000n), invoice('b', 5000n)], [pay('p', 5000n)])).toEqual([]);
    expect(autoMatch([invoice('a', 5000n)], [pay('p', 5000n), pay('q', 5000n)])).toEqual([]);
  });

  it('never guesses a partial payment, unless the statement quotes the invoice', () => {
    expect(autoMatch([invoice('a', 5000n, 'INV-0042')], [pay('p', 2000n)])).toEqual([]);
    expect(
      autoMatch([invoice('a', 5000n, 'INV-0042')], [pay('p', 2000n, 'WIRE ref inv 0042 thanks')]),
    ).toEqual([{ itemId: 'a', paymentId: 'p' }]);
  });

  it('a quoted reference picks among equal amounts, and is not fooled by a longer number', () => {
    const items = [invoice('a', 5000n, 'INV-0042'), invoice('b', 5000n, 'INV-0043')];
    expect(autoMatch(items, [pay('p', 5000n, 'PAYMENT INV-0043')])).toEqual([
      { itemId: 'b', paymentId: 'p' },
    ]);
    expect(autoMatch([invoice('a', 9000n, 'INV-004')], [pay('p', 2000n, 'PAYMENT INV-0042')])).toEqual([]);
  });

  it('respects the window and what is still owed', () => {
    expect(canPay(invoice('a', 5000n), pay('p', 5001n))).toBe(false);
    expect(canPay(invoice('a', 5000n), pay('p', 5000n, '', '2026-09-30'))).toBe(false);
    expect(canPay(invoice('a', 5000n), pay('p', 5000n, '', '2026-12-31'))).toBe(false);
    expect(canPay(invoice('a', 5000n), pay('p', 0n))).toBe(false);
  });

  it('does not use one deposit twice', () => {
    const items = [invoice('a', 5000n, 'INV-1'), invoice('b', 5000n)];
    expect(autoMatch(items, [pay('p', 5000n, 'PAYMENT INV-1')])).toEqual([{ itemId: 'a', paymentId: 'p' }]);
  });
});

describe('mileage', () => {
  it('multiplies tenths of a mile by the rate, half up', () => {
    expect(mileageDeduction(1000, 725)).toBe(7250n); // 100 miles at 72.5 cents
    expect(mileageDeduction(124, 725)).toBe(899n); // 12.4 miles = 8.99 exactly
    expect(mileageDeduction(1, 655)).toBe(7n); // 0.1 mile = 6.55 cents, rounds up
    expect(mileageDeduction(3, 725)).toBe(22n); // 21.75 cents
  });

  it('takes the rate in force on the trip date, including a mid-year change', () => {
    const rates = [
      { effectiveFrom: d('2025-01-01'), tenths: 700 },
      { effectiveFrom: d('2026-07-01'), tenths: 760 },
      { effectiveFrom: d('2026-01-01'), tenths: 725 },
    ];
    expect(mileageRateOn(rates, d('2026-06-30'))?.tenths).toBe(725);
    expect(mileageRateOn(rates, d('2026-07-01'))?.tenths).toBe(760);
    expect(mileageRateOn(rates, d('2025-12-31'))?.tenths).toBe(700);
    expect(mileageRateOn(rates, d('2024-12-31'))).toBeNull();
  });
});

describe('estimated tax', () => {
  const dues = (y: number) => estimatedTaxPeriods(y).map((p) => p.due);

  it('uses the IRS periods, which are not calendar quarters', () => {
    expect(estimatedTaxPeriods(2026).map((p) => p.through)).toEqual([
      '2026-03-31',
      '2026-05-31',
      '2026-08-31',
      '2026-12-31',
    ]);
  });

  it('matches published due dates, moving past weekends and holidays', () => {
    expect(dues(2026)).toEqual(['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']);
    // April 15 2023 was a Saturday and Emancipation Day was observed on the Monday.
    expect(dues(2023)).toEqual(['2023-04-18', '2023-06-15', '2023-09-15', '2024-01-16']);
    // April 16 2022 was a Saturday, observed on Friday the 15th, so the deadline moved to Monday.
    expect(dues(2022)[0]).toBe('2022-04-18');
    expect(dues(2021)[1]).toBe('2021-06-15');
  });

  it('sets aside on profit only, and never goes negative', () => {
    expect(taxSetAsideTarget(100000n, 2500)).toBe(25000n);
    expect(taxSetAsideTarget(-5000n, 2500)).toBe(0n);
    expect(taxSetAside(100000n, 2500, 10000n)).toBe(15000n);
    expect(taxSetAside(100000n, 2500, 30000n)).toBe(0n);
    expect(taxSetAside(0n, 2500, 0n)).toBe(0n);
  });
});

describe('margin', () => {
  it('is profit over revenue, and undefined without revenue', () => {
    expect(marginBps(100000n, 60000n)).toBe(4000);
    expect(marginBps(100000n, 130000n)).toBe(-3000);
    expect(marginBps(0n, 5000n)).toBeNull();
  });
});
