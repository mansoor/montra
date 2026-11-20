/**
 * PDF statements that print dates without a year (`10/02`) in a DATE | DESCRIPTION | AMOUNT | BALANCE table. The
 * grid is what the doc-worker reads from its synthetic fixture (`apps/doc-worker/tests/fixtures.py`, layout 4);
 * every name and number is invented.
 */
import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import { analyze, detectDateFormat, parseDate, splitSpilledAmount, statementDates } from '../src/index.js';

const HEADER = ['DATE', 'DESCRIPTION', 'AMOUNT', 'BALANCE'];
const ROWS = [
  ['12/28', 'So Cal Power CO Directpay PPD ID: 0012345678', '-207.92', '8,461.51'],
  ['12/28', 'Example Card Autopay Payment 271234567 ID: Examplecap', '-130.00', '8,331.51'],
  ['12/29', 'ATM Withdrawal 12/28 12345 Sample Canyon Rd 4321 R Springfield CA Card', '-260.00', '8,071.51'],
  ['01/02', 'Zelle Payment To Sample Person Jpm99abc123', '-3,198.04', '4,873.47'],
  ['01/03', 'Zelle Payment From Another Person', '3,300.00', '8,173.47'],
];
const opts = { fileType: 'pdf' as const, currency: 'USD' as const, accountType: 'asset' as const };
const statement = {
  opening: 866943n,
  closing: 817347n,
  periodStart: calendarDate('2026-12-15'),
  periodEnd: calendarDate('2027-01-14'),
};

describe('dates printed without a year', () => {
  const period = { start: calendarDate('2026-12-15'), end: calendarDate('2027-01-14') };

  it('take the year from the statement period, December before January', () => {
    expect(parseDate('12/28', 'MM/DD', period)).toBe('2026-12-28');
    expect(parseDate('01/03', 'MM/DD', period)).toBe('2027-01-03');
    expect(parseDate('28/12', 'DD/MM', period)).toBe('2026-12-28');
    // Posted a little outside the period: still the nearest year.
    expect(parseDate('12/10', 'MM/DD', period)).toBe('2026-12-10');
    expect(parseDate('01/20', 'MM/DD', period)).toBe('2027-01-20');
  });

  it('take the most recent year up to a closing date or the upload day', () => {
    const end = { end: calendarDate('2027-01-05') };
    expect(parseDate('12/30', 'MM/DD', end)).toBe('2026-12-30');
    expect(parseDate('01/05', 'MM/DD', end)).toBe('2027-01-05');
    expect(parseDate('02/29', 'MM/DD', { end: calendarDate('2028-03-10') })).toBe('2028-02-29');
    expect(parseDate('02/29', 'MM/DD', end)).toBeNull();
  });

  it('read nothing without the statement dates, and reject impossible days', () => {
    expect(parseDate('10/02', 'MM/DD')).toBeNull();
    expect(parseDate('13/02', 'MM/DD', period)).toBeNull();
    expect(parseDate('10/02/2026', 'MM/DD', period)).toBeNull();
    expect(parseDate('10/02', 'MM/DD/YYYY', period)).toBeNull();
  });

  it('are detected as MM/DD, or DD/MM when a day is above 12', () => {
    expect(detectDateFormat(ROWS.map((r) => r[0]!))).toMatchObject({ format: 'MM/DD', ambiguous: false });
    expect(detectDateFormat(['28/12', '03/01'])).toMatchObject({ format: 'DD/MM', ambiguous: false });
  });

  it('use the period, else its end, else the upload day', () => {
    const upload = calendarDate('2026-11-18');
    expect(statementDates({ statement, referenceDate: upload })).toEqual(period);
    expect(statementDates({ statement: { periodEnd: period.end }, referenceDate: upload })).toEqual({
      end: period.end,
    });
    expect(statementDates({ referenceDate: upload })).toEqual({ end: upload });
    expect(statementDates({})).toBeNull();
  });
});

describe('a DATE | DESCRIPTION | AMOUNT | BALANCE statement with MM/DD dates', () => {
  it('pre-selects the header, start row, columns and date format, and reads every row', () => {
    const a = analyze([{ name: 'Statement', rows: [HEADER, ...ROWS] }], { ...opts, statement });
    expect(a.proposal.mapping).toMatchObject({
      headerRow: 0,
      dataStart: 1,
      date: 0,
      dateFormat: 'MM/DD',
      description: [1],
      amount: 2,
      balance: 3,
      sign: 'normal',
      decimal: '.',
    });
    expect(a.proposal.confidence).toBeGreaterThanOrEqual(0.75);
    expect(a.proposal.warnings).toEqual([]);
    expect(a.parsed.errors).toEqual([]);
    expect(a.parsed.rows.map((r) => [r.date, r.amount, r.balance])).toEqual([
      ['2026-12-28', -20792n, 846151n],
      ['2026-12-28', -13000n, 833151n],
      ['2026-12-29', -26000n, 807151n],
      ['2027-01-02', -319804n, 487347n],
      ['2027-01-03', 330000n, 817347n],
    ]);
    expect(a.balance.status).toBe('ok');
    expect(a.dates).toEqual({ start: statement.periodStart, end: statement.periodEnd });
  });

  it('reads the dates against the upload day when the statement gives no period', () => {
    const a = analyze([{ name: 'Statement', rows: [HEADER, ...ROWS] }], {
      ...opts,
      referenceDate: calendarDate('2027-01-20'),
    });
    expect(a.proposal.mapping.dateFormat).toBe('MM/DD');
    expect(a.parsed.rows.map((r) => r.date)).toEqual([
      '2026-12-28',
      '2026-12-28',
      '2026-12-29',
      '2027-01-02',
      '2027-01-03',
    ]);
  });

  it('takes the amount from a cell the description spilled into, and gives the text back', () => {
    // How the table read before the doc-worker split columns by the header's positions.
    const spilled = [
      ['12/28', 'So Cal Power CO Directpay PPD ID:', '0012345678 -207.92', '8,461.51'],
      ['12/28', 'Example Card Autopay Payment 271234567', 'ID: Examplecap -130.00', '8,331.51'],
      [
        '12/29',
        'ATM Withdrawal 12/28 12345 Sample Canyon Rd',
        '4321 R Springfield CA Card -260.00',
        '8,071.51',
      ],
      ROWS[3]!,
      ROWS[4]!,
    ];
    const a = analyze([{ name: 'Statement', rows: [HEADER, ...spilled] }], { ...opts, statement });
    expect(a.proposal.mapping).toMatchObject({ headerRow: 0, dataStart: 1, date: 0, amount: 2, balance: 3 });
    expect(a.parsed.rows.map((r) => [r.amount, r.description])).toEqual(
      ROWS.map((r) => [expect.any(BigInt) as unknown, r[1]]),
    );
    expect(a.parsed.rows.map((r) => r.amount)).toEqual([-20792n, -13000n, -26000n, -319804n, 330000n]);
    expect(a.balance.status).toBe('ok');
  });

  it('leaves amount cells that read as they are alone', () => {
    expect(splitSpilledAmount('-1,207.92', 'USD', '.')).toBeNull();
    expect(splitSpilledAmount('Card', 'USD', '.')).toBeNull();
    expect(splitSpilledAmount('ID: X -130.00', 'USD', '.')).toEqual({
      amount: -13000n,
      value: '-130.00',
      text: 'ID: X',
    });
  });
});
