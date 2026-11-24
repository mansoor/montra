import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import {
  activeChips,
  amountBound,
  clearFilters,
  hasFilters,
  isAmountText,
  listApiQuery,
  listFiltersToParams,
  listWindow,
  parseListFilters,
  presetStart,
  widen,
  withoutChip,
  type ListFilters,
} from './list-filters';

const d = calendarDate;

describe('preset windows', () => {
  it('count today as the last day', () => {
    const today = d('2026-11-23');
    expect(presetStart('7d', today)).toBe('2026-11-17');
    expect(presetStart('30d', today)).toBe('2026-10-25');
    expect(presetStart('60d', today)).toBe('2026-09-25');
    expect(presetStart('90d', today)).toBe('2026-08-26');
    expect(presetStart('6m', today)).toBe('2026-05-24');
    expect(presetStart('1y', today)).toBe('2025-11-24');
    expect(presetStart('all', today)).toBeUndefined();
  });

  it('clamp month ends and leap days', () => {
    // 31 Aug less 6 months is 28 Feb (clamped), so the window starts on 1 Mar.
    expect(presetStart('6m', d('2026-08-31'))).toBe('2026-03-01');
    // In a leap year it is 29 Feb, so the window starts on 1 Mar as well.
    expect(presetStart('6m', d('2028-08-31'))).toBe('2028-03-01');
    expect(presetStart('1y', d('2028-02-29'))).toBe('2027-03-01');
    expect(presetStart('30d', d('2026-03-01'))).toBe('2026-01-31');
    expect(presetStart('7d', d('2027-01-02'))).toBe('2026-12-27');
  });

  it('use the workspace time zone for today, not the browser’s or the server’s', () => {
    const f: ListFilters = { range: '7d' };
    // 03:30 UTC on 1 March is still 28 February in Los Angeles and already 1 March in Tokyo.
    const now = new Date('2026-03-01T03:30:00Z');
    expect(listWindow(f, 'America/Los_Angeles', now)).toEqual({ from: '2026-02-22' });
    expect(listWindow(f, 'Asia/Tokyo', now)).toEqual({ from: '2026-02-23' });
    expect(listWindow(f, 'UTC', now)).toEqual({ from: '2026-02-23' });
  });

  it('leave the end open, so scheduled items still show; all time has no dates', () => {
    expect(listWindow({ range: '90d' }, 'UTC', new Date('2026-11-23T12:00:00Z'))).toEqual({
      from: '2026-08-26',
    });
    expect(listWindow({ range: 'all' }, 'UTC')).toEqual({});
  });

  it('take a custom range as given, open on either side', () => {
    expect(listWindow({ range: 'custom', from: d('2026-01-01'), to: d('2026-01-31') }, 'UTC')).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(listWindow({ range: 'custom', to: d('2026-01-31') }, 'UTC')).toEqual({ to: '2026-01-31' });
    expect(listWindow({ range: 'custom' }, 'UTC')).toEqual({});
  });
});

describe('the URL', () => {
  it('round-trips every filter', () => {
    const f: ListFilters = {
      range: 'custom',
      from: d('2026-01-01'),
      to: d('2026-03-31'),
      merchant: 'blue bottle',
      text: 'usb cable',
      min: '20',
      max: '99.50',
      dir: 'out',
      account: '0192f5a0-0000-7000-8000-000000000001',
      category: '0192f5a0-0000-7000-8000-000000000002',
    };
    const q = listFiltersToParams(f);
    expect(parseListFilters(new URLSearchParams(q.toString()))).toEqual({ filters: f, explicit: true });
    expect(parseListFilters(Object.fromEntries(q))).toEqual({ filters: f, explicit: true });
  });

  it('keeps the other params, and drops dates that a preset makes moot', () => {
    const q = listFiltersToParams(
      { range: '6m', merchant: 'shell' },
      new URLSearchParams('filter=review&from=2026-01-01&merchant=old'),
    );
    expect(q.toString()).toBe('filter=review&range=6m&merchant=shell');
  });

  it('opens on the default window, and says the link named none', () => {
    expect(parseListFilters({})).toEqual({ filters: { range: '90d' }, explicit: false });
    expect(parseListFilters({ range: 'all' })).toEqual({ filters: { range: 'all' }, explicit: true });
  });

  it('reads a report’s drill-down dates as a custom range', () => {
    expect(parseListFilters({ from: '2026-10-01', to: '2026-10-31' }).filters).toEqual({
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-31',
    });
  });

  it('ignores what is malformed instead of failing', () => {
    expect(
      parseListFilters({
        range: 'forever',
        from: '2026-02-30',
        min: 'twenty',
        max: '-5',
        dir: 'sideways',
        account: 'nope',
        merchant: '  ',
      }),
    ).toEqual({ filters: { range: '90d' }, explicit: false });
  });
});

