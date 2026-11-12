import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import { asCurrencyCode, calendarDate, naturalBalance, nextStatementDate } from '@montra/domain';
import {
  CompleteReconciliationRequest,
  StartReconciliationRequest,
  ToggleClearedRequest,
  UndoReconciliationRequest,
  type ReconciliationDto,
  type ReconciliationHistoryDto,
} from '@montra/schemas';
import { z } from 'zod';
import {
  AuthGuard,
  Ctx,
  dbCtx,
  requireRecentAuth,
  WorkspaceGuard,
  type RequestContext,
} from '../auth/auth.js';
import { Db } from '../db/database.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';

type Ctx = { workspaceId: string; userId: string };

/** The payee of a balance adjustment posted on finishing (DE-12). */
export const ADJUSTMENT_PAYEE = 'Reconciliation adjustment';

/** Who may undo a reconciliation (DE-13): the owner, and an accountant (who may also close periods). */
const UNDO_ROLES = ['owner', 'accountant'] as const;

/**
 * Statement reconciliation (DE-08, DE-11..14; ADR-0039): tick cleared lines until the cleared balance equals the
 * statement's ending balance, then complete — lines become reconciled and their entries locked (edits then follow
 * DE-10). Each statement opens at the previous one's ending balance. A difference left can be booked as an adjustment;
 * the latest completed one can be undone, with a reason, by an owner or accountant.
 */
