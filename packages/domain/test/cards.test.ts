import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calendarDate,
  compareDates,
  rulePayment,
  statementCycle,
  statementDue,
  utilizationBps,
} from '../src/index.js';

const d = calendarDate;

describe('statementCycle (ADR-0026)', () => {
  it('finds the latest statement and when it’s due', () => {
    expect(statementCycle(d('2026-11-07'), 5, 1)).toEqual({
      lastClose: d('2026-11-05'),
      dueDate: d('2026-12-01'),
      nextClose: d('2026-12-05'),
      nextDueDate: d('2027-01-01'),
    });
    // Before this month's closing day, the latest statement is last month's.
    expect(statementCycle(d('2026-11-03'), 5, 30)).toMatchObject({
      lastClose: d('2026-10-05'),
      dueDate: d('2026-10-30'),
      nextClose: d('2026-11-05'),
      nextDueDate: d('2026-11-30'),
    });
  });

  it('counts the closing day itself as closed', () => {
    expect(statementCycle(d('2026-11-05'), 5, 28).lastClose).toBe(d('2026-11-05'));
  });

  it('uses a short month’s last day', () => {
    expect(statementCycle(d('2026-03-01'), 31, 15)).toMatchObject({
      lastClose: d('2026-02-28'),
      dueDate: d('2026-03-15'),
      nextClose: d('2026-03-31'),
    });
    expect(statementCycle(d('2026-02-20'), 10, 31).dueDate).toBe(d('2026-02-28'));
  });

  it('always has the statement closed by today, due after it, and the next one after that', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 1, max: 31 }),
        (n, statementDay, dueDay) => {
          const today = d(new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10));
          const c = statementCycle(today, statementDay, dueDay);
          expect(compareDates(c.lastClose, today)).toBeLessThanOrEqual(0);
          expect(compareDates(c.nextClose, today)).toBeGreaterThan(0);
          expect(compareDates(c.dueDate, c.lastClose)).toBeGreaterThan(0);
          expect(compareDates(c.nextDueDate, c.nextClose)).toBeGreaterThan(0);
          expect(compareDates(c.nextDueDate, c.dueDate)).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe('statementDue', () => {
  it('is what the statement says, less what’s been paid since', () => {
    expect(statementDue(75000n, 20000n, 3500n)).toEqual({ due: 55000n, minimumDue: 3500n });
  });

  it('is nothing once paid, and the minimum never exceeds what’s left', () => {
    expect(statementDue(75000n, 80000n, 3500n)).toEqual({ due: 0n, minimumDue: 0n });
    expect(statementDue(2000n, 0n, 3500n)).toEqual({ due: 2000n, minimumDue: 2000n });
  });

  it('takes the whole amount as the minimum when none is on file', () => {
    expect(statementDue(75000n, 0n, null).minimumDue).toBe(75000n);
  });
});

describe('rulePayment', () => {
  const due = statementDue(75000n, 0n, 3500n);
  it('pays by the rule', () => {
    expect(rulePayment('statement', due, 90000n, null)).toBe(75000n);
    expect(rulePayment('minimum', due, 90000n, null)).toBe(3500n);
    expect(rulePayment('fixed', due, 90000n, 50000n)).toBe(50000n);
  });

  it('never pays more than is owed', () => {
    expect(rulePayment('fixed', due, 20000n, 50000n)).toBe(20000n);
    expect(rulePayment('statement', due, 10000n, null)).toBe(10000n);
    expect(rulePayment('statement', due, -500n, null)).toBe(0n);
  });
});

describe('utilizationBps', () => {
  it('is owed over the limit', () => {
    expect(utilizationBps(75000n, 500000n)).toBe(1500);
    expect(utilizationBps(-100n, 500000n)).toBe(0);
    expect(utilizationBps(75000n, null)).toBeNull();
  });
});
