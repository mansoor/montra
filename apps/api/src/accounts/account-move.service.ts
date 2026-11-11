/**
 * Moving an account to other books (ACC-03; ADR-0033): a preview of what would move and why it can't yet, and the
 * move itself. The re-booking is the poster's (`rebookAccount`), beside the other rules that change the ledger.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import type { AccountMoveBlocker, AccountMovePreviewDto } from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { TransactionPoster } from '../transactions/poster.js';

type Ctx = { workspaceId: string; userId: string };

/** In an entry without a transaction, lines of these roles move with the account (`rebookStandalone`). */
const STANDALONE_ROLES = [
  'opening_balance_equity',
  'investment_gains',
  'uncategorized_income',
  'uncategorized_expense',
  'bank_fees',
  'fx_gain_loss',
  'fx_rounding',
];

const MESSAGES: Record<AccountMoveBlocker, (n: number) => string> = {
  closed_period: (n) =>
    `${n} ${n === 1 ? 'entry is' : 'entries are'} in a closed period. Reopen the books to move this account.`,
  currency_mismatch: () => 'These books keep a different home currency.',
  manual_journal: (n) =>
    `${n} journal ${n === 1 ? 'entry' : 'entries'} written by hand use this account with something only the old books have. Change ${n === 1 ? 'it' : 'them'} first.`,
  rental_books: () => 'Accounts in rental books stay with their properties.',
  property_loan: () => 'This loan is tied to a property.',
  archived: () => 'Restore the account before moving it.',
};

