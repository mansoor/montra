import { describe, expect, it } from 'vitest';
import type { PayrollPersonDto } from '@montra/api-client';
import { calendarDate as d } from '@montra/domain';
import { formatTinInput, hoursText, i9Overdue, missingSteps, parseHours } from './payroll';

const person = (over: Partial<PayrollPersonDto> = {}): PayrollPersonDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  entityId: '00000000-0000-4000-8000-000000000002',
  kind: 'employee',
  firstName: 'Avery',
  middleName: null,
  lastName: 'Testperson',
  displayName: 'Avery Testperson',
  businessName: null,
  email: null,
  phone: null,
  address: {
    line1: '12 Fern St',
    line2: null,
    city: 'Portland',
    region: 'ME',
    postalCode: '04102',
    country: 'US',
  },
  tinType: 'ssn',
  tinMasked: '•••-••-3456',
  hasBirthDate: true,
  hireDate: d('2026-11-02'),
  endDate: null,
  status: 'active',
  payType: 'hourly',
  rate: '2250',
  workState: 'ME',
  bank: null,
  vendorPartyId: null,
  notes: null,
  payScheduleId: null,
  defaultHoursMilli: null,
  onboarding: { w4: null, w9: null, i9: null },
  isOwner: false,
  ownerNote: null,
  version: 1,
  ...over,
});

const i9: NonNullable<PayrollPersonDto['onboarding']['i9']> = {
  id: '00000000-0000-4000-8000-000000000003',
  section1: true,
  section2: false,
  documents: 1,
  section2Due: d('2026-11-05'),
  retainUntil: null,
  mayDestroy: false,
};

describe('missingSteps', () => {
  it('lists what an employee still needs, in order', () => {
    expect(missingSteps(person())).toEqual(['w4', 'i9_section1', 'i9_section2']);
    expect(missingSteps(person({ tinMasked: null, onboarding: { w4: null, w9: null, i9 } }))).toEqual([
      'details',
      'w4',
      'i9_section2',
    ]);
  });

  it('asks a contractor only for a W-9', () => {
    expect(missingSteps(person({ kind: 'contractor', tinMasked: null }))).toEqual(['w9']);
    expect(
      missingSteps(
        person({
          kind: 'contractor',
          onboarding: { w4: null, i9: null, w9: { id: i9.id, signedOn: d('2026-11-01') } },
        }),
      ),
    ).toEqual([]);
  });
});

describe('i9Overdue', () => {
  it('is late once the third business day has passed without Section 2', () => {
    const p = person({ onboarding: { w4: null, w9: null, i9 } });
    expect(i9Overdue(p, '2026-11-05')).toBe(false);
    expect(i9Overdue(p, '2026-11-06')).toBe(true);
    expect(
      i9Overdue(person({ onboarding: { w4: null, w9: null, i9: { ...i9, section2: true } } }), '2026-12-01'),
    ).toBe(false);
  });
});

describe('formatTinInput', () => {
  it('writes an SSN and an EIN the way they’re printed', () => {
    expect(formatTinInput('ssn', '900123456')).toBe('900-12-3456');
    expect(formatTinInput('ssn', '9001')).toBe('900-1');
    expect(formatTinInput('ein', '987654321')).toBe('98-7654321');
    expect(formatTinInput('ssn', '900-12-34567890')).toBe('900-12-3456');
  });
});

describe('hours', () => {
  it('reads and writes hours in thousandths', () => {
    expect(parseHours('37.5')).toBe('37500');
    expect(parseHours('80')).toBe('80000');
    expect(parseHours('7,25')).toBe('7250');
    expect(parseHours('1.2345')).toBeUndefined();
    expect(parseHours('-1')).toBeUndefined();
    expect(hoursText('37500')).toBe('37.5');
    expect(hoursText('80000')).toBe('80');
    expect(hoursText('1250')).toBe('1.25');
  });
});
