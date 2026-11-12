/**
 * Rental screens' pure helpers (RNT-01..14): typed amounts ↔ the API's minor units, and building a lease. No float math:
 * amounts go through parseAmountInput, and rates are checked as text.
 */
import type {
  CreateLeaseInput,
  CreateRentalContactInput,
  LeaseDto,
  LeasePersonInput,
  MaintenanceDto,
  RentalContactDto,
  RentalContactRole,
  RentChargeDto,
  UpdateTenantInput,
} from '@montra/api-client';
import { percentToBps } from './business';
import { parseAmountInput } from './money';
import { staticT } from './i18n-static';

type T = (key: string, values?: Record<string, string | number>) => string;

export const RENT_CHIP: Record<RentChargeDto['status'], string> = {
  paid: 'chip chip-good',
  partial: 'chip chip-warn',
  upcoming: 'chip',
  due: 'chip chip-warn',
  late: 'chip chip-bad',
  waived: 'chip',
};

export const MAINTENANCE_CHIP: Record<MaintenanceDto['status'], string> = {
  open: 'chip chip-warn',
  scheduled: 'chip',
  done: 'chip chip-good',
};

export const PROPERTY_TYPES = ['sfh', 'multi_family', 'condo', 'str', 'commercial'] as const;
export const REMINDER_KINDS = ['insurance', 'property_tax', 'inspection', 'other'] as const;
export const MAINTENANCE_STATUSES = ['open', 'scheduled', 'done'] as const;
export const ALLOCATION_BASES = ['percent', 'units', 'sqft'] as const;

export type Parsed<V> = { ok: true; value: V } | { ok: false; error: string };

/** A required amount above zero, as minor units. */
export function positiveMinor(input: string, currency: string, t: T = staticT): Parsed<string> {
  const p = parseAmountInput(input, currency, 'en-US', t);
  if (!p.ok) return { ok: false, error: p.error };
  if (p.minor <= 0n) return { ok: false, error: t('money.positive') };
  return { ok: true, value: String(p.minor) };
}

/** An amount that may be blank (null) or zero. */
export function optionalMinor(input: string, currency: string, t: T = staticT): Parsed<string | null> {
  if (!input.trim()) return { ok: true, value: null };
  const p = parseAmountInput(input, currency, 'en-US', t);
  if (!p.ok) return { ok: false, error: p.error };
  if (p.minor < 0n) return { ok: false, error: t('money.positive') };
  return { ok: true, value: String(p.minor) };
}

/** A percentage such as 6.25 as basis points; blank is null. */
export function optionalBps(input: string, t: T = staticT): Parsed<number | null> {
  if (!input.trim()) return { ok: true, value: null };
  const bps = percentToBps(input);
  if (bps === null || bps > 10000) return { ok: false, error: t('rentals.percent_invalid') };
  return { ok: true, value: bps };
}

/** Basis points shown as a percent, or a dash when there's nothing to divide by. */
export function percentLabel(bps: number | null): string {
  return bps === null ? '—' : `${(bps / 100).toFixed(2)}%`;
}

/** "A, B, 2C" → unit labels; blank means one home with one unit. */
export function parseUnitLabels(input: string): { label: string }[] {
  return [...new Set(input.split(',').map((s) => s.trim()))].filter(Boolean).map((label) => ({ label }));
}

export interface LeaseFormFields {
  unitId: string;
  tenantIds: string[];
  startDate: string;
  endDate: string;
  rent: string;
  dueDay: string;
  graceDays: string;
  lateFeeFlat: string;
  lateFeePercent: string;
  lateFeeCap: string;
  deposit: string;
  depositAccountId: string;
  fileIds: string[];
}

