/**
 * Year-end forms as substitute PDFs (PRL-17..19; ADR-0034 §7b): Form W-2 copies B, C, 2 and D, Form W-3, Form 1099-NEC
 * copies B, 2 and C, and a Form 1096 worksheet. Copy A of each is the agencies' own scannable form or an electronic
 * filing, so it's never rendered here.
 */
import { PDFDocument } from 'pdf-lib';
import type { W2Boxes } from '@montra/domain';
import { renderFormPdf, usd, type FormDoc } from './form-pdf.js';

const FOOTER =
  'Substitute statement prepared by Montra from the year’s approved pay runs and paid bills. It isn’t Copy A, which is ' +
  'filed on the official form or electronically. Montra doesn’t file it.';

export interface Party {
  name: string;
  address: string | null;
  /** Formatted, and truncated to the last four digits where the copy allows it. */
  tin: string | null;
}

export interface W2Copy {
  year: number;
  copy: 'B' | 'C' | '2' | 'D';
  employer: Party & { caAccount: string | null };
  employee: Party;
  boxes: W2Boxes;
  /** The state in boxes 15–17, when California. */
  state: 'CA' | null;
}

const COPY_TEXT: Record<W2Copy['copy'], string> = {
  B: 'Copy B—To Be Filed With Employee’s FEDERAL Tax Return.',
  C: 'Copy C—For EMPLOYEE’S RECORDS.',
  '2': 'Copy 2—To Be Filed With Employee’s State, City, or Local Income Tax Return.',
  D: 'Copy D—For Employer.',
};

export function w2Doc(d: W2Copy): FormDoc {
  const b = d.boxes;
  return {
    form: `Form W-2 (${d.year})`,
    title: 'Wage and Tax Statement',
    subtitle: COPY_TEXT[d.copy],
    footer: FOOTER,
    blocks: [
      {
        kind: 'fields',
        fields: [
          { label: 'a  Employee’s social security number', value: d.employee.tin, span: 0.4 },
          { label: 'b  Employer identification number (EIN)', value: d.employer.tin, span: 0.6 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          {
            label: 'c  Employer’s name, address, and ZIP code',
            value: [d.employer.name, d.employer.address].filter(Boolean).join('\n'),
          },
        ],
      },
      {
        kind: 'fields',
        fields: [
          {
            label: 'e  Employee’s name    f  Employee’s address and ZIP code',
            value: [d.employee.name, d.employee.address].filter(Boolean).join('\n'),
          },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '1  Wages, tips, other compensation', value: usd(b.box1), span: 0.5 },
          { label: '2  Federal income tax withheld', value: usd(b.box2), span: 0.5 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '3  Social security wages', value: usd(b.box3), span: 0.5 },
          { label: '4  Social security tax withheld', value: usd(b.box4), span: 0.5 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '5  Medicare wages and tips', value: usd(b.box5), span: 0.5 },
          { label: '6  Medicare tax withheld', value: usd(b.box6), span: 0.5 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          {
            label: '12a  Code D (401(k) elective deferrals)',
            value: b.box12D > 0n ? usd(b.box12D) : '',
            span: 0.5,
          },
          { label: '14  Other', value: b.caSdi > 0n ? `CASDI ${usd(b.caSdi)}` : '', span: 0.5 },
        ],
      },
      {
        kind: 'checks',
        label: '13',
        options: [
          { label: 'Statutory employee', checked: false },
          { label: 'Retirement plan', checked: b.retirementPlan },
          { label: 'Third-party sick pay', checked: false },
        ],
      },
      {
        kind: 'fields',
        fields: [
          {
            label: '15  State   Employer’s state ID number',
            value: d.state ? `CA   ${d.employer.caAccount ?? ''}` : '',
            span: 0.4,
          },
          { label: '16  State wages, tips, etc.', value: d.state ? usd(b.caWages) : '', span: 0.3 },
          { label: '17  State income tax', value: d.state ? usd(b.caTax) : '', span: 0.3 },
        ],
      },
      { kind: 'text', text: COPY_TEXT[d.copy], strong: true },
    ],
  };
}

export interface W3Data {
  year: number;
  employer: Party & { caAccount: string | null };
  forms: number;
  boxes: W2Boxes;
}

/** Form W-3, the transmittal: the W-2s added up. Kind of payer 941, kind of employer none apply. */
export function w3Doc(d: W3Data): FormDoc {
  const b = d.boxes;
  return {
    form: `Form W-3 (${d.year})`,
    title: 'Transmittal of Wage and Tax Statements',
    subtitle:
      'Filed with Copy A of the W-2s on paper. When the W-2s are filed electronically (EFW2), keep this for your records.',
    footer: FOOTER,
    blocks: [
      {
        kind: 'checks',
        label: 'b  Kind of Payer',
        options: [
          { label: '941', checked: true },
          { label: 'Military', checked: false },
          { label: '943', checked: false },
          { label: '944', checked: false },
          { label: 'CT-1', checked: false },
          { label: 'Hshld. emp.', checked: false },
          { label: 'Medicare govt. emp.', checked: false },
        ],
      },
      {
        kind: 'checks',
        label: 'Kind of Employer',
        options: [{ label: 'None apply', checked: true }],
      },
      {
        kind: 'fields',
        fields: [
          { label: 'c  Total number of Forms W-2', value: String(d.forms), span: 0.3 },
          { label: 'e  Employer identification number (EIN)', value: d.employer.tin, span: 0.7 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          {
            label: 'f  Employer’s name    g  Employer’s address and ZIP code',
            value: [d.employer.name, d.employer.address].filter(Boolean).join('\n'),
          },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '1  Wages, tips, other compensation', value: usd(b.box1), span: 0.5 },
          { label: '2  Federal income tax withheld', value: usd(b.box2), span: 0.5 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '3  Social security wages', value: usd(b.box3), span: 0.5 },
          { label: '4  Social security tax withheld', value: usd(b.box4), span: 0.5 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '5  Medicare wages and tips', value: usd(b.box5), span: 0.5 },
          { label: '6  Medicare tax withheld', value: usd(b.box6), span: 0.5 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '12a  Deferred compensation', value: usd(b.box12D), span: 0.5 },
          {
            label: '15  State   Employer’s state ID number',
            value: `CA   ${d.employer.caAccount ?? ''}`,
            span: 0.5,
          },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '16  State wages, tips, etc.', value: usd(b.caWages), span: 0.5 },
          { label: '17  State income tax', value: usd(b.caTax), span: 0.5 },
        ],
      },
      {
        kind: 'text',
        text: 'Under penalties of perjury, I declare that I have examined this return and accompanying documents and, to the best of my knowledge and belief, they are true, correct, and complete.',
      },
      { kind: 'signature', label: 'Signature', name: null, date: null },
    ],
  };
}

