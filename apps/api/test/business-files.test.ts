import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { toCsv, toIif, toXero, type JournalLine } from '../src/business/export.service.js';
import { renderInvoicePdf, type InvoicePdfData } from '../src/business/invoice-pdf.js';
import { checkLogo, sniffLogo } from '../src/business/logo.js';
import { FontSet, fontRuns } from '../src/business/pdf-fonts.js';

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** The fonts a PDF embeds, by base name without the subset tag ("NotoSansSC-Regular"). */
async function fontsOf(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const names = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font')) {
      const base = obj.get(PDFName.of('BaseFont'));
      if (base instanceof PDFName)
        names.add(
          base
            .decodeText()
            .replace(/^[A-Z]{6}\+/, '')
            .replace(/-\d+$/, ''),
        );
    }
  }
  return [...names].sort();
}

const labels = {
  invoice: 'Invoice',
  billTo: 'Bill to',
  issued: 'Issued',
  due: 'Due',
  description: 'Description',
  quantity: 'Qty',
  price: 'Price',
  amount: 'Amount',
  subtotal: 'Subtotal',
  tax: 'Tax',
  total: 'Total',
  paid: 'Paid',
  open: 'Balance due',
};
const data = (over: Partial<InvoicePdfData> = {}): InvoicePdfData => ({
  business: { name: 'Rivera Studio', legalName: null, address: '1 Elm St\nAustin, TX', email: 'a@b.example' },
  customer: { name: 'Bluebird Cafe', address: null, email: null },
  number: 'INV-0001',
  issueDate: '11/01/2026',
  dueDate: '12/01/2026',
  notes: null,
  lines: [{ description: 'Design', quantity: '1.5', unitPrice: '$100.00', taxRate: null, amount: '$150.00' }],
  subtotal: '$150.00',
  tax: '$0.00',
  total: '$150.00',
  paid: null,
  open: null,
  labels,
  ...over,
});

describe('renderInvoicePdf', () => {
  const pages = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

  it('makes a one-page PDF for an ordinary invoice', async () => {
    const bytes = await renderInvoicePdf(data());
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pages(bytes)).toBe(1);
  });

  it('does not fail on text the standard fonts cannot print', async () => {
    const bytes = await renderInvoicePdf(
      data({
        customer: { name: '株式会社ブルーバード', address: 'Ünï çødé 🙂', email: null },
        notes: 'Спасибо!\tTabs and\r\nnew lines',
        lines: [{ description: 'مرحبا', quantity: '1', unitPrice: '¥100', taxRate: null, amount: '¥100' }],
      }),
    );
    expect(await pages(bytes)).toBe(1);
  });

  it('prints each script in a font that has it (ADR-0032)', async () => {
    const bytes = await renderInvoicePdf(
      data({
        customer: { name: '株式会社ブルーバード', address: 'שלום, Ünï çødé', email: null },
        notes: 'Спасибо! नमस्ते ขอบคุณ',
        lines: [{ description: 'مرحبا بك', quantity: '1', unitPrice: '¥100', taxRate: null, amount: '¥100' }],
      }),
    );
    const fonts = await fontsOf(bytes);
    for (const f of ['NotoSans', 'NotoSansArabic', 'NotoSansHebrew', 'NotoSansThai', 'NotoSansSC'])
      expect(fonts.some((n) => n.startsWith(`${f}-`))).toBe(true);
  });

  it('embeds only the fonts a Latin invoice needs', async () => {
    expect(await fontsOf(await renderInvoicePdf(data()))).toEqual(['NotoSans-Bold', 'NotoSans-Regular']);
  });

  it('prints the logo and the domain in the header', async () => {
    const plain = await renderInvoicePdf(data());
    const branded = await renderInvoicePdf(
      data({
        business: { ...data().business, domain: 'rivera.example', logo: { bytes: PNG, mime: 'image/png' } },
      }),
    );
    const images = async (b: Uint8Array) => {
      const doc = await PDFDocument.load(b);
      return [...doc.context.enumerateIndirectObjects()].filter(
        ([, o]) =>
          'dict' in o && (o as { dict: PDFDict }).dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
      ).length;
    };
    expect(await images(plain)).toBe(0);
    expect(await images(branded)).toBeGreaterThan(0);
    expect(await pages(branded)).toBe(1);
  });

  it('runs on to more pages rather than off the page', async () => {
    const line = {
      description: `Long description ${'word '.repeat(40)}${'x'.repeat(300)}`,
      quantity: '1',
      unitPrice: '$1.00',
      taxRate: 'Tax 8.25%',
      amount: '$1.00',
    };
    const bytes = await renderInvoicePdf(data({ lines: Array.from({ length: 60 }, () => line) }));
    expect(await pages(bytes)).toBeGreaterThan(1);
  });
});

