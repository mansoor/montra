/**
 * Rental screens' pure helpers (RNT-01..14): typed amounts ↔ the API's minor units, and building a lease. No float math:
 * amounts go through parseAmountInput, and rates are checked as text.
 */
import type { CreateLeaseInput, MaintenanceDto, RentChargeDto } from '@montra/api-client';
import { percentToBps } from './business';
import { parseAmountInput } from './money';
import { staticT } from './i18n-static';

type T = (key: string, values?: Record<string, string | number>) => string;

export const RENT_CHIP: Record<RentChargeDto['status'], string> = {
  paid: 'chip chip-good',
  partial: 'chip chip-warn',
  upcoming: 'chip',
  due: 'chip chip-warn',
  late: 'chip chip-bad',
  waived: 'chip',
};

export const MAINTENANCE_CHIP: Record<MaintenanceDto['status'], string> = {
  open: 'chip chip-warn',
  scheduled: 'chip',
  done: 'chip chip-good',
};

export const PROPERTY_TYPES = ['sfh', 'multi_family', 'condo', 'str', 'commercial'] as const;
export const REMINDER_KINDS = ['insurance', 'property_tax', 'inspection', 'other'] as const;
export const MAINTENANCE_STATUSES = ['open', 'scheduled', 'done'] as const;
export const ALLOCATION_BASES = ['percent', 'units', 'sqft'] as const;

export type Parsed<V> = { ok: true; value: V } | { ok: false; error: string };

/** A required amount above zero, as minor units. */
export function positiveMinor(input: string, currency: string, t: T = staticT): Parsed<string> {
  const p = parseAmountInput(input, currency, 'en-US', t);
  if (!p.ok) return { ok: false, error: p.error };
  if (p.minor <= 0n) return { ok: false, error: t('money.positive') };
  return { ok: true, value: String(p.minor) };
}

/** An amount that may be blank (null) or zero. */
export function optionalMinor(input: string, currency: string, t: T = staticT): Parsed<string | null> {
  if (!input.trim()) return { ok: true, value: null };
  const p = parseAmountInput(input, currency, 'en-US', t);
  if (!p.ok) return { ok: false, error: p.error };
  if (p.minor < 0n) return { ok: false, error: t('money.positive') };
  return { ok: true, value: String(p.minor) };
}

/** A percentage such as 6.25 as basis points; blank is null. */
export function optionalBps(input: string, t: T = staticT): Parsed<number | null> {
  if (!input.trim()) return { ok: true, value: null };
  const bps = percentToBps(input);
  if (bps === null || bps > 10000) return { ok: false, error: t('rentals.percent_invalid') };
  return { ok: true, value: bps };
}

/** Basis points shown as a percent, or a dash when there's nothing to divide by. */
export function percentLabel(bps: number | null): string {
  return bps === null ? '—' : `${(bps / 100).toFixed(2)}%`;
}

/** "A, B, 2C" → unit labels; blank means one home with one unit. */
export function parseUnitLabels(input: string): { label: string }[] {
  return [...new Set(input.split(',').map((s) => s.trim()))].filter(Boolean).map((label) => ({ label }));
}

export interface LeaseFormFields {
  unitId: string;
  tenantIds: string[];
  startDate: string;
  endDate: string;
  rent: string;
  dueDay: string;
  graceDays: string;
  lateFeeFlat: string;
  lateFeePercent: string;
  lateFeeCap: string;
  deposit: string;
  depositAccountId: string;
  fileIds: string[];
}

/** The form as a request, or the first thing wrong with it. */
export function buildLease(f: LeaseFormFields, currency: string, t: T = staticT): Parsed<CreateLeaseInput> {
  if (!f.unitId) return { ok: false, error: t('rentals.choose_unit') };
  if (f.tenantIds.length === 0) return { ok: false, error: t('rentals.choose_tenant') };
  const rent = positiveMinor(f.rent, currency, t);
  if (!rent.ok) return rent;
  if (f.endDate && f.endDate < f.startDate) return { ok: false, error: t('rentals.lease_dates') };
  const dueDay = Number(f.dueDay);
  if (!/^\d{1,2}$/.test(f.dueDay) || dueDay < 1 || dueDay > 31) {
    return { ok: false, error: t('rentals.due_day_invalid') };
  }
  const grace = Number(f.graceDays);
  if (!/^\d{1,2}$/.test(f.graceDays) || grace > 60) return { ok: false, error: t('rentals.grace_invalid') };
  const flat = optionalMinor(f.lateFeeFlat, currency, t);
  if (!flat.ok) return flat;
  const bps = optionalBps(f.lateFeePercent, t);
  if (!bps.ok) return bps;
  const cap = optionalMinor(f.lateFeeCap, currency, t);
  if (!cap.ok) return cap;
  const deposit = optionalMinor(f.deposit, currency, t);
  if (!deposit.ok) return deposit;
  return {
    ok: true,
    value: {
      unitId: f.unitId,
      tenantIds: f.tenantIds,
      startDate: f.startDate as CreateLeaseInput['startDate'],
      endDate: (f.endDate || null) as CreateLeaseInput['endDate'],
      rent: rent.value,
      dueDay,
      lateGraceDays: grace,
      lateFeeFlat: flat.value ?? '0',
      lateFeeBps: bps.value ?? 0,
      lateFeeCap: cap.value,
      deposit: deposit.value ?? '0',
      depositAccountId: f.depositAccountId || null,
      fileIds: f.fileIds,
    },
  };
}

/** Percent targets must come to 100 before they're sent; units and square footage are read by the server. */
export function percentTotal(values: readonly string[]): number | null {
  let total = 0;
  for (const v of values) {
    const bps = percentToBps(v);
    if (bps === null) return null;
    total += bps;
  }
  return total;
}