/** The form as a request, or the first thing wrong with it. */
export function buildLease(f: LeaseFormFields, currency: string, t: T = staticT): Parsed<CreateLeaseInput> {
  if (!f.unitId) return { ok: false, error: t('rentals.choose_unit') };
  if (f.tenantIds.length === 0) return { ok: false, error: t('rentals.choose_tenant') };
  const rent = positiveMinor(f.rent, currency, t);
  if (!rent.ok) return rent;
  if (f.endDate && f.endDate < f.startDate) return { ok: false, error: t('rentals.lease_dates') };
  const dueDay = Number(f.dueDay);
  if (!/^\d{1,2}$/.test(f.dueDay) || dueDay < 1 || dueDay > 31) {
    return { ok: false, error: t('rentals.due_day_invalid') };
  }
  const grace = Number(f.graceDays);
  if (!/^\d{1,2}$/.test(f.graceDays) || grace > 60) return { ok: false, error: t('rentals.grace_invalid') };
  const flat = optionalMinor(f.lateFeeFlat, currency, t);
  if (!flat.ok) return flat;
  const bps = optionalBps(f.lateFeePercent, t);
  if (!bps.ok) return bps;
  const cap = optionalMinor(f.lateFeeCap, currency, t);
  if (!cap.ok) return cap;
  const deposit = optionalMinor(f.deposit, currency, t);
  if (!deposit.ok) return deposit;
  return {
    ok: true,
    value: {
      unitId: f.unitId,
      tenantIds: f.tenantIds,
      startDate: f.startDate as CreateLeaseInput['startDate'],
      endDate: (f.endDate || null) as CreateLeaseInput['endDate'],
      rent: rent.value,
      dueDay,
      lateGraceDays: grace,
      lateFeeFlat: flat.value ?? '0',
      lateFeeBps: bps.value ?? 0,
      lateFeeCap: cap.value,
      deposit: deposit.value ?? '0',
      depositAccountId: f.depositAccountId || null,
      fileIds: f.fileIds,
    },
  };
}

/** Percent targets must come to 100 before they're sent; units and square footage are read by the server. */
export function percentTotal(values: readonly string[]): number | null {
  let total = 0;
  for (const v of values) {
    const bps = percentToBps(v);
    if (bps === null) return null;
    total += bps;
  }
  return total;
}

// ----- Tenant details, people on a lease and property contacts (RNT-17..21, ADR-0038) ----------------------------

/** In the order the contacts card lists them: who runs the place, who fixes it, who covers it, then the utilities. */
export const CONTACT_ROLES: readonly RentalContactRole[] = [
  'property_manager',
  'handyman',
  'insurance',
  'home_warranty',
  'hoa',
  'landscaping',
  'broker',
  'attorney',
  'water',
  'electricity',
  'gas',
  'garbage',
  'internet',
  'other',
];

export const LEASE_COST_KINDS = ['broker_fee', 'legal_fee'] as const;

/** Never the date itself: Show asks the server, which needs a recent sign-in and logs it. */
export const maskedDateOfBirth = (has: boolean): string | null => (has ? '••/••/••••' : null);

/**
 * A website as typed, as a link: "acme.com" becomes "https://acme.com". Anything that isn't http or https (such as
 * `javascript:`) gives no link at all.
 */
export function websiteHref(input: string | null | undefined): string | null {
  const s = input?.trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
  return url.href;
}

