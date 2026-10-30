import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { addDays, asCurrencyCode, calendarDate, minorUnits, type CalendarDate } from '@montra/domain';
import { normalizeDescription } from '@montra/importers';
import {
  amountBand,
  compileRules,
  proposeRuleFromCorrections,
  runPipeline,
  type AiSuggestion,
  type CompiledRule,
  type Decision,
  type HistoryEntry,
  type PipelineItem,
  type RuleRecord,
  type TransferCandidate,
} from '@montra/categorize';
import type { CategoryOption, MemberOption } from '@montra/ai-gateway';
import type { CategorizationDto, RuleSuggestionDto } from '@montra/schemas';
import { AiService } from '../ai/ai.service.js';

type Ctx = { workspaceId: string; userId: string };

/** Stored in `transaction.categorization` (ADR-0012 §7). */
export interface StoredCategorization {
  step: CategorizationDto['step'];
  confidence: number;
  explanation: string;
  ruleId: string | null;
  suggested: { categoryId: string | null; entityId: string | null; memberId: string | null } | null;
  /** The category this transaction contributed to payee history (so a later change can take it back). */
  learned?: { categoryId: string; memberId: string | null; band: number } | null;
  transfer?: { accountId: string; transactionId: string | null } | null;
}

export interface AccountInfo {
  id: string;
  entityId: string;
  entityType: 'personal' | 'business' | 'rental';
  currency: string;
  kind: string;
  name: string;
  last4: string | null;
  defaultMemberId: string | null;
}

/** Per-request lookups shared by every item categorized in one call. */
export interface Prepared {
  rules: CompiledRule[];
  categories: CategoryOption[];
  categoryById: Map<string, CategoryOption>;
  members: MemberOption[];
}

export const payeeKeyOf = (payee: string | null | undefined, description?: string | null): string | null => {
  const key = normalizeDescription(payee || description || '');
  return key || null;
};

export const toDto = (c: StoredCategorization | null | undefined): CategorizationDto | null =>
  c
    ? {
        step: c.step,
        confidence: c.confidence,
        explanation: c.explanation,
        ruleId: c.ruleId ?? null,
        suggested: c.suggested ?? null,
      }
    : null;

/**
 * Runs the six-step pipeline (04 §5) over import rows and manual entries, and turns user choices into
 * payee history, corrections and rule suggestions (AI-05, AIA-06).
 */
@Injectable()
export class Categorizer {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  async accountInfo(trx: Trx, ctx: Ctx, accountId: string): Promise<AccountInfo> {
    const a = await trx
      .selectFrom('app.ledger_account as la')
      .innerJoin('app.entity as e', (j) => j.onRef('e.id', '=', 'la.entity_id'))
      .leftJoin('app.bank_account as ba', (j) => j.onRef('ba.ledger_account_id', '=', 'la.id'))
      .select([
        'la.id',
        'la.entity_id',
        'e.type as entity_type',
        'la.currency',
        'la.name',
        'la.type',
        'ba.kind',
        'ba.last4',
        'ba.default_member_id',
      ])
      .where('la.workspace_id', '=', ctx.workspaceId)
      .where('la.id', '=', accountId)
      .executeTakeFirstOrThrow();
    return {
      id: a.id,
      entityId: a.entity_id,
      entityType: a.entity_type,
      currency: a.currency,
      kind: a.kind ?? (a.type === 'liability' ? 'credit_card' : 'checking'),
      name: a.name,
      last4: a.last4,
      defaultMemberId: a.default_member_id,
    };
  }

