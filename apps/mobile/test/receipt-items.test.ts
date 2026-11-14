import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import { ITEM_PERIODS, itemQuery, periodFrom, widerPeriod } from '../src/features/receipt-items';

// Item search on the phone (RCP-09): the period it covers and how it widens.
describe('item search periods', () => {
  const today = calendarDate('2026-11-13');

  it('starts three months back and widens a step at a time to everything', () => {
    expect(ITEM_PERIODS.map((p) => periodFrom(today, p))).toEqual([
      '2026-08-13',
      '2026-05-13',
      '2025-11-13',
      '2024-11-13',
      '1970-01-01',
    ]);
    expect(widerPeriod('3m')).toBe('6m');
    expect(widerPeriod('2y')).toBe('all');
    expect(widerPeriod('all')).toBeNull();
  });

  it('sends only a real query', () => {
    expect(itemQuery('  whole   milk ')).toBe('whole milk');
    expect(itemQuery('   ')).toBeNull();
    expect(itemQuery('x'.repeat(150))).toHaveLength(100);
  });
});

describe('store details (RCP-01)', () => {
  it('opens the map, calls and visits', async () => {
    const { storeLinks } = await import('../src/features/store-details');
    const store = {
      storeAddress: '1155 Hollister St, San Diego, CA 92154',
      storePhone: '(619) 575-1111',
      storeWebsite: 'walmart.com',
    };
    expect(storeLinks(store, 'android')).toEqual([
      {
        kind: 'place',
        text: '1155 Hollister St, San Diego, CA 92154',
        url: 'geo:0,0?q=1155%20Hollister%20St%2C%20San%20Diego%2C%20CA%2092154',
      },
      { kind: 'phone', text: '(619) 575-1111', url: 'tel:6195751111' },
      { kind: 'website', text: 'walmart.com', url: 'https://walmart.com' },
    ]);
    expect(storeLinks(store, 'ios')[0]!.url).toMatch(/^https:\/\/maps\.apple\.com\/\?q=1155/);
    expect(storeLinks({ storeAddress: null, storePhone: null, storeWebsite: null }, 'android')).toEqual([]);
  });
});
