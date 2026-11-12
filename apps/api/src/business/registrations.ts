/**
 * A business's registrations (BIZ-22..24; ADR-0037): the EIN, state and local numbers on `business_profile`, and other
 * registrations in their own table. Payroll, the year-end forms and the EFW2 file read the employer's numbers from here.
 */
import type { BusinessProfileRow, BusinessRegistrationRow, Trx } from '@montra/db';
import { maskId, type CalendarDate } from '@montra/domain';
import type { BusinessRegistrationsDto, FilingAddressDto, OtherRegistrationDto } from '@montra/schemas';
import type { Ctx } from './shared.js';

/** What payroll needs from the business's registrations, in full. Only server code sees it. */
export interface EmployerIdentity {
  legalName: string | null;
  /** Nine digits. */
  ein: string | null;
  /** The EDD employer payroll tax account, eight digits. */
  caEmployerAccount: string | null;
  filingAddress: FilingAddressDto | null;
}

export async function employerIdentity(trx: Trx, ctx: Ctx, entityId: string): Promise<EmployerIdentity> {
  const r = await trx
    .selectFrom('app.business_profile')
    .select([
      'legal_name',
      'ein',
      'ca_employer_account',
      'filing_line1',
      'filing_line2',
      'filing_city',
      'filing_state',
      'filing_zip',
    ])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('entity_id', '=', entityId)
    .executeTakeFirst();
  return {
    legalName: r?.legal_name ?? null,
    ein: r?.ein ?? null,
    caEmployerAccount: r?.ca_employer_account ?? null,
    filingAddress: r ? filingAddressOf(r) : null,
  };
}

type FilingColumns = Pick<
  BusinessProfileRow,
  'filing_line1' | 'filing_line2' | 'filing_city' | 'filing_state' | 'filing_zip'
>;

export function filingAddressOf(r: FilingColumns): FilingAddressDto | null {
  return r.filing_line1 && r.filing_city && r.filing_state && r.filing_zip
    ? {
        line1: r.filing_line1,
        line2: r.filing_line2,
        city: r.filing_city,
        state: r.filing_state,
        zip: r.filing_zip,
      }
    : null;
}

/** "12-3456789". */
export const formatEin = (ein: string | null): string | null =>
  ein ? `${ein.slice(0, 2)}-${ein.slice(2)}` : null;

/** "123-4567-8", as the EDD prints it. */
export const formatEddAccount = (a: string | null): string | null =>
  a ? `${a.slice(0, 3)}-${a.slice(3, 7)}-${a.slice(7)}` : null;

export async function otherRegistrations(
  trx: Trx,
  ctx: Ctx,
  entityId: string,
): Promise<BusinessRegistrationRow[]> {
  return trx
    .selectFrom('app.business_registration')
    .selectAll()
    .where('workspace_id', '=', ctx.workspaceId)
    .where('entity_id', '=', entityId)
    .orderBy('label')
    .orderBy('id')
    .execute();
}

const dateOrNull = (v: unknown): CalendarDate | null => (v ? (String(v).slice(0, 10) as CalendarDate) : null);

export function otherRegistrationDto(r: BusinessRegistrationRow): OtherRegistrationDto {
  return {
    id: r.id,
    label: r.label,
    number: r.number,
    issuer: r.issuer,
    expiresOn: dateOrNull(r.expires_on),
    version: Number(r.version),
  };
}

export function registrationsDto(
  r: BusinessProfileRow,
  other: BusinessRegistrationRow[],
): BusinessRegistrationsDto {
  return {
    einMasked: maskId(r.ein, 'ein'),
    irsName: r.irs_name,
    naicsCode: r.naics_code,
    formationState: r.formation_state,
    sosEntityNumber: r.sos_entity_number,
    formationDate: dateOrNull(r.formation_date),
    ftbEntityIdMasked: maskId(r.ftb_entity_id),
    caEmployerAccountMasked: maskId(r.ca_employer_account),
    cdtfaPermitMasked: maskId(r.cdtfa_permit),
    registeredAgentName: r.registered_agent_name,
    registeredAgentAddress: r.registered_agent_address,
    dbaName: r.dba_name,
    dbaCounty: r.dba_county,
    dbaExpiresOn: dateOrNull(r.dba_expires_on),
    cityLicenseNumber: r.city_license_number,
    cityLicenseExpiresOn: dateOrNull(r.city_license_expires_on),
    filingAddress: filingAddressOf(r),
    other: other.map(otherRegistrationDto),
  };
}

/** A registration that expires, for the "renew by" reminders (BIZ-24). */
export interface Expiring {
  /** Stable for the reminder's dedupe key: `dba`, `city_license` or the other registration's id. */
  key: string;
  label: string;
  expiresOn: CalendarDate;
}

export function expiringRegistrations(r: BusinessProfileRow, other: BusinessRegistrationRow[]): Expiring[] {
  const out: Expiring[] = [];
  const dba = dateOrNull(r.dba_expires_on);
  if (dba) {
    out.push({
      key: 'dba',
      label: r.dba_name ? `Fictitious business name “${r.dba_name}”` : 'Fictitious business name',
      expiresOn: dba,
    });
  }
  const city = dateOrNull(r.city_license_expires_on);
  if (city) out.push({ key: 'city_license', label: 'City business licence', expiresOn: city });
  for (const o of other) {
    const d = dateOrNull(o.expires_on);
    if (d) out.push({ key: o.id, label: o.label, expiresOn: d });
  }
  return out;
}
