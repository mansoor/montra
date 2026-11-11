/**
 * Renders an invoice to PDF (BIZ-05). Pure: data in, bytes out. Text prints in embedded Noto fonts, script by script
 * (ADR-0032), so names in Arabic, Hebrew, Hindi, Thai, Chinese or Japanese print as written; a character none of the
 * fonts has prints as "?" rather than failing the send. The business's logo and domain head the page.
 */
import { PDFDocument, rgb, type PDFImage, type PDFPage } from 'pdf-lib';
import { drawRuns, FontSet, type ShapedRun } from './pdf-fonts.js';

export interface InvoicePdfData {
  business: {
    name: string;
    legalName: string | null;
    address: string | null;
    email: string | null;
    domain?: string | null;
    /** A PNG or JPEG already checked on upload (`checkLogo`). */
    logo?: { bytes: Uint8Array; mime: string } | null;
  };
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
/** The logo fits in this box, keeping its shape. */
const LOGO_W = 160;
const LOGO_H = 56;

type Weight = 'regular' | 'bold';
type Shaped = ShapedRun[];

const clean = (text: string) => text.replace(/[\r\t]/g, ' ');
const widthOf = (runs: Shaped, size: number) => runs.reduce((w, r) => w + r.width * size, 0);

export async function renderInvoicePdf(d: InvoicePdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${d.labels.invoice} ${d.number}`);
  pdf.setCreator('Montra');
  const fonts = new FontSet(pdf);
  fonts.prepare(textsOf(d));
  // Shaping lays text out with fontkit, which is slow next to the standard fonts: each string is shaped once.
  const shapes = new Map<string, Promise<Shaped>>();
  const shape = (s: string, weight: Weight = 'regular') => {
    const key = `${weight}:${s}`;
    let hit = shapes.get(key);
    if (!hit) {
      hit = fonts.shape(clean(s), weight);
      shapes.set(key, hit);
    }
    return hit;
  };
  const measure = async (s: string, size: number, weight: Weight = 'regular') =>
    widthOf(await shape(s, weight), size);

  let page: PDFPage = pdf.addPage([WIDTH, HEIGHT]);
  let y = HEIGHT - MARGIN;

  const ensure = (needed: number) => {
    if (y - needed >= MARGIN) return;
    page = pdf.addPage([WIDTH, HEIGHT]);
    y = HEIGHT - MARGIN;
  };
  const text = async (s: string, x: number, size = 10, weight: Weight = 'regular', color = INK) =>
    drawRuns(page, await shape(s, weight), x, y, size, color);
  const right = async (s: string, xRight: number, size = 10, weight: Weight = 'regular', color = INK) => {
    const runs = await shape(s, weight);
    drawRuns(page, runs, xRight - widthOf(runs, size), y, size, color);
  };

  /** Words to lines no wider than `width`; a word wider than the column is cut rather than run off the page. */
  const wrap = async (s: string, size: number, width: number): Promise<string[]> => {
    const out: string[] = [];
    const space = await measure(' ', size);
    for (const para of clean(s).split('\n')) {
      // A line's width is the sum of its words' and spaces' (kerning across a space is nil), so each word is shaped once.
      let line = '';
      let lineWidth = 0;
      for (const word of para.split(' ')) {
        const w = await measure(word, size);
        const next = line ? lineWidth + space + w : w;
        if (next <= width) {
          line = line ? `${line} ${word}` : word;
          lineWidth = next;
          continue;
        }
        if (line) out.push(line);
        line = word;
        lineWidth = w;
        while (lineWidth > width && [...line].length > 1) {
          // The longest start that fits, found by halving: a long word is measured a few times, not once per letter.
          const chars = [...line];
          let lo = 1;
          let hi = chars.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if ((await measure(chars.slice(0, mid).join(''), size)) <= width) lo = mid;
            else hi = mid - 1;
          }
          out.push(chars.slice(0, lo).join(''));
          line = chars.slice(lo).join('');
          lineWidth = await measure(line, size);
        }
      }
      out.push(line);
    }
    return out;
  };
  const block = async (s: string | null | undefined, x: number, width: number, color = MUTED) => {
    if (!s) return;
    for (const l of await wrap(s, 10, width)) {
      ensure(14);
      await text(l, x, 10, 'regular', color);
      y -= 14;
    }
  };

  // Header: the logo, who it's from, and the invoice's number and dates.
  const headerTop = y;
  const logo = await embedLogo(pdf, d.business.logo);
  if (logo) {
    const scale = Math.min(LOGO_W / logo.width, LOGO_H / logo.height, 1);
    const h = logo.height * scale;
    page.drawImage(logo, { x: MARGIN, y: y - h + 10, width: logo.width * scale, height: h });
    y -= h + 10;
  }
  await text(d.business.legalName ?? d.business.name, MARGIN, 14, 'bold');
  y -= 20;
  await block(d.business.address, MARGIN, 280);
  await block(d.business.email, MARGIN, 280);
  await block(d.business.domain, MARGIN, 280);
  const leftEnd = y;
  y = headerTop;
  await right(d.labels.invoice, WIDTH - MARGIN, 18, 'bold');
  y -= 24;
  await right(d.number, WIDTH - MARGIN, 11, 'bold');
  y -= 16;
  await right(`${d.labels.issued}: ${d.issueDate}`, WIDTH - MARGIN, 10, 'regular', MUTED);
  y -= 14;
  await right(`${d.labels.due}: ${d.dueDate}`, WIDTH - MARGIN, 10, 'bold');
  y = Math.min(leftEnd, y) - 28;

  // Who it's to.
  ensure(40);
  await text(d.labels.billTo, MARGIN, 9, 'bold', MUTED);
  y -= 15;
  await text(d.customer.name, MARGIN, 11, 'bold');
  y -= 15;
  await block(d.customer.address, MARGIN, 280);
  await block(d.customer.email, MARGIN, 280);
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
  const tableHead = async () => {
    await text(d.labels.description, MARGIN, 9, 'bold', MUTED);
    await right(d.labels.quantity, QTY, 9, 'bold', MUTED);
    await right(d.labels.price, PRICE, 9, 'bold', MUTED);
    await right(d.labels.amount, AMOUNT, 9, 'bold', MUTED);
    // The rule sits under the column titles, not through them.
    y -= 14;
    rule();
    y -= 6;
  };
  await tableHead();
  for (const l of d.lines) {
    const rows = await wrap(l.description, 10, DESCRIPTION_WIDTH);
    const before = page;
    ensure(rows.length * 14 + 6);
    if (page !== before) await tableHead();
    for (const [i, r] of rows.entries()) {
      await text(r, MARGIN);
      if (i === 0) {
        await right(l.quantity, QTY);
        await right(l.unitPrice, PRICE);
        await right(l.amount, AMOUNT);
      }
      y -= 14;
    }
    if (l.taxRate) {
      ensure(12);
      await text(l.taxRate, MARGIN, 8, 'regular', MUTED);
      y -= 12;
    }
    y -= 6;
  }

  // Totals.
  ensure(110);
  y -= 2;
  rule();
  y -= 6;
  const total = async (label: string, value: string, strong = false) => {
    await right(label, PRICE, strong ? 11 : 10, strong ? 'bold' : 'regular');
    await right(value, AMOUNT, strong ? 11 : 10, strong ? 'bold' : 'regular');
    y -= strong ? 18 : 15;
  };
  await total(d.labels.subtotal, d.subtotal);
  await total(d.labels.tax, d.tax);
  await total(d.labels.total, d.total, true);
  if (d.paid) await total(d.labels.paid, d.paid);
  if (d.open) await total(d.labels.open, d.open, true);

  if (d.notes) {
    y -= 10;
    await block(d.notes, MARGIN, WIDTH - 2 * MARGIN);
  }
  return pdf.save();
}

/** The logo, or nothing if it's missing or (against the upload check) can't be drawn: the invoice matters more. */
async function embedLogo(
  pdf: PDFDocument,
  logo: InvoicePdfData['business']['logo'],
): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    return logo.mime === 'image/png' ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
  } catch {
    return null;
  }
}

/** Every string the invoice prints, so its fonts can be cut down to exactly those characters. */
function textsOf(d: InvoicePdfData): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object' && !(v instanceof Uint8Array)) Object.values(v).forEach(walk);
  };
  walk(d);
  return out;
}
