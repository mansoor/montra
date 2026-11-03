import { describe, expect, it } from 'vitest';
import type { BudgetPeriodDto, SankeyDto } from '@montra/schemas';
import { ApiError, createApi } from '../src/api/client';
import {
  assignedInput,
  cacheKey,
  flowSections,
  isUsedLine,
  lineTone,
  parseAssigned,
  percentOf,
  sparkline,
  stepPeriod,
  thin,
  visibleGroups,
} from '../src/features/planning';

type Line = BudgetPeriodDto['groups'][number]['lines'][number];
const line = (over: Partial<Line> = {}): Line => ({
  categoryId: 'c1',
  name: 'Groceries',
  assigned: '0',
  carriedIn: '0',
  activity: '0',
  moved: '0',
  available: '0',
  rolloverMode: 'carry_surplus',
  pace: null,
  goal: null,
  ...over,
});

describe('budget shaping', () => {
  it('steps monthly and pay periods', () => {
    expect(stepPeriod({ periodType: 'monthly', anchorDate: null }, '2026-01-01', -1)).toBe('2025-12-01');
    expect(stepPeriod({ periodType: 'biweekly', anchorDate: '2026-01-02' as never }, '2026-01-02', 1)).toBe(
      '2026-01-16',
    );
  });

  it('hides lines with nothing in them, unless asked', () => {
    expect(isUsedLine(line())).toBe(false);
    expect(isUsedLine(line({ assigned: '100' }))).toBe(true);
    expect(isUsedLine(line({ carriedIn: '-5' }))).toBe(true);
    expect(isUsedLine(line({ goal: { goalId: 'g', monthlyNeeded: '100' } }))).toBe(true);
    const groups = [
      { id: 'a', name: 'A', kind: 'daily', assigned: '0', activity: '0', available: '0', lines: [line()] },
      {
        id: 'b',
        name: 'B',
        kind: 'fun',
        assigned: '5',
        activity: '0',
        available: '5',
        lines: [line(), line({ categoryId: 'c2', assigned: '5', available: '5' })],
      },
    ] as BudgetPeriodDto['groups'];
    expect(visibleGroups(groups, true)).toHaveLength(2);
    const shown = visibleGroups(groups, false);
    expect(shown.map((g) => g.id)).toEqual(['b']);
    expect(shown[0]!.lines.map((l) => l.categoryId)).toEqual(['c2']);
  });

  it('colours overspent and over-pace lines', () => {
    expect(lineTone(line({ available: '-1' }))).toBe('danger');
    expect(
      lineTone(line({ available: '5', pace: { expectedByToday: '1', projected: '9', status: 'over' } })),
    ).toBe('warning');
    expect(lineTone(line({ available: '5' }))).toBe('ok');
  });

  it('computes bar widths from exact amounts, clamped', () => {
    expect(percentOf('2500', '10000')).toBe(25);
    expect(percentOf('20000', '10000')).toBe(100);
    expect(percentOf('-1', '10000')).toBe(0);
    expect(percentOf('1', '0')).toBe(100);
    expect(percentOf('0', '0')).toBe(0);
  });

  it('parses typed amounts without floats, and shows them back', () => {
    expect(parseAssigned('12.50', 'USD')).toBe('1250');
    expect(parseAssigned('500', 'JPY')).toBe('500');
    expect(parseAssigned('', 'USD')).toBe('0');
    expect(parseAssigned('-3', 'USD')).toBeNull();
    expect(parseAssigned('abc', 'USD')).toBeNull();
    expect(assignedInput('1250', 'USD')).toBe('12.50');
    expect(assignedInput('0', 'USD')).toBe('');
  });
});

describe('trends', () => {
  it('scales bars and handles flat series', () => {
    expect(sparkline([])).toEqual([]);
    expect(sparkline(['5', '5'])).toEqual([0.5, 0.5]);
    const bars = sparkline(['0', '50', '100']);
    expect(bars[0]).toBeCloseTo(0.1);
    expect(bars[1]).toBeCloseTo(0.55);
    expect(bars[2]).toBeCloseTo(1);
  });

  it('thins long series and always keeps the last value', () => {
    expect(thin([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const t = thin(
      Array.from({ length: 90 }, (_, i) => i),
      10,
    );
    expect(t).toHaveLength(10);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBe(89);
  });
});

describe('flowSections (NFR-10: a list instead of the Sankey)', () => {
  const data: SankeyDto = {
    from: '2026-11-01' as never,
    to: '2026-11-30' as never,
    currency: 'USD' as never,
    nodes: [
      { id: 'income:s', kind: 'income', label: 'Salary', value: '500', drill: null },
      { id: 'entity:p', kind: 'entity', label: 'Personal', value: '500', drill: null },
      { id: 'group:f', kind: 'group', label: 'Fixed', value: '100', drill: null },
      { id: 'group:d', kind: 'group', label: 'Daily', value: '300', drill: null },
      { id: 'category:r', kind: 'category', label: 'Rent', value: '100', drill: null },
      { id: 'category:g', kind: 'category', label: 'Groceries', value: '200', drill: null },
      { id: 'category:o', kind: 'category', label: 'Dining', value: '100', drill: null },
      { id: 'unspent:p', kind: 'unspent', label: 'Not spent', value: '100', drill: null },
    ],
    links: [
      { source: 'group:d', target: 'category:o', value: '100' },
      { source: 'group:d', target: 'category:g', value: '200' },
      { source: 'group:f', target: 'category:r', value: '100' },
    ],
  };

  it('orders groups by size with their categories beneath, and leaves entities out', () => {
    const s = flowSections(data);
    expect(s.map((x) => x.key)).toEqual(['income', 'spending', 'set_aside']);
    expect(s[0]!.rows.map((r) => r.label)).toEqual(['Salary']);
    expect(s[1]!.rows.map((r) => [r.label, r.indent])).toEqual([
      ['Daily', false],
      ['Groceries', true],
      ['Dining', true],
      ['Fixed', false],
      ['Rent', true],
    ]);
    expect(s[2]!.rows.map((r) => r.label)).toEqual(['Not spent']);
  });

  it('is empty when nothing happened', () => {
    expect(flowSections({ ...data, nodes: [], links: [] })).toEqual([]);
  });
});

describe('planning API calls', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createApi({
    baseUrl: 'http://api',
    token: async () => 't',
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes('fail'))
        return new Response(JSON.stringify({ code: 'version.conflict' }), { status: 409 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });

  it('sends the budget version with assign and move', async () => {
    await api.assignBudget('w', 'b', '2026-11-01', 'c', '500', 3);
    expect(calls.at(-1)!.url).toBe('http://api/v1/workspaces/w/budgets/b/periods/2026-11-01/lines/c');
    expect(calls.at(-1)!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ assigned: '500', version: 3 });
    await api.moveBudget('w', 'b', '2026-11-01', { from: 'c', to: null, amount: '5', version: 4 });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({
      from: 'c',
      to: null,
      amount: '5',
      version: 4,
    });
  });

  it('asks for open recommendations and surfaces conflicts', async () => {
    expect(await api.recommendations('w')).toEqual([]);
    expect(calls.at(-1)!.url).toContain('/recommendations?status=open');
    const err = await api.budgetPeriod('w', 'fail').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'version.conflict', offline: false });
  });

  it('keys the offline copy by workspace', () => {
    expect(cacheKey('w1', 'dashboard')).toBe('plan.w1.dashboard');
  });
});
