/**
 * Rentals on the phone (08 §3): this month's rent and logging a payment. The numbers all come from the server, and no ledger
 * logic lives here; properties, leases and reports are managed on the web.
 */
import type { AccountDto, RentRollDto } from '@montra/schemas';

type RollRow = RentRollDto['rows'][number];

/** Who still owes this month first, largest first; then those who've paid, by name. */
export function rollInOrder(rows: readonly RollRow[]): RollRow[] {
  return [...rows].sort((a, b) => {
    const open = BigInt(b.open) - BigInt(a.open);
    if (open !== 0n) return open > 0n ? 1 : -1;
    return `${a.propertyName} ${a.unitLabel}`.localeCompare(`${b.propertyName} ${b.unitLabel}`);
  });
}

/** Rent lands in a bank or cash account; the portfolio's own are offered first. */
export function rentAccounts(accounts: readonly AccountDto[], entityId: string): AccountDto[] {
  return accounts
    .filter((a) => ['checking', 'savings', 'cash'].includes(a.kind))
    .sort((a, b) => Number(b.entityId === entityId) - Number(a.entityId === entityId));
}
