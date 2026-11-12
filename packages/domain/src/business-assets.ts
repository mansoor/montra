/**
 * Business assets (BIZ-16; ADR-0035): yearly depreciation by method, and what a disposal writes off. Bigint minor units
 * throughout, each year taken as the difference of a running total so the years add up to the basis exactly.
 *
 * Not tax advice. Not modelled: bonus depreciation, the mid-quarter convention, the Section 280F caps on cars, business
 * use below 100% and the yearly Section 179 limits. The owner types the Section 179 amount they elect.
 */
import type { CalendarDate } from './calendar-date.js';
import { divRound } from './rounding.js';

export type AssetCategory = 'equipment' | 'computers' | 'furniture' | 'vehicle' | 'software' | 'other';
export type AssetMethod = 'expense_now' | 'straight_line' | 'macrs_half_year';
export type AssetLife = 3 | 5 | 7 | 10;

export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  'equipment',
  'computers',
  'furniture',
  'vehicle',
  'software',
  'other',
];
export const ASSET_METHODS: readonly AssetMethod[] = ['expense_now', 'straight_line', 'macrs_half_year'];
export const ASSET_LIVES: readonly AssetLife[] = [3, 5, 7, 10];

/**
 * The de minimis safe harbor: up to $2,500 per item or invoice can be expensed instead of capitalized, for a business
 * without audited financial statements (Treas. Reg. §1.263(a)-1(f)(1)(ii)(D); IRS Notice 2015-82). In cents.
 */
export const DE_MINIMIS_MINOR = 250_000n;

/** Recovery periods by IRS Publication 946's classes: computers and cars are 5-year, furniture and equipment 7-year. */
export const DEFAULT_LIFE: Readonly<Record<AssetCategory, AssetLife>> = {
  equipment: 7,
  computers: 5,
  furniture: 7,
  vehicle: 5,
  software: 3,
  other: 7,
};

/**
 * MACRS half-year convention, IRS Publication 946 Appendix A, Table A-1 (200% declining balance switching to straight
 * line), in hundredths of a percent. Each column adds up to 100.00%.
 */
export const MACRS_HALF_YEAR: Readonly<Record<AssetLife, readonly number[]>> = {
  3: [3333, 4445, 1481, 741],
  5: [2000, 3200, 1920, 1152, 1152, 576],
  7: [1429, 2449, 1749, 1249, 893, 892, 893, 446],
  10: [1000, 1800, 1440, 1152, 922, 737, 655, 655, 656, 655, 328],
};

export interface AssetBasis {
  category: AssetCategory;
  method: AssetMethod;
  life: AssetLife;
  cost: bigint;
  section179: bigint;
  inService: CalendarDate;
}

const yearOf = (d: CalendarDate) => Number(d.slice(0, 4));
const monthOf = (d: CalendarDate) => Number(d.slice(5, 7));

/** Software is straight line over 36 months from the month placed in service (IRC §167(f)(1)), not half-year. */
const byMonth = (a: Pick<AssetBasis, 'category' | 'method'>) =>
  a.category === 'software' && a.method === 'straight_line';

/** Depreciation taken by the end of `year` on the basis after Section 179, with no disposal. */
function cumulative(a: AssetBasis, year: number): bigint {
  const basis = a.cost - a.section179;
  const start = yearOf(a.inService);
  if (year < start || basis <= 0n) return 0n;
  const k = year - start; // 0 in the first year
  if (a.method === 'expense_now') return 0n;
  if (a.method === 'macrs_half_year') {
    const table = MACRS_HALF_YEAR[a.life];
    const pct = table.slice(0, k + 1).reduce((t, p) => t + p, 0);
    return divRound(basis * BigInt(pct), 10_000n);
  }
  if (byMonth(a)) {
    const months = Math.min(k * 12 + (13 - monthOf(a.inService)), a.life * 12);
    return divRound(basis * BigInt(months), BigInt(a.life * 12));
  }
  // Straight line, half-year convention: a half year in the first year and in the year after the last.
  const halves = Math.min(2 * k + 1, 2 * a.life);
  return divRound(basis * BigInt(halves), BigInt(2 * a.life));
}

