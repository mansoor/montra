import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import { catalogs, createTranslator, formatCalendarDate, weekdayName } from '../src/index.js';

describe('messages (TZ-06)', () => {
  const t = createTranslator('en-US', { ...catalogs, de: { 'common.save': 'Speichern' } });

  it('interpolates and pluralizes', () => {
    expect(t.t('transactions.review_count', { count: 0 })).toBe('Nothing to review');
    expect(t.t('transactions.review_count', { count: 1 })).toBe('1 transaction to review');
    expect(t.t('transactions.review_count', { count: 1200 })).toBe('1,200 transactions to review');
    expect(t.t('sharing.invite_sent', { email: 'a@b.co' })).toBe(
      'Invite for a@b.co is ready. It expires in 7 days.',
    );
  });

  it('falls back by language and then to English, and shows missing keys', () => {
    const de = createTranslator('de-AT', { ...catalogs, de: { 'common.save': 'Speichern' } });
    expect(de.t('common.save')).toBe('Speichern');
    expect(de.t('common.cancel')).toBe('Cancel');
    expect(de.t('nope.missing')).toBe('nope.missing');
  });

  it('keeps every English message parseable', () => {
    for (const key of Object.keys(catalogs.en!))
      expect(() => t.t(key, { count: 2, amount: '$1', email: 'x' })).not.toThrow();
  });
});

describe('dates (TZ-02, TZ-05)', () => {
  const d = calendarDate('2026-03-05');
  it('formats by the user-chosen pattern', () => {
    expect(formatCalendarDate(d, { format: 'MM/DD/YYYY' })).toBe('03/05/2026');
    expect(formatCalendarDate(d, { format: 'DD.MM.YYYY' })).toBe('05.03.2026');
    expect(formatCalendarDate(d, { format: 'YYYY-MM-DD' })).toBe('2026-03-05');
  });

  it('formats by locale without shifting the day in any time zone', () => {
    expect(formatCalendarDate(d, { locale: 'en-US' })).toBe('Mar 5, 2026');
    expect(formatCalendarDate(d, { locale: 'de-DE', style: 'long' })).toBe('5. März 2026');
    expect(weekdayName(d, 'en-US', 'long')).toBe('Thursday');
  });
});
