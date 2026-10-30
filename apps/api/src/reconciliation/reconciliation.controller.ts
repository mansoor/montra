import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import { asCurrencyCode, naturalBalance } from '@montra/domain';
import { StartReconciliationRequest, ToggleClearedRequest, type ReconciliationDto } from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { Db } from '../db/database.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { parse } from '../common/zod.js';
import { LedgerService } from '../ledger/ledger.service.js';

type Ctx = { workspaceId: string; userId: string };

/**
 * Statement reconciliation (DE-08): tick cleared lines until the cleared balance equals the statement's
 * ending balance, then complete — lines become reconciled and their entries locked (edits then follow DE-10).
 */
@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
export class ReconciliationController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  @Post('accounts/:accountId/reconciliations')
  async start(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<ReconciliationDto> {
    const req = parse(StartReconciliationRequest, body);
    const c = dbCtx(ctx);
    const id = newId();
    await this.db.run(c, async (trx) => {
      const account = await this.ledger.accountRef(trx, c.workspaceId, parse(z.uuid(), accountId));
      if (account.type !== 'asset' && account.type !== 'liability')
        throw unprocessable('account.not_a_bank_account', 'Only balance accounts are reconciled');
      if (req.statementBalance.currency !== account.currency)
        throw unprocessable('currency.mismatch', `Balance must be in ${account.currency}`);
      const open = await trx
        .selectFrom('app.reconciliation')
        .select('id')
        .where('workspace_id', '=', c.workspaceId)
        .where('ledger_account_id', '=', account.id)
        .where('status', '=', 'in_progress')
        .executeTakeFirst();
      if (open)
        throw new AppError(
          409,
          'reconciliation.in_progress',
          'Finish the reconciliation already in progress for this account',
        );
      await trx
        .insertInto('app.reconciliation')
        .values({
          workspace_id: c.workspaceId,
          id,
          entity_id: account.entityId,
          ledger_account_id: account.id,
          statement_date: req.statementDate,
          statement_balance_minor: BigInt(req.statementBalance.amount),
          created_by: c.userId,
        })
        .execute();
    });
    return this.get(ctx, id);
  }

  /** An account's reconciliations, newest first; `?status=in_progress` finds one to resume. */
  @Get('accounts/:accountId/reconciliations')
  async list(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Query('status') status?: string,
  ) {
    const c = dbCtx(ctx);
    const st = status ? parse(z.enum(['in_progress', 'completed']), status) : undefined;
    return this.db.run(c, async (trx) => {
      const rows = await trx
        .selectFrom('app.reconciliation')
        .select('id')
        .where('workspace_id', '=', c.workspaceId)
        .where('ledger_account_id', '=', parse(z.uuid(), accountId))
        .$if(Boolean(st), (q) => q.where('status', '=', st!))
        .orderBy('created_at', 'desc')
        .limit(24)
        .execute();
      const data: ReconciliationDto[] = [];
      for (const r of rows) data.push(await this.load(trx, c, r.id));
      return { data };
    });
  }

  @Get('reconciliations/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ReconciliationDto> {
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.load(trx, c, parse(z.uuid(), id)));
  }

  @Post('reconciliations/:id/cleared')
  @HttpCode(200)
  async toggle(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReconciliationDto> {
    const req = parse(ToggleClearedRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, async (trx) => {
      const r = await this.row(trx, c, parse(z.uuid(), id));
      if (r.status !== 'in_progress')
        throw new AppError(409, 'reconciliation.completed', 'This reconciliation is completed');
      const scope = (ids: string[]) =>
        trx
          .updateTable('app.posting')
          .where('workspace_id', '=', c.workspaceId)
          .where('ledger_account_id', '=', r.ledger_account_id)
          .where('entry_date', '<=', r.statement_date)
          .where('cleared', '<>', 'reconciled')
          .where('id', 'in', ids);
      if (req.clear.length) await scope(req.clear).set({ cleared: 'cleared' }).execute();
      if (req.unclear.length) await scope(req.unclear).set({ cleared: 'uncleared' }).execute();
      return this.load(trx, c, r.id);
    });
  }

  @Post('reconciliations/:id/complete')
  @HttpCode(200)
  async complete(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ReconciliationDto> {
    const c = dbCtx(ctx);
    return this.db.run(c, async (trx) => {
      const dto = await this.load(trx, c, parse(z.uuid(), id));
      if (dto.status !== 'in_progress')
        throw new AppError(409, 'reconciliation.completed', 'This reconciliation is completed');
      if (dto.difference.amount !== '0') {
        throw new AppError(
          422,
          'reconciliation.difference',
          `The cleared balance differs from the statement by ${dto.difference.amount} minor units`,
        );
      }
      const r = await this.row(trx, c, dto.id);
      const lines = await trx
        .updateTable('app.posting')
        .set({ cleared: 'reconciled', reconciliation_id: r.id })
        .where('workspace_id', '=', c.workspaceId)
        .where('ledger_account_id', '=', r.ledger_account_id)
        .where('entry_date', '<=', r.statement_date)
        .where('cleared', '=', 'cleared')
        .returning('journal_entry_id')
        .execute();
      const entries = [...new Set(lines.map((l) => l.journal_entry_id))];
      if (entries.length) {
        await trx
          .updateTable('app.journal_entry')
          .set({ locked: true })
          .where('workspace_id', '=', c.workspaceId)
          .where('id', 'in', entries)
          .where('locked', '=', false)
          .execute();
      }
      await trx
        .updateTable('app.reconciliation')
        .set({ status: 'completed', completed_at: new Date(), completed_by: c.userId })
        .where('workspace_id', '=', c.workspaceId)
        .where('id', '=', r.id)
        .execute();
      return this.load(trx, c, r.id);
    });
  }

  private async row(trx: Trx, c: Ctx, id: string) {
    const r = await trx
      .selectFrom('app.reconciliation')
      .selectAll()
      .where('workspace_id', '=', c.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Reconciliation');
    return r;
  }

  private async load(trx: Trx, c: Ctx, id: string): Promise<ReconciliationDto> {
    const r = await this.row(trx, c, id);
    const account = await this.ledger.accountRef(trx, c.workspaceId, r.ledger_account_id);
    const { rows: totals } = await sql<{ cleared: bigint | null }>`
      select sum(amount_minor)::bigint as cleared from app.posting
       where workspace_id = ${c.workspaceId} and ledger_account_id = ${r.ledger_account_id}
         and entry_date <= ${r.statement_date} and cleared in ('cleared', 'reconciled')`.execute(trx);
    const cleared = naturalBalance(account.type, BigInt(totals[0]?.cleared ?? 0n));
    const lines = await sql<{
      id: string;
      transaction_id: string | null;
      entry_date: string;
      description: string;
      amount_minor: bigint;
      cleared: 'uncleared' | 'cleared' | 'reconciled';
    }>`
      select p.id, je.transaction_id, p.entry_date, coalesce(nullif(t.payee_raw, ''), t.description, je.description) as description,
             p.amount_minor, p.cleared
        from app.posting p
        join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
        left join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
       where p.workspace_id = ${c.workspaceId} and p.ledger_account_id = ${r.ledger_account_id}
         and p.entry_date <= ${r.statement_date}
         and (p.cleared <> 'reconciled' or p.reconciliation_id = ${r.id})
       order by p.entry_date, je.posted_at, p.line_no`.execute(trx);
    const currency = asCurrencyCode(account.currency);
    return {
      id: r.id,
      accountId: r.ledger_account_id,
      statementDate: r.statement_date,
      statementBalance: { amount: r.statement_balance_minor.toString(), currency },
      clearedBalance: { amount: cleared.toString(), currency },
      difference: { amount: (BigInt(r.statement_balance_minor) - cleared).toString(), currency },
      status: r.status,
      lines: lines.rows.map((l) => ({
        postingId: l.id,
        transactionId: l.transaction_id,
        date: l.entry_date,
        description: l.description,
        amount: naturalBalance(account.type, BigInt(l.amount_minor)).toString(),
        cleared: l.cleared,
      })),
      completedAt: r.completed_at?.toISOString() ?? null,
    };
  }
}
