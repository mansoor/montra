import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  createGateway,
  type AiContext,
  type AiEventRecord,
  type AiGateway,
  type AiMode,
  type GatewayStore,
  type ProviderConfig,
  type TaskName,
} from '@montra/ai-gateway';
import type { AiDisclosureDto, AiSettingsDto, UpdateAiSettingsRequest } from '@montra/schemas';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { unprocessable } from '../common/errors.js';

type Ctx = { workspaceId: string; userId: string };

/** Stored in `workspace.ai_settings` (03 §1). The BYOK key lives encrypted in `ai_credential`. */
interface StoredSettings {
  provider?: 'anthropic' | 'openai_compatible';
  endpoint?: string | null;
  models?: { small?: string | null; vision?: string | null; large?: string | null };
  threshold?: number;
  monthlyBudgetUsd?: number | null;
  allowDocumentsToLlm?: boolean;
  failover?: boolean;
}

export interface AiRuntime {
  ctx: AiContext;
  mode: AiMode;
  threshold: number;
  allowDocumentsToLlm: boolean;
  /** False when the mode can't run anything (off, or no key/endpoint configured). */
  available: boolean;
}

export const DEFAULT_THRESHOLD = 0.8;
const CACHE_TTL_DAYS = 90;

/** Per-mode privacy disclosure shown next to each choice (UP-06). Plain language, no marketing. */
export const AI_DISCLOSURES: AiDisclosureDto[] = [
  {
    mode: 'builtin',
    title: 'Built-in AI (hosted by Montra)',
    points: [
      'Payee text, a rounded amount, the account type and your category names are sent to our AI provider (Anthropic) under a data processing agreement.',
      'Account numbers, card numbers, emails and phone numbers are masked first; family member names are replaced with placeholders.',
      'Your data is not used to train models. Requests are not stored by Montra beyond the audit log you can view and delete.',
      'Statement scans and payslip images are only sent if you turn on "Allow documents".',
    ],
  },
  {
    mode: 'byok',
    title: 'Your own API key',
    points: [
      'Requests go from our servers to the provider you choose, with your key, under your agreement with that provider.',
      'The same masking applies before anything is sent. The key is stored encrypted and never shown again.',
      "Check your provider's data-use policy: it decides retention and training, not Montra.",
    ],
  },
  {
    mode: 'local',
    title: 'Local model (Ollama, LM Studio, vLLM)',
    points: [
      'Requests go to the endpoint you enter, usually on your own computer or network. Nothing is sent to a cloud AI provider.',
      'On the hosted service, AI work for imports waits until a Montra window is open on the same network, which runs it against your endpoint.',
      'Local models are usually less accurate; more items will land in the review queue.',
    ],
  },
  {
    mode: 'off',
    title: 'AI off',
    points: [
      'Nothing is sent to any AI provider.',
      'Categories still come from your rules, your history and the known-merchant list; everything else goes to the review queue.',
    ],
  },
];

const monthStart = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;

/**
 * Resolves a workspace's AI mode into an `AiContext` for the gateway (06 §2), backs the gateway's cache,
 * audit log and usage counter with the database, and serves the AI settings and audit endpoints.
 */
@Injectable()
export class AiService {
  readonly gateway: AiGateway;
  private readonly logger = new Logger('ai');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {
    this.gateway = createGateway({
      onProviderFailure: (e) =>
        // OPS-07: surfaced as a structured log line for alerting; the failover (if any) already ran.
        this.logger.warn(`ai provider failure provider=${e.provider} task=${e.task} detail=${e.detail}`),
    });
  }

