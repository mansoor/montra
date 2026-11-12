import { describe, expect, it } from 'vitest';
import { calendarDate, nextStatementDate, reconciliationDue } from '../src/index.js';

const d = calendarDate;

describe('statement dates (DE-11, DE-14)', () => {
  it('suggests the next statement a month on, staying on month ends', () => {
    expect(nextStatementDate(d('2026-09-15'))).toBe('2026-10-15');
    expect(nextStatementDate(d('2026-01-31'))).toBe('2026-02-28');
    expect(nextStatementDate(d('2026-02-28'))).toBe('2026-03-31');
    expect(nextStatementDate(d('2026-12-31'))).toBe('2027-01-31');
    expect(nextStatementDate(d('2026-01-30'))).toBe('2026-02-28');
  });

  it("follows a card's statement day when it has one", () => {
    expect(nextStatementDate(d('2026-01-28'), 30)).toBe('2026-02-28');
    expect(nextStatementDate(d('2026-02-28'), 30)).toBe('2026-03-30');
    expect(nextStatementDate(d('2026-02-28'), 28)).toBe('2026-03-28');
  });

  it('is due once more than a month has passed', () => {
    expect(reconciliationDue(null, d('2026-11-12'))).toBe(false);
    expect(reconciliationDue(d('2026-10-12'), d('2026-11-12'))).toBe(false);
    expect(reconciliationDue(d('2026-10-11'), d('2026-11-12'))).toBe(true);
    expect(reconciliationDue(d('2026-09-30'), d('2026-10-30'))).toBe(false);
    expect(reconciliationDue(d('2026-09-30'), d('2026-10-31'))).toBe(true);
  });
});
