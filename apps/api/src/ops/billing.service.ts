/** What a workspace is on, and what that lets it do (UP-12, OPS-08, ADR-0020). */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { DbContext, Trx } from '@montra/db';
import {
  effectivePlan,
  entitlementsFor,
  flagEnabled,
  PAYMENT_GRACE_DAYS,
  type Plan,
  type SubscriptionStatus,
} from '@montra/domain';
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
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BILLING_PORT) private readonly port: BillingPort,
    @Inject(Worker) private readonly worker: Worker,
  ) {}

  private get enabled(): boolean {
    return this.config.BILLING_MODE !== 'off';
  }

  async get(ctx: Ctx, canManage: boolean): Promise<BillingDto> {
    return this.db.run(ctx, async (trx) => {
      const sub = await trx
        .selectFrom('app.subscription')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .executeTakeFirst();
      const plan = this.planOf(sub);
      const features = entitlementsFor(this.enabled ? plan : 'pro');
      const flags = await trx.selectFrom('app.feature_flag').selectAll().execute();
      const overrides = await trx
        .selectFrom('app.feature_flag_override')
        .select(['key', 'enabled'])
        .where('workspace_id', '=', ctx.workspaceId)
        .execute();
      const override = new Map(overrides.map((o) => [o.key, o.enabled]));
      return {
        mode: this.config.BILLING_MODE,
        plan,
        status: (sub?.status ?? 'none') as BillingDto['status'],
        provider: (sub?.provider ?? null) as BillingDto['provider'],
        interval: (sub?.billing_interval ?? null) as BillingDto['interval'],
        trialEnd: sub?.trial_end?.toISOString() ?? null,
        currentPeriodEnd: sub?.current_period_end?.toISOString() ?? null,
        graceUntil: sub?.grace_until?.toISOString() ?? null,
        cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
        features: {
          businessEntities: features.businessEntities,
          rentalEntities: features.rentalEntities,
          maxBusinesses: features.maxBusinesses,
          maxRentalPortfolios: features.maxRentalPortfolios,
          storageBytes: features.storageBytes.toString(),
        },
        flags: Object.fromEntries(
          flags.map((f) => [f.key, flagEnabled(f, ctx.workspaceId, override.get(f.key))]),
        ),
        canManage,
      };
    });
  }

  private planOf(
    sub: { plan: string; status: string; trial_end: Date | null; grace_until: Date | null } | undefined,
  ): Plan {
    if (!sub) return 'free';
    return effectivePlan(
      {
        plan: sub.plan as Plan,
        status: sub.status as SubscriptionStatus,
        trialEnd: sub.trial_end,
        graceUntil: sub.grace_until,
      },
      new Date(),
    );
  }

  /** Adding books is what a plan pays for. What's already there stays usable, whatever happens to the plan. */
  async assertCanAddEntity(trx: Trx, workspaceId: string, type: string): Promise<void> {
    if (!this.enabled || (type !== 'business' && type !== 'rental')) return;
    const sub = await trx
      .selectFrom('app.subscription')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    const features = entitlementsFor(this.planOf(sub));
    const allowed = type === 'business' ? features.businessEntities : features.rentalEntities;
    if (!allowed) {
      throw new AppError(402, 'plan.required', 'Business and rental books come with the Pro plan');
    }
    const limit = type === 'business' ? features.maxBusinesses : features.maxRentalPortfolios;
    const { n } = await trx
      .selectFrom('app.entity')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('type', '=', type)
      .executeTakeFirstOrThrow();
    if (Number(n) >= limit) throw unprocessable('plan.limit', `This plan allows up to ${limit} of these`);
  }

  async checkoutUrl(ctx: Ctx, email: string, interval: 'month' | 'year'): Promise<string> {
    const sub = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.subscription')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .executeTakeFirst(),
    );
    if (this.planOf(sub) === 'pro' && sub?.status === 'active') {
      throw new AppError(409, 'billing.already_subscribed', 'This workspace is already on the Pro plan');
    }
    const back = `${this.config.WEB_URL}/w/${ctx.workspaceId}/settings?tab=billing`;
    return this.port.checkoutUrl({
      workspaceId: ctx.workspaceId,
      interval,
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
    // apply_subscription keeps a grace that's already running.
    const grace = status === 'past_due' ? new Date(Date.now() + PAYMENT_GRACE_DAYS * 86_400_000) : null;
    const plan: Plan = status === 'canceled' || status === 'none' ? 'free' : 'pro';
    await this.write(
      trx,
      workspaceId,
      plan,
      status,
      'stripe',
      s.customer,
      s.id,
      s.interval,
      s.trialEnd,
      s.currentPeriodEnd,
      grace,
      s.cancelAtPeriodEnd,
    );
  }

  private async write(
    trx: Trx,
    workspaceId: string,
    plan: Plan,
    status: SubscriptionStatus,
    provider: string | null,
    customer: string | null,
    subscription: string | null,
    interval: string | null,
    trialEnd: Date | null,
    periodEnd: Date | null,
    grace: Date | null,
    cancelAtPeriodEnd: boolean,
  ): Promise<void> {
    const quota = entitlementsFor(plan).storageBytes.toString();
    await sql`select app.apply_subscription(${workspaceId}::uuid, ${plan}, ${status}, ${provider}, ${customer},
      ${subscription}, ${interval}, ${trialEnd}, ${periodEnd}, ${grace}, ${cancelAtPeriodEnd}, ${quota}::bigint)`.execute(
      trx,
    );
  }

  /** Writes down lapses the provider never told us about, which is what lowers the quota. */
  async sweep(): Promise<number> {
    return this.db.run({ actorType: 'system' }, async (trx) => {
      const { rows } = await sql<{
        workspace_id: string;
      }>`select workspace_id from app.subscriptions_lapsed()`.execute(trx);
      for (const r of rows) {
        await this.write(
          trx,
          r.workspace_id,
          'free',
          'canceled',
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          false,
        );
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
