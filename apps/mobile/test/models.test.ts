import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import type { LocalTransaction } from '@montra/sync';
import { buildCreateRequest, digitsToDisplay, payeeSuggestions, pressKey } from '../src/features/quick-add';
import { effectiveOutcome, reviewQueue, swipeOutcome } from '../src/features/review';
import { monthSummary } from '../src/features/home';
import {
  buildMapping,
  choicesFromProposal,
  detectDateFormat,
  detectDecimal,
  emptyChoices,
  fileTypeOf,
  nextStep,
} from '../src/features/import-mapping';
import { parseTimeout, shouldLock } from '../src/lock/policy';
import { assessFrame, glareShare, laplacianVariance, summarize, toGray } from '../src/features/camera-metrics';

const t = (id: string, date: string, extra: Partial<LocalTransaction> = {}): LocalTransaction => ({
  id,
  date,
  payee: null,
  description: '',
  amount: '-100',
  currency: 'USD',
  accountId: 'a1',
  categoryId: null,
  categoryName: null,
  memberId: null,
  memo: null,
  tags: [],
  reviewState: 'reviewed',
  status: 'posted',
  suggestedCategoryId: null,
  confidence: null,
  explanation: null,
  merchantName: null,
  version: '1',
  pending: false,
  server: null,
  ...extra,
});

describe('quick add (≤ 3 taps)', () => {
  it('enters amounts like a cash register without floating point', () => {
    let d = '';
    for (const k of ['1', '8', '5', '0'] as const) d = pressKey(d, k);
    expect(d).toBe('1850');
    expect(digitsToDisplay(d, 2)).toBe('18.50');
    expect(digitsToDisplay('5', 2)).toBe('0.05');
    expect(digitsToDisplay('123456789', 2)).toBe('1,234,567.89');
    expect(digitsToDisplay('1850', 0)).toBe('1850');
    expect(pressKey('0', '0')).toBe('');
    expect(pressKey('185', 'back')).toBe('18');
    expect(pressKey('185', 'clear')).toBe('');
    expect(pressKey('999999999999', '9')).toBe('999999999999');
  });

  it('suggests payees by use and recency, with the last category used', () => {
    const history = [
      t('1', '2026-10-01', { payee: 'Blue Bottle', categoryId: 'dining' }),
      t('2', '2026-10-05', { payee: 'blue bottle', categoryId: 'coffee' }),
      t('3', '2026-10-02', { payee: 'Kroger', categoryId: 'groceries' }),
      t('4', '2026-09-01', { payee: 'Bluestone Lane' }),
    ];
    const all = payeeSuggestions(history, '');
    expect(all[0]).toMatchObject({ payee: 'Blue Bottle', count: 2, categoryId: 'coffee' });
    expect(payeeSuggestions(history, 'kro').map((s) => s.payee)).toEqual(['Kroger']);
    expect(payeeSuggestions(history, 'blue').map((s) => s.payee)).toEqual(['Blue Bottle', 'Bluestone Lane']);
  });

  it('builds a signed create request', () => {
    expect(
      buildCreateRequest({
        accountId: 'a1',
        currency: 'USD',
        digits: '1850',
        direction: 'expense',
        payee: ' Lunch ',
        categoryId: null,
        date: '2026-10-31',
      }),
    ).toEqual({ date: '2026-10-31', accountId: 'a1', amount: { amount: '-1850', currency: 'USD' }, payee: 'Lunch' });
    expect(() =>
      buildCreateRequest({ accountId: 'a1', currency: 'USD', digits: '', direction: 'expense', payee: '', categoryId: null, date: '2026-10-31' }),
    ).toThrow();
  });
});

