import { describe, expect, it } from 'vitest';
import type { BusinessProfileDto } from '@montra/api-client';
import { calendarDate as d } from '@montra/domain';
import {
  legalFormOf,
  legalPatch,
  registrationsFormOf,
  registrationsPatch,
  zipText,
} from './business-registration';

const profile = (over: Partial<BusinessProfileDto> = {}): BusinessProfileDto => ({
  entityId: '00000000-0000-4000-8000-000000000001',
  name: 'Harbor Kites',
  businessType: 'sole_prop',
  fiscalYearStartMonth: 1,
  returnForm: 'schedule_c',
  sCorpElectionDate: null,
  registrations: {
    einMasked: '••-•••6789',
    irsName: 'HARBOR KITES',
    naicsCode: '451110',
    formationState: 'CA',
    sosEntityNumber: '202612345678',
    formationDate: null,
    ftbEntityIdMasked: null,
    caEmployerAccountMasked: '••••5678',
    cdtfaPermitMasked: null,
    registeredAgentName: null,
    registeredAgentAddress: null,
    dbaName: 'Kite Shack',
    dbaCounty: 'Monterey',
    dbaExpiresOn: d('2031-01-02'),
    cityLicenseNumber: null,
    cityLicenseExpiresOn: null,
    filingAddress: { line1: '1 Harbor Rd', line2: null, city: 'Monterey', state: 'CA', zip: '93940' },
    other: [],
  },
  currency: 'USD',
  legalName: null,
  address: null,
  email: null,
  invoicePrefix: 'INV-',
  defaultTermsDays: 30,
  defaultDepositAccountId: null,
  taxRateBps: null,
  taxSavingsAccountId: null,
  receiptThreshold: '7500',
  logoFileId: null,
  domain: null,
  version: 1,
  ...over,
});

describe('the legal setup form', () => {
  it('sends nothing when nothing changed', () => {
    const p = profile();
    expect(legalPatch(p, legalFormOf(p))).toEqual({});
  });

  it('sends only the type or fiscal year that changed, so a partner can save the rest', () => {
    const p = profile();
    expect(legalPatch(p, { ...legalFormOf(p), fiscalYearStartMonth: '7' })).toEqual({
      fiscalYearStartMonth: 7,
    });
    expect(legalPatch(p, { ...legalFormOf(p), businessType: 'c_corp' })).toEqual({ businessType: 'c_corp' });
  });

  it('keeps the S-corp election date only for the S-corp types', () => {
    const p = profile();
    expect(
      legalPatch(p, { ...legalFormOf(p), businessType: 's_corp', sCorpElectionDate: '2026-01-01' }),
    ).toEqual({ businessType: 's_corp', sCorpElectionDate: '2026-01-01' });
    const s = profile({
      businessType: 's_corp',
      returnForm: 'form_1120s',
      sCorpElectionDate: d('2026-01-01'),
    });
    expect(legalPatch(s, { ...legalFormOf(s), businessType: 'partnership' })).toEqual({
      businessType: 'partnership',
      sCorpElectionDate: null,
    });
  });
});

describe('the registrations form', () => {
  it('starts masked numbers empty and sends nothing when untouched', () => {
    const p = profile();
    const f = registrationsFormOf(p);
    expect(f.ein).toBe('');
    expect(f.caEmployerAccount).toBe('');
    expect(registrationsPatch(p, f)).toEqual({});
  });

  it('replaces a masked number only when one is typed, and clears plain fields left blank', () => {
    const p = profile();
    const f = { ...registrationsFormOf(p), ein: ' 98-7654321 ', dbaName: '', naicsCode: '451120' };
    expect(registrationsPatch(p, f)).toEqual({ ein: '98-7654321', dbaName: null, naicsCode: '451120' });
  });

  it('sends the filing address whole when any part changes, or null when the street is cleared', () => {
    const p = profile();
    expect(registrationsPatch(p, { ...registrationsFormOf(p), line2: 'Suite 4' })).toEqual({
      filingAddress: { line1: '1 Harbor Rd', line2: 'Suite 4', city: 'Monterey', state: 'CA', zip: '93940' },
    });
    expect(registrationsPatch(p, { ...registrationsFormOf(p), line1: '' })).toEqual({ filingAddress: null });
  });

  it('prints a nine-digit ZIP with its dash', () => {
    expect(zipText('939401234')).toBe('93940-1234');
    expect(zipText('93940')).toBe('93940');
  });
});
