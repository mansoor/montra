/**
 * Plans, flags and versions (UP-12, OPS-01, OPS-04, OPS-08; ADR-0020, ADR-0049). Which features exist is code; which
 * plan gets which, and how much, is data in `app.plan_version`, checked here. Prices live with the payment provider.
 */

/** A plan's key, such as `free`, `pro` or `plus`. Plans are data now (ADR-0049 §1), so any key the database has. */
export type Plan = string;
export const FREE_PLAN = 'free';
export type SubscriptionStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled';

/**
 * Features a plan can switch on. Adding one is code: it goes here, and the same change's migration gives every
 * existing plan version a default, so an upgrade never takes away what someone had (ADR-0049 §1).
 */
export const PLAN_FEATURES = ['payroll', 'staffTime', 'scans', 'voice', 'ownStorage'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** What one plan version allows (ADR-0049 §1). */
export interface PlanEntitlements {
  /** How many business books can be added. 0 means none. */
  businessBooks: number;
  rentalPortfolios: number;
  /** Files, receipts and backups together. */
  storageBytes: bigint;
  /** How many people can sign in to the workspace (ADR-0041). Null: no limit. */
  familyLogins: number | null;
  /** The AI allowance per calendar month in UTC, in millionths of a dollar. Null: no limit. */
  aiMonthlyMicroUsd: bigint | null;
  /** Texts a month for alerts. Sign-in and security texts aren't counted. */
  smsMonthly: number;
  features: PlanFeature[];
}

/** The most a plan can allow of each count, so a slip in the console can't hand out something absurd. */
export const PLAN_MAX_COUNT = 1000;
const MAX_STORAGE = 1024n ** 5n;
const MAX_AI_MICRO_USD = 10_000n * 1_000_000n;

/** Everything, with no limits: `BILLING_MODE=off`, as self-hosted installs, development and tests run. */
export const UNLIMITED_ENTITLEMENTS: PlanEntitlements = {
  businessBooks: PLAN_MAX_COUNT,
  rentalPortfolios: PLAN_MAX_COUNT,
  storageBytes: MAX_STORAGE,
  familyLogins: null,
  aiMonthlyMicroUsd: null,
  smsMonthly: PLAN_MAX_COUNT,
  features: [...PLAN_FEATURES],
};

const GB = 1024n * 1024n * 1024n;

/** What Free and Pro allowed before plans were data, and what migration 0051 seeded. */
export const FREE_STORAGE_BYTES = 5n * GB;
export const PRO_STORAGE_BYTES = 50n * GB;

/** How long a failed payment keeps counting as paid (OPS-08). */
export const PAYMENT_GRACE_DAYS = 14;
export const TRIAL_DAYS = 14;

export class EntitlementsError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function count(o: Record<string, unknown>, key: string, nullable: boolean): number | null {
  const v = o[key];
  if (v === null && nullable) return null;
  if (!isWhole(v) || v < 0 || v > PLAN_MAX_COUNT) {
    throw new EntitlementsError(
      key,
      `a whole number from 0 to ${PLAN_MAX_COUNT}${nullable ? ', or none' : ''}`,
    );
  }
  return v;
}

/** Whole numbers, or digit strings for values past what a JSON number holds exactly. */
function big(o: Record<string, unknown>, key: string, max: bigint, nullable: boolean): bigint | null {
  const v = o[key];
  if (v === null && nullable) return null;
  let n: bigint | null = null;
  if (isWhole(v)) n = BigInt(v);
  else if (typeof v === 'string' && /^\d{1,20}$/.test(v)) n = BigInt(v);
  else if (typeof v === 'bigint') n = v;
  if (n === null || n < 0n || n > max) {
    throw new EntitlementsError(key, `a whole number from 0 to ${max}${nullable ? ', or none' : ''}`);
  }
  return n;
}

/**
 * Checks a version's entitlements, as stored or as sent from the console, against the one schema (ADR-0049 §1).
 * Unknown feature keys are refused, so a typo can't look like it switched something on.
 */
export function parseEntitlements(value: unknown): PlanEntitlements {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EntitlementsError('entitlements', 'an object');
  }
  const o = value as Record<string, unknown>;
  const known = new Set<string>(PLAN_FEATURES);
  const features = o.features;
  if (!Array.isArray(features) || features.some((f) => typeof f !== 'string' || !known.has(f))) {
    throw new EntitlementsError('features', `a list of ${PLAN_FEATURES.join(', ')}`);
  }
  return {
    businessBooks: count(o, 'businessBooks', false)!,
    rentalPortfolios: count(o, 'rentalPortfolios', false)!,
    storageBytes: big(o, 'storageBytes', MAX_STORAGE, false)!,
    familyLogins: count(o, 'familyLogins', true),
    aiMonthlyMicroUsd: big(o, 'aiMonthlyMicroUsd', MAX_AI_MICRO_USD, true),
    smsMonthly: count(o, 'smsMonthly', false)!,
    features: PLAN_FEATURES.filter((f) => (features as string[]).includes(f)),
  };
}