/** "(555) 010-2000 ext. 4" → "tel:5550102000,4"; a leading + stays. Null without digits. */
export function telHref(phone: string | null | undefined): string | null {
  const s = phone?.trim();
  if (!s) return null;
  const [main = '', ext] = s.split(/\s*(?:ext\.?|x|#)\s*/i);
  const digits = main.replace(/[^\d]/g, '');
  if (!digits) return null;
  const plus = main.trimStart().startsWith('+') ? '+' : '';
  const extDigits = ext?.replace(/[^\d]/g, '');
  return `tel:${plus}${digits}${extDigits ? `,${extDigits}` : ''}`;
}

/** A mail link, only for something shaped like an address. */
export function mailtoHref(email: string | null | undefined): string | null {
  const s = email?.trim();
  return s && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s) ? `mailto:${s}` : null;
}

/** A lease's people by role: those who sign (and pay), co-signers, occupants (RNT-18). */
export function peopleByRole(lease: Pick<LeaseDto, 'tenants' | 'people'>) {
  return {
    signers: lease.tenants,
    cosigners: lease.people.filter((p) => p.role === 'cosigner'),
    occupants: lease.people.filter((p) => p.role === 'occupant'),
  };
}

const roleOrder = (r: RentalContactRole) => CONTACT_ROLES.indexOf(r);
const byRoleThenName = (a: RentalContactDto, b: RentalContactDto) =>
  roleOrder(a.role) - roleOrder(b.role) || a.companyName.localeCompare(b.companyName);

/** Contacts linked to one property, by role, leaving out archived ones. */
export function contactsForProperty(
  contacts: readonly RentalContactDto[],
  propertyId: string,
): RentalContactDto[] {
  return contacts.filter((c) => !c.archived && c.propertyIds.includes(propertyId)).sort(byRoleThenName);
}

/** The portfolio's other contacts, which can be linked to this property too. */
export function contactsToLink(
  contacts: readonly RentalContactDto[],
  propertyId: string,
): RentalContactDto[] {
  return contacts.filter((c) => !c.archived && !c.propertyIds.includes(propertyId)).sort(byRoleThenName);
}

/** Who a maintenance job can go to: utilities aside, those serving the property first. */
export function vendorContacts(
  contacts: readonly RentalContactDto[],
  propertyId: string,
): RentalContactDto[] {
  const utility = new Set<RentalContactRole>(['water', 'electricity', 'gas', 'garbage', 'internet']);
  const here = (c: RentalContactDto) => Number(c.propertyIds.includes(propertyId));
  return contacts
    .filter((c) => !c.archived && !utility.has(c.role))
    .sort((a, b) => here(b) - here(a) || a.companyName.localeCompare(b.companyName));
}

/** Brokers and agents, for a lease's broker. */
export const brokerContacts = (contacts: readonly RentalContactDto[]): RentalContactDto[] =>
  contacts.filter((c) => !c.archived && c.role === 'broker').sort(byRoleThenName);

/** The vendor a job went to: the contact if one was picked, else what was typed. */
export const maintenanceVendor = (m: Pick<MaintenanceDto, 'contactName' | 'vendor'>): string | null =>
  m.contactName ?? m.vendor;

const orNull = (s: string): string | null => s.trim() || null;
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export interface ContactFormFields {
  role: RentalContactRole;
  companyName: string;
  contactPerson: string;
  website: string;
  email: string;
  phone: string;
  accountNumber: string;
  notes: string;
}

export const emptyContact = (role: RentalContactRole = 'property_manager'): ContactFormFields => ({
  role,
  companyName: '',
  contactPerson: '',
  website: '',
  email: '',
  phone: '',
  accountNumber: '',
  notes: '',
});

export const contactFields = (c: RentalContactDto): ContactFormFields => ({
  role: c.role,
  companyName: c.companyName,
  contactPerson: c.contactPerson ?? '',
  website: c.website ?? '',
  email: c.email ?? '',
  phone: c.phone ?? '',
  accountNumber: c.accountNumber ?? '',
  notes: c.notes ?? '',
});

type ContactBody = Omit<CreateRentalContactInput, 'entityId' | 'propertyIds'>;

/** The contact form as a request body, or the first thing wrong with it. */
export function buildContact(f: ContactFormFields, t: T = staticT): Parsed<ContactBody> {
  const companyName = f.companyName.trim();
  if (!companyName) return { ok: false, error: t('rentals.contact_company_required') };
  const website = orNull(f.website);
  if (website && !websiteHref(website)) return { ok: false, error: t('rentals.contact_website_invalid') };
  const email = orNull(f.email);
  if (email && !looksLikeEmail(email)) return { ok: false, error: t('rentals.email_invalid') };
  return {
    ok: true,
    value: {
      role: f.role,
      companyName,
      contactPerson: orNull(f.contactPerson),
      website,
      email,
      phone: orNull(f.phone),
      accountNumber: orNull(f.accountNumber),
      notes: orNull(f.notes),
    },
  };
}

export interface TenantFormFields {
  name: string;
  email: string;
  phone: string;
  phoneAlt: string;
  mailingAddress: string;
  /** Blank unless the landlord types one: the date on file is never sent to the page. */
  dateOfBirth: string;
  /** Typed a new date, or asked to clear it. Otherwise the date on file stays. */
  dateOfBirthChanged: boolean;
  emergencyName: string;
  emergencyRelationship: string;
  emergencyPhone: string;
  employer: string;
  monthlyIncome: string;
  vehicle: string;
  notes: string;
}

type TenantBody = Omit<UpdateTenantInput, 'version'>;

/** A tenant's details as a request body; the date of birth only when it changed (RNT-17). */
export function buildTenantDetails(
  f: TenantFormFields,
  currency: string,
  today: string,
  t: T = staticT,
): Parsed<TenantBody> {
  const name = f.name.trim();
  if (!name) return { ok: false, error: t('rentals.tenant_name_required') };
  const email = orNull(f.email);
  if (email && !looksLikeEmail(email)) return { ok: false, error: t('rentals.email_invalid') };
  const income = optionalMinor(f.monthlyIncome, currency, t);
  if (!income.ok) return income;
  const body: TenantBody = {
    name,
    email,
    phone: orNull(f.phone),
    phoneAlt: orNull(f.phoneAlt),
    mailingAddress: orNull(f.mailingAddress),
    emergencyName: orNull(f.emergencyName),
    emergencyRelationship: orNull(f.emergencyRelationship),
    emergencyPhone: orNull(f.emergencyPhone),
    employer: orNull(f.employer),
    monthlyIncome: income.value,
    vehicle: orNull(f.vehicle),
    notes: orNull(f.notes),
  };
  if (f.dateOfBirthChanged) {
    const dob = f.dateOfBirth.trim();
    if (dob && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || dob > today)) {
      return { ok: false, error: t('rentals.dob_invalid') };
    }
    body.dateOfBirth = (dob || null) as TenantBody['dateOfBirth'];
  }
  return { ok: true, value: body };
}