  /** Builds the gateway context for a workspace. Reads run in the caller's transaction. */
  async runtime(trx: Trx, ctx: Ctx, subject?: { type: string; id: string }): Promise<AiRuntime> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select(['ai_mode', 'ai_settings'])
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    const s = (ws.ai_settings ?? {}) as StoredSettings;
    const mode = ws.ai_mode;
    const provider = await this.providerFor(trx, ctx, mode, s);
    const failover =
      mode !== 'off' && s.failover && this.config.AI_FAILOVER_PROVIDER
        ? ({
            id: this.config.AI_FAILOVER_PROVIDER,
            apiKey: this.config.ANTHROPIC_API_KEY,
            baseUrl: this.config.AI_FAILOVER_BASE_URL,
          } satisfies ProviderConfig)
        : undefined;
    const usage = await trx
      .selectFrom('app.ai_usage')
      .select('cost_micro_usd')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('month', '=', monthStart())
      .executeTakeFirst();
    const members = await trx
      .selectFrom('app.family_member')
      .select(['name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .orderBy('created_at')
      .execute();
    const aiCtx: AiContext = {
      workspaceId: ctx.workspaceId,
      mode,
      provider,
      failover,
      budget: { monthlyUsd: s.monthlyBudgetUsd ?? null, spentMicroUsd: usage?.cost_micro_usd ?? 0n },
      store: this.store(ctx),
      pseudonyms: members.map((m, i) => ({ name: m.name, token: `MEMBER_${i + 1}` })),
      parkLocal: mode === 'local' && !this.config.AI_LOCAL_DIRECT,
      subject,
    };
    return {
      ctx: aiCtx,
      mode,
      threshold: s.threshold ?? DEFAULT_THRESHOLD,
      allowDocumentsToLlm: s.allowDocumentsToLlm ?? false,
      available: provider.id !== 'null',
    };
  }

  private async providerFor(trx: Trx, ctx: Ctx, mode: AiMode, s: StoredSettings): Promise<ProviderConfig> {
    if (mode === 'off') return { id: 'null' };
    const models = {
      ...(s.models?.small ? { small: s.models.small } : {}),
      ...(s.models?.vision ? { vision: s.models.vision } : {}),
      ...(s.models?.large ? { large: s.models.large } : {}),
    };
    // Tests and e2e: every enabled mode answers with the deterministic provider.
    if (this.config.AI_PROVIDER === 'fake') return { id: 'fake', models };
    if (mode === 'builtin') {
      const id = this.config.AI_PROVIDER;
      if (id === 'anthropic' && !this.config.ANTHROPIC_API_KEY) return { id: 'null' };
      if (id === 'openai_compatible' && !this.config.AI_BASE_URL) return { id: 'null' };
      return { id, apiKey: this.config.ANTHROPIC_API_KEY, baseUrl: this.config.AI_BASE_URL };
    }
    if (mode === 'local') {
      if (!s.endpoint) return { id: 'null' };
      return { id: 'openai_compatible', baseUrl: s.endpoint, models };
    }
    const provider = s.provider ?? 'anthropic';
    const cred = await trx
      .selectFrom('app.ai_credential')
      .select('key_enc')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('provider', '=', provider)
      .executeTakeFirst();
    const apiKey = cred
      ? await this.crypto.decrypt(trx, ctx.workspaceId, `ai_credential.${provider}`, cred.key_enc)
      : null;
    if (!apiKey && provider === 'anthropic') return { id: 'null' };
    return { id: provider, apiKey: apiKey ?? undefined, baseUrl: s.endpoint ?? undefined, models };
  }

  /**
   * The gateway's persistence. Each write is its own short transaction so audit entries and spend survive
   * a rollback of the caller's work (a failed import still spent the tokens).
   */
  private store(ctx: Ctx): GatewayStore {
    const run = <T>(fn: (trx: Trx) => Promise<T>) => this.db.run(ctx, fn);
    return {
      cacheGet: async (task: TaskName, keyHash: string) => {
        const row = await run((trx) =>
          trx
            .selectFrom('app.ai_cache')
            .select('output')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('task', '=', task)
            .where('key_hash', '=', keyHash)
            .where('expires_at', '>', new Date())
            .executeTakeFirst(),
        );
        return row?.output ?? null;
      },
      cachePut: async (task, keyHash, output, model, ttlDays = CACHE_TTL_DAYS) => {
        await run((trx) =>
          trx
            .insertInto('app.ai_cache')
            .values({
              workspace_id: ctx.workspaceId,
              task,
              key_hash: keyHash,
              output: JSON.stringify(output),
              model,
              expires_at: new Date(Date.now() + ttlDays * 86_400_000),
            })
            .onConflict((oc) =>
              oc.columns(['workspace_id', 'task', 'key_hash']).doUpdateSet({
                output: (eb) => eb.ref('excluded.output'),
                model: (eb) => eb.ref('excluded.model'),
                expires_at: (eb) => eb.ref('excluded.expires_at'),
              }),
            )
            .execute(),
        );
      },
      recordEvent: async (e: AiEventRecord) => {
        await run((trx) =>
          trx
            .insertInto('app.ai_event')
            .values({
              workspace_id: ctx.workspaceId,
              task: e.task,
              provider: e.provider,
              model: e.model,
              prompt_version: e.promptVersion,
              input_hash: e.inputHash,
              outcome: e.outcome,
              output: e.output === undefined || e.output === null ? null : JSON.stringify(e.output),
              confidence: e.confidence === null ? null : e.confidence.toFixed(3),
              items: e.items,
              latency_ms: e.latencyMs,
              tokens_in: e.tokensIn,
              tokens_out: e.tokensOut,
              cost_micro_usd: e.costMicroUsd,
              user_action: e.task === 'categorize' && e.outcome === 'ok' ? 'pending' : null,
              subject_type: e.subject?.type ?? null,
              subject_id: e.subject?.id ?? null,
            })
            .execute(),
        );
      },
      addUsage: async (cost: bigint, calls: number) => {
        await run((trx) =>
          sql`insert into app.ai_usage (workspace_id, month, calls, cost_micro_usd)
              values (${ctx.workspaceId}, ${monthStart()}, ${calls}, ${cost})
              on conflict (workspace_id, month) do update
                set calls = app.ai_usage.calls + excluded.calls,
                    cost_micro_usd = app.ai_usage.cost_micro_usd + excluded.cost_micro_usd`.execute(trx),
        );
      },
      parkLocal: async (task: TaskName, input: unknown) => {
        await run((trx) =>
          trx
            .insertInto('app.ai_task')
            .values({
              workspace_id: ctx.workspaceId,
              task,
              input: JSON.stringify(input),
              subject_type: 'workspace',
              subject_id: ctx.workspaceId,
            })
            .execute(),
        );
      },
    };
  }

  // ----- Settings (UP-13) ----------------------------------------------------------------------------------

  async settings(trx: Trx, ctx: Ctx): Promise<AiSettingsDto> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select(['ai_mode', 'ai_settings'])
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    const s = (ws.ai_settings ?? {}) as StoredSettings;
    const provider = s.provider ?? 'anthropic';
    const cred = await trx
      .selectFrom('app.ai_credential')
      .select('last4')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('provider', '=', provider)
      .executeTakeFirst();
    const usage = await trx
      .selectFrom('app.ai_usage')
      .select(['calls', 'cost_micro_usd'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('month', '=', monthStart())
      .executeTakeFirst();
    const spentUsd = Number(usage?.cost_micro_usd ?? 0n) / 1e6;
    const budget = s.monthlyBudgetUsd ?? null;
    const ratio = budget === null ? 0 : budget === 0 ? Infinity : spentUsd / budget;
    return {
      mode: ws.ai_mode,
      provider,
      endpoint: s.endpoint ?? null,
      models: { small: s.models?.small ?? null, vision: s.models?.vision ?? null, large: s.models?.large ?? null },
      hasKey: Boolean(cred),
      keyLast4: cred?.last4 ?? null,
      threshold: s.threshold ?? DEFAULT_THRESHOLD,
      monthlyBudgetUsd: budget,
      allowDocumentsToLlm: s.allowDocumentsToLlm ?? false,
      failover: s.failover ?? false,
      usage: {
        month: monthStart().slice(0, 7),
        calls: usage?.calls ?? 0,
        spentUsd: Math.round(spentUsd * 10_000) / 10_000,
        state: ratio >= 1 ? 'exhausted' : ratio >= 0.8 ? 'downgraded' : 'ok',
      },
      disclosures: AI_DISCLOSURES,
    };
  }

  async updateSettings(trx: Trx, ctx: Ctx, req: UpdateAiSettingsRequest): Promise<void> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select(['ai_mode', 'ai_settings'])
      .where('id', '=', ctx.workspaceId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const s: StoredSettings = { ...((ws.ai_settings ?? {}) as StoredSettings) };
    if (req.provider !== undefined) s.provider = req.provider;
    if (req.endpoint !== undefined) s.endpoint = req.endpoint;
    if (req.models !== undefined) s.models = req.models;
    if (req.threshold !== undefined) s.threshold = req.threshold;
    if (req.monthlyBudgetUsd !== undefined) s.monthlyBudgetUsd = req.monthlyBudgetUsd;
    if (req.allowDocumentsToLlm !== undefined) s.allowDocumentsToLlm = req.allowDocumentsToLlm;
    if (req.failover !== undefined) s.failover = req.failover;
    const mode = req.mode ?? ws.ai_mode;
    if (mode === 'local' && !s.endpoint)
      throw unprocessable('ai.endpoint_required', 'Local mode needs the URL of your model server');
    const provider = s.provider ?? 'anthropic';
    if (req.clearKey) {
      await trx
        .deleteFrom('app.ai_credential')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('provider', '=', provider)
        .execute();
    }
    if (req.apiKey) {
      const keyEnc = await this.crypto.encrypt(trx, ctx.workspaceId, `ai_credential.${provider}`, req.apiKey);
      await trx
        .insertInto('app.ai_credential')
        .values({
          workspace_id: ctx.workspaceId,
          provider,
          key_enc: keyEnc!,
          last4: req.apiKey.slice(-4),
          created_by: ctx.userId,
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'provider']).doUpdateSet({
            key_enc: (eb) => eb.ref('excluded.key_enc'),
            last4: (eb) => eb.ref('excluded.last4'),
            created_by: (eb) => eb.ref('excluded.created_by'),
          }),
        )
        .execute();
    }
    await trx
      .updateTable('app.workspace')
      .set({ ai_mode: mode, ai_settings: JSON.stringify(s) })
      .where('id', '=', ctx.workspaceId)
      .execute();
  }
}