describe('font runs', () => {
  it('keeps spaces and digits with the text around them, and starts a run per script', () => {
    expect(fontRuns('Bluebird 株式会社 2026')).toEqual([
      { font: 0, text: 'Bluebird ' },
      { font: 4, text: '株式会社 2026' },
    ]);
  });

  it('leaves digits out of a right-to-left run, which would reverse them', () => {
    expect(fontRuns('مرحبا 123')).toEqual([
      { font: 1, text: 'مرحبا' },
      { font: 0, text: ' 123' },
    ]);
  });

  it('prints Hindi in Noto Sans itself, and Thai in its own font', () => {
    expect(fontRuns('नमस्ते ขอบคุณ')).toEqual([
      { font: 0, text: 'नमस्ते ' },
      { font: 3, text: 'ขอบคุณ' },
    ]);
  });

  it('lays out joined Arabic and Devanagari conjuncts at their shaped width', async () => {
    const fonts = new FontSet(await PDFDocument.create());
    const words = ['مرحبا', 'क्षत्रिय'];
    fonts.prepare(words);
    for (const w of words) {
      const [run] = await fonts.shape(w, 'regular');
      // Shaping substitutes forms the font's character map doesn't reach; the PDF gives those a whole em, so the
      // drawing has to say where each goes.
      expect(run!.glyphs.some((g) => g.pdfWidth === 1000)).toBe(true);
      expect(run!.width).toBeCloseTo(run!.glyphs.reduce((t, g) => t + g.xAdvance, 0) / run!.unitsPerEm);
    }
  });

  it('prints what no font has as "?"', () => {
    expect(
      fontRuns('안녕 🙂')
        .map((r) => r.text)
        .join(''),
    ).toBe('?? ?');
  });
});

describe('logos', () => {
  it('reads the type and size from the content', async () => {
    expect(sniffLogo(PNG)).toEqual({ mediaType: 'image/png', width: 1, height: 1 });
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0,
    ]);
    expect(sniffLogo(jpeg)).toEqual({ mediaType: 'image/jpeg', width: 30, height: 20 });
    expect(await checkLogo(PNG)).toMatchObject({ ok: true });
  });

  it('refuses what is not a PNG or JPEG the PDF can draw, whatever its name says', async () => {
    expect(await checkLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({
      ok: false,
      reason: 'type',
    });
    expect(await checkLogo(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({ ok: false, reason: 'type' });
    const broken = Buffer.concat([PNG.subarray(0, 30), Buffer.alloc(10)]);
    expect(await checkLogo(broken)).toEqual({ ok: false, reason: 'type' });
    expect(await checkLogo(Buffer.alloc(1_048_577))).toEqual({ ok: false, reason: 'size' });
    const huge = Buffer.from(PNG);
    huge.writeUInt32BE(5000, 16);
    expect(await checkLogo(huge)).toEqual({ ok: false, reason: 'pixels' });
  });
});

describe('accounting exports', () => {
  const l = (over: Partial<JournalLine>): JournalLine => ({
    entryId: 'e1',
    date: '2026-11-03',
    kind: 'standard',
    description: 'Payment',
    payee: 'Bluebird',
    account: 'Sales & services',
    accountType: 'income',
    taxLine: 'US_SCH_C_L1',
    amount: '-100.00',
    currency: 'USD',
    ...over,
  });

  it('neutralizes text a spreadsheet would run as a formula, and keeps negative numbers as numbers', () => {
    const csv = toCsv([l({ payee: '=HYPERLINK("http://evil","x")', description: '@SUM(A1)' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain(`'@SUM(A1)`);
    expect(csv).toContain(',,100.00,USD');
    const xero = toXero([l({ description: '+1 evil', amount: '-5.00' })]);
    expect(xero).toContain(`'+1 evil`);
    expect(xero.trim().endsWith(',-5.00')).toBe(true);
  });

  it('quotes commas and quotes in CSV', () => {
    expect(toCsv([l({ payee: 'Acme, "Inc"' })])).toContain('"Acme, ""Inc"""');
  });

  it('writes one balanced journal per entry for QuickBooks, with no stray tabs', () => {
    const iif = toIif([
      l({ account: 'Checking', amount: '100.00', payee: 'Tab\there' }),
      l({}),
      l({ entryId: 'e2', account: 'Checking', amount: '-5.00' }),
      l({ entryId: 'e2', account: 'Supplies', amount: '5.00' }),
    ]).split('\r\n');
    expect(iif[3]).toBe('TRNS\tGENERAL JOURNAL\t11/03/2026\tChecking\tTab here\t100.00\tPayment');
    expect(iif[4]).toBe('SPL\tGENERAL JOURNAL\t11/03/2026\tSales & services\tBluebird\t-100.00\tPayment');
    expect(iif[5]).toBe('ENDTRNS');
    expect(iif[6]!.startsWith('TRNS')).toBe(true);
  });
});
