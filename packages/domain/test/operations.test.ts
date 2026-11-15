import { describe, expect, it } from 'vitest';
import {
  aiAlertPct,
  aiLimitMicroUsd,
  aiUsedShare,
  effectivePlan,
  entitlementsJson,
  EntitlementsError,
  flagEnabled,
  FREE_STORAGE_BYTES,
  isVersionBelow,
  maintenanceNoticeOk,
  parseEntitlements,
  PRO_STORAGE_BYTES,
} from '../src/operations.js';

const now = new Date('2026-11-04T12:00:00Z');
const later = new Date('2026-11-05T12:00:00Z');
const earlier = new Date('2026-11-03T12:00:00Z');

describe('effectivePlan', () => {
  it('is free with no subscription', () => {
    expect(effectivePlan(null, now)).toBe('free');
  });

  it('is the plan paid for while paid, whatever its key', () => {
    expect(effectivePlan({ plan: 'pro', status: 'active', trialEnd: null, graceUntil: null }, now)).toBe(
      'pro',
    );
    expect(effectivePlan({ plan: 'plus', status: 'active', trialEnd: null, graceUntil: null }, now)).toBe(
      'plus',
    );
  });

  it('follows the trial’s end, even if no webhook says so', () => {
    const trial = { plan: 'pro', status: 'trialing' as const, graceUntil: null };
    expect(effectivePlan({ ...trial, trialEnd: later }, now)).toBe('pro');
    expect(effectivePlan({ ...trial, trialEnd: earlier }, now)).toBe('free');
  });

  it('keeps a failed payment on until the grace runs out', () => {
    const late = { plan: 'pro', status: 'past_due' as const, trialEnd: null };
    expect(effectivePlan({ ...late, graceUntil: later }, now)).toBe('pro');
    expect(effectivePlan({ ...late, graceUntil: earlier }, now)).toBe('free');
  });

  it('is free once canceled', () => {
    expect(effectivePlan({ plan: 'pro', status: 'canceled', trialEnd: null, graceUntil: later }, now)).toBe(
      'free',
    );
  });
});

describe('parseEntitlements (ADR-0049 §1)', () => {
  const pro = {
    businessBooks: 10,
    rentalPortfolios: 10,
    storageBytes: 53687091200,
    familyLogins: null,
    aiMonthlyMicroUsd: null,
    smsMonthly: 0,
    features: ['payroll', 'staffTime', 'scans', 'voice', 'ownStorage'],
  };

  it('reads what migration 0051 seeded for Pro', () => {
    expect(parseEntitlements(pro)).toEqual({ ...pro, storageBytes: PRO_STORAGE_BYTES, familyLogins: null });
    expect(parseEntitlements({ ...pro, storageBytes: 5368709120 }).storageBytes).toBe(FREE_STORAGE_BYTES);
  });

  it('takes big numbers as digit strings, and round-trips through what is stored', () => {
    const big = parseEntitlements({ ...pro, aiMonthlyMicroUsd: '5000000', storageBytes: '1099511627776' });
    expect(big.aiMonthlyMicroUsd).toBe(5_000_000n);
    expect(parseEntitlements(entitlementsJson(big))).toEqual(big);
  });

  it('refuses unknown features, negative or fractional counts, and missing fields', () => {
    expect(() => parseEntitlements({ ...pro, features: ['payroll', 'teleport'] })).toThrow(EntitlementsError);
    expect(() => parseEntitlements({ ...pro, businessBooks: -1 })).toThrow(/businessBooks/);
    expect(() => parseEntitlements({ ...pro, rentalPortfolios: 1.5 })).toThrow(/rentalPortfolios/);
    expect(() => parseEntitlements({ ...pro, smsMonthly: null })).toThrow(/smsMonthly/);
    expect(() => parseEntitlements({ ...pro, aiMonthlyMicroUsd: '-5' })).toThrow(/aiMonthlyMicroUsd/);
    const { storageBytes: _, ...missing } = pro;
    expect(() => parseEntitlements(missing)).toThrow(/storageBytes/);
    expect(() => parseEntitlements([])).toThrow(EntitlementsError);
  });

  it('keeps features in one order, without repeats', () => {
    expect(parseEntitlements({ ...pro, features: ['voice', 'scans', 'voice'] }).features).toEqual([
      'scans',
      'voice',
    ]);
  });
});

