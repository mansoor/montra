/**
 * Substitute renderings of the payroll forms (PRL-02..04; ADR-0034 §4). Pure: data in, bytes out. Each form keeps the
 * official form's fields, certification wording and order, laid out as labelled boxes rather than over the agency's
 * own PDF. English only, as the forms are.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/** One labelled box; `span` is its share of the row (rows add up to 1). */
export interface FormField {
  label: string;
  value: string | null;
  span?: number;
}

export type FormBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'fields'; fields: FormField[] }
  | { kind: 'checks'; label?: string; options: { label: string; checked: boolean }[] }
  | { kind: 'text'; text: string; strong?: boolean }
  | { kind: 'signature'; name: string | null; date: string | null; label: string };

export interface FormDoc {
  /** "Form W-4 (2026)" */
  form: string;
  title: string;
  /** Under the title: who the form is for and what it does. */
  subtitle?: string;
  blocks: FormBlock[];
  /** Printed small at the foot of every page. */
  footer: string;
}

const WIDTH = 612; // US Letter
const HEIGHT = 792;
const MARGIN = 40;
const INNER = WIDTH - 2 * MARGIN;
const INK = rgb(0.1, 0.12, 0.14);
const MUTED = rgb(0.42, 0.45, 0.48);
const LINE = rgb(0.7, 0.72, 0.75);
const SHADE = rgb(0.93, 0.94, 0.95);

