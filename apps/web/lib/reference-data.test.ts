import { describe, expect, it } from 'vitest';
import { bpsToPercent, MAPPING_EXAMPLE, percentToBps, readMappingJson } from './reference-data';

describe('reference data editor (OPS-05)', () => {
  it('turns a deductible percentage into basis points and back', () => {
    expect(percentToBps('100')).toBe(10000);
    expect(percentToBps('50')).toBe(5000);
    expect(percentToBps(' 12.5 ')).toBe(1250);
    expect(percentToBps('0.25')).toBe(25);
    expect(percentToBps('0')).toBe(0);
    for (const bad of ['', '101', '50.123', '-5', 'half', '1e2']) expect(percentToBps(bad)).toBeNull();
    expect(bpsToPercent(10000)).toBe('100');
    expect(bpsToPercent(5000)).toBe('50');
    expect(bpsToPercent(1250)).toBe('12.5');
    expect(bpsToPercent(25)).toBe('0.25');
    expect(bpsToPercent(0)).toBe('0');
    for (const bps of [0, 1, 99, 1250, 5000, 10000]) expect(percentToBps(bpsToPercent(bps))).toBe(bps);
  });

  it('checks a column mapping as the importer reads it', () => {
    expect(readMappingJson(MAPPING_EXAMPLE)).toMatchObject({ ok: true, mapping: { amount: 2 } });
    expect(readMappingJson('{ nope')).toEqual({ ok: false, problem: 'json' });
    const noAmount = { ...JSON.parse(MAPPING_EXAMPLE), amount: undefined };
    const res = readMappingJson(JSON.stringify(noAmount));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.problem).toMatch(/^amount: /);
    expect(readMappingJson(JSON.stringify({ ...noAmount, debit: 2, credit: 3 })).ok).toBe(true);
    expect(
      readMappingJson(JSON.stringify({ ...JSON.parse(MAPPING_EXAMPLE), dateFormat: 'whenever' })).ok,
    ).toBe(false);
  });
});
