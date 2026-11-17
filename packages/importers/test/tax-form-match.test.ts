import { describe, expect, it } from 'vitest';
import {
  decideTaxFormMatch,
  issuerNamesAgree,
  type TaxFormMatchInput,
  type TaxIssuerCandidate,
} from '../src/index.js';

// ADR-0052 §4: when a tax form read from a file is matched automatically, and what's suggested otherwise.
const acme: TaxIssuerCandidate = {
  id: 'e-acme',
  name: 'Acme Corp',
  memberId: 'sam',
  last4: null,
  institution: null,
  active: true,
};
const cafe: TaxIssuerCandidate = { ...acme, id: 'e-cafe', name: 'Corner Cafe', memberId: 'alex' };
const savings: TaxIssuerCandidate = {
  id: 'a-savings',
  name: 'Savings',
  memberId: null,
  last4: '4471',
  institution: 'First Example Bank',
  active: true,
};
const checking: TaxIssuerCandidate = {
  ...savings,
  id: 'a-checking',
  name: 'Checking',
  last4: '1200',
  active: false,
};

const w2 = (over: Partial<TaxFormMatchInput> = {}): TaxFormMatchInput => ({
  kind: 'w2',
  year: 2025,
  issuerName: 'ACME CORPORATION',
  accountLast4: null,
  personId: null,
  personName: 'Sam',
  candidates: [acme, cafe],
  signal: 'w2:ein:123456789',
  memory: null,
  ...over,
});

describe('decideTaxFormMatch', () => {
  it('matches the one employer that fits the name and had pay in the year, saying why', () => {
    expect(decideTaxFormMatch(w2())).toMatchObject({
      automatic: true,
      targetId: 'e-acme',
      reason: 'Matched: Acme Corp is Sam’s only employer with payslips in 2025',
    });
  });

  it('doesn’t match an employer with no pay that year, nor one of another person', () => {
    expect(decideTaxFormMatch(w2({ candidates: [{ ...acme, active: false }] })).automatic).toBe(false);
    expect(decideTaxFormMatch(w2({ personId: 'alex' })).automatic).toBe(false);
    // With no name and no last four digits the form gives nothing to fit.
    expect(decideTaxFormMatch(w2({ issuerName: null, signal: null })).automatic).toBe(false);
  });

  it('matches from memory after one confirmation when the signal names an EIN, three for a name', () => {
    const memory = { targetId: 'e-acme', confirmations: 1 };
    const noActivity = [{ ...acme, active: false }];
    expect(decideTaxFormMatch(w2({ candidates: noActivity, memory }))).toMatchObject({
      automatic: true,
      targetId: 'e-acme',
      reason: 'Matched as before: forms from this issuer went to Acme Corp',
    });
    const byName = { candidates: noActivity, signal: 'w2:name:ACME CORPORATION' };
    expect(decideTaxFormMatch(w2({ ...byName, memory })).automatic).toBe(false);
    expect(decideTaxFormMatch(w2({ ...byName, memory: { ...memory, confirmations: 3 } })).automatic).toBe(
      true,
    );
    // A target that's gone isn't matched.
    expect(decideTaxFormMatch(w2({ candidates: [cafe], memory })).targetId).toBeNull();
  });

  it('matches an account by its last four digits and its income in the year', () => {
    const input: TaxFormMatchInput = {
      kind: '1099_int',
      year: 2025,
      issuerName: 'First Example Bank, N.A.',
      accountLast4: '4471',
      personId: 'alex',
      personName: 'Alex',
      candidates: [savings, checking],
      signal: '1099_int:ein:345678901:last4:4471',
      memory: null,
    };
    expect(decideTaxFormMatch(input)).toMatchObject({
      automatic: true,
      targetId: 'a-savings',
      reason: 'Matched: Savings is the only account ending 4471 with interest in 2025',
    });
    // Two accounts at the bank that earned interest, and no digits to tell them apart: suggested, not matched.
    const both = decideTaxFormMatch({
      ...input,
      accountLast4: null,
      candidates: [savings, { ...checking, active: true }],
    });
    expect(both.automatic).toBe(false);
    expect(both.candidates.map((c) => c.name)).toEqual(['Checking', 'Savings']);
    expect(both.candidates[0]!.reason).toBe('Is at First Example Bank, had interest in 2025');
  });
});

describe('issuerNamesAgree', () => {
  it('compares meaningful words, not “Bank” or “Inc”', () => {
    expect(issuerNamesAgree('ACME CORPORATION', 'Acme Corp')).toBe(true);
    expect(issuerNamesAgree('First Example Bank', 'Second Bank')).toBe(false);
    expect(issuerNamesAgree(null, 'Acme')).toBe(false);
  });
});
