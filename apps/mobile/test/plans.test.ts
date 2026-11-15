import { describe, expect, it } from 'vitest';
import type { PlanOfferDto } from '@montra/schemas';
import { aiUsedPercent, headlinePrice, otherPlans } from '../src/features/plans';

const offer = (key: string, prices: PlanOfferDto['prices']): PlanOfferDto => ({
  key,
  name: key,
  description: '',
  entitlements: {
    businessBooks: 0,
    rentalPortfolios: 0,
    storageBytes: '0',
    familyLogins: null,
    aiMonthlyMicroUsd: null,
    smsMonthly: 0,
    features: [],
  },
  prices,
});

describe('the plan and AI on the phone (ADR-0049)', () => {
  it('shows AI as a whole share, never dollars', () => {
    expect(aiUsedPercent(null)).toBeNull();
    expect(aiUsedPercent(0.704)).toBe(70);
    expect(aiUsedPercent(1.5)).toBe(100);
  });

  it('lists the other paid plans, and their monthly price first', () => {
    const month = { interval: 'month' as const, amountMinor: '900', currency: 'USD' };
    const year = { interval: 'year' as const, amountMinor: '9000', currency: 'USD' };
    const offers = [offer('free', []), offer('pro', [year, month]), offer('plus', []), offer('max', [year])];
    expect(otherPlans(offers, 'pro').map((o) => o.key)).toEqual(['max']);
    expect(headlinePrice(offers[1]!)).toBe(month);
    expect(headlinePrice(offers[3]!)).toBe(year);
  });
});