@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
export class ReconciliationController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
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
      // DE-11: statements follow one another, each opening at the last one's ending balance.
      const last = await this.lastCompleted(trx, c, account.id);
      if (last && req.statementDate <= last.statement_date)
        throw unprocessable(
          'reconciliation.statement_date_order',
          `The statement date must be after ${last.statement_date}, the last statement reconciled`,
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
          opening_balance_minor: last?.statement_balance_minor ?? 0n,
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
    const st = status ? parse(z.enum(['in_progress', 'completed', 'undone']), status) : undefined;
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

  /** DE-14: the account's reconciliation history, newest statement first, and what the next one starts with. */
  @Get('accounts/:accountId/reconciliations/history')
  async history(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
  ): Promise<ReconciliationHistoryDto> {
    const c = dbCtx(ctx);
    const id = parse(z.uuid(), accountId);
    return this.db.run(c, async (trx) => {
      const account = await this.ledger.accountRef(trx, c.workspaceId, id);
      const currency = asCurrencyCode(account.currency);
      const bank = await trx
        .selectFrom('app.bank_account')
        .select('statement_day')
        .where('workspace_id', '=', c.workspaceId)
        .where('ledger_account_id', '=', id)
        .executeTakeFirst();
      const rows = await trx
        .selectFrom('app.reconciliation as r')
        .leftJoin('app.app_user as cu', 'cu.id', 'r.created_by')
        .leftJoin('app.app_user as fu', 'fu.id', 'r.completed_by')
        .leftJoin('app.app_user as uu', 'uu.id', 'r.undone_by')
        .select([
          'r.id',
          'r.statement_date',
          'r.statement_balance_minor',
          'r.opening_balance_minor',
          'r.status',
          'r.created_at',
          'r.created_by',
          'r.completed_at',
          'r.completed_by',
          'r.adjustment_transaction_id',
          'r.adjustment_minor',
          'r.undone_at',
          'r.undone_by',
          'r.undo_reason',
          'cu.display_name as created_name',
          'fu.display_name as completed_name',
          'uu.display_name as undone_name',
        ])
        .where('r.workspace_id', '=', c.workspaceId)
        .where('r.ledger_account_id', '=', id)
        .orderBy('r.statement_date', 'desc')
        .orderBy('r.created_at', 'desc')
        .limit(240)
        .execute();
      const last = await this.lastCompleted(trx, c, id);
      const mayUndo = (UNDO_ROLES as readonly string[]).includes(ctx.role ?? '');
      const actor = (userId: string | null, name: string | null) =>
        userId ? { userId, name: name ?? '' } : null;
      const money = (v: bigint | string) => ({ amount: BigInt(v).toString(), currency });
      return {
        accountId: id,
        reconciledThrough: last?.statement_date ?? null,
        next: {
          statementDate: last
            ? nextStatementDate(calendarDate(last.statement_date), bank?.statement_day ?? null)
            : null,
          openingBalance: money(last?.statement_balance_minor ?? 0n),
        },
        inProgressId: rows.find((r) => r.status === 'in_progress')?.id ?? null,
        items: rows.map((r) => ({
          id: r.id,
          statementDate: r.statement_date,
          openingBalance: money(r.opening_balance_minor),
          statementBalance: money(r.statement_balance_minor),
          status: r.status,
          startedAt: r.created_at.toISOString(),
          startedBy: actor(r.created_by, r.created_name),
          completedAt: r.completed_at?.toISOString() ?? null,
          completedBy: actor(r.completed_by, r.completed_name),
          adjustment:
            r.adjustment_transaction_id && r.adjustment_minor !== null
              ? { transactionId: r.adjustment_transaction_id, amount: money(r.adjustment_minor) }
              : null,
          undoneAt: r.undone_at?.toISOString() ?? null,
          undoneBy: actor(r.undone_by, r.undone_name),
          undoReason: r.undo_reason,
          canUndo: mayUndo && r.id === last?.id,
        })),
      };
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
  async complete(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReconciliationDto> {
    const req = parse(CompleteReconciliationRequest, body ?? {});
    const c = dbCtx(ctx);
    return this.db.run(c, async (trx) => {
      let dto = await this.load(trx, c, parse(z.uuid(), id));
      if (dto.status !== 'in_progress')
        throw new AppError(409, 'reconciliation.completed', 'This reconciliation is completed');
      const r = await this.row(trx, c, dto.id);
      if (dto.difference.amount !== '0' && req.adjustment) {
        // DE-12: book the difference on the statement date, cleared, so it's reconciled with the rest below.
        const account = await this.ledger.accountRef(trx, c.workspaceId, r.ledger_account_id);
        const difference = BigInt(dto.difference.amount);
        const signed = account.type === 'asset' ? difference : -difference;
        const categoryId =
          req.adjustment.categoryId ?? (await this.adjustmentCategory(trx, c, account.entityId, signed));
        const transactionId = await this.transactions.createInTrx(trx, c, {
          date: r.statement_date,
          accountId: account.id,
          amount: { amount: signed.toString(), currency: account.currency },
          payee: ADJUSTMENT_PAYEE,
          description: ADJUSTMENT_PAYEE,
          categoryId,
          source: 'manual',
          reviewState: 'reviewed',
          clearedAccountId: account.id,
          categorization: {
            step: 'user',
            confidence: 1,
            explanation: 'Chosen by you',
            ruleId: null,
            suggested: null,
          },
        });
        await trx
          .updateTable('app.reconciliation')
          .set({ adjustment_transaction_id: transactionId, adjustment_minor: difference })
          .where('workspace_id', '=', c.workspaceId)
          .where('id', '=', r.id)
          .execute();
        dto = await this.load(trx, c, r.id);
      }
      if (dto.difference.amount !== '0') {
        throw new AppError(
          422,
          'reconciliation.difference',
          `The cleared balance differs from the statement by ${dto.difference.amount} minor units`,
        );
      }
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
        .set({
          status: 'completed',
          completed_at: new Date(),
          completed_by: c.userId,
          deposits_minor: BigInt(dto.clearedDeposits.amount),
          payments_minor: BigInt(dto.clearedPayments.amount),
        })
        .where('workspace_id', '=', c.workspaceId)
        .where('id', '=', r.id)
        .execute();
      return this.load(trx, c, r.id);
    });
  }

  /**
   * DE-13: undoes the account's latest completed reconciliation. Its lines go back to cleared and their entries unlock,
   * unless another reconciliation still holds a line of the entry. Refused in a closed period. The audit log keeps the
   * reason. Only this path can un-reconcile a line: it sets `app.allow_unreconcile` for its transaction (migration 0039).
   */
  @Post('reconciliations/:id/undo')
  @HttpCode(200)
  async undo(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReconciliationDto> {
    requireRole(ctx, ...UNDO_ROLES);
    requireRecentAuth(ctx);
    const { reason } = parse(UndoReconciliationRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, async (trx) => {
      const r = await this.row(trx, c, parse(z.uuid(), id));
      if (r.status !== 'completed')
        throw new AppError(
          409,
          'reconciliation.not_completed',
          'Only a completed reconciliation can be undone',
        );
      const last = await this.lastCompleted(trx, c, r.ledger_account_id);
      if (last?.id !== r.id)
        throw new AppError(
          409,
          'reconciliation.not_latest',
          "Only the account's latest reconciliation can be undone. Undo the later ones first",
        );
      const lines = await trx
        .selectFrom('app.posting as p')
        .innerJoin('app.journal_entry as je', (j) =>
          j.onRef('je.workspace_id', '=', 'p.workspace_id').onRef('je.id', '=', 'p.journal_entry_id'),
        )
        .select([
          'p.journal_entry_id',
          sql<boolean>`je.entry_date <= coalesce(app.locked_through(je.workspace_id, je.entity_id), '-infinity'::date)`.as(
            'closed',
          ),
        ])
        .where('p.workspace_id', '=', c.workspaceId)
        .where('p.reconciliation_id', '=', r.id)
        .execute();
      if (lines.some((l) => l.closed))
        throw new AppError(
          409,
          'reconciliation.period_closed',
          'Some of its lines are in a closed period. Reopen the period first',
        );

      await sql`select set_config('app.allow_unreconcile', 'on', true)`.execute(trx);
      await trx
        .updateTable('app.posting')
        .set({ cleared: 'cleared', reconciliation_id: null })
        .where('workspace_id', '=', c.workspaceId)
        .where('reconciliation_id', '=', r.id)
        .execute();
      const entries = [...new Set(lines.map((l) => l.journal_entry_id))];
      if (entries.length) {
        // An entry stays locked while another statement still reconciles one of its lines (a transfer between two
        // reconciled accounts).
        const held = await trx
          .selectFrom('app.posting')
          .select('journal_entry_id')
          .distinct()
          .where('workspace_id', '=', c.workspaceId)
          .where('journal_entry_id', 'in', entries)
          .where('cleared', '=', 'reconciled')
          .execute();
        const keep = new Set(held.map((h) => h.journal_entry_id));
        const release = entries.filter((e) => !keep.has(e));
        if (release.length) {
          await trx
            .updateTable('app.journal_entry')
            .set({ locked: false })
            .where('workspace_id', '=', c.workspaceId)
            .where('id', 'in', release)
            .where('locked', '=', true)
            .execute();
        }
      }
      await sql`select set_config('app.allow_unreconcile', '', true)`.execute(trx);

      await trx
        .updateTable('app.reconciliation')
        .set({ status: 'undone', undone_at: new Date(), undone_by: c.userId, undo_reason: reason })
        .where('workspace_id', '=', c.workspaceId)
        .where('id', '=', r.id)
        .execute();
      // A statement already started after this one now opens where the chain ends again.
      const previous = await this.lastCompleted(trx, c, r.ledger_account_id);
      await trx
        .updateTable('app.reconciliation')
        .set({ opening_balance_minor: previous?.statement_balance_minor ?? 0n })
        .where('workspace_id', '=', c.workspaceId)
        .where('ledger_account_id', '=', r.ledger_account_id)
        .where('status', '=', 'in_progress')
        .execute();
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: c.workspaceId,
          actor_user_id: c.userId,
          action: 'reconciliation.undo',
          subject_type: 'reconciliation',
          subject_id: r.id,
          diff: JSON.stringify({
            reason,
            accountId: r.ledger_account_id,
            statementDate: r.statement_date,
            lines: lines.length,
          }),
        })
        .execute();
      return this.load(trx, c, r.id);
    });
  }

  private lastCompleted(trx: Trx, c: Ctx, accountId: string) {
    return trx
      .selectFrom('app.reconciliation')
      .select(['id', 'statement_date', 'statement_balance_minor'])
      .where('workspace_id', '=', c.workspaceId)
      .where('ledger_account_id', '=', accountId)
      .where('status', '=', 'completed')
      .orderBy('statement_date', 'desc')
      .orderBy('completed_at', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** DE-12: an adjustment's category unless another is picked: the books' Uncategorized income or expense. */
  private async adjustmentCategory(trx: Trx, c: Ctx, entityId: string, signed: bigint): Promise<string> {
    const resolver = await this.ledger.resolver(trx, c.workspaceId);
    return resolver.systemAccount(entityId, signed > 0n ? 'uncategorized_income' : 'uncategorized_expense')
      .id;
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
    const currency = asCurrencyCode(account.currency);
    const money = (v: bigint) => ({ amount: v.toString(), currency });
    const natural = (v: bigint | string | null | undefined) => naturalBalance(account.type, BigInt(v ?? 0n));
    const opening = BigInt(r.opening_balance_minor);
    const previous = await trx
      .selectFrom('app.reconciliation')
      .select('statement_date')
      .where('workspace_id', '=', c.workspaceId)
      .where('ledger_account_id', '=', r.ledger_account_id)
      .where('status', '=', 'completed')
      .where('statement_date', '<', r.statement_date)
      .where('id', '<>', r.id)
      .orderBy('statement_date', 'desc')
      .limit(1)
      .executeTakeFirst();
    type Line = {
      id: string;
      transaction_id: string | null;
      entry_date: string;
      description: string;
      amount_minor: bigint;
      cleared: 'uncleared' | 'cleared' | 'reconciled';
    };
    // An undone one no longer holds any line.
    const lines: Line[] =
      r.status === 'undone'
        ? []
        : (
            await sql<Line>`
      select p.id, je.transaction_id, p.entry_date, coalesce(nullif(t.payee_raw, ''), t.description, je.description) as description,
             p.amount_minor, p.cleared
        from app.posting p
        join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
        left join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
       where p.workspace_id = ${c.workspaceId} and p.ledger_account_id = ${r.ledger_account_id}
         and p.entry_date <= ${r.statement_date}
         and (p.cleared <> 'reconciled' or p.reconciliation_id = ${r.id})
       order by p.entry_date, je.posted_at, p.line_no`.execute(trx)
          ).rows;

    let deposits = 0n;
    let payments = 0n;
    let cleared: bigint;
    let chainBreak: ReconciliationDto['chainBreak'] = null;
    if (r.status === 'in_progress') {
      for (const l of lines) {
        if (l.cleared === 'uncleared') continue;
        const n = natural(l.amount_minor);
        if (n > 0n) deposits += n;
        else payments -= n;
      }
      const { rows: totals } = await sql<{ cleared: bigint | null }>`
        select sum(amount_minor)::bigint as cleared from app.posting
         where workspace_id = ${c.workspaceId} and ledger_account_id = ${r.ledger_account_id}
           and entry_date <= ${r.statement_date} and cleared in ('cleared', 'reconciled')`.execute(trx);
      cleared = natural(totals[0]?.cleared);
      // DE-11: the lines reconciled up to the previous statement should still add up to where this one opens.
      if (previous) {
        const { rows: held } = await sql<{ total: bigint | null }>`
          select sum(amount_minor)::bigint as total from app.posting
           where workspace_id = ${c.workspaceId} and ledger_account_id = ${r.ledger_account_id}
             and entry_date <= ${previous.statement_date} and cleared = 'reconciled'`.execute(trx);
        const reconciled = natural(held[0]?.total);
        if (reconciled !== opening) chainBreak = { reconciledBalance: money(reconciled) };
      }
    } else {
      // Completed or undone: the figures it closed with, at no difference.
      deposits = BigInt(r.deposits_minor ?? 0n);
      payments = BigInt(r.payments_minor ?? 0n);
      cleared = BigInt(r.statement_balance_minor);
    }
    const difference = BigInt(r.statement_balance_minor) - cleared;
    const adjustmentCategoryId =
      r.status === 'in_progress' && difference !== 0n
        ? await this.adjustmentCategory(
            trx,
            c,
            account.entityId,
            account.type === 'asset' ? difference : -difference,
          )
        : null;
    return {
      id: r.id,
      accountId: r.ledger_account_id,
      statementDate: r.statement_date,
      statementBalance: money(BigInt(r.statement_balance_minor)),
      openingBalance: money(opening),
      previousStatementDate: previous?.statement_date ?? null,
      clearedDeposits: money(deposits),
      clearedPayments: money(payments),
      clearedBalance: money(cleared),
      difference: money(difference),
      chainBreak,
      adjustmentCategoryId,
      adjustment:
        r.adjustment_transaction_id && r.adjustment_minor !== null
          ? { transactionId: r.adjustment_transaction_id, amount: money(BigInt(r.adjustment_minor)) }
          : null,
      status: r.status,
      lines: lines.map((l) => ({
        postingId: l.id,
        transactionId: l.transaction_id,
        date: l.entry_date,
        description: l.description,
        amount: natural(l.amount_minor).toString(),
        cleared: l.cleared,
      })),
      completedAt: r.completed_at?.toISOString() ?? null,
    };
  }
}