@Injectable()
export class AccountMoveService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
  ) {}

  preview(ctx: Ctx, accountId: string, toEntityId: string): Promise<AccountMovePreviewDto> {
    return this.db.run(ctx, (trx) => this.check(trx, ctx, accountId, toEntityId));
  }

  async move(ctx: Ctx, accountId: string, toEntityId: string): Promise<AccountMovePreviewDto> {
    return this.db.run(ctx, async (trx) => {
      // One move at a time per account: a second request waits, then finds it already moved.
      await trx
        .selectFrom('app.ledger_account')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();
      const p = await this.check(trx, ctx, accountId, toEntityId);
      if (p.blockers.length) {
        throw new AppError(409, 'account.move_blocked', p.blockers.map((b) => b.message).join(' '));
      }
      const done = await this.poster.rebookAccount(trx, ctx, accountId, p.fromEntityId, toEntityId);
      if (p.clearedDefaults.includes('default_deposit_account')) {
        await trx
          .updateTable('app.business_profile')
          .set({ default_deposit_account_id: null })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', p.fromEntityId)
          .where('default_deposit_account_id', '=', accountId)
          .execute();
      }
      if (p.clearedDefaults.includes('tax_savings_account')) {
        await trx
          .updateTable('app.business_profile')
          .set({ tax_savings_account_id: null })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', p.fromEntityId)
          .where('tax_savings_account_id', '=', accountId)
          .execute();
      }
      // What else is kept per account and entity follows it.
      await trx
        .updateTable('app.loan_schedule')
        .set({ entity_id: toEntityId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('loan_account_id', '=', accountId)
        .where('property_id', 'is', null)
        .execute();
      await trx
        .updateTable('app.account_valuation')
        .set({ entity_id: toEntityId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('account_id', '=', accountId)
        .execute();
      await trx
        .insertInto('app.account_move')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          ledger_account_id: accountId,
          from_entity_id: p.fromEntityId,
          to_entity_id: toEntityId,
          transactions: done.transactions,
          entries: done.entries,
          moved_by: ctx.userId,
        })
        .execute();
      return { ...p, transactions: done.transactions, entries: done.entries, moved: true };
    });
  }

  private async check(
    trx: Trx,
    ctx: Ctx,
    accountId: string,
    toEntityId: string,
  ): Promise<AccountMovePreviewDto> {
    const account = await trx
      .selectFrom('app.ledger_account as a')
      .innerJoin('app.bank_account as b', (j) =>
        j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
      )
      .select(['a.id', 'a.entity_id', 'a.archived_at'])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.id', '=', accountId)
      .executeTakeFirst();
    if (!account) throw notFound('Account');
    const entities = await trx
      .selectFrom('app.entity')
      .select(['id', 'type', 'functional_currency', 'archived_at'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', [account.entity_id, toEntityId])
      .execute();
    const from = entities.find((e) => e.id === account.entity_id)!;
    const to = entities.find((e) => e.id === toEntityId);
    if (!to || to.archived_at) throw notFound('Books');
    if (to.id === from.id)
      throw unprocessable('account.move_same_books', 'The account is already in these books');

    const blockers: AccountMovePreviewDto['blockers'] = [];
    const block = (code: AccountMoveBlocker, count = 1) =>
      blockers.push({ code, count, message: MESSAGES[code](count) });
    if (account.archived_at) block('archived');
    if (from.type === 'rental' || to.type === 'rental') block('rental_books');
    if (from.functional_currency !== to.functional_currency) block('currency_mismatch');
    const propertyLoan = await trx
      .selectFrom('app.loan_schedule')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('loan_account_id', '=', accountId)
      .where('property_id', 'is not', null)
      .executeTakeFirst();
    if (propertyLoan) block('property_loan');

    // Every entry the move rewrites: all of each transaction with a line on the account, and its own entries.
    const { rows } = await sql<{
      transactions: number;
      entries: number;
      closed: number;
      manual: number;
      reconciled: number;
      cross: number;
    }>`
      with touched as (
        select distinct je.id, je.transaction_id
          from app.posting p
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
         where p.workspace_id = ${ctx.workspaceId} and p.ledger_account_id = ${accountId}
      ), rewritten as (
        select je.* from app.journal_entry je
         where je.workspace_id = ${ctx.workspaceId}
           and (je.transaction_id in (select transaction_id from touched where transaction_id is not null)
                or je.id in (select id from touched where transaction_id is null))
      )
      select
        (select count(distinct transaction_id) from touched)::int as transactions,
        (select count(*) from touched where transaction_id is null)::int as entries,
        (select count(*) from rewritten r
          where r.entry_date <= coalesce(app.locked_through(${ctx.workspaceId}, r.entity_id), '-infinity'::date)
             or r.entry_date <= coalesce(app.locked_through(${ctx.workspaceId}, ${toEntityId}::uuid), '-infinity'::date))::int as closed,
        (select count(distinct t.id) from touched t
           join app.posting p on p.workspace_id = ${ctx.workspaceId} and p.journal_entry_id = t.id
           join app.ledger_account a on a.id = p.ledger_account_id
          where t.transaction_id is null and p.ledger_account_id <> ${accountId}
            and (a.system_role is null or a.system_role <> all(${STANDALONE_ROLES}::text[])))::int as manual,
        (select count(*) from app.posting p
          where p.workspace_id = ${ctx.workspaceId} and p.ledger_account_id = ${accountId}
            and p.cleared = 'reconciled')::int as reconciled,
        (select count(distinct r.transaction_id) from rewritten r
           join app.posting p on p.workspace_id = r.workspace_id and p.journal_entry_id = r.id
           join app.ledger_account a on a.id = p.ledger_account_id
          where r.transaction_id is not null and a.entity_id = ${from.id}
            and a.is_category and a.system_role is null)::int as cross`.execute(trx);
    const r = rows[0]!;
    if (r.closed) block('closed_period', r.closed);
    if (r.manual) block('manual_journal', r.manual);

    const defaults = await trx
      .selectFrom('app.business_profile')
      .select(['default_deposit_account_id', 'tax_savings_account_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', from.id)
      .executeTakeFirst();
    const clearedDefaults: AccountMovePreviewDto['clearedDefaults'] = [];
    if (defaults?.default_deposit_account_id === accountId) clearedDefaults.push('default_deposit_account');
    if (defaults?.tax_savings_account_id === accountId) clearedDefaults.push('tax_savings_account');

    return {
      accountId,
      fromEntityId: from.id,
      toEntityId,
      transactions: r.transactions,
      entries: r.entries,
      reconciledLines: r.reconciled,
      crossBooks: r.cross,
      clearedDefaults,
      blockers,
      moved: false,
    };
  }
}