/** As stored in `plan_version.entitlements`: plain JSON, with numbers where they fit exactly and strings otherwise. */
export function entitlementsJson(e: PlanEntitlements): Record<string, unknown> {
  const num = (n: bigint) => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString());
  return {
    businessBooks: e.businessBooks,
    rentalPortfolios: e.rentalPortfolios,
    storageBytes: num(e.storageBytes),
    familyLogins: e.familyLogins,
    aiMonthlyMicroUsd: e.aiMonthlyMicroUsd === null ? null : num(e.aiMonthlyMicroUsd),
    smsMonthly: e.smsMonthly,
    features: [...e.features],
  };
}

export function hasFeature(e: PlanEntitlements, feature: PlanFeature): boolean {
  return e.features.includes(feature);
}

export interface SubscriptionState {
  plan: Plan;
  status: SubscriptionStatus;
  trialEnd: Date | null;
  graceUntil: Date | null;
}

/** Whether a subscription gives its plan right now. Without one, a workspace is on Free. */
export function subscriptionCounts(sub: SubscriptionState | null, now: Date): boolean {
  if (!sub || sub.plan === FREE_PLAN) return false;
  switch (sub.status) {
    case 'active':
      return true;
    case 'trialing':
      return Boolean(sub.trialEnd && sub.trialEnd > now);
    case 'past_due':
      return Boolean(sub.graceUntil && sub.graceUntil > now);
    default:
      return false;
  }
}

/** What someone gets right now. The clock decides as well as the provider, so a missed webhook can't keep a lapsed plan on. */
export function effectivePlan(sub: SubscriptionState | null, now: Date): Plan {
  return sub && subscriptionCounts(sub, now) ? sub.plan : FREE_PLAN;
}

/**
 * The AI limit that applies, in millionths of a dollar: the smaller of the plan's allowance and the customer's own
 * monthly budget (ADR-0049 §2). A customer can set a lower limit, never a higher one. Null: no limit.
 */
export function aiLimitMicroUsd(planMicroUsd: bigint | null, customerUsd: number | null): bigint | null {
  const customer =
    customerUsd === null || !Number.isFinite(customerUsd)
      ? null
      : BigInt((Math.max(0, customerUsd) * 1_000_000).toFixed(0));
  if (planMicroUsd === null) return customer;
  if (customer === null) return planMicroUsd;
  return customer < planMicroUsd ? customer : planMicroUsd;
}

/** The highest share of the month's AI limit reached that the owners hear about: 0, 80 or 100 (ADR-0049 §2). */
export function aiAlertPct(spentMicroUsd: bigint, limitMicroUsd: bigint | null): 0 | 80 | 100 {
  if (limitMicroUsd === null) return 0;
  if (limitMicroUsd <= 0n || spentMicroUsd >= limitMicroUsd) return 100;
  return spentMicroUsd * 100n >= limitMicroUsd * 80n ? 80 : 0;
}

/** The share of the month's AI used, 0 to 1 and capped there. Null without a limit. */
export function aiUsedShare(spentMicroUsd: bigint, limitMicroUsd: bigint | null): number | null {
  if (limitMicroUsd === null) return null;
  if (limitMicroUsd <= 0n || spentMicroUsd >= limitMicroUsd) return 1;
  return Number((spentMicroUsd * 10_000n) / limitMicroUsd) / 10_000;
}

/** A small stable hash. This package runs in browsers and on phones too, and a rollout needs no cryptography. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Whether a flag is on for a workspace: an override first, then the rollout share, stable for that workspace and flag. */
export function flagEnabled(
  flag: { key: string; enabled: boolean; rollout: number },
  workspaceId: string,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  if (!flag.enabled) return false;
  if (flag.rollout >= 100) return true;
  return fnv1a(`${flag.key}:${workspaceId}`) % 100 < flag.rollout;
}

/** Numeric parts only; anything after a hyphen doesn't count. An unreadable version is treated as old. */
function versionParts(v: string): number[] | null {
  const core = v.trim().split('-')[0] ?? '';
  if (!/^\d+(\.\d+){0,2}$/.test(core)) return null;
  const parts = core.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function isVersionBelow(version: string, minimum: string): boolean {
  const min = versionParts(minimum);
  if (!min) return false;
  const v = versionParts(version);
  if (!v) return true;
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== min[i]!) return v[i]! < min[i]!;
  }
  return false;
}

/** OPS-03: planned maintenance has to be announced at least this far ahead. */
export const MAINTENANCE_NOTICE_HOURS = 48;

export function maintenanceNoticeOk(showFrom: Date, startsAt: Date): boolean {
  return startsAt.getTime() - showFrom.getTime() >= MAINTENANCE_NOTICE_HOURS * 3_600_000;
}
