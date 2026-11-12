import { describe, expect, it } from 'vitest';
import type { LeaseDto, MaintenanceDto, RentalContactDto } from '@montra/api-client';
import {
  brokerContacts,
  buildContact,
  buildLease,
  buildLeasePerson,
  buildTenantDetails,
  contactsForProperty,
  contactsToLink,
  emptyContact,
  emptyPerson,
  maintenanceVendor,
  mailtoHref,
  maskedDateOfBirth,
  optionalBps,
  optionalMinor,
  parseUnitLabels,
  peopleByRole,
  percentLabel,
  percentTotal,
  positiveMinor,
  telHref,
  vendorContacts,
  websiteHref,
  type LeaseFormFields,
  type TenantFormFields,
} from './rentals';

const fields = (over: Partial<LeaseFormFields> = {}): LeaseFormFields => ({
  unitId: 'u1',
  tenantIds: ['t1'],
  startDate: '2026-01-01',
  endDate: '',
  rent: '1,500.50',
  dueDay: '1',
  graceDays: '5',
  lateFeeFlat: '',
  lateFeePercent: '',
  lateFeeCap: '',
  deposit: '',
  depositAccountId: '',
  fileIds: [],
  ...over,
});

describe('amounts', () => {
  it('needs a positive amount, in minor units', () => {
    expect(positiveMinor('1,200.05', 'USD')).toEqual({ ok: true, value: '120005' });
    expect(positiveMinor('0', 'USD').ok).toBe(false);
    expect(positiveMinor('abc', 'USD').ok).toBe(false);
  });

  it('allows blank and zero where optional', () => {
    expect(optionalMinor('  ', 'USD')).toEqual({ ok: true, value: null });
    expect(optionalMinor('0', 'USD')).toEqual({ ok: true, value: '0' });
    expect(optionalMinor('-5', 'USD').ok).toBe(false);
  });
});

describe('percentages', () => {
  it('reads basis points, refusing over 100', () => {
    expect(optionalBps('6.25')).toEqual({ ok: true, value: 625 });
    expect(optionalBps('')).toEqual({ ok: true, value: null });
    expect(optionalBps('100.01').ok).toBe(false);
    expect(optionalBps('1.234').ok).toBe(false);
  });

  it('labels a missing ratio with a dash', () => {
    expect(percentLabel(null)).toBe('—');
    expect(percentLabel(85)).toBe('0.85%');
  });

  it('totals targets, or says it can not', () => {
    expect(percentTotal(['50', '25.5', '24.5'])).toBe(10000);
    expect(percentTotal(['50', 'x'])).toBeNull();
  });
});

describe('unit labels', () => {
  it('splits, trims and drops repeats', () => {
    expect(parseUnitLabels(' A, B ,,A')).toEqual([{ label: 'A' }, { label: 'B' }]);
    expect(parseUnitLabels('')).toEqual([]);
  });
});

describe('buildLease', () => {
  it('builds the request, defaulting what was left blank', () => {
    const res = buildLease(fields(), 'USD');
    expect(res).toEqual({
      ok: true,
      value: expect.objectContaining({
        rent: '150050',
        dueDay: 1,
        lateGraceDays: 5,
        lateFeeFlat: '0',
        lateFeeBps: 0,
        lateFeeCap: null,
        deposit: '0',
        endDate: null,
        depositAccountId: null,
      }),
    });
  });

  it('carries the late fee rule and deposit', () => {
    const res = buildLease(
      fields({ lateFeeFlat: '25', lateFeePercent: '5', lateFeeCap: '50', deposit: '1500' }),
      'USD',
    );
    expect(res.ok && res.value).toMatchObject({
      lateFeeFlat: '2500',
      lateFeeBps: 500,
      lateFeeCap: '5000',
      deposit: '150000',
    });
  });

  it.each([
    [{ unitId: '' }, 'unit'],
    [{ tenantIds: [] }, 'tenant'],
    [{ rent: '' }, 'rent'],
    [{ endDate: '2025-12-31' }, 'end date'],
    [{ dueDay: '32' }, 'due day'],
    [{ dueDay: '0' }, 'zero due day'],
    [{ graceDays: '61' }, 'grace'],
    [{ lateFeePercent: '200' }, 'percent'],
    [{ deposit: '-1' }, 'deposit'],
  ])('refuses a bad %j (%s)', (over, _name) => {
    expect(buildLease(fields(over as Partial<LeaseFormFields>), 'USD').ok).toBe(false);
  });
});

// ----- RNT-17..21 -------------------------------------------------------------------------------------------------

