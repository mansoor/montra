/** Helpers for the Phase 6 screens (budget, flow, goals). */

export interface Drill {
  entityId?: string;
  memberId?: string;
  propertyId?: string;
  q?: string;
  categoryIds?: string[];
  accountIds?: string[];
  from?: string;
  to?: string;
}

/** The transactions list filtered to what makes up a number (FLOW-01/02 drill-down). */
export function drillHref(base: string, d: Drill | null | undefined): string {
  if (!d) return `${base}/transactions`;
  const q = new URLSearchParams();
  if (d.entityId) q.set('entityId', d.entityId);
  if (d.memberId) q.set('memberId', d.memberId);
  if (d.propertyId) q.set('propertyId', d.propertyId);
  if (d.q) q.set('q', d.q);
  if (d.categoryIds?.length) q.set('categoryIds', d.categoryIds.join(','));
  if (d.accountIds?.length) q.set('accountIds', d.accountIds.join(','));
  if (d.from) q.set('from', d.from);
  if (d.to) q.set('to', d.to);
  const s = q.toString();
  return `${base}/transactions${s ? `?${s}` : ''}`;
}

/** Progress as a 0–100 number for bars (display only). */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return part > 0n ? 100 : 0;
  const p = Number((part * 1000n) / whole) / 10;
  return Math.max(0, Math.min(100, p));
}

/** Previous / next period start for monthly budgets (weekly ones step by their length on the server side). */
export function shiftMonth(start: string, n: number): string {
  const [y, m] = start.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  const yy = Math.floor(index / 12);
  const mm = (index % 12) + 1;
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-01`;
}

export function shiftDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The parts of a Sankey node and link that its layout reads. */
interface FlowNode {
  id: string;
  kind: string;
}
interface FlowLink {
  source: string;
  target: string;
}

/**
 * Sankey columns (FLOW-02, FLOW-06): income → books → groups, savings and what's left → categories. A book that gets
 * money from another book (an owner draw or contribution) sits one column to the right of it, so money between books
 * flows left to right like the rest. A transfer node that feeds a book sits with income; one a book pays into sits
 * with the groups. `count` is the number of columns.
 */
export function sankeyColumns(
  nodes: readonly FlowNode[],
  links: readonly FlowLink[],
): { column: Map<string, number>; count: number } {
  const depth = new Map(nodes.filter((n) => n.kind === 'entity').map((n) => [n.id, 0]));
  const between = links.filter((l) => depth.has(l.source) && depth.has(l.target));
  // Longest path, capped so a loop between books (not expected: the server nets each pair) still ends.
  for (let pass = 0; pass < depth.size; pass++) {
    let changed = false;
    for (const l of between) {
      const d = depth.get(l.source)! + 1;
      if (d > depth.get(l.target)! && d < depth.size) {
        depth.set(l.target, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const shift = Math.max(0, ...depth.values());
  const sources = new Set(links.map((l) => l.source));
  const column = new Map(
    nodes.map((n) => [
      n.id,
      n.kind === 'income' || n.kind === 'deficit' || (n.kind === 'transfer' && sources.has(n.id))
        ? 0
        : n.kind === 'entity'
          ? 1 + depth.get(n.id)!
          : n.kind === 'category'
            ? 3 + shift
            : 2 + shift,
    ]),
  );
  return { column, count: 4 + shift };
}
