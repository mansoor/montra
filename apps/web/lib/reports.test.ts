import { describe, expect, it } from 'vitest';
import {
  barPercent,
  chartBars,
  chartLines,
  filtersFromParams,
  filtersToParams,
  formatBytes,
  minutesToTime,
  savedToParams,
  timeToMinutes,
} from './reports';

const id = '01a1a742-deb2-7249-b415-7cd1f4ddcf63';

describe('filtersFromParams', () => {
  it('takes what is well formed', () => {
    expect(
      filtersFromParams({
        from: '2026-01-01',
        to: '2026-02-01',
        entityId: id,
        categoryIds: `${id},${id}`,
        tags: 'trip, work',
        memberId: 'household',
        groupBy: 'payee',
      }),
    ).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
      entityId: id,
      categoryIds: [id, id],
      tags: ['trip', 'work'],
      memberId: 'household',
      groupBy: 'payee',
    });
  });

  it('drops what is not, so an old link still opens', () => {
    expect(
      filtersFromParams({
        from: 'yesterday',
        entityId: 'nope',
        categoryIds: 'x,y',
        accountIds: '',
        memberId: 'someone',
        groupBy: 'nope',
      }),
    ).toEqual({});
  });
});

describe('params', () => {
  it('leaves out what is empty', () => {
    expect(filtersToParams({ from: '2026-01-01', entityId: '', tags: undefined }).toString()).toBe(
      'from=2026-01-01',
    );
  });

  it('reads a saved report, whose lists are arrays', () => {
    expect(
      savedToParams({ tags: ['a', 'b'], from: '2026-01-01', junk: 'x', accountIds: [1] }).toString(),
    ).toBe('from=2026-01-01&accountIds=&tags=a%2Cb'.replace('accountIds=&', ''));
  });
});

describe('charts', () => {
  const rows = [
    { key: 'h', cells: { category: 'Heading', amount: '999' }, drill: null, emphasis: true },
    { key: 'a', cells: { category: 'A', amount: '300' }, drill: null, emphasis: false },
    { key: 'b', cells: { category: 'B', amount: '100' }, drill: null, emphasis: false },
    { key: 'c', cells: { category: 'C', amount: null }, drill: null, emphasis: false },
  ];

  it('draws bars from the value column, skipping headings and blanks', () => {
    const report = { chart: { kind: 'bar' as const, x: 'category', y: ['amount'] }, rows };
    expect(chartBars(report)).toEqual([
      { key: 'a', label: 'A', value: 300n },
      { key: 'b', label: 'B', value: 100n },
    ]);
    expect(chartBars({ chart: null, rows })).toEqual([]);
  });

  it('draws lines with one series per value column', () => {
    const lines = chartLines({
      chart: { kind: 'line', x: 'month', y: ['income', 'expense'] },
      rows: [
        {
          key: 'm',
          cells: { month: '2026-01-01', income: '5', expense: null },
          drill: null,
          emphasis: false,
        },
      ],
    });
    expect(lines).toEqual({
      labels: ['2026-01-01'],
      series: [
        { key: 'income', values: ['5'] },
        { key: 'expense', values: ['0'] },
      ],
    });
    expect(chartLines({ chart: null, rows: [] })).toBeNull();
  });

  it('scales bars to the largest, and nothing negative', () => {
    expect(barPercent(50n, 200n)).toBe(25);
    expect(barPercent(-5n, 200n)).toBe(0);
    expect(barPercent(5n, 0n)).toBe(0);
  });
});

describe('formats', () => {
  it('writes bytes for people', () => {
    expect(formatBytes('512')).toBe('512 B');
    expect(formatBytes('2048')).toBe('2.0 KB');
    expect(formatBytes(String(5 * 1024 ** 3))).toBe('5.00 GB');
  });

  it('turns minutes into a time and back', () => {
    expect(minutesToTime(1320)).toBe('22:00');
    expect(minutesToTime(65)).toBe('01:05');
    expect(minutesToTime(null)).toBe('');
    expect(timeToMinutes('07:00')).toBe(420);
    expect(timeToMinutes('')).toBeNull();
    expect(timeToMinutes('24:30')).toBeNull();
  });
});