function printable(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.replace(/[\r\t]/g, ' ')) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of printable(font, text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

export async function renderFormPdf(doc: FormDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.form.replace(/[^\x20-\x7e]/g, '?'));
  pdf.setCreator('Montra');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page!: PDFPage;
  let y = 0;
  const pages: PDFPage[] = [];
  const newPage = () => {
    page = pdf.addPage([WIDTH, HEIGHT]);
    pages.push(page);
    y = HEIGHT - MARGIN;
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 16) newPage();
  };
  const text = (s: string, x: number, size: number, font: PDFFont, color = INK) =>
    page.drawText(printable(font, s), { x, y, size, font, color });

  newPage();
  // Title band: the form's number on the left, its title beside it.
  page.drawRectangle({ x: MARGIN, y: y - 40, width: INNER, height: 44, color: SHADE });
  y -= 16;
  text(doc.form, MARGIN + 8, 13, bold);
  const titleX = MARGIN + 8 + Math.max(170, bold.widthOfTextAtSize(printable(bold, doc.form), 13) + 16);
  const titleLines = wrap(bold, doc.title, 11, WIDTH - MARGIN - 8 - titleX);
  titleLines.forEach((l, i) =>
    page.drawText(l, { x: titleX, y: y - i * 13, size: 11, font: bold, color: INK }),
  );
  y -= Math.max(28, titleLines.length * 13 + 4);
  if (doc.subtitle) {
    y -= 6;
    for (const l of wrap(regular, doc.subtitle, 8, INNER)) {
      ensure(11);
      text(l, MARGIN, 8, regular, MUTED);
      y -= 11;
    }
  }
  y -= 8;

  for (const b of doc.blocks) {
    switch (b.kind) {
      case 'heading': {
        ensure(30);
        y -= 6;
        page.drawRectangle({ x: MARGIN, y: y - 4, width: INNER, height: 16, color: INK });
        text(b.text, MARGIN + 6, 9.5, bold, rgb(1, 1, 1));
        y -= 20;
        break;
      }
      case 'fields': {
        const total = b.fields.reduce((s, f) => s + (f.span ?? 1 / b.fields.length), 0);
        const cells = b.fields.map((f) => {
          const w = (INNER * (f.span ?? 1 / b.fields.length)) / total;
          return { f, w, lines: wrap(regular, f.value ?? '', 10, w - 8) };
        });
        const height = 14 + Math.max(1, ...cells.map((c) => c.lines.length)) * 12 + 4;
        ensure(height);
        let x = MARGIN;
        for (const c of cells) {
          page.drawRectangle({
            x,
            y: y - height + 10,
            width: c.w,
            height,
            borderColor: LINE,
            borderWidth: 0.6,
          });
          page.drawText(printable(regular, c.f.label), {
            x: x + 4,
            y: y + 1,
            size: 6.5,
            font: regular,
            color: MUTED,
          });
          c.lines.forEach((l, i) =>
            page.drawText(l, { x: x + 4, y: y - 12 - i * 12, size: 10, font: regular, color: INK }),
          );
          x += c.w;
        }
        y -= height;
        break;
      }
      case 'checks': {
        if (b.label) {
          for (const l of wrap(regular, b.label, 8, INNER)) {
            ensure(11);
            text(l, MARGIN, 8, regular, MUTED);
            y -= 11;
          }
        }
        for (const o of b.options) {
          const lines = wrap(regular, o.label, 9, INNER - 22);
          ensure(lines.length * 11 + 4);
          page.drawRectangle({
            x: MARGIN + 2,
            y: y - 2,
            width: 9,
            height: 9,
            borderColor: INK,
            borderWidth: 0.8,
          });
          if (o.checked) text('X', MARGIN + 3.6, 8.5, bold);
          lines.forEach((l, i) =>
            page.drawText(l, {
              x: MARGIN + 18,
              y: y - i * 11,
              size: 9,
              font: o.checked ? bold : regular,
              color: INK,
            }),
          );
          y -= lines.length * 11 + 4;
        }
        y -= 4;
        break;
      }
      case 'text': {
        const font = b.strong ? bold : regular;
        for (const l of wrap(font, b.text, 8.5, INNER)) {
          ensure(11);
          text(l, MARGIN, 8.5, font);
          y -= 11;
        }
        y -= 6;
        break;
      }
      case 'signature': {
        ensure(34);
        y -= 4;
        const nameW = INNER * 0.68;
        page.drawRectangle({
          x: MARGIN,
          y: y - 24,
          width: nameW,
          height: 30,
          borderColor: LINE,
          borderWidth: 0.6,
        });
        page.drawRectangle({
          x: MARGIN + nameW,
          y: y - 24,
          width: INNER - nameW,
          height: 30,
          borderColor: LINE,
          borderWidth: 0.6,
        });
        text(b.label, MARGIN + 4, 6.5, regular, MUTED);
        page.drawText('Date', { x: MARGIN + nameW + 4, y, size: 6.5, font: regular, color: MUTED });
        if (b.name) {
          page.drawText(printable(bold, `/s/ ${b.name}`), {
            x: MARGIN + 4,
            y: y - 16,
            size: 11,
            font: bold,
            color: INK,
          });
        }
        if (b.date)
          page.drawText(b.date, { x: MARGIN + nameW + 4, y: y - 16, size: 11, font: regular, color: INK });
        y -= 34;
        break;
      }
    }
  }

  pages.forEach((p, i) => {
    const lines = [...wrap(regular, doc.footer, 6.5, INNER), `Page ${i + 1} of ${pages.length}`];
    lines.forEach((l, n) =>
      p.drawText(l, { x: MARGIN, y: MARGIN - 10 - n * 8, size: 6.5, font: regular, color: MUTED }),
    );
  });
  return pdf.save();
}

// ----- The forms ---------------------------------------------------------------------------------------------------

const FOOTER =
  'Substitute form prepared by Montra from the information recorded. It keeps the official form’s content and order. ' +
  'Montra does not file this form; keep it with your payroll records.';

