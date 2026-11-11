import { describe, expect, it } from 'vitest';
import {
  efw2File,
  efw2Problems,
  necThreshold,
  yearEndDue,
  type Efw2Input,
  type W2Boxes,
} from '../src/index.js';

const boxes = (over: Partial<W2Boxes> = {}): W2Boxes => ({
  box1: 7_020_000n,
  box2: 406_400n,
  box3: 7_540_000n,
  box4: 467_480n,
  box5: 7_540_000n,
  box6: 109_330n,
  box12D: 520_000n,
  retirementPlan: true,
  caSdi: 98_020n,
  caWages: 7_020_000n,
  caTax: 85_072n,
  ...over,
});

// Made-up employer and employees. SSA rejects 9xx SSNs on a W-2, so the accepted ones here are never issued for another
// reason: group 00 (123-00-6789) and serial 0000 (234-56-0000).
const input = (over: Partial<Efw2Input> = {}): Efw2Input => ({
  year: 2026,
  submitter: {
    ein: '12-3456789',
    userId: 'TEST1234',
    name: 'Tide Pool Cafe LLC',
    address: { line1: '1 Harbor Rd', line2: 'Suite 2', city: 'Monterey', state: 'CA', zip: '93940-1234' },
    contactName: 'Pat Owner',
    contactPhone: '(831) 555-0100',
    contactEmail: 'Owner@Example.test',
  },
  employer: {
    ein: '123456789',
    name: 'Tide Pool Cafe LLC',
    address: { line1: '1 Harbor Rd', line2: null, city: 'Monterey', state: 'CA', zip: '93940' },
  },
  employees: [
    {
      ssn: '123-00-6789',
      first: 'Casey',
      middle: 'Q',
      last: 'Exampleton',
      address: { line1: '4 Kelp Way', city: 'Monterey', state: 'CA', zip: '93940' },
      boxes: boxes(),
    },
    {
      ssn: '234560000',
      first: 'José',
      last: 'Muñoz-Test',
      address: null,
      boxes: boxes({
        box1: 100n,
        box2: 0n,
        box3: 100n,
        box4: 6n,
        box5: 100n,
        box6: 1n,
        box12D: 0n,
        retirementPlan: false,
      }),
    },
  ],
  ...over,
});

/** The text at 1-based positions start..end of a record. */
const at = (record: string, start: number, end: number) => record.slice(start - 1, end);

describe('year-end dates and thresholds', () => {
  it('is due January 31, or the next banking day', () => {
    expect(yearEndDue(2026)).toBe('2027-02-01'); // January 31, 2027 is a Sunday
    expect(yearEndDue(2024)).toBe('2025-01-31');
  });

  it('owes a 1099-NEC from $600 through 2025 and from $2,000 for 2026', () => {
    expect(necThreshold(2025)).toEqual({ amount: 60_000n, known: true });
    expect(necThreshold(2026)).toEqual({ amount: 200_000n, known: true });
    // A later year isn't known yet (it's indexed for inflation): the last known figure, flagged.
    expect(necThreshold(2027)).toEqual({ amount: 200_000n, known: false });
  });
});

describe('the EFW2 file (SSA Publication 42-007)', () => {
  const file = efw2File(input());
  const records = file.split('\r\n').slice(0, -1);

  it('is RA, RE, an RW per employee, RT and RF, each 512 bytes ending CR LF', () => {
    expect(file.endsWith('\r\n')).toBe(true);
    expect(records.map((r) => r.slice(0, 2))).toEqual(['RA', 'RE', 'RW', 'RW', 'RT', 'RF']);
    for (const r of records) expect(r).toHaveLength(512);
  });

  it('puts the submitter where SSA reads it', () => {
    const ra = records[0]!;
    expect(at(ra, 3, 11)).toBe('123456789');
    expect(at(ra, 12, 19)).toBe('TEST1234');
    expect(at(ra, 36, 37)).toBe('98');
    expect(at(ra, 38, 94).trimEnd()).toBe('TIDE POOL CAFE LLC');
    expect(at(ra, 95, 116).trimEnd()).toBe('SUITE 2');
    expect(at(ra, 117, 138).trimEnd()).toBe('1 HARBOR RD');
    expect(at(ra, 163, 171)).toBe('939401234');
    expect(at(ra, 396, 422).trimEnd()).toBe('PAT OWNER');
    expect(at(ra, 423, 437).trimEnd()).toBe('8315550100');
    // The email keeps its case; everything else is upper case.
    expect(at(ra, 446, 485).trimEnd()).toBe('Owner@Example.test');
    expect(at(ra, 500, 500)).toBe('L');
  });

  it('marks the employer as a regular 941 filer for the tax year', () => {
    const re = records[1]!;
    expect(at(re, 3, 6)).toBe('2026');
    expect(at(re, 8, 16)).toBe('123456789');
    expect(at(re, 40, 96).trimEnd()).toBe('TIDE POOL CAFE LLC');
    expect(at(re, 165, 173)).toBe('93940    ');
    expect(at(re, 174, 174)).toBe('N');
    expect(at(re, 219, 219)).toBe('R');
    expect(at(re, 220, 220)).toBe(' ');
  });

  it('writes each W-2 in cents, right-justified and zero-filled', () => {
    const rw = records[2]!;
    expect(at(rw, 3, 11)).toBe('123006789');
    expect(at(rw, 12, 26).trimEnd()).toBe('CASEY');
    expect(at(rw, 27, 41).trimEnd()).toBe('Q');
    expect(at(rw, 42, 61).trimEnd()).toBe('EXAMPLETON');
    expect(at(rw, 188, 198)).toBe('00007020000');
    expect(at(rw, 199, 209)).toBe('00000406400');
    expect(at(rw, 210, 220)).toBe('00007540000');
    expect(at(rw, 221, 231)).toBe('00000467480');
    expect(at(rw, 232, 242)).toBe('00007540000');
    expect(at(rw, 243, 253)).toBe('00000109330');
    expect(at(rw, 287, 297)).toBe('00000520000');
    expect(at(rw, 298, 308)).toBe('00000000000');
    expect(at(rw, 265, 275)).toBe(' '.repeat(11));
    expect(at(rw, 488, 488)).toBe('1');
    // Accents are dropped, not mangled.
    const second = records[3]!;
    expect(at(second, 12, 26).trimEnd()).toBe('JOSE');
    expect(at(second, 42, 61).trimEnd()).toBe('MUNOZ-TEST');
    expect(at(second, 488, 488)).toBe('0');
  });

  it('adds the W-2s up in the RT and counts them in the RF', () => {
    const rt = records[4]!;
    expect(at(rt, 3, 9)).toBe('0000002');
    expect(at(rt, 10, 24)).toBe('000000007020100');
    expect(at(rt, 55, 69)).toBe('000000000467486');
    expect(at(rt, 145, 159)).toBe('000000000520000');
    expect(at(records[5]!, 8, 16)).toBe('000000002');
  });

  it('says what SSA would reject before the file is made', () => {
    expect(efw2Problems(input())).toEqual([]);
    const bad = input({
      submitter: { ...input().submitter, ein: '07-1234567', userId: 'short', contactEmail: '' },
      employees: [{ ...input().employees[0]!, ssn: '900-12-3456' }],
    });
    expect(efw2Problems(bad).map((p) => p.where)).toEqual(['submitter', 'submitter', 'submitter', 0]);
    expect(efw2Problems(bad).at(-1)!.message).toContain('starts with 9');
  });
});
