import { describe, expect, it } from 'vitest';
import {
  calendarDate as d,
  employmentStatus,
  i9MayDestroy,
  i9RetainUntil,
  i9Section2Due,
  maskTin,
} from '../src/index.js';

describe('I-9 retention (3 years after hire or 1 year after leaving, whichever is later)', () => {
  it('has no date while the person is still employed', () => {
    expect(i9RetainUntil(d('2024-03-01'), null)).toBeNull();
  });

  it('uses 3 years after hire for someone who left early', () => {
    // USCIS example: hired and left within the first year, so hire + 3 years is later.
    expect(i9RetainUntil(d('2024-03-01'), d('2024-09-30'))).toBe('2027-03-01');
  });

  it('uses 1 year after leaving for a long-serving employee', () => {
    expect(i9RetainUntil(d('2015-06-15'), d('2026-01-10'))).toBe('2027-01-10');
  });

  it('may be destroyed only after the date has passed', () => {
    expect(i9MayDestroy(d('2027-03-01'), d('2027-03-01'))).toBe(false);
    expect(i9MayDestroy(d('2027-03-01'), d('2027-03-02'))).toBe(true);
    expect(i9MayDestroy(null, d('2040-01-01'))).toBe(false);
  });
});

describe('I-9 Section 2 due date (third business day after the first day)', () => {
  it('is Thursday for a Monday start', () => {
    expect(i9Section2Due(d('2026-11-09'))).toBe('2026-11-12');
  });

  it('skips the weekend', () => {
    expect(i9Section2Due(d('2026-11-12'))).toBe('2026-11-17'); // Thursday → Tuesday
    expect(i9Section2Due(d('2026-11-14'))).toBe('2026-11-18'); // Saturday → Wednesday
  });
});

describe('masking', () => {
  it('masks an SSN and an EIN the way each is written', () => {
    expect(maskTin('ssn', '6789')).toBe('•••-••-6789');
    expect(maskTin('ein', '6789')).toBe('••-•••6789');
    expect(maskTin(null, null)).toBeNull();
  });
});

describe('employment status', () => {
  it('follows the dates', () => {
    const today = d('2026-11-10');
    expect(employmentStatus(d('2026-12-01'), null, today)).toBe('starting');
    expect(employmentStatus(d('2026-01-01'), null, today)).toBe('active');
    expect(employmentStatus(d('2026-01-01'), d('2026-11-10'), today)).toBe('active');
    expect(employmentStatus(d('2026-01-01'), d('2026-11-09'), today)).toBe('ended');
  });
});
