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
import { aiAlertPct, aiLimitMicroUsd, aiUsedShare } from '@montra/domain';
import type { AiDisclosureDto, AiProblem, AiSettingsDto, UpdateAiSettingsRequest } from '@montra/schemas';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { AppError, unprocessable } from '../common/errors.js';
import { MAIL_PORT, type MailPort } from '../mail/mail.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { Plans } from '../ops/plans.js';

type Ctx = { workspaceId: string; userId: string };

type AiProvider = NonNullable<StoredSettings['provider']>;

/** Stored in `workspace.ai_settings` (03 §1). The BYOK key lives encrypted in `ai_credential`. */
interface StoredSettings {
  provider?: 'anthropic' | 'openai_compatible';
  endpoint?: string | null;
  models?: { small?: string | null; vision?: string | null; large?: string | null };
  threshold?: number;
  monthlyBudgetUsd?: number | null;
  allowDocumentsToLlm?: boolean;
  allowReceiptImagesToLlm?: boolean;
  failover?: boolean;
}

export interface AiRuntime {
  ctx: AiContext;
  mode: AiMode;
  threshold: number;
  allowDocumentsToLlm: boolean;
  /** Receipt images may go to the provider (builtin/BYOK only); otherwise receipts are OCR'd first. */
  allowReceiptImages: boolean;
  /** False when the mode can't run anything (off, or no key/endpoint configured). */
  available: boolean;
  /** Why a mode that is on can't run (null when it can, or when AI is off). */
  problem: AiProblem | null;
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

/**
 * What to tell the user when AI can't run, with the fix. Features that degrade without AI put this in their
 * warnings instead of a bare "AI is off", so a BYOK workspace with no key doesn't look switched off.
 */
export const AI_PROBLEM_TEXT: Record<AiProblem, string> = {
  no_key: 'AI is set to use your own API key, but no key is saved. Add one in Settings → AI.',
  no_endpoint: 'AI is set to a local model, but no model URL is saved. Add one in Settings → AI.',
  not_configured: "Built-in AI isn't set up on this server. Choose another mode in Settings → AI.",
};

/**
 * The warning a feature stores when AI can't run, ending with what to do meanwhile: "AI is off: enter the
 * lines yourself", or the reason and fix when AI is on but can't run.
 */
export const aiUnavailableWarning = (r: Pick<AiRuntime, 'problem'>, meanwhile: string) =>
  r.problem ? `${AI_PROBLEM_TEXT[r.problem]} Until then, ${meanwhile}.` : `AI is off: ${meanwhile}`;

const monthStart = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;

/** ADR-0049 §2: the operator's monthly limit on built-in AI across the service, in millionths of a dollar. */
export const AI_CEILING_SETTING = 'ai_monthly_ceiling_micro_usd';
/** The service's spend is a sum over every workspace, so it's read at most this often. */
const SERVICE_SPEND_TTL_MS = 60_000;

export async function readAiCeiling(trx: Trx): Promise<bigint | null> {
  const row = await trx
    .selectFrom('app.system_setting')
    .select('value')
    .where('key', '=', AI_CEILING_SETTING)
    .executeTakeFirst();
  return row && /^\d{1,20}$/.test(row.value) ? BigInt(row.value) : null;
}

/** What the workspace's owners are told at 80% and 100% of the month's AI (ADR-0049 §2). */
const ALLOWANCE_NOTICE: Record<80 | 100, { title: string; body: string }> = {
  80: {
    title: 'You’ve used 80% of this month’s AI',
    body: 'Montra now uses a smaller model to make it last. When it’s used up, AI tasks wait until next month: transactions are categorized by your rules, and scans and statements can still be filed and entered by hand.',
  },
  100: {
    title: 'This month’s AI is used up',
    body: 'Until next month, transactions are categorized by your rules, scans and statements can still be filed and entered by hand, and voice entry is off. Nothing already done is undone.',
  },
};

/**
 * Resolves a workspace's AI mode into an `AiContext` for the gateway (06 §2), backs the gateway's cache,
 * audit log and usage counter with the database, and serves the AI settings and audit endpoints.
 */
@Injectable()
export class AiService {
  readonly gateway: AiGateway;
  private readonly logger = new Logger('ai');
  private serviceSpend: { month: string; at: number; micro: bigint } | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(Plans) private readonly plans: Plans,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
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
    const problem = await this.problemFor(trx, ctx, mode, s);
    const provider = problem ? ({ id: 'null' } as const) : await this.providerFor(trx, ctx, mode, s);
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
    // ADR-0049 §2: the plan's allowance is on what the service pays for, built-in AI. The operator's ceiling stops
    // all of it at once. A customer's own key or model is theirs, and only their own budget applies.
    const planMicroUsd = mode === 'builtin' ? await this.plans.aiAllowance(trx) : null;
    const ceilingReached = mode === 'builtin' && (await this.ceilingReached(trx));
    const customerUsd = s.monthlyBudgetUsd ?? null;
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
      budget: {
        monthlyUsd: customerUsd,
        planMicroUsd: ceilingReached ? 0n : planMicroUsd,
        spentMicroUsd: usage?.cost_micro_usd ?? 0n,
      },
      store: this.store(ctx, mode, aiLimitMicroUsd(planMicroUsd, customerUsd)),
      pseudonyms: members.map((m, i) => ({ name: m.name, token: `MEMBER_${i + 1}` })),
      parkLocal: mode === 'local' && !this.config.AI_LOCAL_DIRECT,
      subject,
    };
    return {
      ctx: aiCtx,
      mode,
      threshold: s.threshold ?? DEFAULT_THRESHOLD,
      allowDocumentsToLlm: s.allowDocumentsToLlm ?? false,
      allowReceiptImages: (mode === 'builtin' || mode === 'byok') && (s.allowReceiptImagesToLlm ?? false),
      available: provider.id !== 'null',
      problem,
    };
  }

  /**
   * Why a mode that is on can't run. BYOK and local are the workspace's own settings, so they count even with
   * the fake provider; built-in depends on this server's provider config, which `fake` satisfies.
   */
  private async problemFor(trx: Trx, ctx: Ctx, mode: AiMode, s: StoredSettings): Promise<AiProblem | null> {
    if (mode === 'off') return null;
    if (mode === 'local') return s.endpoint ? null : 'no_endpoint';
    if (mode === 'byok') {
      const provider = s.provider ?? 'anthropic';
      if (provider !== 'anthropic') return null;
      return (await this.hasKey(trx, ctx, provider)) ? null : 'no_key';
    }
    const id = this.config.AI_PROVIDER;
    if (id === 'null') return 'not_configured';
    if (id === 'anthropic' && !this.config.ANTHROPIC_API_KEY) return 'not_configured';
    if (id === 'openai_compatible' && !this.config.AI_BASE_URL) return 'not_configured';
    return null;
  }

  private async hasKey(trx: Trx, ctx: Ctx, provider: AiProvider): Promise<boolean> {
    const cred = await trx
      .selectFrom('app.ai_credential')
      .select('provider')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('provider', '=', provider)
      .executeTakeFirst();
    return Boolean(cred);
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
   * Whether the whole service has spent the operator's ceiling this month (ADR-0049 §2). The first time it has,
   * staff are told. A circuit breaker against a bug or abuse, not a plan limit.
   */
  private async ceilingReached(trx: Trx): Promise<boolean> {
    const ceiling = await readAiCeiling(trx);
    if (ceiling === null) return false;
    const month = monthStart();
    if (
      !this.serviceSpend ||
      this.serviceSpend.month !== month ||
      Date.now() - this.serviceSpend.at > SERVICE_SPEND_TTL_MS
    ) {
      const { rows } = await sql<{
        spent: string;
      }>`select app.ai_service_spend(${month}::date) as spent`.execute(trx);
      this.serviceSpend = { month, at: Date.now(), micro: BigInt(rows[0]?.spent ?? 0) };
    }
    const reached = this.serviceSpend.micro >= ceiling;
    if (reached) void this.alertCeiling(month, ceiling);
    return reached;
  }

  /** Once a month: the log, and an email to every admin and owner on staff. */
  private async alertCeiling(month: string, ceiling: bigint): Promise<void> {
    try {
      const { rows } = await this.db.run({ actorType: 'system' }, (trx) =>
        sql<{ email: string }>`select email from app.ai_ceiling_reached(${month}::date)`.execute(trx),
      );
      if (rows.length === 0) return;
      const dollars = (Number(ceiling) / 1e6).toFixed(2);
      this.logger.error(`ai ceiling reached month=${month.slice(0, 7)} ceiling_usd=${dollars}`);
      for (const r of rows) {
        await this.mail.send({
          to: r.email,
          category: 'transactional',
          subject: 'Montra: built-in AI is stopped for the month',
          text: [
            `The service has spent its built-in AI ceiling of $${dollars} for ${month.slice(0, 7)}, so built-in AI is stopped for every workspace until the month ends.`,
            'Customers fall back as when AI fails: rules categorize transactions, and scans and statements are entered by hand.',
            'If this is a bug or abuse, find it before raising the ceiling. The ceiling is in the staff console.',
          ].join('\n\n'),
        });
      }
    } catch (e) {
      this.logger.error(`ai ceiling alert failed: ${(e as Error).message}`);
    }
  }

  /** At 80% and 100% of the month's limit, once each, the workspace's owners hear about it (ADR-0049 §2). */
  private async alertOwners(ctx: Ctx, spent: bigint, alerted: number, limit: bigint | null): Promise<void> {
    const pct = aiAlertPct(spent, limit);
    if (pct === 0 || pct <= alerted) return;
    const month = monthStart();
    const owners = await this.db.run(ctx, async (trx) => {
      const turned = await trx
        .updateTable('app.ai_usage')
        .set({ alerted_pct: pct })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('month', '=', month)
        .where('alerted_pct', '<', pct)
        .returning('alerted_pct')
        .executeTakeFirst();
      if (!turned) return [];
      return trx
        .selectFrom('app.workspace_member')
        .select('user_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('role', '=', 'owner')
        .where('status', '=', 'active')
        .execute();
    });
    const notice = ALLOWANCE_NOTICE[pct];
    for (const o of owners) {
      if (!o.user_id) continue;
      const owner = { workspaceId: ctx.workspaceId, userId: o.user_id };
      try {
        await this.db.run(owner, async (trx) => {
          const prefs = await this.notifications.prefsIn(trx, owner.userId);
          await this.notifications.create(
            trx,
            owner,
            {
              type: 'ai_allowance',
              dedupeKey: `ai_allowance:${month.slice(0, 7)}:${pct}`,
              title: notice.title,
              body: notice.body,
              link: `/w/${owner.workspaceId}/settings?tab=ai`,
            },
            prefs,
          );
        });
      } catch (e) {
        this.logger.warn(`Couldn't tell ${owner.userId} about AI use: ${(e as Error).message}`);
      }
    }
  }

  /**
   * The gateway's persistence. Each write is its own short transaction so audit entries and spend survive
   * a rollback of the caller's work (a failed import still spent the tokens).
   */
  private store(ctx: Ctx, mode: AiMode, limit: bigint | null): GatewayStore {
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
                output: sql`excluded.output`,
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
        const builtin = mode === 'builtin' ? cost : 0n;
        const { rows } = await run((trx) =>
          sql<{ cost_micro_usd: string; alerted_pct: number }>`
              insert into app.ai_usage (workspace_id, month, calls, cost_micro_usd, builtin_micro_usd)
              values (${ctx.workspaceId}, ${monthStart()}, ${calls}, ${cost}, ${builtin})
              on conflict (workspace_id, month) do update
                set calls = app.ai_usage.calls + excluded.calls,
                    cost_micro_usd = app.ai_usage.cost_micro_usd + excluded.cost_micro_usd,
                    builtin_micro_usd = app.ai_usage.builtin_micro_usd + excluded.builtin_micro_usd
              returning cost_micro_usd, alerted_pct`.execute(trx),
        );
        const row = rows[0];
        if (row) {
          try {
            await this.alertOwners(ctx, BigInt(row.cost_micro_usd), row.alerted_pct, limit);
          } catch (e) {
            this.logger.warn(`AI use alert failed: ${(e as Error).message}`);
          }
        }
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
    const spent = usage?.cost_micro_usd ?? 0n;
    const spentUsd = Number(spent) / 1e6;
    const budget = s.monthlyBudgetUsd ?? null;
    const planMicroUsd = ws.ai_mode === 'builtin' ? await this.plans.aiAllowance(trx) : null;
    const limit = aiLimitMicroUsd(planMicroUsd, budget);
    const share = aiUsedShare(spent, limit);
    const alert = aiAlertPct(spent, limit);
    return {
      mode: ws.ai_mode,
      provider,
      endpoint: s.endpoint ?? null,
      models: {
        small: s.models?.small ?? null,
        vision: s.models?.vision ?? null,
        large: s.models?.large ?? null,
      },
      hasKey: Boolean(cred),
      keyLast4: cred?.last4 ?? null,
      threshold: s.threshold ?? DEFAULT_THRESHOLD,
      monthlyBudgetUsd: budget,
      allowDocumentsToLlm: s.allowDocumentsToLlm ?? false,
      allowReceiptImagesToLlm: s.allowReceiptImagesToLlm ?? false,
      failover: s.failover ?? false,
      usage: {
        month: monthStart().slice(0, 7),
        calls: usage?.calls ?? 0,
        spentUsd: Number(spentUsd.toFixed(4)),
        state: alert === 100 ? 'exhausted' : alert === 80 ? 'downgraded' : 'ok',
        share,
        planAllowance: planMicroUsd !== null,
      },
      problem: await this.problemFor(trx, ctx, ws.ai_mode, s),
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
    if (req.allowReceiptImagesToLlm !== undefined) s.allowReceiptImagesToLlm = req.allowReceiptImagesToLlm;
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
    // Saving "your own key" without one would quietly turn every AI feature off. Removing the key (clearKey on
    // its own) is still allowed; the settings page then says what's missing.
    if (req.mode === 'byok' && provider === 'anthropic' && !req.apiKey) {
      if (!(await this.hasKey(trx, ctx, provider))) {
        const message = 'Enter your API key to use your own key';
        throw new AppError(422, 'ai.key_required', message, [{ path: 'apiKey', message }]);
      }
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
