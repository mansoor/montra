/**
 * Plans as data (ADR-0049 §1): what the workspace in context is on, and what that lets it do. Every check that a plan
 * allows something reads from here, so the console's edits take effect without a release.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { DbContext, Trx } from '@montra/db';
import {
  FREE_PLAN,
  hasFeature,
  parseEntitlements,
  subscriptionCounts,
  UNLIMITED_ENTITLEMENTS,
  type PlanEntitlements,
  type PlanFeature,
  type SubscriptionStatus,
} from '@montra/domain';
import type { PlanEntitlementsDto, PlanOfferDto } from '@montra/schemas';
import { AppError } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';

export interface SubscriptionRow {
  plan: string;
  plan_version_id: string | null;
  status: string;
  trial_end: Date | null;
  grace_until: Date | null;
  /** From migration 0053. A given plan (`comp`) ends at its period's end, as a trial does. */
  provider?: string | null;
  current_period_end?: Date | null;
}

export interface PlanVersionRow {
  id: string;
  planKey: string;
  planName: string;
  version: number;
  entitlements: PlanEntitlements;
}

export interface CurrentPlan {
  /** The version that applies now: the one subscribed to while it counts, else Free's latest. */
  version: PlanVersionRow;
  /** What it allows, or everything with plans off. */
  entitlements: PlanEntitlements;
  subscription: SubscriptionRow | null;
}

/** What a feature is called when it isn't on the plan. */
const FEATURE_NAMES: Record<PlanFeature, string> = {
  payroll: 'Payroll',
  staffTime: 'Staff time',
  scans: 'Scanning documents',
  voice: 'Voice entry',
  ownStorage: 'Your own storage',
  familyVault: 'Family Document Vault',
};

export function entitlementsDto(e: PlanEntitlements): PlanEntitlementsDto {
  return {
    businessBooks: e.businessBooks,
    rentalPortfolios: e.rentalPortfolios,
    storageBytes: e.storageBytes.toString(),
    familyLogins: e.familyLogins,
    aiMonthlyMicroUsd: e.aiMonthlyMicroUsd === null ? null : e.aiMonthlyMicroUsd.toString(),
    smsMonthly: e.smsMonthly,
    features: [...e.features],
  };
}

