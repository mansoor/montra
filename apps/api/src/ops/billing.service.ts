/** What a workspace is on, and what that lets it do (UP-12, OPS-08, ADR-0020, ADR-0049 §1). */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { DbContext, Trx } from '@montra/db';
import { flagEnabled, FREE_PLAN, PAYMENT_GRACE_DAYS, type SubscriptionStatus } from '@montra/domain';
import type { BillingDto } from '@montra/schemas';
import { AppError, unprocessable } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { Worker } from '../jobs/queue.js';
import {
  BILLING_PORT,
  type BillingEvent,
  type BillingPort,
  type ProviderSubscription,
} from './billing.port.js';
import { ERROR_REPORTER, type ErrorReporter } from './errors.js';
import { entitlementsDto, Plans } from './plans.js';

type Ctx = DbContext & { workspaceId: string; userId: string };

const SWEEP_EVERY_MS = 3_600_000;

/** What the provider's words mean here. `incomplete` isn't paid for yet, and isn't anything else either. */
const STATUS: Record<string, SubscriptionStatus> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete_expired: 'canceled',
  paused: 'canceled',
  incomplete: 'none',
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BILLING_PORT) private readonly port: BillingPort,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(Plans) private readonly plans: Plans,
    @Inject(ERROR_REPORTER) private readonly errors: ErrorReporter,
  ) {}

  private get enabled(): boolean {
    return this.plans.enabled;
  }

  async get(ctx: Ctx, canManage: boolean): Promise<BillingDto> {
    return this.db.run(ctx, async (trx) => {
      const sub = await trx
        .selectFrom('app.subscription')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .executeTakeFirst();
      const current = await this.plans.current(trx);
      const e = current.entitlements;
      const flags = await trx.selectFrom('app.feature_flag').selectAll().execute();
      const overrides = await trx
        .selectFrom('app.feature_flag_override')
        .select(['key', 'enabled'])
        .where('workspace_id', '=', ctx.workspaceId)
        .execute();
      const override = new Map(overrides.map((o) => [o.key, o.enabled]));
      return {
        mode: this.config.BILLING_MODE,
        plan: current.version.planKey,
        planName: current.version.planName,
        status: (sub?.status ?? 'none') as BillingDto['status'],
        provider: (sub?.provider ?? null) as BillingDto['provider'],
        interval: (sub?.billing_interval ?? null) as BillingDto['interval'],
        trialEnd: sub?.trial_end?.toISOString() ?? null,
        currentPeriodEnd: sub?.current_period_end?.toISOString() ?? null,
        graceUntil: sub?.grace_until?.toISOString() ?? null,
        cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
        entitlements: entitlementsDto(e),
        features: {
          businessEntities: e.businessBooks > 0,
          rentalEntities: e.rentalPortfolios > 0,
          maxBusinesses: e.businessBooks,
          maxRentalPortfolios: e.rentalPortfolios,
          storageBytes: e.storageBytes.toString(),
        },
        flags: Object.fromEntries(
          flags.map((f) => [f.key, flagEnabled(f, ctx.workspaceId, override.get(f.key))]),
        ),
        canManage,
      };
    });
  }

  /**
   * Adding books is what a plan pays for. What's already there stays usable, whatever happens to the plan. The
   * transaction's context is the workspace's.
   */
  async assertCanAddEntity(trx: Trx, workspaceId: string, type: string): Promise<void> {
    if (!this.enabled || (type !== 'business' && type !== 'rental')) return;
    const e = await this.plans.entitlements(trx);
    const limit = type === 'business' ? e.businessBooks : e.rentalPortfolios;
    if (limit <= 0) {
      throw new AppError(
        402,
        'plan.required',
        type === 'business'
          ? "Business books aren't included in this workspace's plan"
          : "Rental books aren't included in this workspace's plan",
      );
    }
    const { n } = await trx
      .selectFrom('app.entity')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('type', '=', type)
      .executeTakeFirstOrThrow();
    if (Number(n) >= limit) throw unprocessable('plan.limit', `This plan allows up to ${limit} of these`);
  }

  /** Checkout for a plan and interval (ADR-0049 §1). Changing between paid plans is the provider's portal. */
  async checkoutUrl(ctx: Ctx, email: string, planKey: string, interval: 'month' | 'year'): Promise<string> {
    if (!this.enabled) throw new AppError(404, 'not_found', 'Plans are not in use here');
    const { sub, price, current } = await this.db.run(ctx, async (trx) => ({
      sub: await trx
        .selectFrom('app.subscription')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .executeTakeFirst(),
      price: await this.plans.checkoutPrice(trx, planKey, interval),
      current: await this.plans.current(trx),
    }));
    if (sub?.provider === 'stripe' && current.version.planKey !== FREE_PLAN) {
      throw new AppError(
        409,
        'billing.already_subscribed',
        `This workspace is already on ${current.version.planName}. Change plans in the billing portal.`,
      );
    }
    if (!price) throw new AppError(404, 'billing.no_price', "That plan can't be bought just now");
    const back = `${this.config.WEB_URL}/w/${ctx.workspaceId}/settings?tab=billing`;
    return this.port.checkoutUrl({
      workspaceId: ctx.workspaceId,
      price: price.priceRef,
      customer: sub?.customer_ref ?? null,
      email,
      // One trial for a workspace: having had a subscription of any kind uses it up.
      trial: !sub?.subscription_ref,
      successUrl: `${back}&checkout=done`,
      cancelUrl: back,
    });
  }

  async portalUrl(ctx: Ctx): Promise<string> {
    const sub = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.subscription')
        .select('customer_ref')
        .where('workspace_id', '=', ctx.workspaceId)
        .executeTakeFirst(),
    );
    if (!sub?.customer_ref) throw unprocessable('billing.no_customer', 'There is nothing to manage yet');
    return this.port.portalUrl(
      sub.customer_ref,
      `${this.config.WEB_URL}/w/${ctx.workspaceId}/settings?tab=billing`,
    );
  }

  /** Whatever the event says, the current state is read back from the provider, so events can arrive in any order. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ handled: boolean }> {
    const event: BillingEvent = this.port.parseEvent(rawBody, signature);
    if (!event.subscription) return { handled: false };
    const current = await this.port.subscription(event.subscription);
    await this.db.run({ actorType: 'system' }, async (trx) => {
      const fresh = await sql<{ fresh: boolean }>`
        select app.record_billing_event(${event.id}, ${event.type}) as fresh`.execute(trx);
      if (fresh.rows[0]?.fresh) await this.apply(trx, current);
    });
    return { handled: true };
  }

  private async apply(trx: Trx, s: ProviderSubscription): Promise<void> {
    const status = STATUS[s.status] ?? 'none';
    const known = await sql<{ workspace_id: string }>`
      select workspace_id from app.subscription_by_ref('stripe', ${s.id}, ${s.customer})`.execute(trx);
    const workspaceId = s.workspaceId ?? known.rows[0]?.workspace_id;
    // Not one of ours, or created by hand in the provider's dashboard. Nothing to attach it to.
    if (!workspaceId) return;
    const ended = status === 'canceled' || status === 'none';
    const version = ended
      ? await this.plans.free(trx)
      : s.priceId
        ? await this.plans.versionByPrice(trx, 'stripe', s.priceId)
        : undefined;
    if (!version) {
      // A price nobody added to a plan: the workspace stays as it was until someone does (ADR-0049 §1).
      const detail = { subscription: s.id, price: s.priceId ?? 'none' };
      this.logger.error(
        `billing price not on any plan subscription=${detail.subscription} price=${detail.price}`,
      );
      this.errors.captureMessage('A subscription is for a price that is on no plan', detail);
      return;
    }
    // apply_plan_version keeps a grace that's already running.
    const grace = status === 'past_due' ? new Date(Date.now() + PAYMENT_GRACE_DAYS * 86_400_000) : null;
    await this.write(trx, workspaceId, version.id, status, {
      provider: 'stripe',
      customer: s.customer,
      subscription: s.id,
      interval: s.interval,
      trialEnd: s.trialEnd,
      periodEnd: s.currentPeriodEnd,
      grace,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    });
  }

  private async write(
    trx: Trx,
    workspaceId: string,
    versionId: string,
    status: SubscriptionStatus,
    p: {
      provider: string | null;
      customer: string | null;
      subscription: string | null;
      interval: string | null;
      trialEnd: Date | null;
      periodEnd: Date | null;
      grace: Date | null;
      cancelAtPeriodEnd: boolean;
    },
  ): Promise<void> {
    await sql`select app.apply_plan_version(${workspaceId}::uuid, ${versionId}::uuid, ${status}, ${p.provider},
      ${p.customer}, ${p.subscription}, ${p.interval}, ${p.trialEnd}, ${p.periodEnd}, ${p.grace},
      ${p.cancelAtPeriodEnd})`.execute(trx);
  }

  /** Writes down lapses the provider never told us about, which is what lowers the quota. */
  async sweep(): Promise<number> {
    return this.db.run({ actorType: 'system' }, async (trx) => {
      const { rows } = await sql<{
        workspace_id: string;
      }>`select workspace_id from app.subscriptions_lapsed()`.execute(trx);
      const free = await this.plans.free(trx);
      for (const r of rows) {
        await this.write(trx, r.workspace_id, free.id, 'canceled', {
          provider: null,
          customer: null,
          subscription: null,
          interval: null,
          trialEnd: null,
          periodEnd: null,
          grace: null,
          cancelAtPeriodEnd: false,
        });
      }
      return rows.length;
    });
  }

  register(): void {
    this.worker.register('billing.sweep', async () => {
      await this.schedule(new Date(Date.now() + SWEEP_EVERY_MS));
      return { lapsed: await this.sweep() };
    });
  }

  async schedule(at: Date = new Date()): Promise<void> {
    if (!this.enabled) return;
    await this.db.run({ actorType: 'system' }, (trx) =>
      sql`select app.schedule_system_job('schedule', 'billing.sweep', ${at})`.execute(trx),
    );
  }
}
