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
  /** Signed change from the paying account's view (negative = money out); null for manual journals. */
  amount: bigint | null;
  currency: string;
  categories: string[];
  isTransfer: boolean;
  needsReview: boolean;
  status: string;
  tags: string[];
}

/** The bank/card posting of a transaction (first non-category, non-system line on a known account). */
export function bankPosting(t: TransactionDto, accountIds: ReadonlySet<string>) {
  const postings = t.entries[0]?.postings ?? [];
  const isTransfer = t.entries[0]?.kind === 'transfer';
  const banks = postings.filter((p) => !p.isCategory && p.systemRole === null && accountIds.has(p.accountId));
  // For transfers, the leg money leaves from.
  return (isTransfer ? banks.find((p) => p.credit !== null) : banks[0]) ?? banks[0] ?? null;
}

/** Summarizes a transaction for lists using the API's signed `amount` and `isCategory` flags. */
export function toTransactionRow(
  t: TransactionDto,
  accounts: ReadonlyMap<string, { name: string }>,
): TransactionRow {
  const isTransfer = t.entries[0]?.kind === 'transfer';
  const accountIds = new Set(accounts.keys());
  const bank = bankPosting(t, accountIds);
  const postings = t.entries.flatMap((e) => e.postings);
  const categories = isTransfer
    ? postings
        .filter((p) => !p.isCategory && p.systemRole === null && accountIds.has(p.accountId) && p !== bank)
        .map((p) => `→ ${p.accountName}`)
    : unique(postings.filter((p) => p.isCategory).map((p) => p.accountName));
  return {
    id: t.id,
    date: t.date,
    title: t.payee || t.description || (isTransfer ? 'Transfer' : '(no payee)'),
    accountName: bank?.accountName ?? '',
    amount: t.amount ? BigInt(t.amount.amount) : null,
    currency: t.amount?.currency ?? bank?.currency ?? 'USD',
    categories,
    isTransfer,
    needsReview: t.reviewState === 'needs_review',
    status: t.status,
    tags: t.tags,
  };
}

export const accountMap = (accounts: { id: string; name: string }[]) =>
  new Map(accounts.map((a) => [a.id, a]));

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

const unique = <T>(xs: T[]) => [...new Set(xs)];
