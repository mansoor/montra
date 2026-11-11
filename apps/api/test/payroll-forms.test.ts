import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { formatTin, i9Doc, renderFormPdf, usd, usDate, w4Doc, w9Doc } from '../src/payroll/form-pdf.js';

// The substitute form renderings (PRL-02..04, ADR-0032 §4). Pure: no database.
const pages = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

describe('form helpers', () => {
  it('writes money, dates and tax IDs the way the forms do', () => {
    expect(usd(400000n)).toBe('$4,000.00');
    expect(usd('-2550')).toBe('-$25.50');
    expect(usDate('2026-11-02')).toBe('11/02/2026');
    expect(formatTin('ssn', '900123456')).toBe('900-12-3456');
    expect(formatTin('ein', '987654321')).toBe('98-7654321');
  });
});

describe('renderFormPdf', () => {
  it('renders a W-4 on one page, ticking the filing status chosen', async () => {
    const doc = w4Doc({
      year: 2026,
      firstName: 'Avery Q',
      lastName: 'Testperson',
      address: '12 Fern St\nPortland, ME 04102',
      ssn: '900-12-3456',
      filingStatus: 'head_of_household',
      multipleJobs: false,
      dependents: 0n,
      otherIncome: 0n,
      deductions: 0n,
      extraWithholding: 0n,
      exempt: false,
      signedName: 'Avery Q Testperson',
      signedOn: '2026-11-02',
      employer: { name: 'Harbor Bakery LLC', address: null, ein: null },
      firstDay: null,
    });
    const status = doc.blocks.find((b) => b.kind === 'checks' && b.label === '(c) Filing status');
    expect(status && status.kind === 'checks' && status.options.filter((o) => o.checked).length).toBe(1);
    expect(await pages(await renderFormPdf(doc))).toBe(1);
  });

  it('renders a W-9 with only one classification ticked, and crosses out item 2 when told', async () => {
    const doc = w9Doc({
      legalName: 'Rowan Sampleton',
      businessName: null,
      taxClassification: 'llc_s',
      otherClassification: null,
      foreignPartners: false,
      exemptPayeeCode: null,
      fatcaCode: null,
      address: '9 Pine Ave\nBangor, ME 04401',
      accountNumbers: null,
      tinType: 'ein',
      tin: '987654321',
      backupWithholding: true,
      signedName: 'Rowan Sampleton',
      signedOn: '2026-11-10',
      requester: { name: 'Harbor Bakery LLC', address: null },
    });
    const classes = doc.blocks.find((b) => b.kind === 'checks' && b.label?.startsWith('3a'));
    expect(
      classes && classes.kind === 'checks' && classes.options.filter((o) => o.checked).map((o) => o.label),
    ).toEqual(['LLC (S corporation)']);
    expect(doc.blocks.some((b) => b.kind === 'text' && b.text.startsWith('2. [Crossed out'))).toBe(true);
    expect(await pages(await renderFormPdf(doc))).toBe(1);
  });

  it('renders an I-9 with B and C documents, and does not fail on text the fonts cannot print', async () => {
    const bytes = await renderFormPdf(
      i9Doc({
        lastName: 'Tëstpërson 株式',
        firstName: 'Ávery',
        middleInitial: null,
        otherLastNames: null,
        address: null,
        apartment: null,
        city: null,
        state: null,
        zip: null,
        birthDate: null,
        ssn: null,
        email: null,
        phone: null,
        citizenship: 'authorized_alien',
        aNumber: null,
        workUntil: '2028-06-30',
        i94Number: null,
        passportNumber: 'P1234567',
        passportCountry: 'Testland',
        employeeSignedName: 'Ávery Tëstpërson',
        employeeSignedOn: '2026-11-02',
        preparer: { name: 'Pat Helper', address: '1 Main St', signedOn: '2026-11-02' },
        documents: [
          {
            list: 'B',
            title: 'Driver’s license',
            issuingAuthority: 'Maine',
            number: 'D123',
            expiresOn: null,
          },
          { list: 'C', title: 'Birth certificate', issuingAuthority: null, number: null, expiresOn: null },
        ],
        firstDay: null,
        additionalInfo: null,
        employerSignedName: null,
        employerTitle: null,
        employerSignedOn: null,
        businessName: null,
        businessAddress: null,
      }),
    );
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pages(bytes)).toBeGreaterThanOrEqual(1);
  });
});
