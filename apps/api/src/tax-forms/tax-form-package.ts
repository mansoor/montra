/**
 * Tax forms in the year-end tax package (ADR-0052 §7.3, TAX-07): each form's file under `tax-forms/`, an index an
 * accountant can sort (`tax-forms.csv`) and the checks against the books as on the screen (`tax-forms-check.pdf`).
 * Pure: the forms the maker can read in, names and bytes out. Montra checks the forms; it doesn't prepare a return.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { asCurrencyCode, formatMoney, money, toDecimalString } from '@montra/domain';
import { catalogs } from '@montra/i18n';
import type { TaxFormDto, TaxFormExpectedDto, TaxFormKind, TaxFormWaiverDto } from '@montra/schemas';

const en = catalogs.en as Record<string, string>;
const USD = asCurrencyCode('USD');

export const FORM_NAMES: Record<TaxFormKind, string> = {
  w2: 'W-2',
  '1099_int': '1099-INT',
  '1099_div': '1099-DIV',
  '1098': '1098',
};

/** The box an accountant looks for first, and the federal tax withheld, per kind. */
const MAIN_BOX: Record<TaxFormKind, { box: string; label: string; withheld: string | null }> = {
  w2: { box: 'box1', label: 'Box 1 wages', withheld: 'box2' },
  '1099_int': { box: 'box1', label: 'Box 1 interest', withheld: 'box4' },
  '1099_div': { box: 'box1a', label: 'Box 1a ordinary dividends', withheld: 'box4' },
  '1098': { box: 'box1', label: 'Box 1 mortgage interest', withheld: null },
};

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const README_LINE =
  'tax-forms/ holds the tax forms received for the year (W-2, 1099 and 1098), listed in tax-forms.csv, with any expected form that hasn’t come; tax-forms-check.pdf shows how each was checked against the books. Montra checked the forms against the books. It didn’t prepare a tax return.';

export const leftOutLine = (n: number) =>
  `${n} tax ${n === 1 ? 'form' : 'forms'} not included: you can't see ${n === 1 ? 'it' : 'them'}.`;

const firstName = (name: string | null | undefined) => (name ? (name.trim().split(/\s+/)[0] ?? '') : '');
const fileSafe = (s: string) =>
  s
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .trim()
    .slice(0, 60);