describe('amounts', () => {
  it('parse what was typed into unsigned minor units, never floats', () => {
    expect(amountBound('20', 'USD')).toBe('2000');
    expect(amountBound('99.5', 'USD')).toBe('9950');
    expect(amountBound('1,234.56', 'USD')).toBe('123456');
    expect(amountBound('(5.00)', 'USD')).toBe('500');
    expect(amountBound('1500', 'JPY')).toBe('1500');
    expect(amountBound('12,50', 'EUR', 'de-DE')).toBe('1250');
    expect(amountBound('1.234', 'USD')).toBeUndefined();
    expect(amountBound('', 'USD')).toBeUndefined();
  });

  it('only let through what the URL keeps, so typing never loops', () => {
    expect(isAmountText(' 20 ', 'USD')).toBe(true);
    expect(isAmountText('1,234.50', 'USD')).toBe(true);
    expect(isAmountText('(5)', 'USD')).toBe(false);
    expect(isAmountText('$20', 'USD')).toBe(false);
    expect(isAmountText('2.555', 'USD')).toBe(false);
    for (const ok of ['20', '1,234.50']) expect(parseListFilters({ min: ok }).filters.min).toBe(ok);
  });

  it('go to the API with the window, merchant and direction', () => {
    const f: ListFilters = { range: '30d', merchant: 'fresh', min: '20', max: '100', dir: 'in' };
    expect(listApiQuery(f, { timeZone: 'UTC', currency: 'USD' }, new Date('2026-11-23T12:00:00Z'))).toEqual({
      from: '2026-10-25',
      merchant: 'fresh',
      amountMin: '2000',
      amountMax: '10000',
      direction: 'in',
    });
  });
});

describe('widening, chips and clearing', () => {
  it('widens one preset at a time, then to all time', () => {
    const steps: string[] = [];
    let f: ListFilters | null = { range: '7d' };
    while (f) {
      steps.push(f.range);
      f = widen(f);
    }
    expect(steps).toEqual(['7d', '30d', '60d', '90d', '6m', '1y', 'all']);
  });

  it('opens a custom range at its start', () => {
    expect(widen({ range: 'custom', from: d('2026-01-01'), to: d('2026-02-01') })).toEqual({
      range: 'custom',
      from: undefined,
      to: '2026-02-01',
    });
    expect(widen({ range: 'custom', to: d('2026-02-01') })).toBeNull();
  });

  it('shows a chip per filter, and removing one keeps the rest', () => {
    const f: ListFilters = { range: 'custom', from: d('2026-01-01'), merchant: 'x', min: '5', dir: 'out' };
    expect(activeChips(f)).toEqual(['dates', 'merchant', 'amount', 'dir']);
    expect(activeChips(withoutChip(f, 'amount'))).toEqual(['dates', 'merchant', 'dir']);
    expect(withoutChip(f, 'dates')).toMatchObject({ range: '90d', merchant: 'x' });
    expect(activeChips({ range: '1y' })).toEqual([]);
    // Words on a receipt are a filter of their own, kept apart from the merchant.
    const r: ListFilters = { range: '90d', merchant: 'x', text: 'order 112' };
    expect(activeChips(r)).toEqual(['merchant', 'text']);
    expect(withoutChip(r, 'text')).toEqual({ range: '90d', merchant: 'x' });
    expect(hasFilters({ range: '90d', text: 'drill' })).toBe(true);
  });

  it('clears the filters but keeps a preset window', () => {
    expect(clearFilters({ range: '1y', merchant: 'x', account: 'a' })).toEqual({ range: '1y' });
    expect(clearFilters({ range: 'custom', from: d('2026-01-01') })).toEqual({ range: '90d' });
    expect(hasFilters({ range: '1y' })).toBe(false);
    expect(hasFilters({ range: '1y', dir: 'in' })).toBe(true);
    expect(hasFilters({ range: 'custom' })).toBe(true);
  });
});
