/**
 * Renders an invoice to PDF (BIZ-05). Pure: data in, bytes out. The standard PDF fonts cover Latin text only, so other
 * characters print as "?" rather than failing the send (ADR-0017); embedding a Unicode font is a later improvement.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface InvoicePdfData {
  business: { name: string; legalName: string | null; address: string | null; email: string | null };
  customer: { name: string; address: string | null; email: string | null };
  number: string;
  issueDate: string;
  dueDate: string;
  notes: string | null;
  lines: {
    description: string;
    quantity: string;
    unitPrice: string;
    taxRate: string | null;
    amount: string;
  }[];
  subtotal: string;
  tax: string;
  total: string;
  paid: string | null;
  open: string | null;
  labels: Record<
    | 'invoice'
    | 'billTo'
    | 'issued'
    | 'due'
    | 'description'
    | 'quantity'
    | 'price'
    | 'amount'
    | 'subtotal'
    | 'tax'
    | 'total'
    | 'paid'
    | 'open',
    string
  >;
}

const WIDTH = 612; // US Letter
const HEIGHT = 792;
const MARGIN = 54;
const INK = rgb(0.1, 0.12, 0.14);
const MUTED = rgb(0.42, 0.45, 0.48);

/** What the font can print, one character at a time. */
function printable(font: PDFFont, text: string): string {
  const flat = text.replace(/[\r\t]/g, ' ');
  let out = '';
  for (const ch of flat) {
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
      // A single word wider than the column is cut, not allowed to run off the page.
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

export async function renderInvoicePdf(d: InvoicePdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${d.labels.invoice} ${printableAscii(d.number)}`);
  pdf.setCreator('Montra');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([WIDTH, HEIGHT]);
  let y = HEIGHT - MARGIN;

  const ensure = (needed: number) => {
    if (y - needed >= MARGIN) return;
    page = pdf.addPage([WIDTH, HEIGHT]);
    y = HEIGHT - MARGIN;
  };
  const text = (s: string, x: number, size = 10, font = regular, color = INK) =>
    page.drawText(printable(font, s), { x, y, size, font, color });
  const right = (s: string, xRight: number, size = 10, font = regular, color = INK) => {
    const p = printable(font, s);
    page.drawText(p, { x: xRight - font.widthOfTextAtSize(p, size), y, size, font, color });
  };
  const block = (s: string | null, x: number, width: number, color = MUTED) => {
    if (!s) return;
    for (const l of wrap(regular, s, 10, width)) {
      ensure(14);
      text(l, x, 10, regular, color);
      y -= 14;
    }
  };

  // Header: who it's from, and the invoice's number and dates.
  const headerTop = y;
  text(d.business.legalName ?? d.business.name, MARGIN, 14, bold);
  y -= 20;
  block(d.business.address, MARGIN, 280);
  block(d.business.email, MARGIN, 280);
  const leftEnd = y;
  y = headerTop;
  right(d.labels.invoice, WIDTH - MARGIN, 18, bold);
  y -= 24;
  right(d.number, WIDTH - MARGIN, 11, bold);
  y -= 16;
  right(`${d.labels.issued}: ${d.issueDate}`, WIDTH - MARGIN, 10, regular, MUTED);
  y -= 14;
  right(`${d.labels.due}: ${d.dueDate}`, WIDTH - MARGIN, 10, bold);
  y = Math.min(leftEnd, y) - 28;

  // Who it's to.
  ensure(40);
  text(d.labels.billTo, MARGIN, 9, bold, MUTED);
  y -= 15;
  text(d.customer.name, MARGIN, 11, bold);
  y -= 15;
  block(d.customer.address, MARGIN, 280);
  block(d.customer.email, MARGIN, 280);
  y -= 16;

  // Columns, right-aligned from the page edge.
  const AMOUNT = WIDTH - MARGIN;
  const PRICE = AMOUNT - 90;
  const QTY = PRICE - 80;
  const DESCRIPTION_WIDTH = QTY - 50 - MARGIN;
  const rule = () => {
    page.drawLine({
      start: { x: MARGIN, y: y + 10 },
      end: { x: WIDTH - MARGIN, y: y + 10 },
      thickness: 0.5,
      color: MUTED,
    });
  };
  const tableHead = () => {
    text(d.labels.description, MARGIN, 9, bold, MUTED);
    right(d.labels.quantity, QTY, 9, bold, MUTED);
    right(d.labels.price, PRICE, 9, bold, MUTED);
    right(d.labels.amount, AMOUNT, 9, bold, MUTED);
    y -= 8;
    rule();
    y -= 8;
  };
  tableHead();
  for (const l of d.lines) {
    const rows = wrap(regular, l.description, 10, DESCRIPTION_WIDTH);
    const before = page;
    ensure(rows.length * 14 + 6);
    if (page !== before) tableHead();
    rows.forEach((r, i) => {
      text(r, MARGIN);
      if (i === 0) {
        right(l.quantity, QTY);
        right(l.unitPrice, PRICE);
        right(l.amount, AMOUNT);
      }
      y -= 14;
    });
    if (l.taxRate) {
      ensure(12);
      text(l.taxRate, MARGIN, 8, regular, MUTED);
      y -= 12;
    }
    y -= 6;
  }

  // Totals.
  ensure(110);
  y -= 2;
  rule();
  y -= 6;
  const total = (label: string, value: string, strong = false) => {
    right(label, PRICE, strong ? 11 : 10, strong ? bold : regular);
    right(value, AMOUNT, strong ? 11 : 10, strong ? bold : regular);
    y -= strong ? 18 : 15;
  };
  total(d.labels.subtotal, d.subtotal);
  total(d.labels.tax, d.tax);
  total(d.labels.total, d.total, true);
  if (d.paid) total(d.labels.paid, d.paid);
  if (d.open) total(d.labels.open, d.open, true);

  if (d.notes) {
    y -= 10;
    block(d.notes, MARGIN, WIDTH - 2 * MARGIN);
  }
  return pdf.save();
}

const printableAscii = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');
