import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { asCurrencyCode, validateEntry, type JournalEntryDraft } from '@montra/domain';
import { AuditedNoteRequest, ManualJournalRequest, PeriodLockRequest } from '@montra/schemas';
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
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { notFound, unprocessable } from '../common/errors.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { LedgerService } from '../ledger/ledger.service.js';

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class JournalsController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /** Journal view of any entry (DE-07). */
  @Get('journal-entries/:entryId')
  async get(@Ctx() ctx: RequestContext, @Param('entryId') entryId: string) {
    const id = parse(z.uuid(), entryId);
    return this.db.run(dbCtx(ctx), async (trx) => {
      const entry = await trx
        .selectFrom('app.journal_entry')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!entry) throw notFound('Journal entry');
      const postings = await trx
        .selectFrom('app.posting as p')
        .innerJoin('app.ledger_account as a', 'a.id', 'p.ledger_account_id')
        .select([
          'p.line_no',
          'p.ledger_account_id',
          'a.name',
          'a.type',
          'p.amount_minor',
          'p.currency',
          'p.member_id',
          'p.memo',
          'p.cleared',
        ])
        .where('p.workspace_id', '=', ctx.workspaceId!)
        .where('p.journal_entry_id', '=', id)
        .orderBy('p.line_no')
        .execute();
      return {
        id: entry.id,
        entityId: entry.entity_id,
        transactionId: entry.transaction_id,
        date: entry.entry_date,
        kind: entry.kind,
        description: entry.description,
        locked: entry.locked,
        reversesEntryId: entry.reverses_entry_id,
        postings: postings.map((p) => ({
          lineNo: p.line_no,
          accountId: p.ledger_account_id,
          accountName: p.name,
          accountType: p.type,
          debit: p.amount_minor > 0n ? p.amount_minor.toString() : null,
          credit: p.amount_minor < 0n ? (-p.amount_minor).toString() : null,
          currency: p.currency,
          memberId: p.member_id,
          memo: p.memo,
          cleared: p.cleared,
        })),
      };
    });
  }

  /** Manual journal entries for advanced users and accountants (DE-07): opening balances, depreciation, … */
  @Post('journal-entries')
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRole(ctx, 'owner', 'partner', 'accountant');
    const req = parse(ManualJournalRequest, body);
    const [entryId] = await this.db.run(dbCtx(ctx), async (trx) => {
      const entity = await trx
        .selectFrom('app.entity')
        .select(['id', 'functional_currency'])
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('id', '=', req.entityId)
        .executeTakeFirst();
      if (!entity) throw notFound('Entity');
      const postings: JournalEntryDraft['postings'][number][] = [];
      for (const [i, line] of req.lines.entries()) {
        const account = await this.ledger.accountRef(trx, ctx.workspaceId!, line.accountId);
        if (account.currency !== entity.functional_currency) {
          throw unprocessable(
            'fx.rate_required',
            'Manual journals currently post in the entity currency only',
          );
        }
        const amount = line.debit !== undefined ? BigInt(line.debit) : -BigInt(line.credit!);
        if (amount === 0n) throw unprocessable('ledger.zero_posting', `Line ${i + 1} has a zero amount`);
        postings.push({
          lineNo: i + 1,
          accountId: account.id,
          accountEntityId: account.entityId,
          currency: account.currency,
          amount,
          functionalAmount: amount,
          fxRate: null,
          memberId: line.memberId ?? null,
          memo: line.memo ?? null,
        });
      }
      const draft: JournalEntryDraft = {
        entityId: entity.id,
        functionalCurrency: asCurrencyCode(entity.functional_currency),
        entryDate: req.date,
        kind: req.kind,
        description: req.description,
        postings,
      };
      validateEntry(draft);
      return this.ledger.post(trx, dbCtx(ctx), null, [draft]);
    });
    return this.get(ctx, entryId!);
  }

  /** Close the books through a date for one entity (DE-09). */
  @Put('entities/:entityId/period-lock')
  async lock(@Ctx() ctx: RequestContext, @Param('entityId') entityId: string, @Body() body: unknown) {
    requireRole(ctx, 'owner', 'accountant');
    const req = parse(PeriodLockRequest, body);
    const id = parse(z.uuid(), entityId);
    await this.db.run(dbCtx(ctx), async (trx) => {
      const existing = await trx
        .selectFrom('app.period_lock')
        .select('locked_through')
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('entity_id', '=', id)
        .executeTakeFirst();
      await trx
        .insertInto('app.period_lock')
        .values({
          workspace_id: ctx.workspaceId!,
          entity_id: id,
          locked_through: req.lockedThrough,
          locked_by: ctx.user.id,
          note: req.note ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'entity_id']).doUpdateSet({
            locked_through: req.lockedThrough,
            locked_by: ctx.user.id,
            locked_at: new Date(),
            note: req.note ?? null,
          }),
        )
        .execute();
      await trx
        .insertInto('app.period_lock_event')
        .values({
          workspace_id: ctx.workspaceId!,
          entity_id: id,
          action: existing ? 'relock' : 'lock',
          locked_through: req.lockedThrough,
          actor_user_id: ctx.user.id,
          note: req.note ?? null,
        })
        .execute();
    });
    return { entityId: id, lockedThrough: req.lockedThrough };
  }

  /** Re-open the books (owner only, recent re-authentication, recorded with a note). */
  @Delete('entities/:entityId/period-lock')
  async unlock(@Ctx() ctx: RequestContext, @Param('entityId') entityId: string, @Body() body: unknown) {
    requireRole(ctx, 'owner');
    requireRecentAuth(ctx);
    const { note } = parse(AuditedNoteRequest, body);
    const id = parse(z.uuid(), entityId);
    await this.db.run(dbCtx(ctx), async (trx) => {
      const res = await trx
        .deleteFrom('app.period_lock')
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('entity_id', '=', id)
        .executeTakeFirst();
      if (res.numDeletedRows === 0n) throw notFound('Period lock');
      await trx
        .insertInto('app.period_lock_event')
        .values({
          workspace_id: ctx.workspaceId!,
          entity_id: id,
          action: 'unlock',
          actor_user_id: ctx.user.id,
          note,
        })
        .execute();
    });
    return { entityId: id, lockedThrough: null };
  }

  @Get('entities/:entityId/period-lock/history')
  async history(@Ctx() ctx: RequestContext, @Param('entityId') entityId: string) {
    const rows = await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .selectFrom('app.period_lock_event')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('entity_id', '=', parse(z.uuid(), entityId))
        .orderBy('id', 'desc')
        .execute(),
    );
    return {
      data: rows.map((r) => ({
        action: r.action,
        lockedThrough: r.locked_through,
        actorUserId: r.actor_user_id,
        note: r.note,
        at: r.at,
      })),
    };
  }

  /** Audited unlock of a reconciled entry (DE-08): the only path that bypasses the lock guard. */
  @Post('journal-entries/:entryId/unlock')
  async unlockEntry(@Ctx() ctx: RequestContext, @Param('entryId') entryId: string, @Body() body: unknown) {
    requireRole(ctx, 'owner');
    requireRecentAuth(ctx);
    const { note } = parse(AuditedNoteRequest, body);
    const id = parse(z.uuid(), entryId);
    await this.db.run({ ...dbCtx(ctx), allowLockedEdit: true }, async (trx) => {
      const res = await trx
        .updateTable('app.journal_entry')
        .set({ locked: false })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('id', '=', id)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw notFound('Journal entry');
      await trx
        .updateTable('app.posting')
        .set({ cleared: 'cleared', reconciliation_id: null })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('journal_entry_id', '=', id)
        .where('cleared', '=', 'reconciled')
        .execute();
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ctx.workspaceId!,
          actor_user_id: ctx.user.id,
          action: 'journal_entry.unlock',
          subject_type: 'journal_entry',
          subject_id: id,
          diff: JSON.stringify({ note }),
        })
        .execute();
    });
    return this.get(ctx, id);
  }

  /** Full audit log (NFR-03), owners only via RLS. */
  @Get('audit-log')
  async audit(
    @Ctx() ctx: RequestContext,
    @Query('subjectId') subjectId?: string,
    @Query('limit') limit?: string,
  ) {
    requireRole(ctx, 'owner');
    const rows = await this.db.run(dbCtx(ctx), (trx) => {
      let q = trx
        .selectFrom('app.audit_log')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId!)
        .orderBy('id', 'desc')
        .limit(parse(z.coerce.number().int().min(1).max(500).default(100), limit));
      if (subjectId) q = q.where('subject_id', '=', subjectId);
      return q.execute();
    });
    return {
      data: rows.map((r) => ({
        id: r.id.toString(),
        at: r.at,
        actorUserId: r.actor_user_id,
        actorType: r.actor_type,
        action: r.action,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        diff: r.diff,
      })),
    };
  }
}
