import { describe, expect, it } from 'vitest';
import {
  buildLease,
  optionalBps,
  optionalMinor,
  parseUnitLabels,
  percentLabel,
  percentTotal,
  positiveMinor,
  type LeaseFormFields,
} from './rentals';

const fields = (over: Partial<LeaseFormFields> = {}): LeaseFormFields => ({
  unitId: 'u1',
  tenantIds: ['t1'],
  startDate: '2026-01-01',
  endDate: '',
  rent: '1,500.50',
  dueDay: '1',
  graceDays: '5',
  lateFeeFlat: '',
  lateFeePercent: '',
  lateFeeCap: '',
  deposit: '',
  depositAccountId: '',
  fileIds: [],
  ...over,
});

describe('amounts', () => {
  it('needs a positive amount, in minor units', () => {
    expect(positiveMinor('1,200.05', 'USD')).toEqual({ ok: true, value: '120005' });
    expect(positiveMinor('0', 'USD').ok).toBe(false);
    expect(positiveMinor('abc', 'USD').ok).toBe(false);
  });

  it('allows blank and zero where optional', () => {
    expect(optionalMinor('  ', 'USD')).toEqual({ ok: true, value: null });
    expect(optionalMinor('0', 'USD')).toEqual({ ok: true, value: '0' });
    expect(optionalMinor('-5', 'USD').ok).toBe(false);
  });
});

describe('percentages', () => {
  it('reads basis points, refusing over 100', () => {
    expect(optionalBps('6.25')).toEqual({ ok: true, value: 625 });
    expect(optionalBps('')).toEqual({ ok: true, value: null });
    expect(optionalBps('100.01').ok).toBe(false);
    expect(optionalBps('1.234').ok).toBe(false);
  });

  it('labels a missing ratio with a dash', () => {
    expect(percentLabel(null)).toBe('—');
    expect(percentLabel(85)).toBe('0.85%');
  });

  it('totals targets, or says it can not', () => {
    expect(percentTotal(['50', '25.5', '24.5'])).toBe(10000);
    expect(percentTotal(['50', 'x'])).toBeNull();
  });
});

describe('unit labels', () => {
  it('splits, trims and drops repeats', () => {
    expect(parseUnitLabels(' A, B ,,A')).toEqual([{ label: 'A' }, { label: 'B' }]);
    expect(parseUnitLabels('')).toEqual([]);
  });
});

describe('buildLease', () => {
  it('builds the request, defaulting what was left blank', () => {
    const res = buildLease(fields(), 'USD');
    expect(res).toEqual({
      ok: true,
      value: expect.objectContaining({
        rent: '150050',
        dueDay: 1,
        lateGraceDays: 5,
        lateFeeFlat: '0',
        lateFeeBps: 0,
        lateFeeCap: null,
        deposit: '0',
        endDate: null,
        depositAccountId: null,
      }),
    });
  });

  it('carries the late fee rule and deposit', () => {
    const res = buildLease(
      fields({ lateFeeFlat: '25', lateFeePercent: '5', lateFeeCap: '50', deposit: '1500' }),
      'USD',
    );
    expect(res.ok && res.value).toMatchObject({
      lateFeeFlat: '2500',
      lateFeeBps: 500,
      lateFeeCap: '5000',
      deposit: '150000',
    });
  });

  it.each([
    [{ unitId: '' }, 'unit'],
    [{ tenantIds: [] }, 'tenant'],
    [{ rent: '' }, 'rent'],
    [{ endDate: '2025-12-31' }, 'end date'],
    [{ dueDay: '32' }, 'due day'],
    [{ dueDay: '0' }, 'zero due day'],
    [{ graceDays: '61' }, 'grace'],
    [{ lateFeePercent: '200' }, 'percent'],
    [{ deposit: '-1' }, 'deposit'],
  ])('refuses a bad %j (%s)', (over, _name) => {
    expect(buildLease(fields(over as Partial<LeaseFormFields>), 'USD').ok).toBe(false);
  });
});
