import { describe, expect, it } from 'vitest';
import type { BillDto, InvoiceDto } from '@montra/schemas';
import {
  invoicePdfName,
  newestFirst,
  normalizeMiles,
  openBills,
  openInvoices,
  sumMinor,
} from '../src/features/business';

const invoice = (id: string, status: InvoiceDto['status'], dueDate: string) =>
  ({ id, status, dueDate, open: '100' }) as unknown as InvoiceDto;
const bill = (id: string, status: BillDto['status'], dueDate: string) =>
  ({ id, status, dueDate, amount: '100' }) as unknown as BillDto;

describe('what is open', () => {
  it('leaves out drafts, paid and void, most urgent first', () => {
    const list = [
      invoice('a', 'sent', '2026-12-01'),
      invoice('b', 'paid', '2026-01-01'),
      invoice('c', 'overdue', '2026-10-01'),
      invoice('d', 'draft', '2026-01-01'),
      invoice('e', 'partial', '2026-11-01'),
      invoice('f', 'void', '2026-01-01'),
    ];
    expect(openInvoices(list).map((i) => i.id)).toEqual(['c', 'e', 'a']);
  });

  it('does the same for bills', () => {
    const list = [
      bill('a', 'open', '2026-12-01'),
      bill('b', 'paid', '2026-01-01'),
      bill('c', 'overdue', '2026-10-01'),
    ];
    expect(openBills(list).map((b) => b.id)).toEqual(['c', 'a']);
  });

  it('adds minor units exactly', () => {
    expect(sumMinor(['9007199254740993', '1'])).toBe(9007199254740994n);
  });
});

describe('normalizeMiles', () => {
  it('takes what the API takes', () => {
    expect(normalizeMiles(' 12.4 ')).toBe('12.4');
    expect(normalizeMiles('100')).toBe('100');
    expect(normalizeMiles('0.5')).toBe('0.5');
  });

  it('refuses the rest', () => {
    for (const bad of ['', '0', '0.0', '12.45', '-3', 'abc', '1,000']) {
      expect(normalizeMiles(bad)).toBeNull();
    }
  });
});

describe('the invoice PDF on the phone (ADR-0032)', () => {
  it('names the file after the invoice, safely', () => {
    expect(invoicePdfName('INV-0007')).toBe('INV-0007.pdf');
    expect(invoicePdfName('2026/11 #3')).toBe('2026_11_3.pdf');
    expect(invoicePdfName('../x')).toBe('x.pdf');
    expect(invoicePdfName('請求-1')).toBe('請求-1.pdf');
    expect(invoicePdfName('///')).toBe('invoice.pdf');
  });
});

describe('the business landing page', () => {
  it('lists the months newest first for the table', () => {
    const months = [{ start: '2026-09-01' }, { start: '2026-11-01' }, { start: '2026-10-01' }];
    expect(newestFirst(months).map((m) => m.start)).toEqual(['2026-11-01', '2026-10-01', '2026-09-01']);
  });
});
