/**
 * A payslip for one paycheck (PRL-08). Pure: data in, bytes out. Each line shows this period and the year to date; the
 * employer's own taxes are listed for information, as they don't come out of pay.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface PayslipRow {
  label: string;
  hours: string | null;
  rate: string | null;
  current: string;
  ytd: string;
}

export interface PayslipPdfData {
  employer: { name: string; address: string | null };
  employee: { name: string; address: string | null; ssnLast4: string | null };
  periodStart: string;
  periodEnd: string;
  payDate: string;
  sections: { title: string; rows: PayslipRow[] }[];
  gross: { current: string; ytd: string };
  net: { current: string; ytd: string };
  employerTaxes: PayslipRow[];
  draft: boolean;
}

const WIDTH = 612;
const HEIGHT = 792;
const MARGIN = 48;
const INK = rgb(0.1, 0.12, 0.14);
const MUTED = rgb(0.42, 0.45, 0.48);
const LINE = rgb(0.75, 0.77, 0.8);
const SHADE = rgb(0.93, 0.94, 0.95);

function printable(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.replace(/[\r\n\t]/g, ' ')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

export async function renderPayslipPdf(d: PayslipPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Payslip ${d.payDate}`);
  pdf.setCreator('Montra');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = pdf.addPage([WIDTH, HEIGHT]);
  let y = HEIGHT - MARGIN;
  const ensure = (n: number) => {
    if (y - n < MARGIN + 30) {
      page = pdf.addPage([WIDTH, HEIGHT]);
      y = HEIGHT - MARGIN;
    }
  };
  const text = (s: string, x: number, size = 9.5, font = regular, color = INK) =>
    page.drawText(printable(font, s), { x, y, size, font, color });
  const right = (s: string, xRight: number, size = 9.5, font = regular, color = INK) => {
    const p = printable(font, s);
    page.drawText(p, { x: xRight - font.widthOfTextAtSize(p, size), y, size, font, color });
  };

  // Header.
  text(d.employer.name, MARGIN, 14, bold);
  right(d.draft ? 'Payslip (draft)' : 'Payslip', WIDTH - MARGIN, 16, bold);
  y -= 16;
  if (d.employer.address) {
    for (const l of d.employer.address.split('\n')) {
      text(l, MARGIN, 9, regular, MUTED);
      y -= 12;
    }
  }
  y -= 10;
  page.drawRectangle({ x: MARGIN, y: y - 46, width: WIDTH - 2 * MARGIN, height: 56, color: SHADE });
  text('Employee', MARGIN + 8, 7.5, regular, MUTED);
  text('Pay period', MARGIN + 260, 7.5, regular, MUTED);
  text('Pay date', MARGIN + 420, 7.5, regular, MUTED);
  y -= 13;
  text(d.employee.name, MARGIN + 8, 11, bold);
  text(`${d.periodStart} to ${d.periodEnd}`, MARGIN + 260, 10.5);
  text(d.payDate, MARGIN + 420, 10.5, bold);
  y -= 13;
  if (d.employee.address) text(d.employee.address.replace(/\n/g, ', '), MARGIN + 8, 8.5, regular, MUTED);
  y -= 11;
  if (d.employee.ssnLast4) text(`SSN xxx-xx-${d.employee.ssnLast4}`, MARGIN + 8, 8.5, regular, MUTED);
  y -= 26;

  const COLS = { hours: 330, rate: 400, current: 480, ytd: WIDTH - MARGIN };
  const head = (title: string) => {
    ensure(40);
    text(title, MARGIN, 10, bold);
    right('Hours', COLS.hours, 7.5, regular, MUTED);
    right('Rate', COLS.rate, 7.5, regular, MUTED);
    right('This period', COLS.current, 7.5, regular, MUTED);
    right('Year to date', COLS.ytd, 7.5, regular, MUTED);
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: WIDTH - MARGIN, y }, thickness: 0.5, color: LINE });
    y -= 12;
  };
  const row = (r: PayslipRow, font = regular) => {
    ensure(14);
    text(r.label, MARGIN + 4, 9.5, font);
    if (r.hours) right(r.hours, COLS.hours, 9.5, font);
    if (r.rate) right(r.rate, COLS.rate, 9.5, font);
    right(r.current, COLS.current, 9.5, font);
    right(r.ytd, COLS.ytd, 9.5, font, MUTED);
    y -= 14;
  };

  for (const s of d.sections) {
    if (!s.rows.length) continue;
    head(s.title);
    for (const r of s.rows) row(r);
    if (s.title === 'Earnings') row({ label: 'Gross pay', hours: null, rate: null, ...d.gross }, bold);
    y -= 8;
  }

  ensure(40);
  page.drawRectangle({ x: MARGIN, y: y - 10, width: WIDTH - 2 * MARGIN, height: 26, color: SHADE });
  text('Net pay', MARGIN + 8, 12, bold);
  right(d.net.current, COLS.current, 12, bold);
  right(d.net.ytd, COLS.ytd, 10, regular, MUTED);
  y -= 36;

  if (d.employerTaxes.length) {
    head('Paid by the employer (not taken from pay)');
    for (const r of d.employerTaxes) row(r);
  }

  page.drawText(
    printable(
      regular,
      'Prepared by Montra from the pay run your employer approved. Montra does not move money or file taxes, and this is not tax advice.',
    ),
    { x: MARGIN, y: MARGIN - 10, size: 6.5, font: regular, color: MUTED },
  );
  return pdf.save();
}