describe('swipe review', () => {
  it('commits on distance or fling, and needs a suggestion to accept', () => {
    expect(swipeOutcome(150, 0, 400)).toBe('accept');
    expect(swipeOutcome(-150, 0, 400)).toBe('edit');
    expect(swipeOutcome(60, 0, 400)).toBe('cancel');
    expect(swipeOutcome(40, 1200, 400)).toBe('accept');
    expect(swipeOutcome(40, -1200, 400)).toBe('cancel');
    expect(effectiveOutcome('accept', t('x', '2026-10-01'))).toBe('edit');
    expect(effectiveOutcome('accept', t('x', '2026-10-01', { suggestedCategoryId: 'c' }))).toBe('accept');
  });

  it('orders the stack by confidence, then date', () => {
    const q = reviewQueue([
      t('a', '2026-10-01', { reviewState: 'needs_review', confidence: 0.5 }),
      t('b', '2026-10-02', { reviewState: 'needs_review', confidence: 0.9 }),
      t('c', '2026-10-03', { reviewState: 'needs_review' }),
      t('d', '2026-10-04'),
    ]);
    expect(q.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('home summary', () => {
  it('sums this month in bigint and lists upcoming bills', () => {
    const s = monthSummary(
      [
        t('1', '2026-10-02', { amount: '-1250', categoryId: 'c' }),
        t('2', '2026-10-15', { amount: '-750', reviewState: 'needs_review' }),
        t('3', '2026-10-20', { amount: '300000', categoryId: 'salary' }),
        t('4', '2026-09-30', { amount: '-999', categoryId: 'c' }),
        t('5', '2026-11-05', { amount: '-1599', status: 'scheduled' }),
        t('6', '2026-10-10', { amount: '-100', currency: 'EUR', categoryId: 'c' }),
      ],
      calendarDate('2026-10-31'),
      'USD',
    );
    expect(s).toMatchObject({ spent: 2000n, income: 300000n, count: 3, needsReview: 1 });
    expect(s.upcoming.map((x) => x.id)).toEqual(['5']);
  });
});

describe('guided mapping', () => {
  const analysis = {
    header: ['Posted', 'Details', 'Debit', 'Credit'],
    sample: [
      ['Posted', 'Details', 'Debit', 'Credit'],
      ['25/10/2026', 'TESCO', '12,50', ''],
      ['03/10/2026', 'SALARY', '', '2.000,00'],
    ],
    accounts: [],
    accountColumn: null,
    templateId: null,
  };

  it('walks the steps and builds a valid mapping', () => {
    const c = emptyChoices();
    expect(nextStep(c)).toBe('date');
    c.date = 0;
    c.description = 1;
    expect(nextStep(c)).toBe('amount');
    c.debit = 2;
    c.credit = 3;
    expect(nextStep(c)).toBe('review');
    expect(buildMapping(c, analysis, null)).toEqual({
      headerRow: 0,
      dataStart: 1,
      date: 0,
      dateFormat: 'DD/MM/YYYY',
      description: [1],
      debit: 2,
      credit: 3,
      sign: 'normal',
      decimal: ',',
    });
  });

  it('detects date formats and decimal separators conservatively', () => {
    expect(detectDateFormat(['10/03/2026', '10/04/2026'])).toBe('MM/DD/YYYY');
    expect(detectDateFormat(['10/03/2026', '10/04/2026'], true)).toBe('DD/MM/YYYY');
    expect(detectDateFormat(['2026-10-03 10:00'])).toBe('YYYY-MM-DD');
    expect(detectDateFormat(['13/03/2026'])).toBe('DD/MM/YYYY');
    expect(detectDateFormat(['hello'])).toBeNull();
    expect(detectDecimal(['$1,234.50', '12.00'])).toBe('.');
    expect(choicesFromProposal(null)).toEqual(emptyChoices());
    expect(fileTypeOf('Statement.PDF')).toBe('pdf');
    expect(fileTypeOf('export', 'text/csv')).toBe('csv');
    expect(fileTypeOf('photo.heic')).toBeNull();
  });
});

describe('app lock (PLT-07)', () => {
  it('locks on cold start and after the inactivity timeout', () => {
    const base = { enabled: true, coldStart: false, lastActiveAt: 0, timeout: '5m' as const };
    expect(shouldLock({ ...base, coldStart: true, now: 0 })).toBe(true);
    expect(shouldLock({ ...base, now: 4 * 60_000 })).toBe(false);
    expect(shouldLock({ ...base, now: 5 * 60_000 })).toBe(true);
    expect(shouldLock({ ...base, timeout: 'never', now: 10 ** 9 })).toBe(false);
    expect(shouldLock({ ...base, timeout: 'immediately', now: 1 })).toBe(true);
    expect(shouldLock({ ...base, enabled: false, coldStart: true, now: 0 })).toBe(false);
    expect(parseTimeout('15m')).toBe('15m');
    expect(parseTimeout('bogus')).toBe('5m');
  });
});

describe('camera frame quality (spike)', () => {
  const frame = (w: number, h: number, px: (x: number, y: number) => number) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = px(x, y);
        rgba.set([v, v, v, 255], (y * w + x) * 4);
      }
    return rgba;
  };

  it('scores sharp edges above flat or smooth images', () => {
    const checker = frame(64, 64, (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 230 : 20));
    const flat = frame(64, 64, () => 128);
    const gradient = frame(64, 64, (x) => x * 4);
    const sharp = laplacianVariance(toGray(checker, 64, 64));
    expect(sharp).toBeGreaterThan(1000);
    expect(laplacianVariance(toGray(flat, 64, 64))).toBe(0);
    expect(laplacianVariance(toGray(gradient, 64, 64))).toBeLessThan(sharp / 100);
    expect(assessFrame(checker, 64, 64)).toMatchObject({ sharp: true, glareOk: true });
  });

  it('measures glare and downscales large frames', () => {
    const glare = frame(100, 100, (x) => (x < 20 ? 255 : 100));
    expect(glareShare(toGray(glare, 100, 100, 100))).toBeCloseTo(0.2, 5);
    const g = toGray(frame(1024, 512, () => 50), 1024, 512);
    expect([g.width, g.height]).toEqual([256, 128]);
  });

  it('summarizes the spike against the go/no-go criteria', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      at: '',
      device: 'Pixel 6',
      kind: 'receipt' as const,
      latencyMs: 800 + i * 10,
      blur: 500,
      glare: 0.01,
      usable: true,
    }));
    expect(summarize(samples)).toMatchObject({ samples: 30, pass: true, sharpShare: 1, usableShare: 1 });
    expect(summarize(samples.slice(0, 10)).pass).toBe(false);
    expect(summarize(samples.map((s) => ({ ...s, latencyMs: 2000 }))).pass).toBe(false);
  });
});
