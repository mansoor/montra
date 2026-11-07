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

  it('gives each statement its own due date when a short month has no day after the close', () => {
    // Closing the 28th, due the 29th: February 2031 has no 29th, so it's due 1 March, ahead of March's own on the 29th.
    expect(statementCycle(d('2031-02-28'), 28, 29)).toEqual({
      lastClose: d('2031-02-28'),
      dueDate: d('2031-03-01'),
      nextClose: d('2031-03-28'),
      nextDueDate: d('2031-03-29'),
    });
  });

  // Every statement day, due day and date through months of every length: 31 days, February of 28 and of 29, and 30.
  // A random sample missed the February case above, so this checks them all.
  it('always has the statement closed by today, due after it, and the next one due later', () => {
    const bad: string[] = [];
    const days = [
      ...Array.from({ length: 120 }, (_, n) => Date.UTC(2027, 0, 1 + n)),
      ...Array.from({ length: 60 }, (_, n) => Date.UTC(2028, 1, 1 + n)),
    ];
    for (const t of days) {
      const today = d(new Date(t).toISOString().slice(0, 10));
      for (let statementDay = 1; statementDay <= 31; statementDay++) {
        for (let dueDay = 1; dueDay <= 31; dueDay++) {
          const c = statementCycle(today, statementDay, dueDay);
          const ok =
            compareDates(c.lastClose, today) <= 0 &&
            compareDates(c.nextClose, today) > 0 &&
            compareDates(c.dueDate, c.lastClose) > 0 &&
            compareDates(c.nextDueDate, c.nextClose) > 0 &&
            compareDates(c.nextDueDate, c.dueDate) > 0;
          if (!ok && bad.length < 5) bad.push(`${today} ${statementDay} ${dueDay}`);
        }
      }
    }
    expect(bad).toEqual([]);
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
