/**
 * Adding a bill on the web (ADR-0048 §4): uploaded and read like the phone's scan, or typed in. These helpers are the
 * pure parts of `components/planning/add-bill.tsx`: who may add one, waiting for the reading, what the reading fills
 * in, and checking the form before it's filed.
 */
import { isCalendarDate } from '@montra/domain';
import type { BillerDto, ScanBillDetectedDto, ScanDto } from '@montra/api-client';
import { staticT } from './i18n-static';
import { minorToInput, parseAmountInput } from './money';

type T = (key: string, values?: Record<string, string | number>) => string;

/**
 * Whether the login may add bills to these books: everyone but a viewer, in books it can write. The same rule as the
 * phone's `abilitiesOf(…).writes` (AUTH-18); the server still decides.
 */
export function canWriteBooks(
  workspace: { role: string; entities: { id: string; access?: 'read' | 'write' }[] },
  entityId: string,
): boolean {
  if (workspace.role === 'viewer') return false;
  return workspace.entities.find((e) => e.id === entityId)?.access !== 'read';
}

/**
 * Waits for a scan to be read, checking every `everyMs` for at most `limitMs`; null when it took longer. The phone's
 * `waitForScan` (apps/mobile/src/features/scanner.ts), so both clients wait the same way.
 */
export async function waitForScan<S extends { status: string }>(
  get: () => Promise<S>,
  everyMs = 1500,
  limitMs = 120_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<S | null> {
  for (let waited = 0; waited <= limitMs; waited += everyMs) {
    const scan = await get();
    if (scan.status !== 'reading') return scan;
    await sleep(everyMs);
  }
  return null;
}

/**
 * The provider's name when the scan filed its bill automatically (ADR-0051: the provider is learned and the amount and
 * due date were read), else null. The phone's `autoFiledName` (apps/mobile/src/features/intake-review.ts).
 */
export function autoFiledName(scan: Pick<ScanDto, 'status' | 'bill'> | null): string | null {
  const b = scan?.bill;
  if (scan?.status !== 'used' || !b?.filed) return null;
  return b.candidates.find((c) => c.billerId === b.billerId)?.name ?? b.billerName ?? '';
}

/** `billerId` empty means a new provider, named `newName`, on `categoryId`. */
export interface BillDraft {
  billerId: string;
  newName: string;
  categoryId: string;
  amount: string;
  dueDate: string;
  billDate: string;
}

export const blankDraft = (categoryId: string): BillDraft => ({
  billerId: '',
  newName: '',
  categoryId,
  amount: '',
  dueDate: '',
  billDate: '',
});

/**
 * What a reading fills in: the provider it matched (else its first candidate, else a new one named as printed), the
 * amount due and the dates. Like the phone, the amount shows in the reading's currency.
 */
export function draftFromReading(found: ScanBillDetectedDto | null, base: BillDraft): BillDraft {
  if (!found) return base;
  const date = (d: string | null) => (d && isCalendarDate(d) ? d : '');
  return {
    ...base,
    billerId: found.billerId ?? found.candidates[0]?.billerId ?? '',
    newName: found.billerName ?? '',
    amount: found.amount && found.currency ? minorToInput(BigInt(found.amount), found.currency) : base.amount,
    dueDate: date(found.dueDate) || base.dueDate,
    billDate: date(found.billDate) || base.billDate,
  };
}

/** How the reading found its provider, for the line under the provider field. */
export function matchNote(
  found: ScanBillDetectedDto | null,
  t: T = staticT,
): { key: 'account' | 'name' | 'none'; text: string } | null {
  if (!found) return null;
  const id = found.billerId ?? found.candidates[0]?.billerId;
  const match = found.candidates.find((c) => c.billerId === id);
  if (!match) return { key: 'none', text: t('billers.bill_match_none') };
  return {
    key: match.reason,
    text: t(match.reason === 'account' ? 'billers.bill_match_account' : 'billers.bill_match_name', {
      name: match.name,
    }),
  };
}

/** A provider to choose; `entityId` is null for one only the reading knows. */
export interface ProviderChoice {
  id: string;
  name: string;
  entityId: string | null;
}

/** The providers to choose from: the ones listed, plus any the reading matched that aren't (another book's). */
export function providerChoices(
  billers: Pick<BillerDto, 'id' | 'name' | 'entityId' | 'archived'>[],
  found: ScanBillDetectedDto | null,
): ProviderChoice[] {
  const listed: ProviderChoice[] = billers
    .filter((b) => !b.archived)
    .map((b) => ({ id: b.id, name: b.name, entityId: b.entityId }));
  const known = new Set(listed.map((b) => b.id));
  const extra: ProviderChoice[] = (found?.candidates ?? [])
    .filter((c) => !known.has(c.billerId))
    .map((c) => ({ id: c.billerId, name: c.name, entityId: null }));
  return [...listed, ...extra];
}

export type BillField = 'billerId' | 'newName' | 'categoryId' | 'amount' | 'dueDate' | 'billDate';

export type BillCheck =
  | { ok: true; amount: string; dueDate: string; billDate: string | null }
  | { ok: false; errors: Partial<Record<BillField, string>> };

/** Checks the form before filing; the amount comes back in minor units of `currency`. */
export function checkBillDraft(d: BillDraft, currency: string, locale = 'en-US', t: T = staticT): BillCheck {
  const errors: Partial<Record<BillField, string>> = {};
  if (!d.billerId) {
    if (!d.newName.trim()) errors.newName = t('billers.bill_name_required');
    if (!d.categoryId) errors.categoryId = t('billers.bill_category_required');
  }
  const amount = parseAmountInput(d.amount, currency, locale, t);
  if (!amount.ok) errors.amount = amount.error;
  else if (amount.minor <= 0n) errors.amount = t('billers.bill_amount_positive');
  if (!d.dueDate.trim()) errors.dueDate = t('billers.bill_due_required');
  else if (!isCalendarDate(d.dueDate.trim())) errors.dueDate = t('billers.bill_date_invalid');
  if (d.billDate.trim() && !isCalendarDate(d.billDate.trim()))
    errors.billDate = t('billers.bill_date_invalid');
  if (Object.keys(errors).length > 0 || !amount.ok) return { ok: false, errors };
  return {
    ok: true,
    amount: amount.minor.toString(),
    dueDate: d.dueDate.trim(),
    billDate: d.billDate.trim() || null,
  };
}
