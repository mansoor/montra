/** Plans, flags and versions (UP-12, OPS-01, OPS-04, OPS-08; ADR-0020). Prices aren't here: they live with the payment provider. */

export type Plan = 'free' | 'pro';
export type SubscriptionStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled';

export interface Entitlements {
  plan: Plan;
  /** Business and rental books can be added. What's already there stays readable and exportable either way. */
  businessEntities: boolean;
  rentalEntities: boolean;
  /** Soft limits from assumption 4. */
  maxBusinesses: number;
  maxRentalPortfolios: number;
  storageBytes: bigint;
}

const GB = 1024n * 1024n * 1024n;

export const FREE_STORAGE_BYTES = 5n * GB;
export const PRO_STORAGE_BYTES = 50n * GB;

/** How long a failed payment keeps counting as paid (OPS-08). */
export const PAYMENT_GRACE_DAYS = 14;
export const TRIAL_DAYS = 14;

export function entitlementsFor(plan: Plan): Entitlements {
  return plan === 'pro'
    ? {
        plan,
        businessEntities: true,
        rentalEntities: true,
        maxBusinesses: 10,
        maxRentalPortfolios: 10,
        storageBytes: PRO_STORAGE_BYTES,
      }
    : {
        plan,
        businessEntities: false,
        rentalEntities: false,
        maxBusinesses: 0,
        maxRentalPortfolios: 0,
        storageBytes: FREE_STORAGE_BYTES,
      };
}

export interface SubscriptionState {
  plan: Plan;
  status: SubscriptionStatus;
  trialEnd: Date | null;
  graceUntil: Date | null;
}

/** What someone gets right now. The clock decides as well as the provider, so a missed webhook can't keep a lapsed plan on. */
export function effectivePlan(sub: SubscriptionState | null, now: Date): Plan {
  if (!sub || sub.plan === 'free') return 'free';
  switch (sub.status) {
    case 'active':
      return 'pro';
    case 'trialing':
      return sub.trialEnd && sub.trialEnd > now ? 'pro' : 'free';
    case 'past_due':
      return sub.graceUntil && sub.graceUntil > now ? 'pro' : 'free';
    default:
      return 'free';
  }
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
