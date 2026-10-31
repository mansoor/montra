import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import { asCurrencyCode, calendarDate, minorUnits } from '@montra/domain';
import { compileRule, RuleError, validateRule, type CompiledRule, type Subject } from '@montra/categorize';
import type {
  CreateRuleRequest,
  RuleConditions,
  RuleDto,
  RulePreviewDto,
  RuleSuggestionDto,
  UpdateRuleRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { JobQueue, type Job, type JobContext, Worker } from '../jobs/queue.js';
import { TransactionPoster, type TransactionSpec } from '../transactions/poster.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { Categorizer, ruleRecord } from './categorizer.service.js';

type Ctx = { workspaceId: string; userId: string };
type RuleActions = {
  categoryId?: string | null;
  memberId?: string | null;
  entityId?: string | null;
  tags?: string[];
  renamePayee?: string | null;
  markReviewed?: boolean;
};

const SCAN_CHUNK = 2000;
const APPLY_CHUNK = 200;
const SAMPLE = 20;

interface Candidate {
  id: string;
  subject: Subject;
  payee: string | null;
  date: string;
  amount: bigint;
  currency: string;
  categoryId: string | null;
  memberId: string | null;
  splits: number;
}

/** Rules CRUD, preview and "apply to existing" (UP-02, 04 §6), and rule suggestions (AI-05). */
@Injectable()
export class RulesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
    @Inject(Categorizer) private readonly categorizer: Categorizer,
  ) {}

  register(): void {
    this.worker.register('rules.apply', (job, jc) => this.applyJob(job, jc));
  }

  async list(trx: Trx, ctx: Ctx): Promise<RuleDto[]> {
    const rows = await trx
      .selectFrom('app.rule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .orderBy('priority')
      .orderBy('created_at')
      .execute();
    return rows.map(toRuleDto);
  }

  async get(trx: Trx, ctx: Ctx, id: string): Promise<RuleDto> {
    const r = await trx
      .selectFrom('app.rule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Rule');
    return toRuleDto(r);
  }

  async create(
    trx: Trx,
    ctx: Ctx,
    req: CreateRuleRequest,
    origin: 'user' | 'ai_suggested' | 'correction' = 'user',
  ): Promise<RuleDto> {
    await this.check(trx, ctx, req.conditions, req.actions);
    const r = await trx
      .insertInto('app.rule')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: req.entityId,
        name: req.name,
        scope: req.scope,
        priority: req.priority,
        conditions: JSON.stringify(req.conditions),
        actions: JSON.stringify(req.actions),
        origin,
        enabled: req.enabled,
        created_by: ctx.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRuleDto(r);
  }

  async update(trx: Trx, ctx: Ctx, id: string, req: UpdateRuleRequest, ifMatch?: string): Promise<RuleDto> {
    const cur = await trx
      .selectFrom('app.rule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!cur) throw notFound('Rule');
    if (ifMatch !== undefined && ifMatch.replace(/^W\//, '').replace(/"/g, '') !== `v${cur.version}`)
      throw new AppError(
        412,
        'version.mismatch',
        'The rule changed since you loaded it. Reload and try again.',
      );
    const conditions = (req.conditions ?? cur.conditions) as RuleConditions;
    const actions = (req.actions ?? cur.actions) as RuleActions;
    await this.check(trx, ctx, conditions, actions);
    const r = await trx
      .updateTable('app.rule')
      .set({
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.entityId !== undefined ? { entity_id: req.entityId } : {}),
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
        conditions: JSON.stringify(conditions),
        actions: JSON.stringify(actions),
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRuleDto(r);
  }

  async remove(trx: Trx, ctx: Ctx, id: string): Promise<void> {
    const res = await trx
      .deleteFrom('app.rule')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!res.numDeletedRows) throw notFound('Rule');
  }

  /** Validates the grammar and that referenced categories, members and entities exist and are usable. */
  private async check(trx: Trx, ctx: Ctx, conditions: RuleConditions, actions: RuleActions): Promise<void> {
    const errors = validateRule(conditions as never, actions);
    if (errors.length) throw unprocessable('rule.invalid', errors.join('; '));
    if (actions.categoryId) {
      const c = await trx
        .selectFrom('app.ledger_account')
        .select(['is_category', 'type'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', actions.categoryId)
        .executeTakeFirst();
      if (!c || !c.is_category || (c.type !== 'income' && c.type !== 'expense'))
        throw unprocessable('rule.category_invalid', 'Choose an income or expense category');
    }
    if (actions.memberId) {
      const m = await trx
        .selectFrom('app.family_member')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', actions.memberId)
        .executeTakeFirst();
      if (!m) throw unprocessable('rule.member_invalid', 'Unknown family member');
    }
  }

  // ----- Preview and apply to existing (UP-02) ------------------------------------------------------------

  async preview(
    trx: Trx,
    ctx: Ctx,
    conditions: RuleConditions,
    actions: RuleActions | undefined,
    entityId: string | null | undefined,
  ): Promise<RulePreviewDto> {
    const errors = validateRule(conditions as never, actions ?? { markReviewed: true });
    if (errors.length) throw unprocessable('rule.invalid', errors.join('; '));
    const rule = this.compile({
      id: 'preview',
      name: 'preview',
      conditions,
      actions: actions ?? {},
      entityId,
    });
    const out: RulePreviewDto = { matches: 0, changes: 0, skippedLocked: 0, sample: [] };
    for await (const chunk of this.scan(trx, ctx, entityId ?? null)) {
      for (const c of chunk) {
        if (!rule.matches(c.subject)) continue;
        out.matches++;
        const changes = wouldChange(c, actions ?? {});
        if (changes) {
          const protection = await this.poster.protection(trx, ctx, c.id);
          if (protection !== 'none') out.skippedLocked++;
          else out.changes++;
        }
        if (out.sample.length < SAMPLE)
          out.sample.push({
            transactionId: c.id,
            date: c.date,
            payee: c.payee,
            amount: { amount: c.amount.toString(), currency: asCurrencyCode(c.currency) },
            categoryId: c.categoryId,
          });
      }
    }
    return out;
  }

  async startApply(trx: Trx, ctx: Ctx, ruleId: string): Promise<string> {
    await this.get(trx, ctx, ruleId);
    return this.queue.enqueue(trx, { ...ctx, queue: 'ai', type: 'rules.apply', payload: { ruleId } });
  }

  /**
   * Applies a rule to existing transactions in chunks. Locked and reconciled entries are skipped (the
   * preview said how many); single-category transactions only. Each change is audited by the row trigger.
   */
  private async applyJob(job: Job, jc: JobContext): Promise<Record<string, unknown>> {
    if (!job.workspace_id || !job.created_by) throw new Error('Job without workspace or user');
    const ctx: Ctx = { workspaceId: job.workspace_id, userId: job.created_by };
    const { ruleId } = job.payload as { ruleId: string };
    const { rule, record } = await this.db.run(ctx, async (trx) => {
      const r = await trx
        .selectFrom('app.rule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', ruleId)
        .executeTakeFirstOrThrow();
      return { record: r, rule: compileRule(ruleRecord(r)) };
    });
    const actions = record.actions as RuleActions;
    const targets: Candidate[] = [];
    await this.db.run(ctx, async (trx) => {
      for await (const chunk of this.scan(trx, ctx, record.entity_id))
        for (const c of chunk) if (rule.matches(c.subject) && wouldChange(c, actions)) targets.push(c);
    });
    let changed = 0;
    let skipped = 0;
    for (let i = 0; i < targets.length; i += APPLY_CHUNK) {
      await jc.progress((i / Math.max(1, targets.length)) * 100).catch(() => {});
      await this.db.run(ctx, async (trx) => {
        for (const c of targets.slice(i, i + APPLY_CHUNK)) {
          if (c.splits !== 1 && actions.categoryId) {
            skipped++;
            continue;
          }
          if ((await this.poster.protection(trx, ctx, c.id)) !== 'none') {
            skipped++;
            continue;
          }
          const tags = actions.tags?.length ? await this.tagUnion(trx, ctx, c.id, actions.tags) : undefined;
          await this.transactions.updateInTrx(
            trx,
            ctx,
            c.id,
            {
              ...(actions.categoryId ? { categoryId: actions.categoryId } : {}),
              ...(actions.memberId !== undefined && actions.memberId !== null
                ? { memberId: actions.memberId }
                : {}),
              ...(actions.renamePayee ? { payee: actions.renamePayee } : {}),
              ...(tags ? { tags } : {}),
              ...(actions.markReviewed ? { reviewState: 'reviewed' as const } : {}),
            },
            undefined,
            {
              learn: false,
              categorization: {
                step: 'rule',
                confidence: 1,
                explanation: `Matched rule '${record.name}'`,
                ruleId: record.id,
                suggested: null,
              },
            },
          );
          changed++;
        }
      });
    }
    await this.db.run(ctx, (trx) =>
      sql`update app.rule set hit_count = hit_count + ${changed}, last_hit_at = now()
           where workspace_id = ${ctx.workspaceId} and id = ${ruleId}`.execute(trx),
    );
    return { matched: targets.length, changed, skipped };
  }

  private async tagUnion(trx: Trx, ctx: Ctx, id: string, add: string[]): Promise<string[]> {
    const rows = await trx
      .selectFrom('app.transaction_tag as tt')
      .innerJoin('app.tag as t', 't.id', 'tt.tag_id')
      .select('t.name')
      .where('tt.workspace_id', '=', ctx.workspaceId)
      .where('tt.transaction_id', '=', id)
      .execute();
    const names = rows.map((r) => r.name);
    for (const t of add) if (!names.some((n) => n.toLowerCase() === t.toLowerCase())) names.push(t);
    return names;
  }

  private compile(r: {
    id: string;
    name: string;
    conditions: RuleConditions;
    actions: RuleActions;
    entityId: string | null | undefined;
  }): CompiledRule {
    try {
      return compileRule({
        id: r.id,
        name: r.name,
        entityId: r.entityId ?? null,
        priority: 0,
        conditions: r.conditions as never,
        actions: r.actions,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      if (e instanceof RuleError) throw unprocessable('rule.invalid', e.message);
      throw e;
    }
  }

  /** Posted standard transactions as rule subjects, in keyset chunks (newest first). */
  private async *scan(trx: Trx, ctx: Ctx, entityId: string | null): AsyncGenerator<Candidate[]> {
    let after: { date: string; id: string } | null = null;
    for (;;) {
      let q = trx
        .selectFrom('app.transaction as t')
        .innerJoin('app.ledger_account as la', (j) =>
          j.on(sql<boolean>`la.workspace_id = t.workspace_id and la.id = (t.spec->>'accountId')::uuid`),
        )
        .select([
          't.id',
          't.txn_date',
          't.payee_raw',
          't.payee_key',
          't.description',
          't.raw_description',
          't.spec',
          't.primary_entity_id',
          'la.currency',
          'la.entity_id',
        ])
        .where('t.workspace_id', '=', ctx.workspaceId)
        .where('t.status', '=', 'posted')
        .where('t.deleted_at', 'is', null)
        .where(sql<boolean>`t.spec->>'type' = 'standard'`)
        .orderBy('t.txn_date', 'desc')
        .orderBy('t.id', 'desc')
        .limit(SCAN_CHUNK);
      if (entityId) q = q.where('t.primary_entity_id', '=', entityId);
      if (after) {
        const a = after;
        q = q.where((eb) =>
          eb.or([
            eb('t.txn_date', '<', a.date),
            eb.and([eb('t.txn_date', '=', a.date), eb('t.id', '<', a.id)]),
          ]),
        );
      }
      const rows = await q.execute();
      if (rows.length === 0) return;
      yield rows.map((r) => {
        const spec = r.spec as Extract<TransactionSpec, { type: 'standard' }>;
        const single = spec.splits.length === 1 ? spec.splits[0]! : null;
        return {
          id: r.id,
          payee: r.payee_raw,
          date: r.txn_date,
          amount: BigInt(spec.amount),
          currency: spec.currency,
          categoryId: single && !spec.uncategorized ? single.accountId : null,
          memberId: single ? (single.memberId ?? spec.memberId) : spec.memberId,
          splits: spec.splits.length,
          subject: {
            payee: r.payee_raw,
            payeeKey: r.payee_key,
            description: r.description,
            rawDescription: r.raw_description,
            amountMinor: BigInt(spec.amount),
            exponent: minorUnits(asCurrencyCode(r.currency)),
            accountId: spec.accountId,
            entityId: r.entity_id,
            date: calendarDate(r.txn_date),
          },
        };
      });
      const last = rows.at(-1)!;
      after = { date: last.txn_date, id: last.id };
      if (rows.length < SCAN_CHUNK) return;
    }
  }

  // ----- Rule suggestions (AI-05) -------------------------------------------------------------------------

  async suggestions(trx: Trx, ctx: Ctx): Promise<RuleSuggestionDto[]> {
    const rows = await trx
      .selectFrom('app.rule_suggestion')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    const out: RuleSuggestionDto[] = [];
    for (const r of rows)
      out.push({
        id: r.id,
        name: r.name,
        payeeKey: r.payee_key,
        conditions: r.conditions as RuleSuggestionDto['conditions'],
        actions: r.actions as Record<string, unknown>,
        evidence: r.evidence,
        existingMatches: await this.categorizer.payeeTransactions(trx, ctx, r.payee_key),
        createdAt: r.created_at.toISOString(),
      });
    return out;
  }

  async acceptSuggestion(
    trx: Trx,
    ctx: Ctx,
    id: string,
    applyToExisting: boolean,
  ): Promise<{ rule: RuleDto; jobId: string | null }> {
    const s = await trx
      .selectFrom('app.rule_suggestion')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw notFound('Rule suggestion');
    const rule = await this.create(
      trx,
      ctx,
      {
        name: s.name,
        entityId: null,
        scope: 'transaction',
        priority: 100,
        conditions: s.conditions as RuleConditions,
        actions: s.actions as CreateRuleRequest['actions'],
        enabled: true,
      },
      'ai_suggested',
    );
    await trx
      .updateTable('app.rule_suggestion')
      .set({ status: 'accepted', rule_id: rule.id })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .execute();
    const jobId = applyToExisting ? await this.startApply(trx, ctx, rule.id) : null;
    return { rule, jobId };
  }

  async dismissSuggestion(trx: Trx, ctx: Ctx, id: string): Promise<void> {
    const res = await trx
      .updateTable('app.rule_suggestion')
      .set({ status: 'dismissed' })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!res.numUpdatedRows) throw notFound('Rule suggestion');
  }
}

function wouldChange(c: Candidate, a: RuleActions): boolean {
  return Boolean(
    (a.categoryId && a.categoryId !== c.categoryId) ||
    (a.memberId && a.memberId !== c.memberId) ||
    (a.renamePayee && a.renamePayee !== c.payee) ||
    a.tags?.length,
  );
}

export function toRuleDto(r: {
  id: string;
  name: string;
  entity_id: string | null;
  scope: 'transaction' | 'receipt_line';
  priority: number;
  conditions: unknown;
  actions: unknown;
  origin: 'user' | 'ai_suggested' | 'correction';
  enabled: boolean;
  hit_count: number;
  last_hit_at: Date | null;
  version: bigint;
  created_at: Date;
}): RuleDto {
  return {
    id: r.id,
    name: r.name,
    entityId: r.entity_id,
    scope: r.scope,
    priority: r.priority,
    conditions: r.conditions as RuleDto['conditions'],
    actions: r.actions as Record<string, unknown>,
    origin: r.origin,
    enabled: r.enabled,
    hitCount: r.hit_count,
    lastHitAt: r.last_hit_at?.toISOString() ?? null,
    version: r.version.toString(),
    createdAt: r.created_at.toISOString(),
  };
}
