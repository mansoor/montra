import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import { asCurrencyCode, calendarDate, type CalendarDate } from '@montra/domain';
import { parseQuickAddHeuristic } from '@montra/categorize';
import type {
  AcceptReviewRequest,
  AcceptReviewResponse,
  CategoryProposalDto,
  CategoryProposalsResponse,
  QuickAddDraftDto,
  ResolveReviewRequest,
  ResolveReviewResponse,
  ReviewItemDto,
  ReviewListResponse,
  SuggestionDto,
  SuggestRequest,
} from '@montra/schemas';
import { notFound, unprocessable } from '../common/errors.js';
import { AiService } from '../ai/ai.service.js';
import { TransactionPoster, type TransactionSpec } from '../transactions/poster.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { Categorizer, toDto, type StoredCategorization } from './categorizer.service.js';
import { MerchantDirectory } from './merchants.js';

type Ctx = { workspaceId: string; userId: string };
type StandardSpec = Extract<TransactionSpec, { type: 'standard' }>;

const PAGE = 100;

interface StoredProposals {
  source: 'ai' | 'reference';
  proposals: Array<Omit<CategoryProposalDto, 'exists'> & { payeeKeys: string[] }>;
}

/** Review queue (AI-03/04), editor suggestions, natural-language quick add (TXN-06) and UP-03 proposals. */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(Categorizer) private readonly categorizer: Categorizer,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
    @Inject(MerchantDirectory) private readonly merchants: MerchantDirectory,
  ) {}

  // ----- Review queue -------------------------------------------------------------------------------------

  async list(
    trx: Trx,
    ctx: Ctx,
    q: { entityId?: string; minConfidence?: number; cursor?: string },
  ): Promise<ReviewListResponse> {
    const base = () => {
      let b = trx
        .selectFrom('app.transaction as t')
        .where('t.workspace_id', '=', ctx.workspaceId)
        .where('t.review_state', '=', 'needs_review')
        .where('t.status', '=', 'posted')
        .where('t.deleted_at', 'is', null);
      if (q.entityId) b = b.where('t.primary_entity_id', '=', q.entityId);
      if (q.minConfidence !== undefined)
        b = b.where(sql<boolean>`coalesce((t.categorization->>'confidence')::numeric, 0) >= ${q.minConfidence}`);
      return b;
    };
    const total = Number(
      (await base().select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n,
    );
    let page = base()
      .select([
        't.id',
        't.txn_date',
        't.payee_raw',
        't.payee_key',
        't.description',
        't.spec',
        't.primary_entity_id',
        't.categorization',
        't.version',
      ])
      .orderBy('t.txn_date', 'desc')
      .orderBy('t.id', 'desc')
      .limit(PAGE + 1);
    if (q.cursor) {
      const [d, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      page = page.where((eb) =>
        eb.or([eb('t.txn_date', '<', d!), eb.and([eb('t.txn_date', '=', d!), eb('t.id', '<', id!)])]),
      );
    }
    const rows = await page.execute();
    const merchants = await this.merchants.load(trx);
    const items = rows.slice(0, PAGE).map((r): ReviewItemDto => {
      const spec = r.spec as TransactionSpec | null;
      const std = spec?.type === 'standard' ? spec : null;
      const single = std && std.splits.length === 1 ? std.splits[0]! : null;
      return {
        transactionId: r.id,
        date: r.txn_date,
        payee: r.payee_raw,
        description: r.description,
        amount: std ? { amount: std.amount, currency: asCurrencyCode(std.currency) } : null,
        accountId: std?.accountId ?? null,
        entityId: r.primary_entity_id,
        categoryId: single && !std!.uncategorized ? single.accountId : null,
        memberId: single?.memberId ?? std?.memberId ?? null,
        categorization: toDto(r.categorization as StoredCategorization | null),
        merchant: r.payee_key ? merchants.lookup(r.payee_key) : null,
        version: r.version.toString(),
      };
    });
    const last = rows.length > PAGE ? rows[PAGE - 1] : null;
    return {
      items,
      total,
      nextCursor: last ? Buffer.from(`${last.txn_date}|${last.id}`).toString('base64url') : null,
    };
  }

  /** Accepts suggestions as they are. Items without a suggestion, split items and locked items are skipped. */
  async accept(trx: Trx, ctx: Ctx, req: AcceptReviewRequest): Promise<AcceptReviewResponse> {
    let q = trx
      .selectFrom('app.transaction')
      .select(['id', 'categorization', 'spec'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('review_state', '=', 'needs_review')
      .where('status', '=', 'posted')
      .where('deleted_at', 'is', null);
    if (req.transactionIds?.length) q = q.where('id', 'in', req.transactionIds);
    if (req.entityId) q = q.where('primary_entity_id', '=', req.entityId);
    if (req.minConfidence !== undefined)
      q = q.where(sql<boolean>`coalesce((categorization->>'confidence')::numeric, 0) >= ${req.minConfidence}`);
    const rows = await q.limit(5000).execute();
    let accepted = 0;
    let skipped = 0;
    for (const r of rows) {
      const c = r.categorization as StoredCategorization | null;
      const spec = r.spec as TransactionSpec | null;
      const categoryId = c?.suggested?.categoryId;
      if (!categoryId || spec?.type !== 'standard' || spec.splits.length !== 1) {
        skipped++;
        continue;
      }
      if ((await this.poster.protection(trx, ctx, r.id)) !== 'none') {
        skipped++;
        continue;
      }
      await this.transactions.updateInTrx(trx, ctx, r.id, {
        categoryId,
        ...(c.suggested?.memberId ? { memberId: c.suggested.memberId } : {}),
        reviewState: 'reviewed',
      });
      accepted++;
    }
    return { accepted, skipped };
  }

  /** A different category than suggested: a correction the app learns from (AI-05). */
  async resolve(trx: Trx, ctx: Ctx, id: string, req: ResolveReviewRequest): Promise<ResolveReviewResponse> {
    const { ruleSuggestion } = await this.transactions.updateInTrx(
      trx,
      ctx,
      id,
      {
        categoryId: req.categoryId,
        ...(req.memberId !== undefined ? { memberId: req.memberId } : {}),
        reviewState: 'reviewed',
      },
      req.version !== undefined ? `"v${req.version}"` : undefined,
    );
    return { transactionId: id, ruleSuggestion };
  }

  // ----- Editor suggestion -------------------------------------------------------------------------------

  async suggest(trx: Trx, ctx: Ctx, req: SuggestRequest): Promise<SuggestionDto> {
    const account = await this.categorizer.accountInfo(trx, ctx, req.accountId);
    const merchants = await this.merchants.load(trx);
    const prepared = await this.categorizer.prepare(trx, ctx);
    const item = this.categorizer.item(account, {
      id: 'suggest',
      payee: req.payee || null,
      description: req.description ?? '',
      amountMinor: BigInt(req.amount.amount),
      date: calendarDate(req.date),
    });
    const m = item.payeeKey ? merchants.match(item.payeeKey) : null;
    if (m)
      item.merchant = {
        id: m.id,
        name: m.displayName,
        categoryId:
          prepared.categories.find(
            (c) => c.entityId === account.entityId && c.name.toLowerCase() === m.categoryHint?.toLowerCase(),
          )?.id ?? null,
      };
    const { decisions } = await this.categorizer.categorize(trx, ctx, account, [item], {
      useAi: true,
      prepared,
      subject: { type: 'suggest', id: account.id },
    });
    const d = decisions[0]!;
    return {
      categoryId: d.categoryId,
      entityId: d.entityId,
      memberId: d.memberId ?? account.defaultMemberId,
      tags: d.tags,
      payee: d.renamePayee ?? (m ? m.displayName : null),
      confidence: d.confidence,
      step: d.step,
      explanation: d.explanation,
    };
  }

  // ----- Natural-language quick add (TXN-06) --------------------------------------------------------------

  async parseQuickAdd(trx: Trx, ctx: Ctx, text: string, today: CalendarDate): Promise<QuickAddDraftDto> {
    const accounts = await trx
      .selectFrom('app.ledger_account as la')
      .leftJoin('app.bank_account as ba', (j) => j.onRef('ba.ledger_account_id', '=', 'la.id'))
      .select(['la.id', 'la.name', 'la.currency', 'ba.kind', 'la.type'])
      .where('la.workspace_id', '=', ctx.workspaceId)
      .where('la.is_category', '=', false)
      .where('la.system_role', 'is', null)
      .where('la.archived_at', 'is', null)
      .where('la.type', 'in', ['asset', 'liability'])
      .orderBy('la.sort_order')
      .execute();
    const prepared = await this.categorizer.prepare(trx, ctx);
    const h = parseQuickAddHeuristic(text, {
      today,
      accounts: accounts.map((a) => ({ id: a.id, label: a.name })),
      categories: prepared.categories.map((c) => ({ id: c.id, name: c.name })),
      members: prepared.members.map((m) => ({ id: m.id, name: m.name })),
    });
    const currencyOf = (id: string | null) => accounts.find((a) => a.id === id)?.currency ?? accounts[0]?.currency;
    let draft = { ...h, source: 'heuristic' as 'ai' | 'heuristic' };
    const runtime = await this.ai.runtime(trx, ctx, { type: 'quick_add', id: ctx.userId });
    if (runtime.available && h.confidence < 0.9) {
      const res = await this.ai.gateway.parseQuickAdd(
        text,
        {
          today,
          currency: currencyOf(h.accountId) ?? 'USD',
          accounts: accounts.map((a) => ({ id: a.id, label: a.name, kind: a.kind ?? a.type })),
          categories: prepared.categories,
          members: prepared.members,
        },
        { ...runtime.ctx, parkLocal: false },
      );
      if (res.ok && res.value.amount && res.value.confidence >= h.confidence) {
        const v = res.value;
        draft = {
          ...h,
          date: v.date ? calendarDate(v.date) : h.date,
          amount: v.amount,
          direction: v.direction,
          payee: v.payee ?? h.payee,
          accountId: v.accountId ?? h.accountId,
          categoryId: v.categoryId ?? h.categoryId,
          memberId: v.memberId ?? h.memberId,
          memo: v.memo ?? h.memo,
          tags: v.tags.length ? v.tags : h.tags,
          confidence: v.confidence,
          source: 'ai',
        };
      }
    }
    const currency = currencyOf(draft.accountId) ?? 'USD';
    return {
      date: draft.date,
      amount: draft.amount ? { amount: toMinor(draft.amount, currency), currency: asCurrencyCode(currency) } : null,
      direction: draft.direction,
      payee: draft.payee,
      accountId: draft.accountId,
      categoryId: draft.categoryId,
      memberId: draft.memberId,
      memo: draft.memo,
      tags: draft.tags,
      confidence: draft.confidence,
      source: draft.source,
      spans: h.spans,
    } as QuickAddDraftDto;
  }

  // ----- Category proposals from the first import (UP-03) -------------------------------------------------

  async proposals(trx: Trx, ctx: Ctx, batchId: string): Promise<CategoryProposalsResponse> {
    const batch = await this.batch(trx, ctx, batchId);
    const account = await this.categorizer.accountInfo(trx, ctx, batch.ledger_account_id);
    const existing = await this.existingNames(trx, ctx, account.entityId);
    const cached = (batch.analysis as { categoryProposals?: StoredProposals } | null)?.categoryProposals;
    if (cached) return present(cached, existing);

    const rows = await trx
      .selectFrom('app.import_row')
      .select(['payee_raw', 'normalized_desc', 'amount_minor', 'suggestion'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('import_batch_id', '=', batchId)
      .where('status', 'in', ['new', 'probable_duplicate'])
      .execute();
    // Only rows the pipeline couldn't place are worth new categories.
    const open = rows.filter((r) => !(r.suggestion as { categoryId?: string | null } | null)?.categoryId);
    const byPayee = new Map<string, { payee: string; rows: number; total: bigint }>();
    for (const r of open) {
      const key = r.normalized_desc ?? '';
      if (!key) continue;
      const g = byPayee.get(key) ?? { payee: r.payee_raw ?? key, rows: 0, total: 0n };
      g.rows++;
      g.total += r.amount_minor ?? 0n;
      byPayee.set(key, g);
    }
    const top = [...byPayee.entries()].sort((a, b) => b[1].rows - a[1].rows).slice(0, 80);
    let stored: StoredProposals = { source: 'reference', proposals: [] };
    const runtime = await this.ai.runtime(trx, ctx, { type: 'import_batch', id: batchId });
    if (runtime.available && top.length) {
      const res = await this.ai.gateway.proposeCategories(
        {
          entityType: account.entityType,
          existing: [...existing.values()].map((e) => e.name),
          payees: top.map(([, g]) => ({ payee: g.payee, rows: g.rows, totalMinor: g.total })),
        },
        { ...runtime.ctx, parkLocal: false },
      );
      if (res.ok) {
        stored = {
          source: 'ai',
          proposals: res.value.categories.slice(0, 20).map((c) => {
            const payees = res.value.assignments.filter((a) => a.category === c.name).map((a) => a.payee);
            const keys = top.filter(([, g]) => payees.includes(g.payee)).map(([k]) => k);
            return {
              name: c.name,
              group: c.group,
              kind: c.kind,
              payees: payees.slice(0, 5),
              rows: keys.reduce((n, k) => n + byPayee.get(k)!.rows, 0),
              payeeKeys: keys,
            };
          }),
        };
      }
    }
    if (stored.proposals.length === 0) {
      // AI off or unavailable: known-merchant category hints (OPS-05 reference data).
      const merchants = await this.merchants.load(trx);
      const groups = new Map<string, { payees: string[]; keys: string[]; rows: number; income: boolean }>();
      for (const [key, g] of top) {
        const m = merchants.match(key);
        if (!m?.categoryHint) continue;
        const x = groups.get(m.categoryHint) ?? { payees: [], keys: [], rows: 0, income: g.total > 0n };
        if (x.payees.length < 5) x.payees.push(m.displayName);
        x.keys.push(key);
        x.rows += g.rows;
        groups.set(m.categoryHint, x);
      }
      stored = {
        source: 'reference',
        proposals: [...groups.entries()].map(([name, x]) => ({
          name,
          group: x.income ? 'Income' : 'Everyday',
          kind: x.income ? 'income' : 'expense',
          payees: x.payees,
          rows: x.rows,
          payeeKeys: x.keys,
        })),
      };
    }
    await trx
      .updateTable('app.import_batch')
      .set({
        analysis: sql`jsonb_set(coalesce(analysis, '{}'::jsonb), '{categoryProposals}', ${JSON.stringify(stored)}::jsonb)`,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', batchId)
      .execute();
    return present(stored, existing);
  }

  /** Creates the chosen categories in the account's entity and points the matching preview rows at them. */
  async acceptProposals(trx: Trx, ctx: Ctx, batchId: string, names: string[]): Promise<{ created: number; rows: number }> {
    const batch = await this.batch(trx, ctx, batchId);
    if (batch.status !== 'preview' && batch.status !== 'needs_mapping')
      throw unprocessable('import.not_editable', `The import is ${batch.status}`);
    const stored = (batch.analysis as { categoryProposals?: StoredProposals } | null)?.categoryProposals;
    if (!stored) throw unprocessable('import.no_proposals', 'Load the proposals first');
    const account = await this.categorizer.accountInfo(trx, ctx, batch.ledger_account_id);
    const existing = await this.existingNames(trx, ctx, account.entityId);
    let created = 0;
    let rows = 0;
    for (const p of stored.proposals.filter((x) => names.includes(x.name))) {
      let categoryId = existing.get(p.name.toLowerCase())?.id;
      if (!categoryId) {
        categoryId = await this.createCategory(trx, ctx, account.entityId, account.currency, p);
        created++;
      }
      if (!p.payeeKeys.length) continue;
      const explanation =
        stored.source === 'ai' ? `AI proposed category "${p.name}"` : `Known merchant → ${p.name}`;
      const res = await sql`
        update app.import_row
           set category_id = ${categoryId},
               suggestion = coalesce(suggestion, '{}'::jsonb)
                 || jsonb_build_object('categoryId', ${categoryId}::text, 'confidence', 0.85, 'step', ${stored.source === 'ai' ? 'ai' : 'merchant'}::text,
                                       'explanation', ${explanation}::text, 'autoApply', true, 'userSet', true,
                                       'suggested', jsonb_build_object('categoryId', ${categoryId}::text, 'entityId', ${account.entityId}::text, 'memberId', null))
         where workspace_id = ${ctx.workspaceId} and import_batch_id = ${batchId}
           and status in ('new', 'probable_duplicate') and category_id is null
           and normalized_desc = any(${p.payeeKeys}::text[])`.execute(trx);
      rows += Number(res.numAffectedRows ?? 0n);
    }
    return { created, rows };
  }

  private async createCategory(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    currency: string,
    p: { name: string; group: string; kind: 'income' | 'expense' },
  ): Promise<string> {
    let group = await trx
      .selectFrom('app.category_group')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where(sql<boolean>`lower(name) = lower(${p.group})`)
      .executeTakeFirst();
    if (!group) {
      group = await trx
        .insertInto('app.category_group')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: entityId,
          name: p.group.slice(0, 100),
          kind: p.kind === 'income' ? 'income' : 'daily',
          sort_order: 900,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    }
    const row = await trx
      .insertInto('app.ledger_account')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: entityId,
        type: p.kind,
        subtype: 'category',
        name: p.name.slice(0, 100),
        currency,
        is_category: true,
        category_group_id: group.id,
        sort_order: 900,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async existingNames(trx: Trx, ctx: Ctx, entityId: string) {
    const rows = await trx
      .selectFrom('app.ledger_account')
      .select(['id', 'name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('is_category', '=', true)
      .where('archived_at', 'is', null)
      .execute();
    return new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  }

  private async batch(trx: Trx, ctx: Ctx, id: string) {
    const b = await trx
      .selectFrom('app.import_batch')
      .select(['id', 'status', 'ledger_account_id', 'analysis'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!b) throw notFound('Import');
    return b;
  }
}

function present(s: StoredProposals, existing: Map<string, { id: string; name: string }>): CategoryProposalsResponse {
  return {
    source: s.source,
    proposals: s.proposals.map(({ payeeKeys: _k, ...p }) => ({ ...p, exists: existing.has(p.name.toLowerCase()) })),
  };
}

/** "18.50" → "1850" for a 2-decimal currency. */
function toMinor(decimal: string, currency: string): string {
  const exp = currency === 'JPY' || currency === 'KRW' ? 0 : 2;
  const [i, f = ''] = decimal.replace(/^-/, '').split('.');
  return (BigInt(i || '0') * 10n ** BigInt(exp) + BigInt((f + '00').slice(0, exp) || '0')).toString();
}