/** "$1,234.56" from minor units, for US forms. */
export function usd(minor: bigint | string): string {
  const n = BigInt(minor);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}$${whole}.${cents}`;
}

/** "123-45-6789" or "12-3456789". */
export function formatTin(type: 'ssn' | 'itin' | 'ein' | null, digits: string | null): string | null {
  if (!digits) return null;
  return type === 'ein'
    ? `${digits.slice(0, 2)}-${digits.slice(2)}`
    : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/** "11/10/2026" from a calendar date, as the forms write dates. */
export const usDate = (d: string | null): string | null =>
  d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : null;

export interface W4PdfData {
  year: number;
  firstName: string;
  lastName: string;
  address: string | null;
  ssn: string | null;
  filingStatus: 'single' | 'married_jointly' | 'head_of_household';
  multipleJobs: boolean;
  dependents: bigint;
  otherIncome: bigint;
  deductions: bigint;
  extraWithholding: bigint;
  exempt: boolean;
  signedName: string;
  signedOn: string;
  employer: { name: string; address: string | null; ein: string | null };
  firstDay: string | null;
}

export function w4Doc(d: W4PdfData): FormDoc {
  return {
    form: `Form W-4 (${d.year})`,
    title: 'Employee’s Withholding Certificate',
    subtitle:
      'Complete Form W-4 so that your employer can withhold the correct federal income tax from your pay. Give Form W-4 to your employer. Your withholding is subject to review by the IRS.',
    footer: FOOTER,
    blocks: [
      { kind: 'heading', text: 'Step 1: Enter Personal Information' },
      {
        kind: 'fields',
        fields: [
          { label: '(a) First name and middle initial', value: d.firstName, span: 0.35 },
          { label: 'Last name', value: d.lastName, span: 0.35 },
          { label: '(b) Social security number', value: d.ssn, span: 0.3 },
        ],
      },
      { kind: 'fields', fields: [{ label: 'Address; City or town, state, and ZIP code', value: d.address }] },
      {
        kind: 'checks',
        label: '(c) Filing status',
        options: [
          { label: 'Single or Married filing separately', checked: d.filingStatus === 'single' },
          {
            label: 'Married filing jointly or Qualifying surviving spouse',
            checked: d.filingStatus === 'married_jointly',
          },
          {
            label:
              'Head of household (Check only if you’re unmarried and pay more than half the costs of keeping up a home for yourself and a qualifying individual.)',
            checked: d.filingStatus === 'head_of_household',
          },
        ],
      },
      { kind: 'heading', text: 'Step 2: Multiple Jobs or Spouse Works' },
      {
        kind: 'checks',
        options: [
          {
            label:
              '(c) If there are only two jobs total, you may check this box. Do the same on Form W-4 for the other job.',
            checked: d.multipleJobs,
          },
        ],
      },
      { kind: 'heading', text: 'Step 3: Claim Dependent and Other Credits' },
      {
        kind: 'fields',
        fields: [
          { label: '3  Total of qualifying children and other dependents credits', value: usd(d.dependents) },
        ],
      },
      { kind: 'heading', text: 'Step 4 (optional): Other Adjustments' },
      {
        kind: 'fields',
        fields: [
          { label: '4(a) Other income (not from jobs)', value: usd(d.otherIncome) },
          { label: '4(b) Deductions', value: usd(d.deductions) },
          { label: '4(c) Extra withholding (each pay period)', value: usd(d.extraWithholding) },
        ],
      },
      {
        kind: 'checks',
        options: [
          {
            label:
              'Exempt from withholding: I claim exemption from withholding for this year, and I meet both conditions in the instructions.',
            checked: d.exempt,
          },
        ],
      },
      { kind: 'heading', text: 'Step 5: Sign Here' },
      {
        kind: 'text',
        text: 'Under penalties of perjury, I declare that this certificate, to the best of my knowledge and belief, is true, correct, and complete.',
      },
      {
        kind: 'signature',
        label: 'Employee’s signature (This form is not valid unless you sign it.)',
        name: d.signedName,
        date: usDate(d.signedOn),
      },
      { kind: 'heading', text: 'Employers Only' },
      {
        kind: 'fields',
        fields: [
          {
            label: 'Employer’s name and address',
            value: [d.employer.name, d.employer.address].filter(Boolean).join('\n'),
            span: 0.55,
          },
          { label: 'First date of employment', value: usDate(d.firstDay), span: 0.2 },
          { label: 'Employer identification number (EIN)', value: d.employer.ein, span: 0.25 },
        ],
      },
    ],
  };
}

export const W9_CLASSIFICATIONS: Record<string, string> = {
  individual: 'Individual/sole proprietor',
  c_corporation: 'C corporation',
  s_corporation: 'S corporation',
  partnership: 'Partnership',
  trust_estate: 'Trust/estate',
  llc_c: 'LLC (C corporation)',
  llc_s: 'LLC (S corporation)',
  llc_p: 'LLC (Partnership)',
  other: 'Other',
};

export interface W9PdfData {
  legalName: string;
  businessName: string | null;
  taxClassification: string;
  otherClassification: string | null;
  foreignPartners: boolean;
  exemptPayeeCode: string | null;
  fatcaCode: string | null;
  address: string;
  accountNumbers: string | null;
  tinType: 'ssn' | 'itin' | 'ein';
  tin: string;
  backupWithholding: boolean;
  signedName: string;
  signedOn: string;
  requester: { name: string; address: string | null };
}

export function w9Doc(d: W9PdfData): FormDoc {
  const lines = d.address.split('\n');
  return {
    form: 'Form W-9 (Rev. March 2024)',
    title: 'Request for Taxpayer Identification Number and Certification',
    subtitle: 'Give form to the requester. Do not send to the IRS.',
    footer: FOOTER,
    blocks: [
      { kind: 'fields', fields: [{ label: '1  Name of entity/individual', value: d.legalName }] },
      {
        kind: 'fields',
        fields: [
          {
            label: '2  Business name/disregarded entity name, if different from above',
            value: d.businessName,
          },
        ],
      },
      {
        kind: 'checks',
        label: '3a  Federal tax classification (check only one)',
        options: Object.entries(W9_CLASSIFICATIONS).map(([k, label]) => ({
          label: k === 'other' && d.otherClassification ? `${label}: ${d.otherClassification}` : label,
          checked: d.taxClassification === k,
        })),
      },
      {
        kind: 'checks',
        options: [
          {
            label:
              '3b  If on line 3a you checked “Partnership” or “Trust/estate,” or checked “LLC” and entered “P” as its tax classification, and you are providing this form to a partnership, trust, or estate in which you have an ownership interest, check this box if you have any foreign partners, owners, or beneficiaries.',
            checked: d.foreignPartners,
          },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '4  Exempt payee code (if any)', value: d.exemptPayeeCode },
          { label: 'Exemption from FATCA reporting code (if any)', value: d.fatcaCode },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '5  Address (number, street, and apt. or suite no.)', value: lines[0] ?? null, span: 0.6 },
          {
            label: 'Requester’s name and address (optional)',
            value: [d.requester.name, d.requester.address].filter(Boolean).join('\n'),
            span: 0.4,
          },
        ],
      },
      {
        kind: 'fields',
        fields: [{ label: '6  City, state, and ZIP code', value: lines.slice(1).join(', ') || null }],
      },
      {
        kind: 'fields',
        fields: [{ label: '7  List account number(s) here (optional)', value: d.accountNumbers }],
      },
      { kind: 'heading', text: 'Part I  Taxpayer Identification Number (TIN)' },
      {
        kind: 'fields',
        fields: [
          {
            label: 'Social security number',
            value: d.tinType === 'ein' ? null : formatTin(d.tinType, d.tin),
          },
          {
            label: 'Employer identification number',
            value: d.tinType === 'ein' ? formatTin('ein', d.tin) : null,
          },
        ],
      },
      { kind: 'heading', text: 'Part II  Certification' },
      { kind: 'text', text: 'Under penalties of perjury, I certify that:' },
      {
        kind: 'text',
        text: '1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and',
      },
      {
        kind: 'text',
        text: d.backupWithholding
          ? '2. [Crossed out: the payee has been notified by the IRS that they are currently subject to backup withholding.]'
          : '2. I am not subject to backup withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and',
      },
      {
        kind: 'text',
        text: '3. I am a U.S. citizen or other U.S. person (defined in the instructions); and',
      },
      {
        kind: 'text',
        text: '4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.',
      },
      { kind: 'signature', label: 'Signature of U.S. person', name: d.signedName, date: usDate(d.signedOn) },
    ],
  };
}

export const I9_CITIZENSHIP: Record<string, string> = {
  citizen: '1. A citizen of the United States',
  noncitizen_national: '2. A noncitizen national of the United States',
  permanent_resident: '3. A lawful permanent resident (Enter USCIS or A-Number.)',
  authorized_alien:
    '4. A noncitizen (other than Item Numbers 2. and 3. above) authorized to work until (exp. date, if any)',
};

export interface I9PdfData {
  lastName: string;
  firstName: string;
  middleInitial: string | null;
  otherLastNames: string | null;
  address: string | null;
  apartment: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  birthDate: string | null;
  ssn: string | null;
  email: string | null;
  phone: string | null;
  citizenship: string | null;
  aNumber: string | null;
  workUntil: string | null;
  i94Number: string | null;
  passportNumber: string | null;
  passportCountry: string | null;
  employeeSignedName: string | null;
  employeeSignedOn: string | null;
  preparer: { name: string; address: string | null; signedOn: string | null } | null;
  documents: {
    list: 'A' | 'B' | 'C';
    title: string;
    issuingAuthority: string | null;
    number: string | null;
    expiresOn: string | null;
  }[];
  firstDay: string | null;
  additionalInfo: string | null;
  employerSignedName: string | null;
  employerTitle: string | null;
  employerSignedOn: string | null;
  businessName: string | null;
  businessAddress: string | null;
}

export function i9Doc(d: I9PdfData): FormDoc {
  const docs = (list: 'A' | 'B' | 'C') => d.documents.filter((x) => x.list === list);
  const docBlocks = (list: 'A' | 'B' | 'C', heading: string): FormBlock[] =>
    docs(list).length
      ? [
          { kind: 'text', text: heading, strong: true },
          ...docs(list).flatMap((x): FormBlock[] => [
            {
              kind: 'fields',
              fields: [
                { label: 'Document title', value: x.title, span: 0.3 },
                { label: 'Issuing authority', value: x.issuingAuthority, span: 0.25 },
                { label: 'Document number (if any)', value: x.number, span: 0.25 },
                { label: 'Expiration date (if any)', value: usDate(x.expiresOn), span: 0.2 },
              ],
            },
          ]),
        ]
      : [];
  return {
    form: 'Form I-9 (Edition 01/20/25)',
    title: 'Employment Eligibility Verification',
    subtitle:
      'Department of Homeland Security, U.S. Citizenship and Immigration Services. All employees must complete and sign Section 1 no later than the first day of employment. Employers must complete Section 2 within 3 business days of the employee’s first day of employment, and must physically examine, or examine consistent with an alternative procedure authorized by DHS, documentation from List A OR a combination of documentation from List B and List C.',
    footer: `${FOOTER} Montra does not use E-Verify.`,
    blocks: [
      { kind: 'heading', text: 'Section 1. Employee Information and Attestation' },
      {
        kind: 'fields',
        fields: [
          { label: 'Last Name (Family Name)', value: d.lastName, span: 0.3 },
          { label: 'First Name (Given Name)', value: d.firstName, span: 0.3 },
          { label: 'Middle Initial (if any)', value: d.middleInitial, span: 0.12 },
          { label: 'Other Last Names Used (if any)', value: d.otherLastNames, span: 0.28 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: 'Address (Street Number and Name)', value: d.address, span: 0.36 },
          { label: 'Apt. Number (if any)', value: d.apartment, span: 0.12 },
          { label: 'City or Town', value: d.city, span: 0.26 },
          { label: 'State', value: d.state, span: 0.1 },
          { label: 'ZIP Code', value: d.zip, span: 0.16 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: 'Date of Birth (mm/dd/yyyy)', value: usDate(d.birthDate), span: 0.2 },
          { label: 'U.S. Social Security Number', value: d.ssn, span: 0.2 },
          { label: 'Employee’s Email Address', value: d.email, span: 0.35 },
          { label: 'Employee’s Telephone Number', value: d.phone, span: 0.25 },
        ],
      },
      {
        kind: 'text',
        text: 'I am aware that federal law provides for imprisonment and/or fines for false statements, or the use of false documents, in connection with the completion of this form. I attest, under penalty of perjury, that this information, including my selection of the box attesting to my citizenship or immigration status, is true and correct.',
      },
      {
        kind: 'checks',
        label: 'Check one of the following boxes to attest to your citizenship or immigration status:',
        options: Object.entries(I9_CITIZENSHIP).map(([k, label]) => ({
          label: k === 'authorized_alien' && d.workUntil ? `${label}: ${usDate(d.workUntil)}` : label,
          checked: d.citizenship === k,
        })),
      },
      {
        kind: 'text',
        text: 'If you check Item Number 4., enter one of these: USCIS A-Number OR Form I-94 Admission Number OR Foreign Passport Number and Country of Issuance.',
      },
      {
        kind: 'fields',
        fields: [
          { label: 'USCIS A-Number', value: d.aNumber },
          { label: 'Form I-94 Admission Number', value: d.i94Number },
          {
            label: 'Foreign Passport Number and Country of Issuance',
            value: [d.passportNumber, d.passportCountry].filter(Boolean).join(', ') || null,
          },
        ],
      },
      {
        kind: 'signature',
        label: 'Signature of Employee',
        name: d.employeeSignedName,
        date: usDate(d.employeeSignedOn),
      },
      ...(d.preparer
        ? ([
            { kind: 'heading', text: 'Supplement A. Preparer and/or Translator Certification' },
            {
              kind: 'text',
              text: 'I attest, under penalty of perjury, that I have assisted in the completion of Section 1 of this form and that to the best of my knowledge the information is true and correct.',
            },
            {
              kind: 'fields',
              fields: [
                {
                  label: 'Preparer’s or translator’s name and address',
                  value: [d.preparer.name, d.preparer.address].filter(Boolean).join('\n'),
                },
              ],
            },
            {
              kind: 'signature',
              label: 'Signature of Preparer or Translator',
              name: d.preparer.name,
              date: usDate(d.preparer.signedOn),
            },
          ] as FormBlock[])
        : []),
      { kind: 'heading', text: 'Section 2. Employer Review and Verification' },
      ...docBlocks('A', 'List A'),
      ...docBlocks('B', 'List B'),
      ...docBlocks('C', 'List C'),
      { kind: 'fields', fields: [{ label: 'Additional Information', value: d.additionalInfo }] },
      {
        kind: 'text',
        text: 'Certification: I attest, under penalty of perjury, that (1) I have examined the documentation presented by the above-named employee, (2) the above-listed documentation appears to be genuine and to relate to the employee named, and (3) to the best of my knowledge, the employee is authorized to work in the United States.',
      },
      {
        kind: 'fields',
        fields: [
          { label: 'First Day of Employment (mm/dd/yyyy)', value: usDate(d.firstDay), span: 0.3 },
          {
            label: 'Last Name, First Name and Title of Employer or Authorized Representative',
            value: [d.employerSignedName, d.employerTitle].filter(Boolean).join(', ') || null,
            span: 0.7,
          },
        ],
      },
      {
        kind: 'signature',
        label: 'Signature of Employer or Authorized Representative',
        name: d.employerSignedName,
        date: usDate(d.employerSignedOn),
      },
      {
        kind: 'fields',
        fields: [
          { label: 'Employer’s Business or Organization Name', value: d.businessName, span: 0.4 },
          {
            label: 'Employer’s Business or Organization Address, City or Town, State, ZIP Code',
            value: d.businessAddress,
            span: 0.6,
          },
        ],
      },
    ],
  };
}
