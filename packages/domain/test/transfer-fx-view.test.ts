import { describe, expect, it } from 'vitest';
import { bpsPercent, displayRate, transferFxView, type TransferFxFigures } from '../src/index.js';

const fx: TransferFxFigures = {
  sent: { currency: 'USD' },
  received: { currency: 'EUR' },
  effectiveRate: '0.9090909091',
  marketRate: '0.9259259259',
  marketRateDate: '2026-11-13',
  cost: { amount: '2000', currency: 'USD' },
  costBps: 182,
};

describe('transfer FX view (CUR-08)', () => {
  it('shows rates at four significant decimals', () => {
    expect(displayRate('0.9090909091')).toBe('0.9091');
    expect(displayRate('1.08')).toBe('1.08');
    expect(displayRate('150')).toBe('150');
    expect(displayRate('0.0067114094')).toBe('0.006711');
  });

  it('shows basis points as a percent without the sign', () => {
    expect(bpsPercent(182)).toBe('1.82');
    expect(bpsPercent(-5)).toBe('0.05');
    expect(bpsPercent(1000)).toBe('10.00');
  });

  it('reads a cost, a gain, an even rate and a missing market rate', () => {
    expect(transferFxView(fx)).toEqual({
      effective: '1 USD = 0.9091 EUR',
      market: '1 USD = 0.9259 EUR',
      marketDate: '2026-11-13',
      outcome: { tone: 'cost', amount: 2000n, currency: 'USD', percent: '1.82' },
    });
    expect(
      transferFxView({ ...fx, cost: { amount: '-800', currency: 'USD' }, costBps: -80 }).outcome,
    ).toEqual({
      tone: 'gain',
      amount: 800n,
      currency: 'USD',
      percent: '0.80',
    });
    expect(transferFxView({ ...fx, cost: { amount: '0', currency: 'USD' }, costBps: 0 }).outcome?.tone).toBe(
      'even',
    );
    const none = transferFxView({ ...fx, marketRate: null, marketRateDate: null, cost: null, costBps: null });
    expect(none.market).toBeNull();
    expect(none.outcome).toBeNull();
    expect(none.effective).toBe('1 USD = 0.9091 EUR');
  });
});
