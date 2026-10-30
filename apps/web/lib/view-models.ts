/** Pure shaping of API DTOs for pages: grouping, net position, transaction amounts. */
import type { AccountDto, CategoryDto, TransactionDto, WorkspaceDto } from '@montra/api-client';

export interface EntityAccounts {
  entityId: string;
  entityName: string;
  entityType: string;
  accounts: AccountDto[];
}

export function groupAccountsByEntity(workspace: WorkspaceDto, accounts: AccountDto[]): EntityAccounts[] {
  return workspace.entities
    .map((e) => ({
      entityId: e.id,
      entityName: e.name,
      entityType: e.type,
      accounts: accounts.filter((a) => a.entityId === e.id && !a.archived),
    }))
    .filter((g) => g.accounts.length > 0);
}

/** Net position per currency: money held in asset accounts minus amounts owed on liabilities. */
export function netPosition(accounts: AccountDto[]): { currency: string; amount: bigint }[] {
  const totals = new Map<string, bigint>();
  for (const a of accounts) {
    if (a.archived) continue;
    const v = BigInt(a.balance.amount);
    totals.set(a.currency, (totals.get(a.currency) ?? 0n) + (a.type === 'asset' ? v : -v));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount }));
}

export interface TransactionRow {
  id: string;
  date: string;
  title: string;
  accountName: string;
  /** Signed change from the paying account's view (negative = money out). */
  amount: bigint;
  currency: string;
  categories: string[];
  isTransfer: boolean;
  needsReview: boolean;
}

/**
 * Summarizes a transaction for lists, using the bank-side posting of its first entry. When `categoryIds` is
 * given, only real categories are listed (inter-entity clearing and owner-equity lines are hidden).
 */
export function toTransactionRow(
  t: TransactionDto,
  accountIds: ReadonlySet<string>,
  categoryIds?: ReadonlySet<string>,
): TransactionRow {
  const entry = t.entries[0];
  const postings = entry?.postings ?? [];
  const bankPostings = postings.filter((p) => accountIds.has(p.accountId));
  const isTransfer = entry?.kind === 'transfer';
  // For transfers, show the leg money leaves from; otherwise the single bank-side posting.
  const bank = (isTransfer ? bankPostings.find((p) => p.credit !== null) : bankPostings[0]) ?? postings[0];
  const amount = bank ? BigInt(bank.debit ?? '0') - BigInt(bank.credit ?? '0') : 0n;
  const categories = t.entries
    .flatMap((e) => e.postings)
    .filter((p) => !accountIds.has(p.accountId) && (!categoryIds || categoryIds.has(p.accountId)))
    .map((p) => p.accountName);
  return {
    id: t.id,
    date: t.date,
    title: t.payee || t.description || (isTransfer ? 'Transfer' : '(no payee)'),
    accountName: bank?.accountName ?? '',
    amount: isTransfer ? -abs(amount) : amount,
    currency: bank?.currency ?? 'USD',
    categories: isTransfer
      ? bankPostings.filter((p) => p !== bank).map((p) => `→ ${p.accountName}`)
      : unique(categories),
    isTransfer,
    needsReview: t.reviewState === 'needs_review',
  };
}

export interface CategoryGroup {
  label: string;
  categories: CategoryDto[];
}

/** Categories grouped by entity, then by category group, for pickers (allows business splits). */
export function groupCategories(
  workspace: WorkspaceDto,
  categories: CategoryDto[],
  type?: 'income' | 'expense',
): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  for (const e of workspace.entities) {
    const inEntity = categories.filter((c) => c.entityId === e.id && (!type || c.type === type));
    const byGroup = new Map<string, CategoryDto[]>();
    for (const c of inEntity) {
      const key = c.group ?? 'Other';
      byGroup.set(key, [...(byGroup.get(key) ?? []), c]);
    }
    for (const [group, cats] of byGroup) groups.push({ label: `${e.name} · ${group}`, categories: cats });
  }
  return groups;
}

const abs = (n: bigint) => (n < 0n ? -n : n);
const unique = <T>(xs: T[]) => [...new Set(xs)];
