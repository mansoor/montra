import { describe, expect, it } from 'vitest';
import {
  channelOutcome,
  deliveryTime,
  inQuietHours,
  localClock,
  matchSnippet,
  parseSearchQuery,
  searchAmountToMinor,
  textMatchesTerms,
} from '../src/index.js';

describe('parseSearchQuery', () => {
  it('reads words, amounts and tags in any order', () => {
    expect(parseSearchQuery('coffee >20 tag:travel beans')).toEqual({
      terms: ['coffee', 'beans'],
      amounts: [{ op: '>', value: '20' }],
      tags: ['travel'],
    });
  });

  it('joins an operator to the number after it, with separators and a currency sign', () => {
    expect(parseSearchQuery('> 500').amounts).toEqual([{ op: '>', value: '500' }]);
    expect(parseSearchQuery('>=$1,500.50').amounts).toEqual([{ op: '>=', value: '1500.50' }]);
    expect(parseSearchQuery('<20 >5').amounts).toHaveLength(2);
    expect(parseSearchQuery('=12.50').amounts).toEqual([{ op: '=', value: '12.50' }]);
  });

  it('keeps quoted phrases whole', () => {
    expect(parseSearchQuery('"whole foods" >20')).toEqual({
      terms: ['whole foods'],
      amounts: [{ op: '>', value: '20' }],
      tags: [],
    });
  });

  it('treats what does not parse as words, so typing never fails', () => {
    expect(parseSearchQuery('>abc tag: "unclosed').terms).toEqual(['>abc', 'tag:', 'unclosed']);
    expect(parseSearchQuery('').terms).toEqual([]);
    expect(parseSearchQuery('>').terms).toEqual(['>']);
  });

  it('keeps tag case, and accepts the prefix in any case', () => {
    expect(parseSearchQuery('TAG:Travel').tags).toEqual(['Travel']);
  });

  it('limits how much it takes', () => {
    expect(parseSearchQuery('a b c d e f g h i j k l').terms).toHaveLength(10);
  });
});

describe('searchAmountToMinor', () => {
  it('scales by the currency, cutting extra places', () => {
    expect(searchAmountToMinor('500', 2)).toBe(50000n);
    expect(searchAmountToMinor('12.5', 2)).toBe(1250n);
    expect(searchAmountToMinor('12.999', 2)).toBe(1299n);
    expect(searchAmountToMinor('500', 0)).toBe(500n);
    expect(searchAmountToMinor('1.5', 3)).toBe(1500n);
  });
});

describe('matching text', () => {
  it('needs every term, ignoring case', () => {
    expect(textMatchesTerms('Birthday gift for Sam', ['gift', 'SAM'])).toBe(true);
    expect(textMatchesTerms('Birthday gift', ['gift', 'sam'])).toBe(false);
  });

  it('shows the words around a match and marks what was cut', () => {
    const text = `${'a '.repeat(100)}needle ${'b '.repeat(100)}`;
    const snippet = matchSnippet(text, ['needle'], 40);
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(matchSnippet('short text', ['short'])).toBe('short text');
  });
});

describe('quiet hours', () => {
  const overnight = { start: 22 * 60, end: 7 * 60 };

  it('runs past midnight, including the start and not the end', () => {
    expect(inQuietHours(22 * 60, overnight)).toBe(true);
    expect(inQuietHours(23 * 60, overnight)).toBe(true);
    expect(inQuietHours(6 * 60 + 59, overnight)).toBe(true);
    expect(inQuietHours(7 * 60, overnight)).toBe(false);
    expect(inQuietHours(12 * 60, overnight)).toBe(false);
  });

  it('works inside one day, and the same start and end means none', () => {
    expect(inQuietHours(13 * 60, { start: 12 * 60, end: 14 * 60 })).toBe(true);
    expect(inQuietHours(15 * 60, { start: 12 * 60, end: 14 * 60 })).toBe(false);
    expect(inQuietHours(60, { start: 60, end: 60 })).toBe(false);
  });

  it('holds a notification until the end, in the user’s time zone', () => {
    // 04:00 UTC on 4 Nov is 22:00 on 3 Nov in Chicago (UTC-6 in winter): just started, nine hours to go.
    const now = new Date('2026-11-04T04:00:00Z');
    expect(deliveryTime(now, 'America/Chicago', overnight).toISOString()).toBe('2026-11-04T13:00:00.000Z');
    // The same instant in Karachi is 09:00: fine to send now.
    expect(deliveryTime(now, 'Asia/Karachi', overnight)).toEqual(now);
    expect(deliveryTime(now, 'America/Chicago', null)).toEqual(now);
  });

  it('reads the local clock', () => {
    expect(localClock(new Date('2026-11-04T04:30:00Z'), 'America/Chicago')).toEqual({
      minutes: 22 * 60 + 30,
      date: '2026-11-03',
      weekday: 2,
    });
    // Midnight is hour zero, not 24.
    expect(localClock(new Date('2026-11-04T00:00:00Z'), 'UTC').minutes).toBe(0);
  });
});

describe('channelOutcome', () => {
  const base = { enabled: true, hasDestination: true, sentToday: 0, cap: 5 };

  it('sends under the cap, and keeps it in-app at the cap', () => {
    expect(channelOutcome(base)).toBe('send');
    expect(channelOutcome({ ...base, sentToday: 4 })).toBe('send');
    expect(channelOutcome({ ...base, sentToday: 5 })).toBe('capped');
    expect(channelOutcome({ ...base, cap: 0 })).toBe('capped');
  });

  it('respects the preference first, then needs somewhere to send it', () => {
    expect(channelOutcome({ ...base, enabled: false, sentToday: 9 })).toBe('off');
    expect(channelOutcome({ ...base, hasDestination: false })).toBe('none');
  });
});