export interface NecCopy {
  year: number;
  copy: 'B' | '2' | 'C';
  payer: Party & { phone: string | null };
  recipient: Party;
  amount: bigint;
  state: 'CA' | null;
  stateAccount: string | null;
}

const NEC_COPY: Record<NecCopy['copy'], string> = {
  B: 'Copy B—For Recipient. This is important tax information and is being furnished to the IRS.',
  '2': 'Copy 2—To be filed with recipient’s state income tax return, when required.',
  C: 'Copy C—For Payer.',
};

export function necDoc(d: NecCopy): FormDoc {
  return {
    form: `Form 1099-NEC (${d.year})`,
    title: 'Nonemployee Compensation',
    subtitle: NEC_COPY[d.copy],
    footer: FOOTER,
    blocks: [
      {
        kind: 'fields',
        fields: [
          {
            label:
              'PAYER’S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.',
            value: [d.payer.name, d.payer.address, d.payer.phone].filter(Boolean).join('\n'),
          },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: 'PAYER’S TIN', value: d.payer.tin, span: 0.5 },
          { label: 'RECIPIENT’S TIN', value: d.recipient.tin, span: 0.5 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          {
            label: 'RECIPIENT’S name, street address (including apt. no.), city or town, state, and ZIP',
            value: [d.recipient.name, d.recipient.address].filter(Boolean).join('\n'),
          },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '1  Nonemployee compensation', value: usd(d.amount), span: 0.5 },
          { label: '4  Federal income tax withheld', value: usd(0n), span: 0.5 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '5  State tax withheld', value: d.state ? usd(0n) : '', span: 0.3 },
          {
            label: '6  State/Payer’s state no.',
            value: d.state ? `CA   ${d.stateAccount ?? ''}` : '',
            span: 0.4,
          },
          { label: '7  State income', value: d.state ? usd(d.amount) : '', span: 0.3 },
        ],
      },
      { kind: 'text', text: NEC_COPY[d.copy], strong: true },
    ],
  };
}

export interface Form1096Data {
  year: number;
  payer: Party & { phone: string | null; contact: string | null; email: string | null };
  forms: number;
  total: bigint;
}

/** Form 1096 as a worksheet: the totals to copy onto the red form, or to check against an IRIS filing. */
export function form1096Doc(d: Form1096Data): FormDoc {
  return {
    form: `Form 1096 (${d.year})`,
    title: 'Annual Summary and Transmittal of U.S. Information Returns',
    subtitle:
      'A worksheet for the official form, which is filed on paper with Copy A of the 1099-NECs. Filing electronically through IRIS needs no 1096.',
    footer: FOOTER,
    blocks: [
      {
        kind: 'fields',
        fields: [
          {
            label: 'FILER’S name, street address, city or town, state, and ZIP code',
            value: [d.payer.name, d.payer.address].filter(Boolean).join('\n'),
          },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: 'Name of person to contact', value: d.payer.contact, span: 0.4 },
          { label: 'Telephone number', value: d.payer.phone, span: 0.3 },
          { label: 'Email address', value: d.payer.email, span: 0.3 },
        ],
      },
      {
        kind: 'fields',
        fields: [
          { label: '1  Employer identification number', value: d.payer.tin, span: 0.4 },
          { label: '3  Total number of forms', value: String(d.forms), span: 0.3 },
          { label: '5  Total amount reported with this Form 1096', value: usd(d.total), span: 0.3 },
        ],
      },
      {
        kind: 'checks',
        label: '6  Enter an “X” in only one box below',
        options: [{ label: '1099-NEC', checked: true }],
      },
      {
        kind: 'text',
        text: 'Under penalties of perjury, I declare that I have examined this return and accompanying documents and, to the best of my knowledge and belief, they are true, correct, and complete.',
      },
      { kind: 'signature', label: 'Signature', name: null, date: null },
    ],
  };
}

/** Several forms in one PDF, each starting on its own page. */
export async function combinedPdf(docs: FormDoc[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setCreator('Montra');
  out.setTitle(docs[0]?.form.replace(/[^\x20-\x7e]/g, '?') ?? 'Forms');
  for (const doc of docs) {
    const part = await PDFDocument.load(await renderFormPdf(doc));
    for (const page of await out.copyPages(part, part.getPageIndices())) out.addPage(page);
  }
  return out.save();
}
