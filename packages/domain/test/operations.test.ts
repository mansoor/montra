import { describe, expect, it } from 'vitest';
import {
  effectivePlan,
  entitlementsFor,
  flagEnabled,
  FREE_STORAGE_BYTES,
  isVersionBelow,
  maintenanceNoticeOk,
  PRO_STORAGE_BYTES,
} from '../src/operations.js';

const now = new Date('2026-11-04T12:00:00Z');
const later = new Date('2026-11-05T12:00:00Z');
const earlier = new Date('2026-11-03T12:00:00Z');

describe('effectivePlan', () => {
  it('is free with no subscription', () => {
    expect(effectivePlan(null, now)).toBe('free');
  });

  it('is pro while paid', () => {
    expect(effectivePlan({ plan: 'pro', status: 'active', trialEnd: null, graceUntil: null }, now)).toBe(
      'pro',
    );
  });

  it('follows the trial’s end, even if no webhook says so', () => {
    const trial = { plan: 'pro' as const, status: 'trialing' as const, graceUntil: null };
    expect(effectivePlan({ ...trial, trialEnd: later }, now)).toBe('pro');
    expect(effectivePlan({ ...trial, trialEnd: earlier }, now)).toBe('free');
  });

  it('keeps a failed payment on until the grace runs out', () => {
    const late = { plan: 'pro' as const, status: 'past_due' as const, trialEnd: null };
    expect(effectivePlan({ ...late, graceUntil: later }, now)).toBe('pro');
    expect(effectivePlan({ ...late, graceUntil: earlier }, now)).toBe('free');
  });

  it('is free once canceled', () => {
    expect(effectivePlan({ plan: 'pro', status: 'canceled', trialEnd: null, graceUntil: later }, now)).toBe(
      'free',
    );
  });
});

describe('entitlementsFor', () => {
  it('gives free personal books and paid business and rental books', () => {
    expect(entitlementsFor('free')).toMatchObject({
      businessEntities: false,
      rentalEntities: false,
      storageBytes: FREE_STORAGE_BYTES,
    });
    expect(entitlementsFor('pro')).toMatchObject({
      businessEntities: true,
      rentalEntities: true,
      maxBusinesses: 10,
      storageBytes: PRO_STORAGE_BYTES,
    });
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
