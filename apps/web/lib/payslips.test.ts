import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import type { PayslipDto } from '@montra/api-client';
import {
  buildUpdate,
  depositRest,
  depositRowsOf,
  depositsInput,
  liveTotals,
  rowsOf,
  type PayslipRow,
} from './payslips';

const slip: PayslipDto = {
  id: 'p1',
  entityId: 'e1',
  employerId: 'em1',
  memberId: 'm1',
  status: 'needs_review',
  payDate: calendarDate('2026-11-01'),
  periodStart: null,
  periodEnd: null,
  currency: 'USD',
  gross: '500000',
  net: '341250',
  gap: '0',
  lines: [
    {
      id: 'l2',
      lineNo: 2,
      section: 'tax',
      code: 'fed_tax',
      label: 'Federal',
      amount: '158750',
      ytd: null,
      accountId: null,
    },
    {
      id: 'l1',
      lineNo: 1,
      section: 'earning',
      code: 'salary',
      label: 'Salary',
      amount: '500000',
      ytd: '5000000',
      accountId: null,
    },
  ],
  mainDeposit: '341250',
  deposits: [],
  fileIds: [],
  extraction: null,
  transactionId: null,
  matchedDeposit: false,
  matchCandidates: [],
  version: 3,
};

const row = (over: Partial<PayslipRow>): PayslipRow => ({
  key: 'k',
  section: 'earning',
  code: 'salary',
  label: 'Salary',
  amount: '100.00',
  ytd: '',
  accountId: null,
  ...over,
});

describe('rowsOf', () => {
  it('shows lines in order, as decimals', () => {
    const { fields, rows } = rowsOf(slip);
    expect(fields).toEqual({ payDate: '2026-11-01', periodStart: '', periodEnd: '', net: '3412.50' });
    expect(rows.map((r) => [r.code, r.amount, r.ytd])).toEqual([
      ['salary', '5000.00', '50000.00'],
      ['fed_tax', '1587.50', ''],
    ]);
  });
});

describe('liveTotals', () => {
  it('adds up what has been typed, ignoring amounts that do not parse yet', () => {
    const rows = [
      row({ amount: '1,000.50' }),
      row({ key: 'b', section: 'tax', code: 'fed_tax', amount: '200.25' }),
      row({ key: 'c', section: 'pre_tax', code: '401k', amount: 'abc' }),
      row({ key: 'd', section: 'employer', code: 'match', amount: '50' }),
    ];
    const t = liveTotals(rows, '800.00', 'USD');
    expect(t).toMatchObject({ gross: 100050n, taxes: 20025n, preTax: 0n, employer: 5000n, net: 80000n });
    // The employer's match isn't part of pay, so it doesn't move the gap.
    expect(t.gap).toBe(25n);
  });
});

describe('buildUpdate', () => {
  const fields = { payDate: '2026-11-01', periodStart: '', periodEnd: '2026-10-31', net: '100.00' };

  it('sends minor units, and null for what was left blank', () => {
    const res = buildUpdate(3, fields, [row({ ytd: '1,200.00' })], 'USD');
    expect(res).toEqual({
      ok: true,
      input: {
        version: 3,
        payDate: '2026-11-01',
        periodStart: null,
        periodEnd: '2026-10-31',
        net: '10000',
        lines: [{ section: 'earning', code: 'salary', label: 'Salary', amount: '10000', ytd: '120000' }],
      },
    });
  });

  it('keeps a line posted somewhere other than its default', () => {
    const res = buildUpdate(3, fields, [row({ accountId: 'a9' })], 'USD');
    expect(res.ok && res.input.lines?.[0]).toMatchObject({ accountId: 'a9' });
  });

  it('points at each field that is wrong', () => {
    const res = buildUpdate(
      3,
      { ...fields, payDate: '', net: 'x' },
      [row({ key: 'a', amount: '', label: ' ' }), row({ key: 'b', amount: '-5', ytd: 'y' })],
      'USD',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(Object.keys(res.errors).sort()).toEqual(
        ['line.a.amount', 'line.a.label', 'line.b.amount', 'line.b.ytd', 'net', 'payDate'].sort(),
      );
    }
  });

  it('refuses a payslip with no lines', () => {
    const res = buildUpdate(3, fields, [], 'USD');
    expect(res.ok === false && res.errors.lines).toBeTruthy();
  });
});

describe('splitting pay (ADR-0022)', () => {
  const row = (accountId: string, amount: string) => ({ key: accountId, accountId, amount });

  it('shows what goes to the main account as it’s typed', () => {
    expect(depositRest('1,500.00', [row('a', '200.00'), row('b', '100.00')], 'USD')).toBe(120000n);
    expect(depositRest('1,500.00', [row('a', '')], 'USD')).toBe(150000n);
    expect(depositRest('1,500.00', [row('a', 'oops')], 'USD')).toBe(150000n);
    expect(depositRest('100.00', [row('a', '200.00')], 'USD')).toBe(-10000n);
  });

  it('builds the request in minor units', () => {
    expect(depositsInput([row('a', '200.00')], 'USD')).toEqual({
      ok: true,
      deposits: [{ accountId: 'a', amount: '20000' }],
    });
    expect(depositsInput([], 'USD')).toEqual({ ok: true, deposits: [] });
  });

  it('refuses an amount that can’t be split off', () => {
    expect(depositsInput([row('a', 'oops')], 'USD').ok).toBe(false);
    expect(depositsInput([row('a', '0')], 'USD').ok).toBe(false);
    expect(depositsInput([row('a', '-5')], 'USD').ok).toBe(false);
  });

  it('round-trips what the server sends', () => {
    const rows = depositRowsOf([{ accountId: 'a', amount: '20050' }], 'USD');
    expect(depositsInput(rows, 'USD')).toEqual({ ok: true, deposits: [{ accountId: 'a', amount: '20050' }] });
  });
});
