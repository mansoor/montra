/**
 * The gateway (06): task functions over pluggable providers. Every provider call goes through `callProvider`,
 * which applies mode, budget (AIA-08), local parking, routing (AIA-02), failover (OPS-07), cost accounting
 * and the audit event (AIA-10). Task functions minimize their input first (AIA-03) and validate the output
 * with Zod (AIA-04). A task never throws to the feature.
 */
import { asCurrencyCode, isCurrencyCode, minorUnits } from '@montra/domain';
import { normalizeDescription, type ColumnMapping } from '@montra/importers';
import type { z } from 'zod';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { FakeAdapter } from './adapters/fake.js';
import { NullAdapter } from './adapters/null.js';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import { amountBand, roundedAmount } from './bands.js';
import { maskText, minimizeDate, minimizeText, unpseudonymize, type Pseudonym } from './minimize.js';
import { calibrate } from './reference/calibration.js';
import { costMicroUsd } from './reference/prices.js';
import { DEFAULT_ROUTING, DOWNGRADE_AT, modelFor } from './reference/routing.js';
import { jsonSchemaOf } from './schema.js';
import * as categorizeV1 from './tasks/categorize/v1.js';
import * as extractV1 from './tasks/extract-statement-table/v1.js';
import * as mapColumnsV1 from './tasks/map-columns/v1.js';
import * as normalizeV1 from './tasks/normalize-payees/v1.js';
import * as quickAddV1 from './tasks/parse-quick-add/v1.js';
import * as pingV1 from './tasks/ping/v1.js';
import * as proposeV1 from './tasks/propose-categories/v1.js';
import type {
  AiContext,
  AiGateway,
  AiMeta,
  CategorizeItem,
  CategorizeOutput,
  CategoryOption,
  CategoryProposalInput,
  CategoryProposalOutput,
  ColumnMappingProposal,
  CompletionResponse,
  FailureReason,
  GridSample,
  MemberOption,
  PayeeNormalization,
  ProviderAdapter,
  ProviderConfig,
  ProviderId,
  QuickAddContext,
  StatementTable,
  StatementText,
  TaskName,
  TaskResult,
  TransactionDraft,
} from './types.js';
import { chunk, clamp01, mapLimit, oneLine, round3, sha256, stableJson } from './util.js';

export interface GatewayOptions {
  adapterFactory?: (cfg: ProviderConfig) => ProviderAdapter;
  now?: () => Date;
  onProviderFailure?: (e: { provider: ProviderId; task: TaskName | 'ping'; detail: string }) => void;
  /** Environment for model overrides (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Parallel provider calls per task invocation (06 §5: up to 8). */
  concurrency?: number;
}

export function defaultAdapterFactory(cfg: ProviderConfig): ProviderAdapter {
  switch (cfg.id) {
    case 'anthropic':
      return new AnthropicAdapter(cfg);
    case 'openai_compatible':
      return new OpenAiCompatibleAdapter(cfg);
    case 'fake':
      return new FakeAdapter();
    case 'null':
      return new NullAdapter();
  }
}

type Fail = { ok: false; reason: FailureReason; detail?: string; meta?: AiMeta };

interface CallSpec<T> {
  task: TaskName | 'ping';
  system: string;
  promptVersion: string;
  context?: string;
  /** Already minimized. */
  input: unknown;
  schema: z.ZodType;
  /** Post-schema validation and mapping; null = invalid output. */
  validate: (parsed: never, answered: { provider: ProviderId; model: string }) => T | null;
  /** For the audit event. */
  eventOutput?: (value: T) => unknown;
  confidence?: (value: T) => number | null;
  items?: number;
}

/** Spend observed during one task invocation, so later batches see earlier batches' cost. */
interface RunState {
  spent: bigint;
}

function emptyMeta(task: TaskName | 'ping', ctx: AiContext, model: string, promptVersion: string): AiMeta {
  return {
    task,
    provider: ctx.provider.id,
    model,
    promptVersion,
    inputHash: '',
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costMicroUsd: 0n,
    cachedItems: 0,
    failedOver: false,
  };
}

function mergeMeta(into: AiMeta, add: AiMeta): void {
  into.provider = add.provider;
  into.model = add.model;
  into.inputHash = add.inputHash || into.inputHash;
  into.tokensIn += add.tokensIn;
  into.tokensOut += add.tokensOut;
  into.costMicroUsd += add.costMicroUsd;
  into.failedOver ||= add.failedOver;
}

