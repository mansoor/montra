/**
 * Credit cards and lines of credit (ADR-0026): the latest statement, what's still due on it, and what the payment rule pays.
 * Read from the ledger on request: nothing about a statement is stored but the account's days and rule.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  accountProfile,
  afterClose,
  kindsWhere,
  rulePayment,
  statementCycle,
  statementDue,
  todayIn,
  utilizationBps,
  type CalendarDate,
  type PayRule,
} from '@montra/domain';
import type { CardStatementDto } from '@montra/schemas';
import { notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';

type Ctx = { workspaceId: string; userId: string };

const STATEMENT_KINDS = kindsWhere((p) => p.statement);

@Injectable()
export class CardsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async today(trx: Trx, ctx: Ctx): Promise<CalendarDate> {
    const w = await trx
      .selectFrom('app.workspace')
      .select('time_zone')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    return todayIn(w.time_zone);
  }

  /** Every card and line of credit with its days set, or one of them. */
  async statements(ctx: Ctx, accountId?: string): Promise<CardStatementDto[]> {
    return this.db.run(ctx, async (trx) => {
      const out = await this.statementsIn(trx, ctx, { accountId });
      if (accountId && !out.length) {
        const exists = await trx
          .selectFrom('app.bank_account')
          .select('kind')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('ledger_account_id', '=', accountId)
          .executeTakeFirst();
        if (!exists) throw notFound('Account');
        if (!accountProfile(exists.kind).statement) {
          throw unprocessable('card.kind', 'Only a card or line of credit has a statement');
        }
      }
      return out;
    });
  }

  async statementsIn(
    trx: Trx,
    ctx: Ctx,
    opts: { accountId?: string; entityId?: string | null } = {},
  ): Promise<CardStatementDto[]> {
    const rows = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', (j) =>
        j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
      )
      .select([
        'a.id',
        'a.name',
        'a.currency',
        'a.entity_id',
        'b.statement_day',
        'b.due_day',
        'b.min_payment_minor',
        'b.credit_limit_minor',
        'b.pay_from_account_id',
        'b.pay_rule',
        'b.pay_fixed_minor',
      ])
      .where('b.workspace_id', '=', ctx.workspaceId)
      .where('b.kind', 'in', STATEMENT_KINDS)
      .where('b.statement_day', 'is not', null)
      .where('b.due_day', 'is not', null)
      .where('a.archived_at', 'is', null)
      .$if(!!opts.accountId, (q) => q.where('a.id', '=', opts.accountId!))
      .$if(!!opts.entityId, (q) => q.where('a.entity_id', '=', opts.entityId!))
      .orderBy('a.name')
      .execute();
    if (!rows.length) return [];
    const today = await this.today(trx, ctx);
    const out: CardStatementDto[] = [];
    for (const r of rows) {
      const cycle = statementCycle(today, r.statement_day!, r.due_day!);
      // Debits reduce what's owed on a liability: the payments and refunds since the statement closed.
      const { rows: sums } = await sql<{ at_close: string; now: string; paid: string }>`
        select coalesce(sum(amount_minor) filter (where entry_date <= ${cycle.lastClose}), 0)::text as at_close,
               coalesce(sum(amount_minor), 0)::text as now,
               coalesce(sum(amount_minor) filter (where entry_date >= ${afterClose(cycle.lastClose)} and amount_minor > 0), 0)::text as paid
          from app.posting
         where workspace_id = ${ctx.workspaceId} and ledger_account_id = ${r.id} and entry_date <= ${today}`.execute(
        trx,
      );
      const statementBalance = -BigInt(sums[0]!.at_close);
      const owed = -BigInt(sums[0]!.now);
      const paidSince = BigInt(sums[0]!.paid);
      const d = statementDue(
        statementBalance > 0n ? statementBalance : 0n,
        paidSince,
        r.min_payment_minor !== null ? BigInt(r.min_payment_minor) : null,
      );
      const limit = r.credit_limit_minor !== null ? BigInt(r.credit_limit_minor) : null;
      const planned =
        r.pay_rule && r.pay_from_account_id
          ? rulePayment(
              r.pay_rule as PayRule,
              d,
              owed,
              r.pay_fixed_minor !== null ? BigInt(r.pay_fixed_minor) : null,
            )
          : 0n;
      // What was charged since the close is what the next statement will hold, if nothing else changes.
      const since = owed - (statementBalance - paidSince);
      out.push({
        accountId: r.id,
        name: r.name,
        currency: r.currency,
        ...cycle,
        statementBalance: String(statementBalance > 0n ? statementBalance : 0n),
        paidSince: String(paidSince),
        due: String(d.due),
        minimumDue: String(d.minimumDue),
        owed: String(owed),
        sinceStatement: String(since > 0n ? since : 0n),
        limit: limit === null ? null : String(limit),
        available: limit === null ? null : String(limit - owed),
        utilizationBps: utilizationBps(owed, limit),
        planned:
          r.pay_rule && r.pay_from_account_id && planned > 0n
            ? { date: cycle.dueDate, amount: String(planned), fromAccountId: r.pay_from_account_id }
            : null,
      });
    }
    return out;
  }
}