export interface PersonFormFields {
  role: 'cosigner' | 'occupant';
  /** A co-signer can be one of the portfolio's tenants. */
  tenantId: string;
  name: string;
  relationship: string;
  email: string;
  phone: string;
  dateOfBirth: string;
}

export const emptyPerson = (role: PersonFormFields['role']): PersonFormFields => ({
  role,
  tenantId: '',
  name: '',
  relationship: '',
  email: '',
  phone: '',
  dateOfBirth: '',
});

/** A co-signer or occupant as a request, or the first thing wrong with it (RNT-18). */
export function buildLeasePerson(
  f: PersonFormFields,
  today: string,
  t: T = staticT,
): Parsed<LeasePersonInput> {
  const tenantId = f.role === 'cosigner' ? f.tenantId : '';
  const name = f.name.trim();
  if (!tenantId && !name) return { ok: false, error: t('rentals.person_name_required') };
  const email = orNull(f.email);
  if (email && !looksLikeEmail(email)) return { ok: false, error: t('rentals.email_invalid') };
  const dob = f.role === 'occupant' ? f.dateOfBirth.trim() : '';
  if (dob && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || dob > today)) {
    return { ok: false, error: t('rentals.dob_invalid') };
  }
  if (tenantId) return { ok: true, value: { role: 'cosigner', tenantId } };
  return {
    ok: true,
    value: {
      role: f.role,
      name,
      relationship: orNull(f.relationship),
      email,
      phone: orNull(f.phone),
      ...(dob ? { dateOfBirth: dob as LeasePersonInput['dateOfBirth'] } : {}),
    },
  };
}