  async prepare(trx: Trx, ctx: Ctx): Promise<Prepared> {
    const ruleRows = await trx
      .selectFrom('app.rule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('enabled', '=', true)
      .where('scope', '=', 'transaction')
      .execute();
    const { rules } = compileRules(ruleRows.map(ruleRecord));
    const cats = await trx
      .selectFrom('app.ledger_account as la')
      .innerJoin('app.entity as e', (j) => j.onRef('e.id', '=', 'la.entity_id'))
      .leftJoin('app.category_group as g', (j) => j.onRef('g.id', '=', 'la.category_group_id'))
      .select(['la.id', 'la.name', 'la.type', 'la.entity_id', 'e.type as entity_type', 'g.name as group'])
      .where('la.workspace_id', '=', ctx.workspaceId)
      .where('la.is_category', '=', true)
      .where('la.system_role', 'is', null)
      .where('la.archived_at', 'is', null)
      .where('la.type', 'in', ['income', 'expense'])
      .orderBy('la.sort_order')
      .execute();
    const categories: CategoryOption[] = cats.map((c) => ({
      id: c.id,
      name: c.name,
      group: c.group,
      kind: c.type === 'income' ? 'income' : 'expense',
      entityId: c.entity_id,
      entityType: c.entity_type,
    }));
    const members = await trx
      .selectFrom('app.family_member')
      .select(['id', 'name', 'relationship'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'active')
      .orderBy('created_at')
      .execute();
    return {
      rules,
      categories,
      categoryById: new Map(categories.map((c) => [c.id, c])),
      members: members.map((m) => ({ id: m.id, name: m.name, relationship: m.relationship })),
    };
  }

  /** Payee history for many keys at once (step 4). */
  async history(trx: Trx, ctx: Ctx, keys: readonly string[]): Promise<Map<string, HistoryEntry[]>> {
    const out = new Map<string, HistoryEntry[]>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 1000) {
      const rows = await trx
        .selectFrom('app.payee_history')
        .select(['payee_key', 'amount_band', 'category_id', 'member_id', 'count'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('payee_key', 'in', unique.slice(i, i + 1000))
        .where('count', '>', 0)
        .execute();
      for (const r of rows) {
        const list = out.get(r.payee_key) ?? [];
        list.push({ amountBand: r.amount_band, categoryId: r.category_id, memberId: r.member_id, count: r.count });
        out.set(r.payee_key, list);
      }
    }
    return out;
  }

  /**
   * Opposite-side postings on the workspace's other bank and card accounts around the items' dates
   * (step 3). Account-view amounts: the posting amount on an asset or liability account.
   */
  async transferCandidates(
    trx: Trx,
    ctx: Ctx,
    accountId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<TransferCandidate[]> {
    const rows = await sql<{
      transaction_id: string;
      account_id: string;
      name: string;
      last4: string | null;
      amount: bigint;
      txn_date: string;
    }>`
      select t.id as transaction_id, la.id as account_id, la.name, ba.last4, p.amount_minor as amount, t.txn_date::text
        from app.posting p
        join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
        join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
        join app.ledger_account la on la.workspace_id = p.workspace_id and la.id = p.ledger_account_id
        left join app.bank_account ba on ba.ledger_account_id = la.id
       where p.workspace_id = ${ctx.workspaceId}
         and la.type in ('asset', 'liability') and not la.is_category and la.system_role is null
         and la.id <> ${accountId}
         and t.status = 'posted' and t.deleted_at is null
         and t.spec->>'type' = 'standard'
         and t.txn_date between ${range.from} and ${range.to}
       limit 5000`.execute(trx);
    return rows.rows.map((r) => ({
      transactionId: r.transaction_id,
      accountId: r.account_id,
      accountName: r.name,
      accountLast4: r.last4,
      amountMinor: BigInt(r.amount),
      date: calendarDate(r.txn_date),
    }));
  }

  /**
   * Categorizes items that all belong to one account (an import batch, or a single manual entry). The AI
   * step runs only when the workspace's mode allows it and `useAi` is set.
   */
  async categorize(
    trx: Trx,
    ctx: Ctx,
    account: AccountInfo,
    items: PipelineItem[],
    opts: { useAi: boolean; prepared?: Prepared; subject?: { type: string; id: string } } = { useAi: true },
  ): Promise<{ decisions: Decision[]; threshold: number; aiUsed: boolean }> {
    if (items.length === 0) return { decisions: [], threshold: 0.8, aiUsed: false };
    const prepared = opts.prepared ?? (await this.prepare(trx, ctx));
    const runtime = await this.ai.runtime(trx, ctx, opts.subject);
    const history = await this.history(
      trx,
      ctx,
      items.map((i) => i.payeeKey).filter((k): k is string => Boolean(k)),
    );
    const dates = items.map((i) => i.date).sort();
    const candidates = await this.transferCandidates(trx, ctx, account.id, {
      from: addDays(dates[0]!, -3),
      to: addDays(dates.at(-1)!, 3),
    });
    let aiUsed = false;
    const ai =
      opts.useAi && runtime.available
        ? async (open: readonly PipelineItem[]): Promise<ReadonlyMap<string, AiSuggestion>> => {
            const res = await this.ai.gateway.categorize(
              open.map((i) => ({
                id: i.id,
                payee: i.payee,
                description: i.description,
                amountMinor: i.amountMinor,
                currency: i.currency,
                date: i.date,
                accountType: i.accountType,
                entityType: i.entityType,
              })),
              { categories: prepared.categories, members: prepared.members },
              runtime.ctx,
            );
            const map = new Map<string, AiSuggestion>();
            if (!res.ok) return map;
            aiUsed = true;
            for (const o of res.value) {
              if (!o.categoryId && !o.memberId) continue;
              map.set(o.id, {
                categoryId: o.categoryId,
                memberId: o.memberId,
                tags: o.tags,
                confidence: o.confidence,
                explanation: o.explanation,
              });
            }
            return map;
          }
        : undefined;
    const decisions = await runPipeline(items, {
      rules: prepared.rules,
      history: (key) => history.get(key) ?? [],
      transferCandidates: (item) =>
        candidates.filter(
          (c) =>
            c.amountMinor === -item.amountMinor &&
            Math.abs(daysBetween(c.date, item.date)) <= 3 &&
            c.accountId !== item.accountId,
        ),
      ai,
      threshold: runtime.threshold,
      entityOfCategory: (id) => prepared.categoryById.get(id)?.entityId ?? null,
    });
    await this.bumpRuleHits(trx, ctx, decisions);
    return { decisions, threshold: runtime.threshold, aiUsed };
  }

  /** Builds a pipeline item for one line on `account`. */
  item(
    account: AccountInfo,
    input: {
      id: string;
      payee: string | null;
      /** Override the key derived from payee/description (imports key on the raw statement text). */
      payeeKey?: string | null;
      description: string;
      rawDescription?: string | null;
      amountMinor: bigint;
      date: CalendarDate;
      fileCategoryId?: string | null;
      fileCategoryName?: string | null;
      merchant?: PipelineItem['merchant'];
    },
  ): PipelineItem {
    return {
      id: input.id,
      payee: input.payee,
      payeeKey:
        input.payeeKey !== undefined
          ? input.payeeKey
          : payeeKeyOf(input.payee, input.rawDescription ?? input.description),
      description: input.description,
      rawDescription: input.rawDescription ?? null,
      amountMinor: input.amountMinor,
      exponent: minorUnits(asCurrencyCode(account.currency)),
      accountId: account.id,
      entityId: account.entityId,
      date: input.date,
      currency: account.currency,
      accountType: account.kind,
      entityType: account.entityType,
      defaultMemberId: account.defaultMemberId,
      fileCategoryId: input.fileCategoryId ?? null,
      fileCategoryName: input.fileCategoryName ?? null,
      merchant: input.merchant ?? null,
    };
  }

  /** The stored form of a decision: applied (≥ threshold) or kept as a suggestion for the review queue. */
  stored(d: Decision): StoredCategorization {
    return {
      step: d.step,
      confidence: Math.round(d.confidence * 1000) / 1000,
      explanation: d.explanation,
      ruleId: d.ruleId,
      suggested:
        d.categoryId || d.memberId
          ? { categoryId: d.categoryId, entityId: d.entityId, memberId: d.memberId }
          : null,
      transfer: d.transfer ? { accountId: d.transfer.accountId, transactionId: d.transfer.transactionId } : null,
    };
  }

  private async bumpRuleHits(trx: Trx, ctx: Ctx, decisions: readonly Decision[]): Promise<void> {
    const hits = new Map<string, number>();
    for (const d of decisions) for (const id of d.matchedRuleIds) hits.set(id, (hits.get(id) ?? 0) + 1);
    if (hits.size === 0) return;
    const ids = [...hits.keys()];
    await sql`
      update app.rule r set hit_count = r.hit_count + v.n, last_hit_at = now()
        from (select * from unnest(${ids}::uuid[], ${ids.map((id) => hits.get(id)!)}::int[]) as t(id, n)) v
       where r.workspace_id = ${ctx.workspaceId} and r.id = v.id`.execute(trx);
  }

  // ----- Learning (AI-05) ----------------------------------------------------------------------------------

  /**
   * Records a category the user chose or confirmed for a transaction: payee history (+1, and −1 for the
   * category it replaces), a correction when it differs from the suggestion, and a rule suggestion after
   * two identical corrections. Returns the new suggestion, if one was created.
   */
  async learn(
    trx: Trx,
    ctx: Ctx,
    t: {
      transactionId: string;
      payee: string | null;
      payeeKey: string | null;
      amountMinor: bigint;
      currency: string;
      categoryId: string | null;
      memberId: string | null;
      previous: StoredCategorization | null;
      previousCategoryId: string | null;
      previousMemberId?: string | null;
    },
  ): Promise<{ learned: StoredCategorization['learned']; suggestion: RuleSuggestionDto | null }> {
    if (!t.payeeKey || !t.categoryId) return { learned: null, suggestion: null };
    const band = amountBand(t.amountMinor, minorUnits(asCurrencyCode(t.currency)));
    const old = t.previous?.learned;
    if (old) await this.bumpHistory(trx, ctx, t.payeeKey, old.band, old.categoryId, old.memberId, -1);
    await this.bumpHistory(trx, ctx, t.payeeKey, band, t.categoryId, t.memberId, 1);
    const learned = { categoryId: t.categoryId, memberId: t.memberId, band };

    let suggestion: RuleSuggestionDto | null = null;
    const suggestedCategory = t.previous?.suggested?.categoryId ?? null;
    const from = suggestedCategory ?? t.previousCategoryId;
    const corrections: Array<{ field: 'category' | 'member'; from: string | null; to: string | null }> = [];
    if (from !== t.categoryId && t.previous && t.previous.step !== 'user')
      corrections.push({ field: 'category', from, to: t.categoryId });
    const suggestedMember = t.previous?.suggested?.memberId ?? t.previousMemberId ?? null;
    if (t.memberId && suggestedMember !== t.memberId && t.previous && t.previous.step !== 'user')
      corrections.push({ field: 'member', from: suggestedMember, to: t.memberId });
    for (const c of corrections) {
      await trx
        .insertInto('app.correction')
        .values({
          workspace_id: ctx.workspaceId,
          transaction_id: t.transactionId,
          payee_key: t.payeeKey,
          field: c.field,
          from_value: c.from,
          to_value: c.to,
          from_step: t.previous?.step ?? null,
          created_by: ctx.userId,
        })
        .execute();
      suggestion = (await this.maybeSuggestRule(trx, ctx, t.payeeKey, t.payee, c.field)) ?? suggestion;
    }
    return { learned, suggestion };
  }

  private async bumpHistory(
    trx: Trx,
    ctx: Ctx,
    payeeKey: string,
    band: number,
    categoryId: string,
    memberId: string | null,
    delta: 1 | -1,
  ): Promise<void> {
    if (delta < 0) {
      await sql`
        update app.payee_history set count = greatest(count - 1, 0)
         where workspace_id = ${ctx.workspaceId} and payee_key = ${payeeKey} and amount_band = ${band}
           and category_id = ${categoryId}
           and coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce(${memberId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`.execute(trx);
      return;
    }
    await sql`
      insert into app.payee_history (workspace_id, payee_key, amount_band, category_id, member_id, count)
      values (${ctx.workspaceId}, ${payeeKey}, ${band}, ${categoryId}, ${memberId}, 1)
      on conflict (workspace_id, payee_key, amount_band, category_id,
                   coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid))
      do update set count = app.payee_history.count + 1, last_used_at = now()`.execute(trx);
  }

  private async maybeSuggestRule(
    trx: Trx,
    ctx: Ctx,
    payeeKey: string,
    payee: string | null,
    field: 'category' | 'member',
  ): Promise<RuleSuggestionDto | null> {
    const rows = await trx
      .selectFrom('app.correction')
      .select(['payee_key', 'field', 'to_value'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('payee_key', '=', payeeKey)
      .where('field', '=', field)
      .orderBy('created_at')
      .execute();
    const proposal = proposeRuleFromCorrections(
      rows.map((r) => ({ payeeKey: r.payee_key, payee, field: r.field, toValue: r.to_value })),
    );
    if (!proposal) return null;
    const actions = JSON.stringify(proposal.actions);
    const existing = await sql<{ id: string }>`
      select id from app.rule_suggestion
       where workspace_id = ${ctx.workspaceId} and payee_key = ${payeeKey} and actions::text = ${actions}::jsonb::text
       limit 1`.execute(trx);
    if (existing.rows.length) return null;
    const label = await this.actionLabel(trx, ctx, proposal.actions);
    const name = `${proposal.name} → ${label}`.slice(0, 200);
    const inserted = await trx
      .insertInto('app.rule_suggestion')
      .values({
        workspace_id: ctx.workspaceId,
        payee_key: payeeKey,
        name,
        conditions: JSON.stringify(proposal.conditions),
        actions,
        evidence: proposal.evidence,
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
    return {
      id: inserted.id,
      name,
      payeeKey,
      conditions: proposal.conditions as RuleSuggestionDto['conditions'],
      actions: proposal.actions as Record<string, unknown>,
      evidence: proposal.evidence,
      existingMatches: await this.payeeTransactions(trx, ctx, payeeKey),
      createdAt: inserted.created_at.toISOString(),
    };
  }

  /** Existing transactions with this payee (the "apply to N existing" count). */
  async payeeTransactions(trx: Trx, ctx: Ctx, payeeKey: string): Promise<number> {
    const r = await trx
      .selectFrom('app.transaction')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('payee_key', '=', payeeKey)
      .where('status', '=', 'posted')
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  private async actionLabel(trx: Trx, ctx: Ctx, a: { categoryId?: string | null; memberId?: string | null }) {
    if (a.categoryId) {
      const c = await trx
        .selectFrom('app.ledger_account')
        .select('name')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', a.categoryId)
        .executeTakeFirst();
      return c?.name ?? 'category';
    }
    if (a.memberId) {
      const m = await trx
        .selectFrom('app.family_member')
        .select('name')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', a.memberId)
        .executeTakeFirst();
      return m?.name ?? 'member';
    }
    return 'rule';
  }
}

export function ruleRecord(r: {
  id: string;
  name: string;
  entity_id: string | null;
  priority: number;
  conditions: unknown;
  actions: unknown;
  enabled: boolean;
  created_at: Date;
}): RuleRecord {
  return {
    id: r.id,
    name: r.name,
    entityId: r.entity_id,
    priority: r.priority,
    conditions: r.conditions as RuleRecord['conditions'],
    actions: r.actions as RuleRecord['actions'],
    enabled: r.enabled,
    createdAt: r.created_at.toISOString(),
  };
}

function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}
