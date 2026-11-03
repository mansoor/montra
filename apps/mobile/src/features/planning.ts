/**
 * Budget, flow and goals on the phone (08 §3). The numbers all come from the server; this only shapes them for
 * small screens. No budget or ledger logic lives here (it stays in the API and @montra/domain).
 */
import {
  calendarDate,
  parseMoney,
  shiftPeriod,
  toDecimalString,
  money,
  type BudgetPeriodType,
} from '@montra/domain';
import type { BudgetPeriodDto, SankeyDto } from '@montra/schemas';

type Line = BudgetPeriodDto['groups'][number]['lines'][number];

/** The start of the period `n` periods from `start`. */
export function stepPeriod(
  budget: Pick<BudgetPeriodDto['budget'], 'periodType' | 'anchorDate'>,
  start: string,
  n: number,
): string {
  const spec = {
    type: budget.periodType as BudgetPeriodType,
    anchor: budget.anchorDate ? calendarDate(budget.anchorDate) : null,
  };
  return shiftPeriod(spec, calendarDate(start), n).start;
}

/** A line worth showing: anything assigned, carried, spent or planned. Empty ones stay behind "show all". */
export const isUsedLine = (l: Line): boolean =>
  BigInt(l.assigned) !== 0n ||
  BigInt(l.activity) !== 0n ||
  BigInt(l.available) !== 0n ||
  BigInt(l.carriedIn) !== 0n ||
  l.goal !== null;

export function visibleGroups(
  groups: BudgetPeriodDto['groups'],
  showAll: boolean,
): BudgetPeriodDto['groups'] {
  if (showAll) return groups;
  return groups.map((g) => ({ ...g, lines: g.lines.filter(isUsedLine) })).filter((g) => g.lines.length > 0);
}

/** 0–100 for a progress bar (display only). */
export function percentOf(part: string | bigint, whole: string | bigint): number {
  const p = BigInt(part);
  const w = BigInt(whole);
  if (w <= 0n) return p > 0n ? 100 : 0;
  const v = Number((p * 1000n) / w) / 10;
  return Math.max(0, Math.min(100, v));
}

export type LineTone = 'danger' | 'warning' | 'ok';

/** Over budget is danger; on pace to overspend is a warning. */
export function lineTone(l: Pick<Line, 'available' | 'pace'>): LineTone {
  if (BigInt(l.available) < 0n) return 'danger';
  return l.pace?.status === 'over' ? 'warning' : 'ok';
}

/**
 * Typed amount → minor units. Returns null when it isn't a valid non-negative amount, so the screen can say
 * so without calling the API.
 */
export function parseAssigned(input: string, currency: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return '0';
  try {
    const m = parseMoney(trimmed, currency);
    return m.amount < 0n ? null : String(m.amount);
  } catch {
    return null;
  }
}

/** Minor units → the text put in an amount field ("" for zero). */
export function assignedInput(minor: string, currency: string): string {
  const v = BigInt(minor);
  return v === 0n ? '' : toDecimalString(money(v, currency));
}

/** Bar heights (0–1) for a small trend; a flat series sits at half height. */
export function sparkline(values: readonly string[]): number[] {
  if (!values.length) return [];
  const nums = values.map(Number);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) return nums.map(() => 0.5);
  return nums.map((v) => 0.1 + (0.9 * (v - min)) / (max - min));
}

/** At most `points` evenly spaced values, always keeping the last (daily forecasts on a phone-width chart). */
export function thin<T>(values: readonly T[], points: number): T[] {
  if (values.length <= points) return [...values];
  const out: T[] = [];
  const step = (values.length - 1) / (points - 1);
  for (let i = 0; i < points; i++) out.push(values[Math.trunc(i * step)]!);
  out[out.length - 1] = values[values.length - 1]!;
  return out;
}

export interface FlowSection {
  key: 'income' | 'spending' | 'set_aside';
  rows: { id: string; label: string; value: string; indent: boolean }[];
}

/**
 * The money flow as lists (a Sankey is unreadable on a phone, and NFR-10 wants a table for every chart anyway):
 * where it came from, where it went (groups with their categories), and what was set aside or left.
 */
export function flowSections(data: SankeyDto): FlowSection[] {
  const nodes = new Map(data.nodes.map((n) => [n.id, n]));
  const by = (kinds: string[]) =>
    data.nodes
      .filter((n) => kinds.includes(n.kind) && BigInt(n.value) > 0n)
      .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0));
  const row = (n: SankeyDto['nodes'][number], indent = false) => ({
    id: n.id,
    label: n.label,
    value: n.value,
    indent,
  });
  const spending = by(['group']).flatMap((g) => {
    const cats = data.links
      .filter((l) => l.source === g.id)
      .map((l) => nodes.get(l.target))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));
    return [row(g), ...cats.map((c) => row(c, true))];
  });
  return [
    { key: 'income' as const, rows: by(['income', 'deficit']).map((n) => row(n)) },
    { key: 'spending' as const, rows: spending },
    { key: 'set_aside' as const, rows: by(['savings', 'debt', 'unspent']).map((n) => row(n)) },
  ].filter((s) => s.rows.length > 0);
}

/** The local-store key for a cached planning response (read while offline). */
export const cacheKey = (workspaceId: string, name: string) => `plan.${workspaceId}.${name}`;
