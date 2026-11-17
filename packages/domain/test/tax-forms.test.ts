import { describe, expect, it } from 'vitest';
import {
  normalizeEin,
  normalizeTaxFormBoxes,
  parseTaxFormBoxes,
  PAYROLL_TAX_TABLES,
  socialSecurityWageBase,
  TAX_FORM_KINDS,
  TaxFormBoxesError,
  taxFormBoxesJson,
  taxFormThreshold,
} from '../src/index.js';

const W2 = {
  box1: '8512034',
  box2: '1204500',
  box3: '9012034',
  box4: '558746',
  box5: '9012034',
  box6: '130674',
  box12: [
    { code: 'D', amount: '500000' },
    { code: 'W', amount: '83000' },
  ],
  box13: { retirementPlan: true },
  box14: [{ label: 'CASDI', amount: '108144' }],
  states: [{ state: 'CA', employerStateId: '123-4567-8', box16: '8429034', box17: '512300' }],
};

describe('parseTaxFormBoxes (ADR-0052 §2)', () => {
  it('reads a W-2 with money as bigint cents', () => {
    const f = parseTaxFormBoxes('w2', W2);
    expect(f.kind).toBe('w2');
    if (f.kind !== 'w2') throw new Error('kind');
    expect(f.boxes.box1).toBe(8_512_034n);
    expect(f.boxes.box12).toEqual([
      { code: 'D', amount: 500_000n },
      { code: 'W', amount: 83_000n },
    ]);
    expect(f.boxes.box13).toEqual({ retirementPlan: true });
    expect(f.boxes.states?.[0]).toMatchObject({ state: 'CA', box17: 512_300n });
    // A blank box is left out, not zero.
    expect(f.boxes.box7).toBeUndefined();
  });

  it('reads the boxes of each phase 1 kind', () => {
    const int = parseTaxFormBoxes('1099_int', {
      box1: '4107',
      box3: '1200',
      box8: '0',
      box7: 'Canada',
      states: [{ state: 'NY', stateTaxWithheld: '50' }],
    });
    expect(int).toMatchObject({ kind: '1099_int', boxes: { box1: 4107n, box3: 1200n, box8: 0n } });
    const div = parseTaxFormBoxes('1099_div', {
      box1a: '125000',
      box1b: '98000',
      box2a: '4000',
      box8: 'Ireland',
    });
    expect(div).toMatchObject({
      kind: '1099_div',
      boxes: { box1a: 125_000n, box1b: 98_000n, box2a: 4_000n },
    });
    const mortgage = parseTaxFormBoxes('1098', {
      box1: '1234567',
      box2: '31250000',
      box3: '2021-06-15',
      box7: true,
      box9: 1,
      box10: '612300',
      box10Label: 'Property tax',
    });
    expect(mortgage).toMatchObject({
      kind: '1098',
      boxes: { box1: 1_234_567n, box2: 31_250_000n, box3: '2021-06-15', box9: 1, box10: 612_300n },
    });
  });

  it('takes an empty form of every kind', () => {
    for (const kind of TAX_FORM_KINDS) expect(parseTaxFormBoxes(kind, {}).boxes).toEqual({});
  });

  it.each([
    ['a decimal amount', 'w2', { box1: '85120.34' }, 'box1'],
    ['a negative amount', 'w2', { box2: '-100' }, 'box2'],
    ['a number instead of a string', 'w2', { box1: 8512034 }, 'box1'],
    ['an amount too long to be real', '1099_int', { box1: '1234567890123456' }, 'box1'],
    ['an unknown box', '1099_int', { box14: '123' }, ''],
    ['a box from another kind', '1099_div', { box1: '100' }, ''],
    ['an unknown box 12 code', 'w2', { box12: [{ code: 'X', amount: '1' }] }, 'box12.0.code'],
    ['five box 12 codes', 'w2', { box12: Array(5).fill({ code: 'D', amount: '1' }) }, 'box12'],
    ['a lower-case state', 'w2', { states: [{ state: 'ca' }] }, 'states.0.state'],
    ['a date in another format', '1098', { box3: '06/15/2021' }, 'box3'],
    ['an array instead of boxes', '1098', [], 'boxes'],
    ['nothing', '1098', null, 'boxes'],
  ] as const)('refuses %s', (_, kind, json, path) => {
    let err: unknown;
    try {
      parseTaxFormBoxes(kind, json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaxFormBoxesError);
    if (path) expect((err as TaxFormBoxesError).path).toBe(path);
  });

  it('refuses a kind it doesn’t know', () => {
    expect(() => parseTaxFormBoxes('1099_b' as never, {})).toThrow(TaxFormBoxesError);
  });

  it('round-trips through the stored JSON, made canonical', () => {
    const f = parseTaxFormBoxes('w2', W2);
    expect(taxFormBoxesJson(f)).toEqual(W2);
    expect(normalizeTaxFormBoxes('1099_int', { box1: '0004107', box2: undefined })).toEqual({ box1: '4107' });
  });
});

describe('identifiers (§8.1)', () => {
  it('keeps an EIN as nine digits', () => {
    expect(normalizeEin('12-3456789')).toBe('123456789');
    expect(normalizeEin(' 123456789 ')).toBe('123456789');
    // SSN-shaped and short numbers aren't EINs.
    expect(normalizeEin('123-45-6789')).toBeNull();
    expect(normalizeEin('12-345678')).toBeNull();
  });
});

describe('yearly figures (§5.2, §7.1)', () => {
  it('knows the Social Security wage base, and agrees with the payroll tables', () => {
    expect(socialSecurityWageBase(2025)).toEqual({ amount: 17_610_000n, known: true });
    for (const t of Object.values(PAYROLL_TAX_TABLES)) {
      expect(socialSecurityWageBase(t.year)).toEqual({ amount: t.fica.ssWageBase, known: true });
    }
    // A year not in the table yet uses the latest known, flagged.
    expect(socialSecurityWageBase(2031)).toEqual({ amount: 18_450_000n, known: false });
    expect(socialSecurityWageBase(1999).known).toBe(false);
  });

  it('expects a 1099-INT or -DIV from $10 and a 1098 from $600', () => {
    expect(taxFormThreshold('1099_int', 2026)).toEqual({ amount: 1_000n, known: true });
    expect(taxFormThreshold('1099_div', 2025)).toEqual({ amount: 1_000n, known: true });
    expect(taxFormThreshold('1098', 2024)).toEqual({ amount: 60_000n, known: true });
    expect(taxFormThreshold('1098', 2040)).toEqual({ amount: 60_000n, known: false });
  });
});