describe('the AI limit (ADR-0049 §2)', () => {
  it('is the smaller of the plan’s allowance and the customer’s own budget', () => {
    expect(aiLimitMicroUsd(null, null)).toBeNull();
    expect(aiLimitMicroUsd(5_000_000n, null)).toBe(5_000_000n);
    expect(aiLimitMicroUsd(null, 2)).toBe(2_000_000n);
    expect(aiLimitMicroUsd(5_000_000n, 2)).toBe(2_000_000n);
    // A higher budget than the plan allows has no effect.
    expect(aiLimitMicroUsd(5_000_000n, 50)).toBe(5_000_000n);
    expect(aiLimitMicroUsd(5_000_000n, 4.35)).toBe(4_350_000n);
    expect(aiLimitMicroUsd(null, 0)).toBe(0n);
  });

  it('tells the owners at 80% and 100%', () => {
    expect(aiAlertPct(1n, null)).toBe(0);
    expect(aiAlertPct(7_999_999n, 10_000_000n)).toBe(0);
    expect(aiAlertPct(8_000_000n, 10_000_000n)).toBe(80);
    expect(aiAlertPct(10_000_000n, 10_000_000n)).toBe(100);
    expect(aiAlertPct(0n, 0n)).toBe(100);
  });

  it('shows a share, never dollars', () => {
    expect(aiUsedShare(1n, null)).toBeNull();
    expect(aiUsedShare(7_000_000n, 10_000_000n)).toBe(0.7);
    expect(aiUsedShare(12_000_000n, 10_000_000n)).toBe(1);
  });
});

describe('flagEnabled', () => {
  const workspace = '11111111-1111-4111-8111-111111111111';

  it('is off when off, and on for everyone at 100', () => {
    expect(flagEnabled({ key: 'a', enabled: false, rollout: 100 }, workspace)).toBe(false);
    expect(flagEnabled({ key: 'a', enabled: true, rollout: 100 }, workspace)).toBe(true);
  });

  it('lets an override win either way', () => {
    expect(flagEnabled({ key: 'a', enabled: false, rollout: 0 }, workspace, true)).toBe(true);
    expect(flagEnabled({ key: 'a', enabled: true, rollout: 100 }, workspace, false)).toBe(false);
  });

  it('rolls out to about the share asked for, and stays put for a workspace', () => {
    const flag = { key: 'new-thing', enabled: true, rollout: 30 };
    const on = Array.from({ length: 2000 }, (_, i) => `ws-${i}`).filter((w) => flagEnabled(flag, w)).length;
    expect(on).toBeGreaterThan(500);
    expect(on).toBeLessThan(700);
    expect(flagEnabled(flag, workspace)).toBe(flagEnabled(flag, workspace));
    expect(flagEnabled({ ...flag, rollout: 0 }, workspace)).toBe(false);
  });
});

describe('isVersionBelow', () => {
  it('compares numerically, not as text', () => {
    expect(isVersionBelow('1.9.0', '1.10.0')).toBe(true);
    expect(isVersionBelow('1.10.0', '1.9.0')).toBe(false);
    expect(isVersionBelow('2.0.0', '2.0.0')).toBe(false);
  });

  it('fills in missing parts and ignores what follows a hyphen', () => {
    expect(isVersionBelow('1.2', '1.2.0')).toBe(false);
    expect(isVersionBelow('1.2.0-beta.1', '1.2.0')).toBe(false);
  });

  it('treats an unreadable version as too old, and an unreadable minimum as no minimum', () => {
    expect(isVersionBelow('banana', '1.0.0')).toBe(true);
    expect(isVersionBelow('1.0.0', 'banana')).toBe(false);
  });
});

describe('maintenanceNoticeOk', () => {
  it('needs 48 hours', () => {
    const from = new Date('2026-11-04T00:00:00Z');
    expect(maintenanceNoticeOk(from, new Date('2026-11-06T00:00:00Z'))).toBe(true);
    expect(maintenanceNoticeOk(from, new Date('2026-11-05T23:59:00Z'))).toBe(false);
  });
});