/**
 * The deduction for one year: Section 179 in the first year, plus that year's depreciation. Zero for "expense now",
 * whose purchase is already an expense.
 */
export function assetDepreciationForYear(a: AssetBasis, year: number): bigint {
  if (a.method === 'expense_now') return 0n;
  const first = year === yearOf(a.inService) ? a.section179 : 0n;
  return first + cumulative(a, year) - cumulative(a, year - 1);
}

/** The years with a deduction, first to last. */
export function assetSchedule(a: AssetBasis): { year: number; amount: bigint }[] {
  if (a.method === 'expense_now') return [];
  const start = yearOf(a.inService);
  const out: { year: number; amount: bigint }[] = [];
  for (let y = start; y <= start + a.life + 1; y++) {
    const amount = assetDepreciationForYear(a, y);
    if (amount > 0n) out.push({ year: y, amount });
  }
  return out;
}

/**
 * The deduction in the year of disposal: half the year's amount under the half-year convention, or the months up to the
 * month of disposal for software. Nothing in the first year beyond Section 179: property placed in service and disposed
 * of in the same year gets no depreciation (Publication 946, chapter 4).
 */
export function assetDepreciationInDisposalYear(a: AssetBasis, disposedOn: CalendarDate): bigint {
  if (a.method === 'expense_now') return 0n;
  const year = yearOf(disposedOn);
  const start = yearOf(a.inService);
  if (year === start) return a.section179;
  if (byMonth(a)) {
    const basis = a.cost - a.section179;
    const total = (months: number) =>
      divRound(basis * BigInt(Math.min(months, a.life * 12)), BigInt(a.life * 12));
    const before = (year - start - 1) * 12 + (13 - monthOf(a.inService));
    return total(before + monthOf(disposedOn)) - total(before);
  }
  return divRound(assetDepreciationForYear(a, year), 2n);
}

/** Gain (positive) or loss (negative) on a disposal: proceeds less the book value written off. */
export const disposalGain = (proceeds: bigint, cost: bigint, accumulated: bigint): bigint =>
  proceeds - (cost - accumulated);

export interface CarveSplit {
  accountId: string;
  /** Signed like the purchase: negative for money out. */
  amount: string;
  memberId: string | null;
  memo?: string | null;
  propertyId?: string | null;
  unitId?: string | null;
}

/**
 * A purchase's splits with an asset's cost moved to `assetAccountId` (ADR-0035 §2). The cost comes out of the splits in
 * `eligible` (the business's expense categories), largest first. Null when they don't add up to the cost.
 */
export function carveAssetSplits<S extends CarveSplit>(
  splits: readonly S[],
  eligible: ReadonlySet<string>,
  cost: bigint,
  assetAccountId: string,
): (S | CarveSplit)[] | null {
  const order = splits
    .map((s, i) => ({ i, take: eligible.has(s.accountId) ? -BigInt(s.amount) : 0n }))
    .filter((x) => x.take > 0n)
    .sort((a, b) => (b.take > a.take ? 1 : b.take < a.take ? -1 : a.i - b.i));
  if (order.reduce((t, x) => t + x.take, 0n) < cost) return null;
  const amounts = splits.map((s) => BigInt(s.amount));
  let left = cost;
  for (const x of order) {
    if (left === 0n) break;
    const take = x.take < left ? x.take : left;
    amounts[x.i] = amounts[x.i]! + take;
    left -= take;
  }
  const kept = splits.flatMap((s, i) => (amounts[i] === 0n ? [] : [{ ...s, amount: String(amounts[i]) }]));
  return [...kept, { accountId: assetAccountId, amount: String(-cost), memberId: null }];
}
