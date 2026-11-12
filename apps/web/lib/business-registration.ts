/**
 * The legal and tax setup and registrations forms (BIZ-21..24; ADR-0037): form state from the business, and the PATCH
 * that saves only what changed. The entity type and fiscal year are sent only when they change, because only an owner
 * may change them and a partner saving the rest mustn't be refused for them. A masked number is replaced only when
 * something is typed over it.
 */
import type { BusinessProfileDto, UpdateBusinessInput } from '@montra/api-client';
import { BUSINESS_TYPES, electsSCorp } from '@montra/domain';

export { BUSINESS_TYPES };

export interface LegalForm {
  businessType: string;
  fiscalYearStartMonth: string;
  sCorpElectionDate: string;
}

export const legalFormOf = (p: BusinessProfileDto): LegalForm => ({
  businessType: p.businessType ?? '',
  fiscalYearStartMonth: String(p.fiscalYearStartMonth),
  sCorpElectionDate: p.sCorpElectionDate ?? '',
});

/** The changes to send; an empty object when nothing changed. */
export function legalPatch(p: BusinessProfileDto, f: LegalForm): UpdateBusinessInput {
  const out: UpdateBusinessInput = {};
  if (f.businessType && f.businessType !== p.businessType) {
    out.businessType = f.businessType as NonNullable<UpdateBusinessInput['businessType']>;
  }
  if (Number(f.fiscalYearStartMonth) !== p.fiscalYearStartMonth) {
    out.fiscalYearStartMonth = Number(f.fiscalYearStartMonth);
  }
  const election = electsSCorp(f.businessType || p.businessType) ? f.sCorpElectionDate || null : null;
  if (election !== (p.sCorpElectionDate ?? null)) out.sCorpElectionDate = election;
  return out;
}

/** Fields typed as text. Masked numbers start empty: what's typed replaces the stored one. */
export interface RegistrationsForm {
  ein: string;
  irsName: string;
  naicsCode: string;
  formationState: string;
  sosEntityNumber: string;
  formationDate: string;
  ftbEntityId: string;
  caEmployerAccount: string;
  cdtfaPermit: string;
  registeredAgentName: string;
  registeredAgentAddress: string;
  dbaName: string;
  dbaCounty: string;
  dbaExpiresOn: string;
  cityLicenseNumber: string;
  cityLicenseExpiresOn: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export const MASKED_FIELDS = ['ein', 'ftbEntityId', 'caEmployerAccount', 'cdtfaPermit'] as const;
const PLAIN_FIELDS = [
  'irsName',
  'naicsCode',
  'formationState',
  'sosEntityNumber',
  'formationDate',
  'registeredAgentName',
  'registeredAgentAddress',
  'dbaName',
  'dbaCounty',
  'dbaExpiresOn',
  'cityLicenseNumber',
  'cityLicenseExpiresOn',
] as const;

export function registrationsFormOf(p: BusinessProfileDto): RegistrationsForm {
  const r = p.registrations;
  const a = r.filingAddress;
  return {
    ein: '',
    irsName: r.irsName ?? '',
    naicsCode: r.naicsCode ?? '',
    formationState: r.formationState ?? '',
    sosEntityNumber: r.sosEntityNumber ?? '',
    formationDate: r.formationDate ?? '',
    ftbEntityId: '',
    caEmployerAccount: '',
    cdtfaPermit: '',
    registeredAgentName: r.registeredAgentName ?? '',
    registeredAgentAddress: r.registeredAgentAddress ?? '',
    dbaName: r.dbaName ?? '',
    dbaCounty: r.dbaCounty ?? '',
    dbaExpiresOn: r.dbaExpiresOn ?? '',
    cityLicenseNumber: r.cityLicenseNumber ?? '',
    cityLicenseExpiresOn: r.cityLicenseExpiresOn ?? '',
    line1: a?.line1 ?? '',
    line2: a?.line2 ?? '',
    city: a?.city ?? '',
    state: a?.state ?? '',
    zip: a?.zip ?? '',
  };
}

/** The changes to send. Blank masked fields keep what's stored; blank plain fields clear it. */
export function registrationsPatch(p: BusinessProfileDto, f: RegistrationsForm): UpdateBusinessInput {
  const before = registrationsFormOf(p);
  const out: Record<string, unknown> = {};
  for (const k of MASKED_FIELDS) if (f[k].trim()) out[k] = f[k].trim();
  for (const k of PLAIN_FIELDS) {
    if (f[k].trim() !== before[k]) out[k] = f[k].trim() || null;
  }
  const address = ['line1', 'line2', 'city', 'state', 'zip'] as const;
  if (address.some((k) => f[k].trim() !== before[k])) {
    out.filingAddress = f.line1.trim()
      ? {
          line1: f.line1.trim(),
          line2: f.line2.trim() || null,
          city: f.city.trim(),
          state: f.state.trim(),
          zip: f.zip.trim(),
        }
      : null;
  }
  return out as UpdateBusinessInput;
}

/** "9-digit ZIP" as the API keeps it ("939401234") → "93940-1234". */
export const zipText = (zip: string) => (zip.length === 9 ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip);
