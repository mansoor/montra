/**
 * Deleting an account added by mistake (ACC-14). Only an empty account goes: no history and nothing else pointing at it.
 * What is only its own setup goes with it in one transaction: its opening balance and that entry, values that posted
 * nothing, its loan details, its saved import mapping and its statement memory. Its transactions in the Trash go too, for
 * good, when they touch nothing else: no other account, no receipt, nothing in closed or reconciled books, and no legal
 * hold on the workspace. Everything else is history, and the account can only be archived (ACC-06).
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '@montra/db';
import type { AccountDeleteBlocker, AccountDeletionDto } from '@montra/schemas';
import { AppError, notFound } from '../common/errors.js';
import { Db } from '../db/database.js';

type Ctx = { workspaceId: string; userId: string };

/** Each blocker as words with its count, for the sentence the web shows. */
type HistoryBlocker = Exclude<AccountDeleteBlocker, 'closed_period' | 'legal_hold'>;
const PHRASES: Record<HistoryBlocker, (n: number) => string> = {
  transactions: (n) => `${n} ${n === 1 ? 'transaction' : 'transactions'}`,
  trashed: (n) => `${n} ${n === 1 ? 'transaction' : 'transactions'} in the trash`,
  trashed_transfers: (n) =>
    `${n} ${n === 1 ? 'transfer' : 'transfers'} in the trash that also ${n === 1 ? 'touches' : 'touch'} another account`,
  trashed_receipts: (n) =>
    `${n} ${n === 1 ? 'transaction' : 'transactions'} in the trash with a receipt kept as a tax record`,
  trashed_closed: (n) =>
    `${n} ${n === 1 ? 'transaction' : 'transactions'} in the trash in closed or reconciled books`,
  entries: (n) =>
    `${n} ${n === 1 ? 'balance adjustment or journal entry' : 'balance adjustments or journal entries'}`,
  values: (n) => `${n} ${n === 1 ? 'value' : 'values'} that changed its balance`,
  receipts: (n) => `${n} ${n === 1 ? 'receipt' : 'receipts'}`,
  statements: (n) => `${n} ${n === 1 ? 'statement' : 'statements'}`,
  reconciliations: (n) => `${n} ${n === 1 ? 'reconciliation' : 'reconciliations'}`,
  loan_payments: (n) => `${n} loan ${n === 1 ? 'payment' : 'payments'}`,
  schedules: (n) =>
    `${n} ${n === 1 ? 'loan, card or asset that uses' : 'loans, cards or assets that use'} it`,
  recurring: (n) => `${n} recurring ${n === 1 ? 'item' : 'items'}`,
  rules: (n) => `${n} ${n === 1 ? 'rule' : 'rules'}`,
  links: (n) => `${n} other ${n === 1 ? 'record' : 'records'} linked to it`,
};

const list = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

interface Opening {
  id: string;
  entryDate: string;
  locked: boolean;
  lockedThrough: string | null;
}

@Injectable()
export class AccountDeleteService {
  constructor(@Inject(Db) private readonly db: Db) {}

  check(ctx: Ctx, accountId: string): Promise<AccountDeletionDto> {
    return this.db.run(ctx, async (trx) => (await this.inspect(trx, ctx, accountId)).dto);
  }