/** `W-2-Acme Corp-Sam.pdf` (§7.3); a second with the same name gets ` (2)`. */
export function packageFileName(
  form: Pick<TaxFormDto, 'kind' | 'issuerName'>,
  person: string | null,
  mime: string,
  taken: Set<string>,
): string {
  const parts = [
    FORM_NAMES[form.kind],
    fileSafe(form.issuerName ?? 'issuer'),
    fileSafe(firstName(person)),
  ].filter(Boolean);
  const stem = parts.join('-');
  const ext = EXTENSIONS[mime] ?? 'bin';
  let name = `${stem}.${ext}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n}).${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

const boxMinor = (boxes: unknown, key: string | null): string | null => {
  if (!key || !boxes || typeof boxes !== 'object') return null;
  const v = (boxes as Record<string, unknown>)[key];
  return typeof v === 'string' && /^\d+$/.test(v) ? v : null;
};
const decimal = (minor: string | null) => (minor === null ? '' : toDecimalString(money(BigInt(minor), USD)));
const shown = (minor: string | null) =>
  minor === null ? '' : formatMoney(money(BigInt(minor), USD), { locale: 'en-US' });
const ein = (v: string | null) => (v ? `${v.slice(0, 2)}-${v.slice(2)}` : '');
export const resultWords = (state: string) => en[`tax_forms.result.${state}`] ?? state;
const checkWords = (status: string) => en[`tax_forms.check_status.${status}`] ?? status;

const cell = (v: string): string => {
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export interface PackageForms {
  forms: readonly TaxFormDto[];
  /** Expected forms not received: missing or waived. */
  expected: readonly TaxFormExpectedDto[];
  waivers: readonly TaxFormWaiverDto[];
  people: ReadonlyMap<string, string>;
  /** Where each form's files sit in the package. */
  paths: ReadonlyMap<string, readonly string[]>;
}

/** One row per form, then one per expected form not received or waived (§7.3). */
export function taxFormsCsv(p: PackageForms): string {
  const rows: string[][] = [
    [
      'Form',
      'Issuer',
      'EIN',
      'Person',
      'Account (last four)',
      'Main box',
      'Amount',
      'Federal tax withheld',
      'Result',
      'Difference',
      'Accepted differences',
      'Files',
    ],
  ];
  for (const f of p.forms) {
    const main = MAIN_BOX[f.kind];
    const accepted = f.checks
      .filter((c) => c.acceptedNote)
      .map((c) => `Box ${c.box}: ${c.acceptedNote}`)
      .join('; ');
    rows.push([
      `${FORM_NAMES[f.kind]}${f.corrected ? ' (corrected)' : ''}`,
      f.issuerName ?? '',
      ein(f.issuerEin),
      f.personMemberId ? (p.people.get(f.personMemberId) ?? '') : '',
      f.accountLast4 ?? '',
      main.label,
      decimal(boxMinor(f.boxes, main.box)),
      decimal(boxMinor(f.boxes, main.withheld)),
      resultWords(f.result.state),
      decimal(f.result.difference),
      accepted,
      (p.paths.get(f.id) ?? []).join('; '),
    ]);
  }
  for (const e of p.expected) {
    const waiver = e.waiverId ? p.waivers.find((w) => w.id === e.waiverId) : undefined;
    const result =
      e.state === 'waived'
        ? `Won't come: ${en[`tax_forms.waiver_reason.${waiver?.reason ?? 'other'}`] ?? waiver?.reason ?? ''}${
            waiver?.note ? ` (${waiver.note})` : ''
          }`
        : 'Not received';
    rows.push([
      FORM_NAMES[e.kind],
      e.name,
      '',
      e.personMemberId ? (p.people.get(e.personMemberId) ?? '') : '',
      '',
      '',
      '',
      '',
      result,
      '',
      '',
      '',
    ]);
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ----- The checks, as a PDF ----------------------------------------------------------------------------------------------

/** What the standard fonts can print; anything else prints as "?" rather than failing the package. */
const printable = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

function fit(text: string, font: PDFFont, size: number, width: number): string {
  const clean = printable(text);
  if (font.widthOfTextAtSize(clean, size) <= width) return clean;
  let cut = clean;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > width) cut = cut.slice(0, -1);
  return `${cut}...`;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of printable(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function formTitle(
  f: Pick<TaxFormDto, 'kind' | 'issuerName' | 'personMemberId'>,
  people: ReadonlyMap<string, string>,
) {
  const person = f.personMemberId ? people.get(f.personMemberId) : undefined;
  return `${FORM_NAMES[f.kind]} from ${f.issuerName ?? 'an issuer not known yet'}${person ? `, for ${person}` : ''}`;
}

/** Each form's result and checks (box, form, books, difference, result, how it was worked out), as the screen shows. */
export async function taxFormsCheckPdf(
  p: PackageForms & { year: number; booksName: string; leftOut: number },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = [612, 792];
  const margin = 40;
  const size = 9;
  const width = W - margin * 2;
  const grey = rgb(0.35, 0.35, 0.35);
  // Box, Form, Books, Difference, Result.
  const cols = [60, 95, 95, 95, width - 345];
  const xs = cols.map((_, i) => margin + cols.slice(0, i).reduce((a, b) => a + b, 0));
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - margin;
  const room = (needed: number) => {
    if (y - needed < margin + 10) {
      page = doc.addPage([W, H]);
      y = H - margin;
    }
  };
  const text = (s: string, x: number, font: PDFFont, sz = size, color = rgb(0.1, 0.1, 0.1)) =>
    page.drawText(s, { x, y, size: sz, font, color });
  const para = (s: string, font = regular, sz = 8, indent = 0, color = grey) => {
    for (const line of wrap(s, font, sz, width - indent)) {
      room(sz + 3);
      text(line, margin + indent, font, sz, color);
      y -= sz + 3;
    }
  };
  const row = (cells: string[], font: PDFFont) => {
    room(14);
    cells.forEach((c, i) => {
      const t = fit(c, font, size, cols[i]! - 6);
      const right = i >= 1 && i <= 3;
      const x = right ? xs[i]! + cols[i]! - 6 - font.widthOfTextAtSize(t, size) : xs[i]!;
      text(t, x, font);
    });
    y -= 13;
  };

  text(printable('Tax forms checked against the books'), margin, bold, 16);
  y -= 18;
  text(printable(`${p.booksName}, ${p.year}`), margin, regular, 9, grey);
  y -= 14;
  para(
    'Each form received is compared with the books, box by box. A difference of $1.00 or less counts as a match. Montra checked the forms against the books; it didn’t prepare a tax return, and this isn’t tax advice.',
  );
  if (p.leftOut > 0) para(leftOutLine(p.leftOut));
  y -= 6;

  if (p.forms.length === 0) para('No tax forms were received for these books and year.', regular, 9, 0);
  for (const f of p.forms) {
    room(60);
    y -= 6;
    const result =
      f.result.state === 'differs' && f.result.difference
        ? `Differs by ${shown(f.result.difference.replace(/^-/, ''))}`
        : resultWords(f.result.state);
    para(`${formTitle(f, p.people)}: ${result}`, bold, 11, 0, rgb(0.1, 0.1, 0.1));
    const details = [
      f.issuerEin ? `EIN ${ein(f.issuerEin)}` : null,
      f.accountLast4 ? `Account ending ${f.accountLast4}` : null,
      f.corrected ? 'Corrected form' : null,
    ].filter(Boolean);
    if (details.length) para(details.join(' · '));
    if (f.checks.length === 0) {
      para(en['tax_forms.no_checks'] ?? 'No checks yet.', regular, 8, 0);
      continue;
    }
    y -= 2;
    row(['Box', 'Form', 'Books', 'Difference', 'Result'], bold);
    for (const c of f.checks) {
      row([c.box, shown(c.form), shown(c.books), shown(c.difference), checkWords(c.status)], regular);
      para(c.rule, regular, 7, 10);
      if (c.explanation) para(c.explanation, regular, 7, 10);
      if (c.acceptedNote) para(`Accepted: ${c.acceptedNote}`, regular, 7, 10);
    }
  }

  if (p.expected.length) {
    room(40);
    y -= 10;
    para('Expected, not received', bold, 11, 0, rgb(0.1, 0.1, 0.1));
    for (const e of p.expected) {
      const person = e.personMemberId ? p.people.get(e.personMemberId) : undefined;
      const waiver = e.waiverId ? p.waivers.find((w) => w.id === e.waiverId) : undefined;
      const state =
        e.state === 'waived'
          ? `won't come (${en[`tax_forms.waiver_reason.${waiver?.reason ?? 'other'}`] ?? ''}${waiver?.note ? `: ${waiver.note}` : ''})`
          : 'not received';
      para(`${FORM_NAMES[e.kind]} from ${e.name}${person ? `, for ${person}` : ''}: ${state}`, regular, 9, 0);
    }
  }

  const pages = doc.getPages();
  pages.forEach((pg, i) =>
    pg.drawText(`Montra - ${i + 1} / ${pages.length}`, {
      x: margin,
      y: 20,
      size: 8,
      font: regular,
      color: rgb(0.5, 0.5, 0.5),
    }),
  );
  return doc.save();
}
