/** Helpers for the Phase 6 screens (budget, flow, goals). */

export interface Drill {
  entityId?: string;
  memberId?: string;
  propertyId?: string;
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