  async delete(ctx: Ctx, accountId: string): Promise<AccountDeletionDto> {
    return this.db.run(ctx, async (trx) => {
      // One delete at a time, and nothing posts to it while we look.
      await trx
        .selectFrom('app.ledger_account')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();
      const { dto, account, opening, trashedIds } = await this.inspect(trx, ctx, accountId);
      if (dto.blockers.length) {
        const code = dto.blockers.every((b) => b.code === 'closed_period')
          ? 'account.opening_locked'
          : dto.blockers.every((b) => b.code === 'legal_hold')
            ? 'account.legal_hold'
            : 'account.not_empty';
        throw new AppError(409, code, dto.reason!);
      }
      const ws = ctx.workspaceId;
      // Its transactions in the Trash, for good: any entries they still have go whole, so the books stay balanced.
      if (trashedIds.length) {
        await trx
          .deleteFrom('app.journal_entry')
          .where('workspace_id', '=', ws)
          .where('transaction_id', 'in', trashedIds)
          .execute();
        try {
          await trx
            .deleteFrom('app.transaction')
            .where('workspace_id', '=', ws)
            .where('id', 'in', trashedIds)
            .execute();
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === '23503' || code === '23514') {
            throw new AppError(
              409,
              'account.not_empty',
              'Another record still uses a transaction of this account in the trash. Archive it instead.',
            );
          }
          throw err;
        }
      }
      // The opening balance and its entry: removing the whole entry keeps the books balanced.
      if (opening) {
        await trx
          .deleteFrom('app.journal_entry')
          .where('workspace_id', '=', ws)
          .where('id', '=', opening.id)
          .execute();
      }
      // Its own setup. Values here posted nothing (those that did are history and block).
      await trx
        .deleteFrom('app.account_valuation')
        .where('workspace_id', '=', ws)
        .where('account_id', '=', accountId)
        .execute();
      await trx
        .deleteFrom('app.loan_schedule')
        .where('workspace_id', '=', ws)
        .where('loan_account_id', '=', accountId)
        .execute();
      await trx
        .deleteFrom('app.import_profile')
        .where('workspace_id', '=', ws)
        .where('ledger_account_id', '=', accountId)
        .execute();
      await trx
        .deleteFrom('app.match_memory')
        .where('workspace_id', '=', ws)
        .where('kind', '=', 'statement')
        .where('target_id', '=', accountId)
        .execute();
      // The bank account row, visibility, moves, payee transfers and tax-form waivers go by cascade; a linked feed
      // account is left unlinked.
      try {
        await trx
          .deleteFrom('app.ledger_account')
          .where('workspace_id', '=', ws)
          .where('id', '=', accountId)
          .execute();
      } catch (err) {
        // Something we can't see (a member's private entry) still points at it.
        if ((err as { code?: string }).code === '23503') {
          throw new AppError(
            409,
            'account.not_empty',
            'Something else still uses this account. Archive it instead.',
          );
        }
        throw err;
      }
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ws,
          actor_user_id: ctx.userId,
          action: 'account.deleted',
          subject_type: 'ledger_account',
          subject_id: accountId,
          diff: JSON.stringify({
            name: account.name,
            kind: account.kind,
            type: account.type,
            currency: account.currency,
            entityId: account.entity_id,
            openingBalance: account.opening_balance_minor.toString(),
            openingDate: String(account.opening_date).slice(0, 10),
            trashedTransactions: trashedIds.length,
          }),
        })
        .execute();
      return { ...dto, deleted: true };
    });
  }

  private async inspect(trx: Trx, ctx: Ctx, accountId: string) {
    const ws = ctx.workspaceId;
    const account = await trx
      .selectFrom('app.ledger_account as a')
      .innerJoin('app.bank_account as b', (j) =>
        j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
      )
      .select([
        'a.id',
        'a.name',
        'a.type',
        'a.currency',
        'a.entity_id',
        'b.kind',
        'b.opening_balance_minor',
        'b.opening_date',
      ])
      .where('a.workspace_id', '=', ws)
      .where('a.id', '=', accountId)
      .executeTakeFirst();
    if (!account) throw notFound('Account');

    const counts = new Map<AccountDeleteBlocker, number>();
    const add = (code: AccountDeleteBlocker, n: number | string | bigint | null | undefined) => {
      const v = Number(n ?? 0);
      if (v > 0) counts.set(code, (counts.get(code) ?? 0) + v);
    };
    const like = `%${accountId}%`;

    // Transactions: those with lines on it, and those whose spec names it (scheduled, or in the trash). One in the Trash
    // goes with the account when it touches nothing else: no other account (only categories and system accounts), no
    // receipt (a tax record, RCP-10), and nothing in closed or reconciled books (DE-10).
    const txns = await sql<{
      id: string;
      trashed: boolean;
      live_receipts: string;
      other_account: boolean;
      has_receipt: boolean;
      closed: boolean;
    }>`
      with t as (
        select je.transaction_id as id
          from app.posting p
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
         where p.workspace_id = ${ws} and p.ledger_account_id = ${accountId} and je.transaction_id is not null
        union
        select t.id from app.transaction t where t.workspace_id = ${ws} and t.spec::text like ${like}
      )
      select x.id, (x.deleted_at is not null or x.status = 'void') as trashed,
             (select count(*) from app.receipt r
               where r.workspace_id = ${ws} and r.deleted_at is null and r.transaction_id = x.id)::text as live_receipts,
             exists (
               select 1 from app.ledger_account la
                where la.workspace_id = ${ws} and la.id <> ${accountId}::uuid
                  and not la.is_category and la.system_role is null
                  and (la.id::text in (select (regexp_matches(coalesce(x.spec::text, ''),
                                         '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g'))[1])
                       or exists (select 1 from app.posting p
                                    join app.journal_entry je on je.workspace_id = p.workspace_id
                                                             and je.id = p.journal_entry_id
                                   where p.workspace_id = ${ws} and je.transaction_id = x.id
                                     and p.ledger_account_id = la.id))) as other_account,
             exists (select 1 from app.receipt r where r.workspace_id = ${ws} and r.transaction_id = x.id)
               as has_receipt,
             (x.txn_date <= app.locked_through(${ws}, x.primary_entity_id)) is true
               or exists (
                 select 1 from app.journal_entry je
                  where je.workspace_id = ${ws} and je.transaction_id = x.id
                    and (je.locked
                         or (je.entry_date <= app.locked_through(${ws}, je.entity_id)) is true
                         or exists (select 1 from app.posting p
                                     where p.workspace_id = je.workspace_id and p.journal_entry_id = je.id
                                       and (p.reconciliation_id is not null or p.cleared = 'reconciled')))) as closed
        from app.transaction x
       where x.workspace_id = ${ws} and x.id in (select id from t)`.execute(trx);
    const tally = { live: 0, transfers: 0, withReceipts: 0, closed: 0, receipts: 0 };
    const trashedIds: string[] = [];
    for (const r of txns.rows) {
      if (!r.trashed) {
        tally.live++;
        tally.receipts += Number(r.live_receipts);
      } else if (r.other_account) tally.transfers++;
      else if (r.has_receipt) tally.withReceipts++;
      else if (r.closed) tally.closed++;
      else trashedIds.push(r.id);
    }
    add('transactions', tally.live);
    add('trashed_transfers', tally.transfers);
    add('trashed_receipts', tally.withReceipts);
    add('trashed_closed', tally.closed);
    add('receipts', tally.receipts);

    // Entries without a transaction. Its own opening balance (against opening-balance equity only) goes with it.
    const entries = (
      await sql<{ id: string; kind: string; entry_date: string; locked: boolean; own_opening: boolean }>`
        select je.id, je.kind, je.entry_date::text as entry_date, je.locked,
               je.kind = 'opening_balance' and not exists (
                 select 1 from app.posting o
                   join app.ledger_account oa on oa.workspace_id = o.workspace_id and oa.id = o.ledger_account_id
                  where o.workspace_id = je.workspace_id and o.journal_entry_id = je.id
                    and o.ledger_account_id <> ${accountId}
                    and oa.system_role is distinct from 'opening_balance_equity') as own_opening
          from app.journal_entry je
         where je.workspace_id = ${ws} and je.transaction_id is null
           and exists (select 1 from app.posting p
                        where p.workspace_id = je.workspace_id and p.journal_entry_id = je.id
                          and p.ledger_account_id = ${accountId})`.execute(trx)
    ).rows;
    const openings = entries.filter((e) => e.own_opening);
    const opening0 = openings.length === 1 ? openings[0]! : null;
    for (const e of entries) {
      if (e === opening0) continue;
      add(e.kind === 'valuation' ? 'values' : 'entries', 1);
    }

    const one = async (q: RawBuilder<{ n: string }>) => (await q.execute(trx)).rows[0]?.n;
    add(
      'statements',
      await one(sql<{ n: string }>`
        select ((select count(*) from app.import_batch
                  where workspace_id = ${ws} and ledger_account_id = ${accountId})
              + (select count(*) from app.document_intake
                  where workspace_id = ${ws} and kind = 'statement' and target_id = ${accountId}
                    and status <> 'dismissed'))::text as n`),
    );
    add(
      'reconciliations',
      await one(sql<{ n: string }>`
        select count(*)::text as n from app.reconciliation
         where workspace_id = ${ws} and ledger_account_id = ${accountId}`),
    );
    add(
      'loan_payments',
      await one(sql<{ n: string }>`
        select count(*)::text as n from app.loan_payment lp
          join app.loan_schedule l on l.workspace_id = lp.workspace_id and l.id = lp.loan_id
         where lp.workspace_id = ${ws} and l.loan_account_id = ${accountId}`),
    );
    add(
      'schedules',
      await one(sql<{ n: string }>`
        select ((select count(*) from app.loan_schedule
                  where workspace_id = ${ws} and paying_account_id = ${accountId}
                    and loan_account_id <> ${accountId})
              + (select count(*) from app.bank_account
                  where workspace_id = ${ws} and ledger_account_id <> ${accountId}
                    and (pay_from_account_id = ${accountId} or loan_account_id = ${accountId})))::text as n`),
    );
    add(
      'recurring',
      await one(sql<{ n: string }>`
        select count(*)::text as n from app.recurring_item
         where workspace_id = ${ws} and spec::text like ${like}`),
    );
    add(
      'rules',
      await one(sql<{ n: string }>`
        select ((select count(*) from app.rule
                  where workspace_id = ${ws} and (conditions::text like ${like} or actions::text like ${like}))
              + (select count(*) from app.rule_suggestion
                  where workspace_id = ${ws} and status = 'pending'
                    and (conditions::text like ${like} or actions::text like ${like})))::text as n`),
    );
    // Every other reference, by foreign key or inside a saved spec. Category-only references (budgets, billers,
    // payee defaults) can't point at a bank account.
    add(
      'links',
      await one(sql<{ n: string }>`
        select (
            (select count(*) from app.ledger_account
              where workspace_id = ${ws} and (parent_id = ${accountId} or tracks_account_id = ${accountId}))
          + (select count(*) from app.employer
              where workspace_id = ${ws}
                and (deposit_account_id = ${accountId} or retirement_account_id = ${accountId}))
          + (select count(*) from app.employer_deposit where workspace_id = ${ws} and account_id = ${accountId})
          + (select count(*) from app.payslip_deposit where workspace_id = ${ws} and account_id = ${accountId})
          + (select count(*) from app.payslip_line where workspace_id = ${ws} and ledger_account_id = ${accountId})
          + (select count(*) from app.payslip where workspace_id = ${ws} and deposit_spec::text like ${like})
          + (select count(*) from app.business_profile
              where workspace_id = ${ws}
                and (default_deposit_account_id = ${accountId} or tax_savings_account_id = ${accountId}))
          + (select count(*) from app.invoice_line where workspace_id = ${ws} and income_account_id = ${accountId})
          + (select count(*) from app.invoice_payment where workspace_id = ${ws} and deposit_spec::text like ${like})
          + (select count(*) from app.bill
              where workspace_id = ${ws}
                and (expense_account_id = ${accountId} or payment_spec::text like ${like}))
          + (select count(*) from app.reimbursement where workspace_id = ${ws} and expense_account_id = ${accountId})
          + (select count(*) from app.property where workspace_id = ${ws} and improvements_account_id = ${accountId})
          + (select count(*) from app.lease where workspace_id = ${ws} and deposit_account_id = ${accountId})
          + (select count(*) from app.rent_payment where workspace_id = ${ws} and deposit_spec::text like ${like})
          + (select count(*) from app.security_deposit_event
              where workspace_id = ${ws} and deposit_spec::text like ${like})
          + (select count(*) from app.loan_payment where workspace_id = ${ws} and deposit_spec::text like ${like})
          + (select count(*) from app.pay_schedule where workspace_id = ${ws} and pay_from_account_id = ${accountId})
          + (select count(*) from app.pay_run where workspace_id = ${ws} and pay_from_account_id = ${accountId})
          + (select count(*) from app.payroll_deposit
              where workspace_id = ${ws} and pay_from_account_id = ${accountId})
          + (select count(*) from app.goal
              where workspace_id = ${ws} and (${accountId}::uuid = any(linked_account_ids) or category_id = ${accountId}))
          + (select count(*) from app.expected_income where workspace_id = ${ws} and account_id = ${accountId})
          + (select count(*) from app.tax_form_target where workspace_id = ${ws} and account_id = ${accountId})
        )::text as n`),
    );

    let opening: Opening | null = null;
    if (opening0) {
      const lock = await sql<{ d: string | null }>`
        select app.locked_through(${ws}, ${account.entity_id})::text as d`.execute(trx);
      opening = {
        id: opening0.id,
        entryDate: opening0.entry_date,
        locked: opening0.locked,
        lockedThrough: lock.rows[0]?.d ?? null,
      };
    }

    const history = [...counts.entries()] as [HistoryBlocker, number][];
    const blockers: AccountDeletionDto['blockers'] = history.map(([code, count]) => ({ code, count }));
    let reason: string | null = null;
    const held =
      trashedIds.length > 0 &&
      (await sql<{ held: boolean }>`select app.current_workspace_on_legal_hold() as held`.execute(trx))
        .rows[0]?.held === true;
    if (history.length) {
      const what = list(history.map(([code, n]) => PHRASES[code](n)));
      reason = `This account has ${what}. Archive it instead, or remove them first.`;
    } else if (held) {
      // A legal hold keeps the workspace as it is: nothing in the Trash goes for good meanwhile.
      blockers.push({ code: 'legal_hold', count: 1 });
      reason = `A legal hold keeps everything in this workspace as it is, so its ${PHRASES.trashed(trashedIds.length)} can't be removed. Archive it instead.`;
    } else if (
      opening &&
      (opening.locked || (opening.lockedThrough !== null && opening.entryDate <= opening.lockedThrough))
    ) {
      blockers.push({ code: 'closed_period', count: 1 });
      reason = opening.lockedThrough
        ? `Its opening balance is dated ${opening.entryDate}, in books closed through ${opening.lockedThrough}. Reopen them to delete it, or archive it instead.`
        : 'Its opening balance is locked. Unlock it to delete the account, or archive it instead.';
    }
    const dto: AccountDeletionDto = {
      accountId,
      name: account.name,
      blockers,
      reason,
      trashedTransactions: trashedIds.length,
      deleted: false,
    };
    return { dto, account, opening, trashedIds };
  }
}
