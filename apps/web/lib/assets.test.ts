import { describe, expect, it } from 'vitest';
import type { BusinessAssetDto } from '@montra/api-client';
import { calendarDate as d } from '@montra/domain';
import {
  assetState,
  attendeesText,
  canReimburse,
  driverText,
  parseAttendeeNames,
  spentByText,
  suggestedLife,
  unpostedYears,
} from './assets';

const t = (key: string) => key;

const asset = (over: Partial<BusinessAssetDto> = {}): BusinessAssetDto => ({
  id: 'a1',
  entityId: 'e1',
  name: 'Laptop',
  category: 'computers',
  serial: null,
  cost: '1000000',
  currency: 'USD',
  inServiceDate: d('2024-03-01'),
  method: 'macrs_half_year',
  lifeYears: 5,
  section179: '0',
  transactionId: null,
  notes: null,
  accumulated: '200000',
  bookValue: '800000',
  schedule: [
    { year: 2024, amount: '200000', posted: true },
    { year: 2025, amount: '320000', posted: false },
    { year: 2026, amount: '192000', posted: false },
  ],
  disposal: null,
  assignedTo: null,
  assignments: [],
  version: 1,
  ...over,
});

describe('assets on the web (BIZ-16, BIZ-17)', () => {
  it('suggests the IRS recovery period by category', () => {
    expect(suggestedLife('computers')).toBe(5);
    expect(suggestedLife('furniture')).toBe(7);
    expect(suggestedLife('software')).toBe(3);
  });

  it('lists the years still to post, leaving out disposed assets', () => {
    expect(unpostedYears([asset()], 2025)).toEqual([2025]);
    expect(unpostedYears([asset()], 2026)).toEqual([2025, 2026]);
    const sold = asset({
      disposal: { date: d('2025-06-01'), proceeds: '0', gain: '0', note: null, transactionId: null },
    });
    expect(unpostedYears([sold], 2026)).toEqual([]);
  });

  it('says whether an asset is in use, with someone, or gone', () => {
    expect(assetState(asset())).toBe('in_use');
    expect(
      assetState(
        asset({
          assignedTo: {
            id: 's',
            personId: 'p',
            personName: 'Casey',
            assignedOn: d('2024-03-04'),
            returnedOn: null,
            note: null,
            version: 1,
          },
        }),
      ),
    ).toBe('assigned');
    expect(
      assetState(
        asset({
          disposal: { date: d('2025-01-01'), proceeds: '0', gain: '0', note: null, transactionId: null },
        }),
      ),
    ).toBe('disposed');
  });
});

describe('expense details (BIZ-18)', () => {
  it('names who spent', () => {
    expect(spentByText({ spentBy: 'owner', spentByName: null }, t)).toBe('expense.spent_by_owner');
    expect(spentByText({ spentBy: 'person', spentByName: 'Casey Example' }, t)).toBe('Casey Example');
    expect(spentByText({ spentBy: null, spentByName: null }, t)).toBeNull();
  });

  it('reads attendees typed with commas or on lines', () => {
    expect(parseAttendeeNames(' Jordan , \nSam Lee,, ')).toEqual(['Jordan', 'Sam Lee']);
    expect(
      attendeesText({
        attendees: [
          { partyId: 'p', name: 'Northwind Co' },
          { partyId: null, name: 'Jordan' },
        ],
      }),
    ).toBe('Northwind Co, Jordan');
  });
});

describe('trips by driver (BIZ-19)', () => {
  it('offers reimbursing only someone else’s trip without a live reimbursement', () => {
    expect(canReimburse({ driver: 'owner', reimbursementStatus: null })).toBe(false);
    expect(canReimburse({ driver: 'person', reimbursementStatus: null })).toBe(true);
    expect(canReimburse({ driver: 'person', reimbursementStatus: 'approved' })).toBe(false);
    expect(canReimburse({ driver: 'person', reimbursementStatus: 'declined' })).toBe(true);
    expect(driverText({ driver: 'owner', driverName: null }, t)).toBe('mileage.driver_owner');
    expect(driverText({ driver: 'person', driverName: 'Casey' }, t)).toBe('Casey');
  });
});