const contact = (over: Partial<RentalContactDto> = {}): RentalContactDto => ({
  id: 'c1',
  entityId: 'e1',
  role: 'insurance',
  companyName: 'Acme Insurance',
  contactPerson: null,
  website: null,
  email: null,
  phone: null,
  accountNumber: null,
  notes: null,
  propertyIds: ['p1'],
  archived: false,
  version: 1,
  ...over,
});

type Person = LeaseDto['people'][number];
const person = (over: Partial<Person> = {}): Person => ({
  id: 'lp1',
  role: 'cosigner',
  tenantId: null,
  name: 'Gary Guarantor',
  relationship: null,
  email: null,
  phone: null,
  mailingAddress: null,
  hasDateOfBirth: false,
  notes: null,
  version: 1,
  ...over,
});

describe('links', () => {
  it('links a website only over http or https, adding https when there is no scheme', () => {
    expect(websiteHref('acme.com')).toBe('https://acme.com/');
    expect(websiteHref(' https://acme.com/claims ')).toBe('https://acme.com/claims');
    expect(websiteHref('http://acme.com:8080/x')).toBe('http://acme.com:8080/x');
    expect(websiteHref('acme.com:8080')).toBe('https://acme.com:8080/');
    expect(websiteHref('javascript:alert(1)')).toBeNull();
    expect(websiteHref('JavaScript:alert(1)')).toBeNull();
    expect(websiteHref('data:text/html,hi')).toBeNull();
    expect(websiteHref('ftp://acme.com')).toBeNull();
    expect(websiteHref('not a site')).toBeNull();
    expect(websiteHref('acme')).toBeNull();
    expect(websiteHref('')).toBeNull();
    expect(websiteHref(null)).toBeNull();
  });

  it('dials digits only, keeping a leading plus and an extension', () => {
    expect(telHref('(555) 010-2000')).toBe('tel:5550102000');
    expect(telHref('+1 555 010 2000')).toBe('tel:+15550102000');
    expect(telHref('555-010-2000 ext. 42')).toBe('tel:5550102000,42');
    expect(telHref('call me')).toBeNull();
    expect(telHref(null)).toBeNull();
  });

  it('mails only something shaped like an address', () => {
    expect(mailtoHref('claims@acme.com')).toBe('mailto:claims@acme.com');
    expect(mailtoHref('nope')).toBeNull();
    expect(mailtoHref('a@b.com" onclick=x')).toBeNull();
  });

  it('masks a date of birth whenever one is on file, and never shows it', () => {
    expect(maskedDateOfBirth(true)).toBe('••/••/••••');
    expect(maskedDateOfBirth(false)).toBeNull();
  });
});

describe('people on a lease (RNT-18)', () => {
  const today = '2026-11-12';

  it('groups signers, co-signers and occupants', () => {
    const g = peopleByRole({
      tenants: [{ id: 't1', name: 'Rita' }],
      people: [person(), person({ id: 'lp2', role: 'occupant', name: 'Kid' })],
    });
    expect(g.signers.map((x) => x.name)).toEqual(['Rita']);
    expect(g.cosigners.map((x) => x.name)).toEqual(['Gary Guarantor']);
    expect(g.occupants.map((x) => x.name)).toEqual(['Kid']);
  });

  it('builds a co-signer from a tenant or a name, and an occupant with a date of birth', () => {
    expect(buildLeasePerson({ ...emptyPerson('cosigner'), tenantId: 't2', name: 'ignored' }, today)).toEqual({
      ok: true,
      value: { role: 'cosigner', tenantId: 't2' },
    });
    expect(
      buildLeasePerson(
        { ...emptyPerson('cosigner'), name: ' Gary ', phone: '555', email: 'g@example.com' },
        today,
      ),
    ).toEqual({
      ok: true,
      value: { role: 'cosigner', name: 'Gary', relationship: null, email: 'g@example.com', phone: '555' },
    });
    const kid = buildLeasePerson(
      {
        ...emptyPerson('occupant'),
        name: 'Kid',
        relationship: 'Son',
        dateOfBirth: '2015-04-01',
        tenantId: 't9',
      },
      today,
    );
    expect(kid.ok && kid.value).toMatchObject({ role: 'occupant', name: 'Kid', dateOfBirth: '2015-04-01' });
    expect(kid.ok && 'tenantId' in kid.value).toBe(false);
  });

  it.each([
    [{ ...emptyPerson('cosigner') }, 'no name'],
    [{ ...emptyPerson('cosigner'), name: 'G', email: 'nope' }, 'bad email'],
    [{ ...emptyPerson('occupant'), name: 'K', dateOfBirth: '2027-01-01' }, 'born later'],
  ])('refuses %j (%s)', (f, _name) => {
    expect(buildLeasePerson(f, today).ok).toBe(false);
  });
});