@Injectable()
export class Plans {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(Db) private readonly db: Db,
  ) {}

  /** `BILLING_MODE=off` gives every workspace everything (ADR-0049 §1). */
  get enabled(): boolean {
    return this.config.BILLING_MODE !== 'off';
  }

  private toVersion(r: {
    id: string;
    plan_key: string;
    name: string;
    version: number;
    entitlements: unknown;
  }): PlanVersionRow {
    return {
      id: r.id,
      planKey: r.plan_key,
      planName: r.name,
      version: r.version,
      entitlements: parseEntitlements(r.entitlements),
    };
  }

  private versions(trx: Trx) {
    return trx
      .selectFrom('app.plan_version as v')
      .innerJoin('app.plan as p', 'p.key', 'v.plan_key')
      .select(['v.id', 'v.plan_key', 'p.name', 'v.version', 'v.entitlements']);
  }

  async version(trx: Trx, id: string): Promise<PlanVersionRow | undefined> {
    const row = await this.versions(trx).where('v.id', '=', id).executeTakeFirst();
    return row && this.toVersion(row);
  }

  /**
   * A plan's current version, which new customers get: the newest that has started. A version that gives less
   * starts at least 30 days after it's added (ADR-0049 §1).
   */
  async latest(trx: Trx, planKey: string): Promise<PlanVersionRow | undefined> {
    const row = await this.versions(trx)
      .where('v.plan_key', '=', planKey)
      .where('v.effective_from', '<=', new Date())
      .orderBy('v.effective_from', 'desc')
      .orderBy('v.version', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row && this.toVersion(row);
  }

  /** The plan picker: every plan offered to new customers, its current version, and its prices (ADR-0049 §1). */
  async offers(trx: Trx): Promise<PlanOfferDto[]> {
    const plans = await trx
      .selectFrom('app.plan')
      .select(['key', 'name', 'description'])
      .where('offered', '=', true)
      .orderBy('sort_order')
      .orderBy('key')
      .execute();
    const out: PlanOfferDto[] = [];
    for (const p of plans) {
      const v = await this.latest(trx, p.key);
      if (!v) continue;
      const prices = await this.activePrices(trx, p.key, v.version);
      // A paid plan with no price yet can't be chosen, so it isn't shown.
      if (p.key !== FREE_PLAN && prices.length === 0) continue;
      out.push({
        key: p.key,
        name: p.name,
        description: p.description,
        entitlements: entitlementsDto(this.enabled ? v.entitlements : UNLIMITED_ENTITLEMENTS),
        prices: prices.map((pr) => ({
          interval: pr.billing_interval,
          amountMinor: String(pr.amount_minor),
          currency: pr.currency,
        })),
      });
    }
    return out;
  }

  async free(trx: Trx): Promise<PlanVersionRow> {
    const v = await this.latest(trx, FREE_PLAN);
    if (!v) throw new Error('The Free plan is missing: migration 0051 seeds it');
    return v;
  }

  /** The subscription of the workspace in the transaction's context, whoever is asking. */
  async subscription(trx: Trx): Promise<SubscriptionRow | null> {
    const { rows } = await sql<SubscriptionRow>`select * from app.current_plan()`.execute(trx);
    return rows[0] ?? null;
  }

  /** The workspace in context: its plan's version now, and what it allows. */
  async current(trx: Trx, now: Date = new Date()): Promise<CurrentPlan> {
    const subscription = await this.subscription(trx);
    const givenAndOver =
      subscription?.provider === 'comp' &&
      subscription.current_period_end !== null &&
      subscription.current_period_end !== undefined &&
      subscription.current_period_end <= now;
    const counts =
      subscription !== null &&
      !givenAndOver &&
      subscriptionCounts(
        {
          plan: subscription.plan,
          status: subscription.status as SubscriptionStatus,
          trialEnd: subscription.trial_end,
          graceUntil: subscription.grace_until,
        },
        now,
      );
    let version: PlanVersionRow | undefined;
    if (counts) {
      // A row an old task wrote before 0051 has no version: the plan's latest stands in for it.
      version = subscription.plan_version_id
        ? await this.version(trx, subscription.plan_version_id)
        : await this.latest(trx, subscription.plan);
    }
    version ??= await this.free(trx);
    return {
      version,
      entitlements: this.enabled ? version.entitlements : UNLIMITED_ENTITLEMENTS,
      subscription,
    };
  }

  async entitlements(trx: Trx): Promise<PlanEntitlements> {
    return this.enabled ? (await this.current(trx)).entitlements : UNLIMITED_ENTITLEMENTS;
  }

  /**
   * Adding with a feature the plan doesn't have is refused. What's already there stays readable, editable and
   * exportable whatever happens to the plan (ADR-0020 §3).
   */
  async assertFeature(trx: Trx, feature: PlanFeature): Promise<void> {
    if (!this.enabled) return;
    if (!hasFeature(await this.entitlements(trx), feature)) {
      throw new AppError(
        402,
        'plan.required',
        `${FEATURE_NAMES[feature]} isn't included in this workspace's plan`,
      );
    }
  }

  /** As `assertFeature`, in a transaction of its own: for a controller, before the work starts. */
  async requireFeature(ctx: DbContext & { workspaceId: string }, feature: PlanFeature): Promise<void> {
    if (!this.enabled) return;
    await this.db.run(ctx, (trx) => this.assertFeature(trx, feature));
  }

  /** The AI allowance a month, or null for none. Only built-in AI is the operator's to pay for (ADR-0049 §2). */
  async aiAllowance(trx: Trx): Promise<bigint | null> {
    if (!this.enabled) return null;
    return (await this.entitlements(trx)).aiMonthlyMicroUsd;
  }

  /** What a payment provider's price id is for. Older prices still count, so their subscribers are recognised. */
  async versionByPrice(trx: Trx, provider: string, priceRef: string): Promise<PlanVersionRow | undefined> {
    const row = await this.versions(trx)
      .innerJoin('app.plan_price as pr', 'pr.plan_version_id', 'v.id')
      .where('pr.provider', '=', provider as 'stripe')
      .where('pr.price_ref', '=', priceRef)
      .executeTakeFirst();
    return row && this.toVersion(row);
  }

  /**
   * The prices new customers pay for a plan: for each interval, the newest active price on the current version or
   * an earlier one. A new version needn't repeat a price that hasn't changed (ADR-0049 §1).
   */
  private async activePrices(trx: Trx, planKey: string, upTo: number) {
    const rows = await trx
      .selectFrom('app.plan_price as pr')
      .innerJoin('app.plan_version as v', 'v.id', 'pr.plan_version_id')
      .select(['pr.billing_interval', 'pr.price_ref', 'pr.amount_minor', 'pr.currency'])
      .where('v.plan_key', '=', planKey)
      .where('v.version', '<=', upTo)
      .where('pr.provider', '=', 'stripe')
      .where('pr.active', '=', true)
      .orderBy('v.version', 'desc')
      .orderBy('pr.created_at', 'desc')
      .execute();
    const first = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!first.has(r.billing_interval)) first.set(r.billing_interval, r);
    return [...first.values()].sort((a, b) => a.billing_interval.localeCompare(b.billing_interval));
  }

  /** The price a new customer pays for a plan and interval, and the version they'll get: the current one. */
  async checkoutPrice(
    trx: Trx,
    planKey: string,
    interval: 'month' | 'year',
  ): Promise<{ priceRef: string; version: PlanVersionRow } | undefined> {
    const plan = await trx
      .selectFrom('app.plan')
      .select(['key', 'offered'])
      .where('key', '=', planKey)
      .executeTakeFirst();
    if (!plan?.offered || plan.key === FREE_PLAN) return undefined;
    const version = await this.latest(trx, planKey);
    if (!version) return undefined;
    const price = (await this.activePrices(trx, planKey, version.version)).find(
      (p) => p.billing_interval === interval,
    );
    return price ? { priceRef: price.price_ref, version } : undefined;
  }
}
