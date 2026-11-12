import type { LocalTransaction } from '@montra/sync';

export interface EditRules {
  /** A line of it is reconciled with a statement (DE-15): shown with a lock. */
  reconciled: boolean;
  /** The paying account can change (the account picker). */
  canMove: boolean;
  /** The date and amount can change. The phone never edits the amount; the date only while not reconciled. */
  canChangeDate: boolean;
  canChangeAmount: boolean;
}

/**
 * What the phone lets you change on a transaction. The server decides (DE-10); this keeps the screen from offering
 * what it would refuse. The paying account can change on an income or expense nothing else manages, with an amount and
 * an account. A reconciled one keeps its account, amount and date until its reconciliation is undone on the web.
 */
export function editRules(row: Pick<LocalTransaction, 'amount' | 'accountId' | 'server'>): EditRules {
  // Rows synced by an older server have no flag: not reconciled, as far as the phone knows.
  const reconciled = row.server?.reconciled === true;
  const standard = row.server ? row.server.entries.some((e) => e.kind === 'standard') : true;
  const canMove =
    !reconciled && standard && !row.server?.managedBy && row.amount !== null && row.accountId !== null;
  return { reconciled, canMove, canChangeDate: !reconciled, canChangeAmount: !reconciled };
}
