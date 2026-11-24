/**
 * An account's holders (ACC-15, ADR-0057 §5) and its full number (ACC-16, §6).
 *
 * Holders are who the bank says owns the account: names in order, each optionally a family member. They sit beside the
 * default member, which says whose spending it is and doesn't change. At most `ACCOUNT_MAX_HOLDERS` (a setting).
 *
 * The full number is sealed in `bank_account.account_number_enc` with its last four in `last4`, as BIZ-26 seals a
 * business's EIN (`crypto/sealed-numbers.ts`). Screens and DTOs get "••••1234"; the number itself is unsealed only for
 * Show, after a recent sign-in, and each Show is logged.
 */
import type { Trx } from '@montra/db';
import { maskLast4 } from '@montra/domain';
import type { AccountHolderDto, AccountHolderInput } from '@montra/schemas';
import { notFound, unprocessable } from '../common/errors.js';
import type { FieldCrypto } from '../crypto/crypto.service.js';
import { sealNumber } from '../crypto/sealed-numbers.js';

type Ctx = { workspaceId: string; userId: string };

/** FieldCrypto's associated data for the full number, as the backup catalog names it. */
export const ACCOUNT_NUMBER_LABEL = 'bank_account.account_number';

/** "••••1234", from the last four alone. */
export const maskAccountNumber = (last4: string | null | undefined): string | null => maskLast4(last4);

/** The columns to write for a full number (null forgets it and leaves the last four as they are). */
export async function sealAccountNumber(
  crypto: FieldCrypto,
  trx: Trx,
  workspaceId: string,
  value: string | null,
): Promise<{ account_number_enc: Buffer | null; last4?: string }> {
  const sealed = await sealNumber(crypto, trx, workspaceId, ACCOUNT_NUMBER_LABEL, value);
  return sealed.last4
    ? { account_number_enc: sealed.enc, last4: sealed.last4 }
    : { account_number_enc: null };
}

/**
 * The full number, for Show and for a statement cover the owner set to "Full" (ADR-0057 §3). Never log it, put it in
 * an error or send it anywhere else.
 */
export function openAccountNumber(
  crypto: FieldCrypto,
  trx: Trx,
  workspaceId: string,
  sealed: Buffer | null,
): Promise<string | null> {
  return crypto.decrypt(trx, workspaceId, ACCOUNT_NUMBER_LABEL, sealed);
}

/** Each account's holders, in order. Accounts without any are absent. */
export async function holdersOf(
  trx: Trx,
  workspaceId: string,
  accountIds: readonly string[],
): Promise<Map<string, AccountHolderDto[]>> {
  const out = new Map<string, AccountHolderDto[]>();
  if (!accountIds.length) return out;
  const rows = await trx
    .selectFrom('app.account_holder')
    .select(['ledger_account_id', 'name', 'member_id'])
    .where('workspace_id', '=', workspaceId)
    .where('ledger_account_id', 'in', [...accountIds])
    .orderBy('ledger_account_id')
    .orderBy('position')
    .execute();
  for (const r of rows) {
    const list = out.get(r.ledger_account_id) ?? [];
    list.push({ name: r.name, memberId: r.member_id });
    out.set(r.ledger_account_id, list);
  }
  return out;
}

/**
 * Replaces an account's holders with `holders`, in order. A row keeps its id while its position stays, so the audit log
 * shows a renamed holder as a change rather than a new one. A member must be in this household; a holder with a member
 * and no name takes the member's.
 */
export async function saveHolders(
  trx: Trx,
  ctx: Ctx,
  accountId: string,
  holders: readonly AccountHolderInput[],
  max: number,
): Promise<void> {
  if (holders.length > max) {
    throw unprocessable('account.holders_limit', `An account can list up to ${max} holders`);
  }
  // Holders are for bank, card, loan and asset accounts, not categories.
  const bank = await trx
    .selectFrom('app.bank_account')
    .select('ledger_account_id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('ledger_account_id', '=', accountId)
    .executeTakeFirst();
  if (!bank) throw notFound('Account');
  const memberIds = [...new Set(holders.map((h) => h.memberId).filter((m): m is string => Boolean(m)))];
  const members = new Map<string, string>();
  if (memberIds.length) {
    for (const m of await trx
      .selectFrom('app.family_member')
      .select(['id', 'name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', memberIds)
      .execute()) {
      members.set(m.id, m.name);
    }
    if (members.size !== memberIds.length) {
      throw unprocessable('account.holder_member', 'Choose a family member from this household');
    }
  }
  const wanted = holders.map((h, position) => ({
    position,
    name: (h.name || (h.memberId ? members.get(h.memberId) : '') || '').slice(0, 100),
    member_id: h.memberId ?? null,
  }));
  const current = await trx
    .selectFrom('app.account_holder')
    .select(['id', 'position', 'name', 'member_id'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('ledger_account_id', '=', accountId)
    .orderBy('position')
    .execute();
  await trx
    .deleteFrom('app.account_holder')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('ledger_account_id', '=', accountId)
    .where('position', '>=', wanted.length)
    .execute();
  for (const w of wanted) {
    const now = current.find((c) => c.position === w.position);
    if (!now) {
      await trx
        .insertInto('app.account_holder')
        .values({ workspace_id: ctx.workspaceId, ledger_account_id: accountId, ...w })
        .execute();
    } else if (now.name !== w.name || now.member_id !== w.member_id) {
      await trx
        .updateTable('app.account_holder')
        .set({ name: w.name, member_id: w.member_id })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', now.id)
        .execute();
    }
  }
}
