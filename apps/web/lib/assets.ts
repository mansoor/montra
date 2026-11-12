/** Business assets, expense details and trips by driver on the web (BIZ-16..19, ADR-0035). */
import type { BusinessAssetDto, ExpenseDetailDto, MileageTripDto } from '@montra/api-client';
import { DEFAULT_LIFE, type AssetCategory } from '@montra/domain';

type T = (key: string, values?: Record<string, string | number>) => string;

export const ASSET_CATEGORY_OPTIONS: readonly AssetCategory[] = [
  'computers',
  'equipment',
  'furniture',
  'vehicle',
  'software',
  'other',
];

/** The recovery period the form suggests for a category (IRS Publication 946 classes). */
export const suggestedLife = (category: AssetCategory): number => DEFAULT_LIFE[category];

export type AssetState = 'disposed' | 'assigned' | 'in_use';

export function assetState(a: Pick<BusinessAssetDto, 'disposal' | 'assignedTo'>): AssetState {
  if (a.disposal) return 'disposed';
  return a.assignedTo ? 'assigned' : 'in_use';
}

/** Years with depreciation not yet in the books, up to `throughYear`. */
export function unpostedYears(assets: readonly BusinessAssetDto[], throughYear: number): number[] {
  const years = new Set<number>();
  for (const a of assets) {
    if (a.disposal) continue;
    for (const s of a.schedule) if (!s.posted && s.year <= throughYear) years.add(s.year);
  }
  return [...years].sort((x, y) => x - y);
}

/** "You (owner)", the person's name, or null when nobody is named. */
export function spentByText(d: Pick<ExpenseDetailDto, 'spentBy' | 'spentByName'>, t: T): string | null {
  if (d.spentBy === 'owner') return t('expense.spent_by_owner');
  if (d.spentBy === 'person') return d.spentByName ?? t('expense.spent_by_someone');
  return null;
}

export const attendeesText = (d: Pick<ExpenseDetailDto, 'attendees'>): string =>
  d.attendees.map((a) => a.name).join(', ');

/** Splits what was typed into attendee names: commas or new lines, blanks dropped, at most 30. */
export function parseAttendeeNames(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);
}

export function driverText(trip: Pick<MileageTripDto, 'driver' | 'driverName'>, t: T): string {
  return trip.driver === 'owner'
    ? t('mileage.driver_owner')
    : (trip.driverName ?? t('expense.spent_by_someone'));
}

/** Whether "Reimburse this trip" is offered: someone else's trip with no live reimbursement. */
export const canReimburse = (trip: Pick<MileageTripDto, 'driver' | 'reimbursementStatus'>): boolean =>
  trip.driver === 'person' && (trip.reimbursementStatus === null || trip.reimbursementStatus === 'declined');
