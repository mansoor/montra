/**
 * Who spent, attendees and business purpose on a business transaction, and "Expenses by person" (BIZ-18, ADR-0035 §7).
 * The details sit beside the transaction, so editing them never re-posts it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { calendarDate, asCurrencyCode, type CalendarDate } from '@montra/domain';
import type { ExpenseDetailDto, ExpensesByPersonDto, SetExpenseDetailRequest } from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { personName } from '../payroll/shared.js';
import { writableBusiness } from './assets.service.js';
import { loadExpenseDetails } from './expense-details.js';
import { businessEntity, todayOf, type Ctx } from './shared.js';

@Injectable()
export class ExpenseDetailsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async set(ctx: Ctx, transactionId: string, req: SetExpenseDetailRequest): Promise<ExpenseDetailDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await writableBusiness(trx, ctx, req.entityId);
      const current = (await loadExpenseDetails(trx, ctx, [transactionId])).get(transactionId);
      if (!current || current.entityId !== e.id) {
        throw notFound('Business spending in this transaction');
      }
      if (current.version !== req.version) {
        throw new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');
      }
      let spent: {
        spent_by: 'owner' | 'person' | null;
        spent_by_person_id: string | null;
        spent_by_name: string | null;
      } = { spent_by: null, spent_by_person_id: null, spent_by_name: null };
      if (req.spentBy?.kind === 'owner')
        spent = { spent_by: 'owner', spent_by_person_id: null, spent_by_name: null };
      if (req.spentBy?.kind === 'person') {
        const p = await trx
          .selectFrom('app.payroll_person')
          .select(['id', 'first_name', 'middle_name', 'last_name'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', e.id)
          .where('id', '=', req.spentBy.personId)
          .executeTakeFirst();
        if (!p) throw notFound('Person');
        spent = { spent_by: 'person', spent_by_person_id: p.id, spent_by_name: personName(p) };
      }
      const partyIds = [...new Set(req.attendees.flatMap((a) => ('partyId' in a ? [a.partyId] : [])))];
      if (partyIds.length) {
        const found = await trx
          .selectFrom('app.business_party')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', e.id)
          .where('id', 'in', partyIds)
          .execute();
        if (found.length !== partyIds.length) {
          throw unprocessable(
            'expense.attendee',
            'Choose attendees from this business’s customers and vendors',
          );
        }
      }
      const names = req.attendees.flatMap((a) => ('name' in a ? [a.name] : []));
      const values = {
        ...spent,
        attendee_names: names,
        attendee_party_ids: partyIds,
        business_purpose: req.businessPurpose || null,
        updated_by: ctx.userId,
      };
      if (current.version === 0) {
        await trx
          .insertInto('app.expense_detail')
          .values({
            workspace_id: ctx.workspaceId,
            transaction_id: transactionId,
            entity_id: e.id,
            ...values,
          })
          .execute();
      } else {
        await trx
          .updateTable('app.expense_detail')
          .set(values)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('transaction_id', '=', transactionId)
          .execute();
      }
      return (await loadExpenseDetails(trx, ctx, [transactionId])).get(transactionId)!;
    });
  }

  /** Business spending by who spent: the owner, each person, and spending nobody was named on. */
  async byPerson(
    ctx: Ctx,
    q: { entityId: string; from?: CalendarDate; to?: CalendarDate },
  ): Promise<ExpensesByPersonDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, q.entityId);
      const today = todayOf(e);
      const from = q.from ?? calendarDate(`${today.slice(0, 4)}-01-01`);
      const to = q.to ?? today;
      const { rows } = await sql<{
        spent_by: 'owner' | 'person' | null;
        person_id: string | null;
        name: string | null;
        amount: string;
        n: number;
      }>`
        select d.spent_by, d.spent_by_person_id as person_id,
               case when d.spent_by = 'person' then max(d.spent_by_name) end as name,
               sum(p.functional_amount_minor)::text as amount, count(distinct t.id)::int as n
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
          join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
          left join app.expense_detail d on d.workspace_id = t.workspace_id and d.transaction_id = t.id
                                        and d.entity_id = p.entity_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${e.id}
           and a.type = 'expense' and p.entry_date between ${from} and ${to} and t.deleted_at is null
         group by d.spent_by, d.spent_by_person_id
        having sum(p.functional_amount_minor) <> 0`.execute(trx);
      const sorted = rows
        .map((r) => ({
          spentBy: r.spent_by,
          personId: r.person_id,
          name: r.name,
          amount: r.amount,
          count: r.n,
        }))
        .sort((a, b) =>
          BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0,
        );
      return {
        entityId: e.id,
        from,
        to,
        currency: asCurrencyCode(e.currency),
        rows: sorted,
        total: String(sorted.reduce((t, r) => t + BigInt(r.amount), 0n)),
      };
    });
  }
}