describe('contacts (RNT-21)', () => {
  const list = [
    contact({ id: 'w', role: 'water', companyName: 'City Water' }),
    contact({ id: 'i', role: 'insurance', companyName: 'Acme Insurance', propertyIds: ['p1', 'p2'] }),
    contact({ id: 'm', role: 'property_manager', companyName: 'Best PM' }),
    contact({ id: 'h', role: 'handyman', companyName: 'Fix-It', propertyIds: ['p2'] }),
    contact({ id: 'b', role: 'broker', companyName: 'Zed Realty', propertyIds: [] }),
    contact({ id: 'x', role: 'handyman', companyName: 'Old Co', archived: true }),
  ];

  it('lists a property’s contacts by role, leaving out archived ones', () => {
    expect(contactsForProperty(list, 'p1').map((c) => c.id)).toEqual(['m', 'i', 'w']);
    expect(contactsToLink(list, 'p1').map((c) => c.id)).toEqual(['h', 'b']);
  });

  it('offers vendors without utilities, those serving the property first', () => {
    expect(vendorContacts(list, 'p2').map((c) => c.id)).toEqual(['i', 'h', 'm', 'b']);
    expect(brokerContacts(list).map((c) => c.id)).toEqual(['b']);
  });

  it('shows a job’s contact, or the vendor typed', () => {
    const m: Pick<MaintenanceDto, 'contactName' | 'vendor'> = { contactName: null, vendor: 'Bob' };
    expect(maintenanceVendor(m)).toBe('Bob');
    expect(maintenanceVendor({ ...m, contactName: 'Fix-It' })).toBe('Fix-It');
  });

  it('builds a contact, blanks as null', () => {
    expect(
      buildContact({ ...emptyContact('electricity'), companyName: ' PG&E ', phone: '1-800-743-5000' }),
    ).toEqual({
      ok: true,
      value: {
        role: 'electricity',
        companyName: 'PG&E',
        contactPerson: null,
        website: null,
        email: null,
        phone: '1-800-743-5000',
        accountNumber: null,
        notes: null,
      },
    });
    expect(buildContact(emptyContact()).ok).toBe(false);
    expect(buildContact({ ...emptyContact(), companyName: 'X', website: 'javascript:alert(1)' }).ok).toBe(
      false,
    );
    expect(buildContact({ ...emptyContact(), companyName: 'X', email: 'nope' }).ok).toBe(false);
  });
});

describe('tenant details (RNT-17)', () => {
  const today = '2026-11-12';
  const f = (over: Partial<TenantFormFields> = {}): TenantFormFields => ({
    name: 'Rita Rollins',
    email: '',
    phone: '',
    phoneAlt: '555-0101',
    mailingAddress: '',
    dateOfBirth: '',
    dateOfBirthChanged: false,
    emergencyName: 'Ron',
    emergencyRelationship: 'Brother',
    emergencyPhone: '555-0199',
    employer: 'Acme',
    monthlyIncome: '6,250.50',
    vehicle: '',
    notes: '',
    ...over,
  });

  it('sends the date of birth only when it changed, and income as minor units', () => {
    const res = buildTenantDetails(f(), 'USD', today);
    expect(res.ok && res.value).toMatchObject({
      phoneAlt: '555-0101',
      monthlyIncome: '625050',
      vehicle: null,
    });
    expect(res.ok && 'dateOfBirth' in res.value).toBe(false);
    const set = buildTenantDetails(f({ dateOfBirth: '1990-02-03', dateOfBirthChanged: true }), 'USD', today);
    expect(set.ok && set.value.dateOfBirth).toBe('1990-02-03');
    const cleared = buildTenantDetails(f({ dateOfBirthChanged: true }), 'USD', today);
    expect(cleared.ok && cleared.value.dateOfBirth).toBeNull();
  });

  it.each([
    [{ name: ' ' }, 'name'],
    [{ email: 'nope' }, 'email'],
    [{ monthlyIncome: '-1' }, 'income'],
    [{ dateOfBirth: '2030-01-01', dateOfBirthChanged: true }, 'future birth'],
  ])('refuses %j (%s)', (over, _name) => {
    expect(buildTenantDetails(f(over), 'USD', today).ok).toBe(false);
  });
});
