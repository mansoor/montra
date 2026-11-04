import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { toCsv, toIif, toXero, type JournalLine } from '../src/business/export.service.js';
import { renderInvoicePdf, type InvoicePdfData } from '../src/business/invoice-pdf.js';

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