function exponentOf(currency: string): number {
  return isCurrencyCode(currency) ? minorUnits(asCurrencyCode(currency)) : 2;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validIsoDate(s: string | null | undefined): s is string {
  if (!s || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/;
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;
function cleanDecimal(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = s.replace(/[\s,$€£]/g, '').replace(/^\((.*)\)$/, '-$1');
  return SIGNED_DECIMAL.test(t) ? t : null;
}

export class Gateway implements AiGateway {
  private readonly factory: (cfg: ProviderConfig) => ProviderAdapter;
  private readonly now: () => Date;
  private readonly env: Record<string, string | undefined>;
  private readonly concurrency: number;
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(private readonly opts: GatewayOptions = {}) {
    this.factory = opts.adapterFactory ?? defaultAdapterFactory;
    this.now = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
    this.concurrency = opts.concurrency ?? 8;
  }

  private adapter(cfg: ProviderConfig): ProviderAdapter {
    const key = `${cfg.id}|${cfg.baseUrl ?? ''}|${cfg.apiKey ? sha256(cfg.apiKey) : ''}`;
    let a = this.adapters.get(key);
    if (!a) {
      a = this.factory(cfg);
      this.adapters.set(key, a);
    }
    return a;
  }

  private isOff(ctx: AiContext): boolean {
    return ctx.mode === 'off' || ctx.provider.id === 'null';
  }

  private budgetRatio(ctx: AiContext, state: RunState): number {
    const limit = ctx.budget.monthlyUsd;
    if (limit === null) return 0;
    if (limit <= 0) return Infinity;
    const limitMicro = BigInt(Math.trunc(limit * 1_000_000));
    return Number(ctx.budget.spentMicroUsd + state.spent) / Number(limitMicro);
  }

  /** The model a task will use right now (after any budget downgrade) — part of cache keys. */
  private modelForTask(
    task: TaskName | 'ping',
    ctx: AiContext,
    cfg: ProviderConfig,
    state: RunState,
  ): string {
    const route = DEFAULT_ROUTING[task];
    const group = this.budgetRatio(ctx, state) >= DOWNGRADE_AT ? 'small' : route.group;
    return modelFor(cfg, group, this.env);
  }

  private async callProvider<T>(
    spec: CallSpec<T>,
    ctx: AiContext,
    state: RunState,
  ): Promise<{ ok: true; value: T; meta: AiMeta } | Fail> {
    const route = DEFAULT_ROUTING[spec.task];
    const inputText = typeof spec.input === 'string' ? spec.input : stableJson(spec.input);
    const inputHash = sha256(`${spec.promptVersion}\n${spec.context ?? ''}\n${inputText}`);
    const primaryModel = this.modelForTask(spec.task, ctx, ctx.provider, state);
    const meta: AiMeta = { ...emptyMeta(spec.task, ctx, primaryModel, spec.promptVersion), inputHash };
    const record = async (
      outcome: 'ok' | 'off' | 'budget' | 'invalid_output' | 'provider_error' | 'refused',
      output: unknown,
      confidence: number | null,
    ) => {
      if (spec.task === 'ping') return;
      await ctx.store.recordEvent({
        task: spec.task,
        provider: meta.provider,
        model: meta.model,
        promptVersion: spec.promptVersion,
        inputHash,
        outcome,
        output,
        confidence,
        items: spec.items ?? 1,
        latencyMs: meta.latencyMs,
        tokensIn: meta.tokensIn,
        tokensOut: meta.tokensOut,
        costMicroUsd: meta.costMicroUsd,
        ...(ctx.subject ? { subject: ctx.subject } : {}),
      });
    };

    if (this.budgetRatio(ctx, state) >= 1) {
      await record('budget', null, null);
      return { ok: false, reason: 'budget', detail: 'monthly AI budget reached', meta };
    }
    if (ctx.parkLocal) {
      if (!ctx.store.parkLocal)
        return { ok: false, reason: 'provider_error', detail: 'local parking unavailable', meta };
      await ctx.store.parkLocal(spec.task as TaskName, {
        promptVersion: spec.promptVersion,
        system: spec.system,
        context: spec.context ?? null,
        input: spec.input,
        schema: jsonSchemaOf(spec.schema),
      });
      return { ok: false, reason: 'pending_local', meta };
    }

    const schema = jsonSchemaOf(spec.schema);
    const attempt = async (cfg: ProviderConfig, model: string): Promise<CompletionResponse> => {
      const res = await this.adapter(cfg).complete({
        task: spec.task,
        model,
        effort: route.effort,
        system: spec.system,
        ...(spec.context ? { context: spec.context } : {}),
        input: inputText,
        schema,
        maxTokens: route.maxTokens,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (res.usage) {
        const cost = costMicroUsd(res.ok ? res.model : model, res.usage);
        meta.tokensIn += res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens;
        meta.tokensOut += res.usage.outputTokens;
        meta.costMicroUsd += cost;
      }
      return res;
    };

    const started = this.now().getTime();
    let calls = 1;
    let res = await attempt(ctx.provider, primaryModel);
    if (!res.ok && res.reason === 'provider_error') {
      this.opts.onProviderFailure?.({ provider: ctx.provider.id, task: spec.task, detail: res.detail });
      if (ctx.failover) {
        const model = this.modelForTask(spec.task, ctx, ctx.failover, state);
        meta.provider = ctx.failover.id;
        meta.model = model;
        meta.failedOver = true;
        calls++;
        res = await attempt(ctx.failover, model);
        if (!res.ok && res.reason === 'provider_error') {
          this.opts.onProviderFailure?.({ provider: ctx.failover.id, task: spec.task, detail: res.detail });
        }
      }
    }
    meta.latencyMs = this.now().getTime() - started;
    if (res.ok) meta.model = res.model;
    state.spent += meta.costMicroUsd;
    await ctx.store.addUsage(meta.costMicroUsd, calls);

    if (!res.ok) {
      await record(res.reason, null, null);
      return { ok: false, reason: res.reason, detail: res.detail, meta };
    }
    const parsed = spec.schema.safeParse(res.json);
    const value = parsed.success
      ? spec.validate(parsed.data as never, { provider: meta.provider, model: meta.model })
      : null;
    if (value === null) {
      await record('invalid_output', null, null);
      return {
        ok: false,
        reason: 'invalid_output',
        detail: parsed.success ? 'failed validation' : 'schema mismatch',
        meta,
      };
    }
    await record('ok', spec.eventOutput ? spec.eventOutput(value) : value, spec.confidence?.(value) ?? null);
    return { ok: true, value, meta };
  }

  /**
   * Batched, per-item cached execution for row tasks (categorize, normalize_payees). Identical items (same
   * cache key) are sent once. Returns per-item results aligned with `items` (null = no answer).
   */
  private async runBatched<I, R>(args: {
    task: TaskName;
    ctx: AiContext;
    items: readonly I[];
    keyOf: (item: I, model: string) => string;
    toWire: (item: I, wireId: string) => unknown;
    system: string;
    promptVersion: string;
    context?: string;
    schema: z.ZodType;
    /** Maps one validated wire result to the cached form; null drops it. */
    fromWire: (result: never, answered: { provider: ProviderId; model: string }) => R | null;
    resultsOf: (parsed: never) => ReadonlyArray<{ id: string }>;
    isCacheable: (cached: unknown) => cached is R;
  }): Promise<{ results: (R | null)[]; meta: AiMeta; failure: Fail | null }> {
    const { task, ctx } = args;
    const route = DEFAULT_ROUTING[task];
    const state: RunState = { spent: 0n };
    const model = this.modelForTask(task, ctx, ctx.provider, state);
    const meta = emptyMeta(task, ctx, model, args.promptVersion);
    const started = this.now().getTime();
    const keys = args.items.map((i) => args.keyOf(i, model));
    const results: (R | null)[] = args.items.map(() => null);

    // 1. Cache (AIA-07)
    const unique = [...new Set(keys)];
    const cached = new Map<string, R>();
    if (route.cacheTtlDays > 0) {
      await Promise.all(
        unique.map(async (k) => {
          const hit = await ctx.store.cacheGet(task, k);
          if (hit !== null && args.isCacheable(hit)) cached.set(k, hit);
        }),
      );
    }
    keys.forEach((k, i) => {
      const hit = cached.get(k);
      if (hit !== undefined) {
        results[i] = hit;
        meta.cachedItems++;
      }
    });
    if (meta.cachedItems > 0) {
      await ctx.store.recordEvent({
        task,
        provider: ctx.provider.id,
        model,
        promptVersion: args.promptVersion,
        inputHash: sha256(unique.filter((k) => cached.has(k)).join('\n')),
        outcome: 'cached',
        output: null,
        confidence: null,
        items: meta.cachedItems,
        latencyMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        costMicroUsd: 0n,
        ...(ctx.subject ? { subject: ctx.subject } : {}),
      });
    }

    // 2. Misses, deduplicated by key, in batches
    const missKeys = unique.filter((k) => !cached.has(k));
    const firstIndex = new Map<string, number>();
    keys.forEach((k, i) => {
      if (!firstIndex.has(k)) firstIndex.set(k, i);
    });
    const batches = chunk(missKeys, route.batchSize);
    let failure: Fail | null = null;
    let answered = 0;
    const fresh = new Map<string, R>();
    await mapLimit(batches, this.concurrency, async (batch) => {
      const wire = batch.map((k, j) => args.toWire(args.items[firstIndex.get(k)!]!, `i${j}`));
      const res = await this.callProvider<Map<string, R>>(
        {
          task,
          system: args.system,
          promptVersion: args.promptVersion,
          ...(args.context ? { context: args.context } : {}),
          input: { items: wire },
          schema: args.schema,
          items: batch.length,
          validate: (parsed: never, ans) => {
            const byWire = new Map<string, R>();
            for (const r of args.resultsOf(parsed)) {
              const j = /^i(\d+)$/.exec(r.id);
              const k = j ? batch[Number(j[1])] : undefined;
              if (!k || byWire.has(k)) continue;
              const v = args.fromWire(r as never, ans);
              if (v !== null) byWire.set(k, v);
            }
            return byWire;
          },
          eventOutput: (v) => [...v.values()],
        },
        ctx,
        state,
      );
      if (res.meta) mergeMeta(meta, res.meta);
      if (!res.ok) {
        failure ??= res;
        return;
      }
      for (const [k, v] of res.value) {
        fresh.set(k, v);
        answered++;
        if (route.cacheTtlDays > 0) await ctx.store.cachePut(task, k, v, res.meta.model, route.cacheTtlDays);
      }
    });
    keys.forEach((k, i) => {
      const v = fresh.get(k);
      if (v !== undefined) results[i] = v;
    });
    meta.latencyMs = this.now().getTime() - started;
    // Only a total failure surfaces as a failure; partial answers are returned (the rest go to review).
    const total = failure !== null && answered === 0 && meta.cachedItems === 0 ? failure : null;
    return { results, meta, failure: total };
  }

  // ----- categorize (AI-01..03, AI-07) ---------------------------------------------------------------------

  async categorize(
    items: readonly CategorizeItem[],
    options: { categories: readonly CategoryOption[]; members: readonly MemberOption[] },
    ctx: AiContext,
  ): Promise<TaskResult<CategorizeOutput[]>> {
    const pv = categorizeV1.PROMPT_VERSION;
    if (this.isOff(ctx)) return { ok: false, reason: 'off' };
    if (items.length === 0) return { ok: true, value: [], meta: emptyMeta('categorize', ctx, '', pv) };

    const categories = [...options.categories].sort((a, b) =>
      `${a.entityType}|${a.group ?? ''}|${a.name}|${a.id}`.localeCompare(
        `${b.entityType}|${b.group ?? ''}|${b.name}|${b.id}`,
      ),
    );
    const catShort = new Map(categories.map((c, i) => [`c${i + 1}`, c]));
    const catById = new Map(categories.map((c) => [c.id, c]));
    const categoryListHash = sha256(categories.map((c) => `${c.id}:${c.name}:${c.group ?? ''}`).join('\n'));
    const pseudonyms = memberPseudonyms(options.members, ctx.pseudonyms);
    const memberShort = new Map(options.members.map((m, i) => [`m${i + 1}`, m]));
    const memberIds = new Set(options.members.map((m) => m.id));
    const context = JSON.stringify({
      categories: categories.map((c, i) => ({
        id: `c${i + 1}`,
        name: c.name,
        group: c.group,
        kind: c.kind,
        entity: c.entityType,
      })),
      members: options.members.map((m, i) => ({
        id: `m${i + 1}`,
        token: pseudonyms.find((p) => p.name === m.name)?.token ?? `MEMBER_${i + 1}`,
        relationship: m.relationship,
      })),
    });

    type Cached = {
      categoryId: string | null;
      memberId: string | null;
      tags: string[];
      raw: number;
      reason: string;
      merchant: { name: string; mcc: string | null } | null;
      provider: ProviderId;
      model: string;
    };

    const run = await this.runBatched<CategorizeItem, Cached>({
      task: 'categorize',
      ctx,
      items,
      system: categorizeV1.SYSTEM,
      promptVersion: pv,
      context,
      schema: categorizeV1.Output,
      keyOf: (i, model) =>
        sha256(
          [
            'categorize',
            model,
            pv,
            normalizeDescription(i.payee || i.description),
            amountBand(i.amountMinor, exponentOf(i.currency)),
            i.accountType,
            i.entityType,
            categoryListHash,
          ].join('|'),
        ),
      toWire: (i, id) => {
        const d = minimizeDate(i.date);
        return {
          id,
          payee: i.payee ? minimizeText(i.payee, pseudonyms) : null,
          description: minimizeText(i.description, pseudonyms),
          amount: roundedAmount(i.amountMinor, exponentOf(i.currency)),
          currency: i.currency,
          month: d.month,
          weekday: d.weekday,
          account: i.accountType,
          entity: i.entityType,
        };
      },
      resultsOf: (p: categorizeV1.Output) => p.results,
      fromWire: (r: categorizeV1.Output['results'][number], ans) => ({
        categoryId: (r.category && catShort.get(r.category)?.id) || null,
        memberId: (r.member && memberShort.get(r.member)?.id) || null,
        tags: r.tags
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 3),
        raw: round3(clamp01(r.confidence)),
        reason: oneLine(unpseudonymize(r.reason, pseudonyms), 100),
        merchant: r.merchant?.name
          ? {
              name: oneLine(r.merchant.name, 80),
              mcc: r.merchant.mcc && /^\d{4}$/.test(r.merchant.mcc) ? r.merchant.mcc : null,
            }
          : null,
        provider: ans.provider,
        model: ans.model,
      }),
      isCacheable: (v): v is Cached =>
        !!v &&
        typeof v === 'object' &&
        'raw' in v &&
        ((v as Cached).categoryId === null || catById.has((v as Cached).categoryId!)) &&
        ((v as Cached).memberId === null || memberIds.has((v as Cached).memberId!)),
    });
    if (run.failure) return run.failure;

    const value = items.map((item, i): CategorizeOutput => {
      const r = run.results[i];
      if (!r) {
        return {
          id: item.id,
          categoryId: null,
          memberId: null,
          tags: [],
          confidence: 0,
          rawConfidence: 0,
          explanation: '',
          merchant: null,
        };
      }
      const cat = r.categoryId ? catById.get(r.categoryId) : undefined;
      const confidence = cat ? round3(calibrate(r.provider, r.model, 'categorize', r.raw)) : 0;
      return {
        id: item.id,
        categoryId: cat?.id ?? null,
        memberId: r.memberId,
        tags: r.tags,
        confidence,
        rawConfidence: r.raw,
        explanation: oneLine(cat ? `AI: ${r.reason} → ${cat.name}` : `AI: ${r.reason}`),
        merchant: r.merchant,
      };
    });
    return { ok: true, value, meta: run.meta };
  }

  // ----- normalize_payees (IMP-10 fallback, AI-07) ---------------------------------------------------------

  async normalizePayees(raw: readonly string[], ctx: AiContext): Promise<TaskResult<PayeeNormalization[]>> {
    const pv = normalizeV1.PROMPT_VERSION;
    if (this.isOff(ctx)) return { ok: false, reason: 'off' };
    if (raw.length === 0) return { ok: true, value: [], meta: emptyMeta('normalize_payees', ctx, '', pv) };
    type Cached = Omit<PayeeNormalization, 'raw'>;
    const run = await this.runBatched<string, Cached>({
      task: 'normalize_payees',
      ctx,
      items: raw,
      system: normalizeV1.SYSTEM,
      promptVersion: pv,
      schema: normalizeV1.Output,
      keyOf: (r, model) => sha256(['normalize_payees', model, pv, normalizeDescription(r)].join('|')),
      toWire: (r, id) => ({ id, raw: minimizeText(r, ctx.pseudonyms) }),
      resultsOf: (p: normalizeV1.Output) => p.results,
      fromWire: (r: normalizeV1.Output['results'][number]) =>
        r.name.trim()
          ? {
              name: oneLine(unpseudonymize(r.name, ctx.pseudonyms), 80),
              kind: r.kind,
              mcc: r.mcc && /^\d{4}$/.test(r.mcc) ? r.mcc : null,
              confidence: round3(clamp01(r.confidence)),
            }
          : null,
      isCacheable: (v): v is Cached => !!v && typeof v === 'object' && 'name' in v && 'kind' in v,
    });
    if (run.failure) return run.failure;
    return {
      ok: true,
      value: raw.map((r, i) =>
        run.results[i]
          ? { raw: r, ...run.results[i]! }
          : { raw: r, name: r, kind: 'unknown', mcc: null, confidence: 0 },
      ),
      meta: run.meta,
    };
  }

  // ----- map_columns (IMP-03) ------------------------------------------------------------------------------

  async mapColumns(sample: GridSample, ctx: AiContext): Promise<TaskResult<ColumnMappingProposal>> {
    if (this.isOff(ctx)) return { ok: false, reason: 'off' };
    const rows = sample.rows.slice(0, 30).map((r) => r.map((c) => maskText(c)));
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const inRange = (c: number | null | undefined) => c === null || c === undefined || (c >= 0 && c < width);
    return this.callProvider<ColumnMappingProposal>(
      {
        task: 'map_columns',
        system: mapColumnsV1.SYSTEM,
        promptVersion: mapColumnsV1.PROMPT_VERSION,
        input: { fileType: sample.fileType, locale: sample.locale, accountType: sample.accountType, rows },
        schema: mapColumnsV1.Output,
        validate: (o: mapColumnsV1.Output, ans) => {
          const cols = [
            o.date,
            o.payee,
            o.amount,
            o.debit,
            o.credit,
            o.balance,
            o.category,
            o.reference,
            o.direction?.column,
            ...o.description,
          ];
          if (!cols.every(inRange)) return null;
          if (o.description.length === 0 || o.description.length > 4) return null;
          if (o.amount === null && (o.debit === null || o.credit === null)) return null;
          if (o.headerRow !== null && (o.headerRow < 0 || o.headerRow >= rows.length)) return null;
          if (o.dataStart < 0 || o.dataStart >= Math.max(rows.length, 1)) return null;
          const mapping: ColumnMapping = {
            headerRow: o.headerRow,
            dataStart: o.dataStart,
            date: o.date,
            dateFormat: o.dateFormat,
            description: o.description,
            sign: o.sign,
            decimal: o.decimal,
            ...(o.payee !== null ? { payee: o.payee } : {}),
            ...(o.amount !== null ? { amount: o.amount } : { debit: o.debit!, credit: o.credit! }),
            ...(o.direction
              ? {
                  direction: {
                    column: o.direction.column,
                    debitValues: o.direction.debitValues.slice(0, 10),
                  },
                }
              : {}),
            ...(o.balance !== null ? { balance: o.balance } : {}),
            ...(o.category !== null ? { category: o.category } : {}),
            ...(o.reference !== null ? { reference: o.reference } : {}),
          };
          return {
            mapping,
            confidence: round3(calibrate(ans.provider, ans.model, 'map_columns', o.confidence)),
          };
        },
        confidence: (v) => v.confidence,
      },
      ctx,
      { spent: 0n },
    );
  }

  // ----- parse_quick_add (TXN-06) --------------------------------------------------------------------------

  async parseQuickAdd(
    text: string,
    qctx: QuickAddContext,
    ctx: AiContext,
  ): Promise<TaskResult<TransactionDraft>> {
    if (this.isOff(ctx)) return { ok: false, reason: 'off' };
    const pseudonyms = memberPseudonyms(qctx.members, ctx.pseudonyms);
    const accounts = new Map(qctx.accounts.map((a, i) => [`a${i + 1}`, a.id]));
    const cats = new Map(qctx.categories.map((c, i) => [`c${i + 1}`, c.id]));
    const members = new Map(qctx.members.map((m, i) => [`m${i + 1}`, m.id]));
    return this.callProvider<TransactionDraft>(
      {
        task: 'parse_quick_add',
        system: quickAddV1.SYSTEM,
        promptVersion: quickAddV1.PROMPT_VERSION,
        input: {
          today: qctx.today,
          currency: qctx.currency,
          accounts: qctx.accounts.map((a, i) => ({
            id: `a${i + 1}`,
            label: maskText(a.label),
            kind: a.kind,
          })),
          categories: qctx.categories.map((c, i) => ({
            id: `c${i + 1}`,
            name: c.name,
            group: c.group,
            kind: c.kind,
          })),
          members: qctx.members.map((m, i) => ({
            id: `m${i + 1}`,
            token: pseudonyms.find((p) => p.name === m.name)?.token ?? `MEMBER_${i + 1}`,
            relationship: m.relationship,
          })),
          // Digits stay: "1200 rent" is the amount.
          note: minimizeText(text, pseudonyms, { keepDigits: true }),
        },
        schema: quickAddV1.Output,
        validate: (o: quickAddV1.Output, ans) => {
          let amount = o.amount?.replace(/[\s,$€£]/g, '') ?? null;
          let direction = o.direction;
          if (amount?.startsWith('-')) {
            amount = amount.slice(1);
            direction = 'out';
          }
          if (amount !== null && (!POSITIVE_DECIMAL.test(amount) || Number(amount) === 0)) amount = null;
          const un = (s: string | null) => (s ? unpseudonymize(s, pseudonyms).trim() || null : null);
          return {
            date: validIsoDate(o.date) ? o.date : null,
            amount,
            direction,
            payee: un(o.payee),
            accountId: (o.account && accounts.get(o.account)) || null,
            categoryId: (o.category && cats.get(o.category)) || null,
            memberId: (o.member && members.get(o.member)) || null,
            memo: un(o.memo),
            tags: o.tags
              .map((t) => t.replace(/^#/, '').trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 3),
            confidence: round3(calibrate(ans.provider, ans.model, 'parse_quick_add', o.confidence)),
          };
        },
        confidence: (v) => v.confidence,
      },
      ctx,
      { spent: 0n },
    );
  }

  // ----- extract_statement_table (IMP-05 scanned) ----------------------------------------------------------

  async extractStatementTable(doc: StatementText, ctx: AiContext): Promise<TaskResult<StatementTable>> {
    const pv = extractV1.PROMPT_VERSION;
    if (this.isOff(ctx)) return { ok: false, reason: 'off' };
    const route = DEFAULT_ROUTING.extract_statement_table;
    const chunks = chunk(
      doc.pages.map((p) => maskText(p)),
      route.batchSize,
    );
    if (chunks.length === 0)
      return {
        ok: true,
        value: { rows: [], opening: null, closing: null, periodStart: null, periodEnd: null },
        meta: emptyMeta('extract_statement_table', ctx, '', pv),
      };
    const state: RunState = { spent: 0n };
    const meta = emptyMeta('extract_statement_table', ctx, '', pv);
    const parts = await mapLimit(chunks, Math.min(4, this.concurrency), (pages, n) =>
      this.callProvider<StatementTable>(
        {
          task: 'extract_statement_table',
          system: extractV1.SYSTEM,
          promptVersion: pv,
          input: { currency: doc.currency, firstPage: n * route.batchSize + 1, pages },
          schema: extractV1.Output,
          validate: (o: extractV1.Output) => {
            const rows = o.rows
              .map((r) => ({
                date: r.date,
                description: oneLine(r.description, 300),
                amount: cleanDecimal(r.amount),
                balance: cleanDecimal(r.balance),
              }))
              .filter(
                (r): r is StatementTable['rows'][number] =>
                  validIsoDate(r.date) && r.amount !== null && r.description !== '',
              );
            if (o.rows.length > 0 && rows.length < o.rows.length / 2) return null;
            return {
              rows,
              opening: cleanDecimal(o.opening),
              closing: cleanDecimal(o.closing),
              periodStart: validIsoDate(o.periodStart) ? o.periodStart : null,
              periodEnd: validIsoDate(o.periodEnd) ? o.periodEnd : null,
            };
          },
          eventOutput: (v) => ({ rows: v.rows.length, opening: v.opening, closing: v.closing }),
        },
        ctx,
        state,
      ),
    );
    for (const p of parts) {
      if (p.meta) mergeMeta(meta, p.meta);
      if (!p.ok) return { ...p, meta };
    }
    const ok = parts as Array<{ ok: true; value: StatementTable; meta: AiMeta }>;
    meta.latencyMs = ok.reduce((m, p) => Math.max(m, p.meta.latencyMs), 0);
    return {
      ok: true,
      value: {
        rows: ok.flatMap((p) => p.value.rows),
        opening: ok.find((p) => p.value.opening !== null)?.value.opening ?? null,
        closing: [...ok].reverse().find((p) => p.value.closing !== null)?.value.closing ?? null,
        periodStart: ok.find((p) => p.value.periodStart !== null)?.value.periodStart ?? null,
        periodEnd: [...ok].reverse().find((p) => p.value.periodEnd !== null)?.value.periodEnd ?? null,
      },
      meta,
    };
  }

  // ----- propose_categories (UP-03) ------------------------------------------------------------------------

  async proposeCategories(
    input: CategoryProposalInput,
    ctx: AiContext,
  ): Promise<TaskResult<CategoryProposalOutput>> {
    if (this.isOff(ctx)) return { ok: false, reason: 'off' };
    const payees = input.payees.slice(0, 300);
    const byId = new Map(payees.map((p, i) => [`p${i + 1}`, p.payee]));
    const existing = new Map(input.existing.map((e) => [e.trim().toLowerCase(), e]));
    return this.callProvider<CategoryProposalOutput>(
      {
        task: 'propose_categories',
        system: proposeV1.SYSTEM,
        promptVersion: proposeV1.PROMPT_VERSION,
        input: {
          entityType: input.entityType,
          existing: input.existing,
          payees: payees.map((p, i) => ({
            id: `p${i + 1}`,
            payee: minimizeText(p.payee, ctx.pseudonyms),
            rows: p.rows,
            total: roundedAmount(p.totalMinor, 2),
          })),
        },
        schema: proposeV1.Output,
        validate: (o: proposeV1.Output) => {
          const proposed = new Map<string, CategoryProposalOutput['categories'][number]>();
          for (const c of o.categories) {
            const name = oneLine(c.name, 60);
            const key = name.toLowerCase();
            if (!name || existing.has(key) || proposed.has(key)) continue;
            proposed.set(key, { name, group: oneLine(c.group, 40) || 'Other', kind: c.kind });
            if (proposed.size >= 25) break;
          }
          const assignments: CategoryProposalOutput['assignments'] = [];
          const seen = new Set<string>();
          for (const a of o.assignments) {
            const payee = byId.get(a.payee);
            const key = a.category.trim().toLowerCase();
            const category = proposed.get(key)?.name ?? existing.get(key);
            if (!payee || !category || seen.has(payee)) continue;
            seen.add(payee);
            assignments.push({ payee, category });
          }
          return { categories: [...proposed.values()], assignments };
        },
        eventOutput: (v) => ({ categories: v.categories, assignments: v.assignments.length }),
      },
      ctx,
      { spent: 0n },
    );
  }

  // ----- ping ----------------------------------------------------------------------------------------------

  async ping(ctx: AiContext): Promise<TaskResult<{ model: string }>> {
    if (this.isOff(ctx)) return { ok: false, reason: 'off' };
    return this.callProvider<{ model: string }>(
      {
        task: 'ping',
        system: pingV1.SYSTEM,
        promptVersion: pingV1.PROMPT_VERSION,
        input: 'ping',
        schema: pingV1.Output,
        validate: (o: pingV1.Output, ans) => (o.ok ? { model: ans.model } : null),
      },
      ctx,
      { spent: 0n },
    );
  }
}

/** Stable pseudonyms for members (MEMBER_1, …), merged with any the caller supplies (tenants etc.). */
function memberPseudonyms(members: readonly MemberOption[], extra: AiContext['pseudonyms']): Pseudonym[] {
  const out: Pseudonym[] = [...(extra ?? [])];
  members.forEach((m, i) => {
    if (!out.some((p) => p.name.toLowerCase() === m.name.toLowerCase()))
      out.push({ name: m.name, token: `MEMBER_${i + 1}` });
  });
  return out;
}

export function createGateway(opts?: GatewayOptions): AiGateway {
  return new Gateway(opts);
}
