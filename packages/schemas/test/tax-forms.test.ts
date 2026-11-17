import { describe, expect, it } from 'vitest';
import {
  AccountantTaxFormsDto,
  CreateTaxFormRequest,
  CreateTaxFormWaiverRequest,
  ListTaxFormsQuery,
  TaxFormDto,
  UpdateTaxFormRequest,
  WorkspaceDto,
} from '../src/index.js';

const EMPLOYER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

describe('typing a tax form in (ADR-0052, TAX-01)', () => {
  it('takes a W-2 with its employer, and keeps the EIN as nine digits', () => {
    const r = CreateTaxFormRequest.parse({
      kind: 'w2',
      taxYear: 2025,
      issuerName: 'Acme Corp',
      issuerEin: '12-3456789',
      personTinLast4: '6789',
      targets: [{ employerId: EMPLOYER }],
      boxes: { box1: '8512034', box2: '1204500', box12: [{ code: 'D', amount: '500000' }] },
    });
    expect(r).toMatchObject({ kind: 'w2', issuerEin: '123456789', targets: [{ employerId: EMPLOYER }] });
  });

  it('checks the boxes against the kind', () => {
    // A 1099-DIV's box on a 1099-INT.
    expect(
      CreateTaxFormRequest.safeParse({ kind: '1099_int', taxYear: 2025, boxes: { box1a: '100' } }).success,
    ).toBe(false);
    expect(
      CreateTaxFormRequest.safeParse({ kind: '1099_div', taxYear: 2025, boxes: { box1a: '100' } }).success,
    ).toBe(true);
    // Money is whole cents as a string.
    expect(
      CreateTaxFormRequest.safeParse({ kind: '1098', taxYear: 2025, boxes: { box1: 12.5 } }).success,
    ).toBe(false);
    expect(CreateTaxFormRequest.safeParse({ kind: '1099_b', taxYear: 2025, boxes: {} }).success).toBe(false);
  });

  it('refuses a full SSN, an SSN-shaped EIN and fields it doesn’t keep', () => {
    const base = { kind: '1099_int', taxYear: 2025, boxes: {} };
    expect(CreateTaxFormRequest.safeParse({ ...base, personTinLast4: '123456789' }).success).toBe(false);
    expect(CreateTaxFormRequest.safeParse({ ...base, issuerEin: '123-45-6789' }).success).toBe(false);
    expect(CreateTaxFormRequest.safeParse({ ...base, personName: 'Sam Lee' }).success).toBe(false);
    expect(CreateTaxFormRequest.safeParse({ ...base, accountNumber: '000123456789' }).success).toBe(false);
  });

  it('takes several accounts for a bank’s 1099-INT, and nothing else as a target', () => {
    expect(
      CreateTaxFormRequest.parse({
        kind: '1099_int',
        taxYear: 2025,
        targets: [{ accountId: ACCOUNT }, { accountId: EMPLOYER }],
        boxes: { box1: '4107' },
      }).targets,
    ).toHaveLength(2);
    expect(
      CreateTaxFormRequest.safeParse({
        kind: '1099_int',
        taxYear: 2025,
        targets: [{ employerId: EMPLOYER, accountId: ACCOUNT }],
        boxes: {},
      }).success,
    ).toBe(false);
  });

  it('needs the version read to change a form', () => {
    expect(UpdateTaxFormRequest.safeParse({ issuerName: 'Acme' }).success).toBe(false);
    expect(UpdateTaxFormRequest.parse({ issuerName: 'Acme', version: 2 })).toMatchObject({ version: 2 });
  });
});

describe('waivers (§7.1)', () => {
  it('ties a W-2 to an employer and the others to an account', () => {
    const ok = CreateTaxFormWaiverRequest.safeParse({
      taxYear: 2025,
      kind: 'w2',
      employerId: EMPLOYER,
      reason: 'not_issued',
    });
    expect(ok.success).toBe(true);
    expect(
      CreateTaxFormWaiverRequest.safeParse({ taxYear: 2025, kind: 'w2', accountId: ACCOUNT, reason: 'other' })
        .success,
    ).toBe(false);
    expect(
      CreateTaxFormWaiverRequest.safeParse({
        taxYear: 2025,
        kind: '1099_int',
        employerId: EMPLOYER,
        accountId: ACCOUNT,
        reason: 'combined',
      }).success,
    ).toBe(false);
  });
});

describe('the form as sent', () => {
  const form = {
    id: EMPLOYER,
    entityId: ACCOUNT,
    taxYear: 2025,
    corrected: false,
    supersedesId: null,
    issuerName: 'First Bank',
    issuerEin: '123456789',
    issuerTinLast4: null,
    personTinLast4: '6789',
    accountLast4: '4321',
    personMemberId: null,
    targets: [{ employerId: null, accountId: ACCOUNT }],
    fileIds: [],
    pages: null,
    status: 'review',
    reason: 'no_person',
    source: 'typed',
    createdBy: null,
    confirmedBy: null,
    confirmedAt: null,
    deletedAt: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    version: 1,
  };

  it('carries the boxes of its kind', () => {
    expect(TaxFormDto.parse({ ...form, kind: '1099_int', boxes: { box1: '4107' } }).kind).toBe('1099_int');
    expect(TaxFormDto.safeParse({ ...form, kind: '1099_int', boxes: { box1a: '4107' } }).success).toBe(false);
  });
});

describe('the owner’s setting (§8.4)', () => {
  it('is a plain on or off, and part of the workspace', () => {
    expect(AccountantTaxFormsDto.parse({ accountantSeesTaxForms: true })).toEqual({
      accountantSeesTaxForms: true,
    });
    expect(AccountantTaxFormsDto.safeParse({ accountantSeesTaxForms: 'yes' }).success).toBe(false);
    expect(WorkspaceDto.shape.accountantSeesTaxForms.parse(false)).toBe(false);
  });

  it('reads the year from the query', () => {
    expect(ListTaxFormsQuery.parse({ year: '2025' })).toEqual({ year: 2025 });
    expect(ListTaxFormsQuery.safeParse({ year: '25' }).success).toBe(false);
  });
});
