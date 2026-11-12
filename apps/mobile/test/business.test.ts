import { describe, expect, it } from 'vitest';
import type { BillDto, ExpenseDetailDto, InvoiceDto } from '@montra/schemas';
import { catalogs } from '@montra/i18n';
import {
  expenseLines,
  invoicePdfName,
  legalSetup,
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

describe('a business expense on the transaction screen (BIZ-18)', () => {
  const detail = (over: Partial<ExpenseDetailDto>): ExpenseDetailDto => ({
    entityId: 'e',
    spentBy: null,
    spentByPersonId: null,
    spentByName: null,
    attendees: [],
    businessPurpose: null,
    isMeal: false,
    needsMealDetail: false,
    assetCandidate: false,
    assetId: null,
    version: 0,
    ...over,
  });

  it('shows who spent, who was there and why', () => {
    expect(
      expenseLines(
        detail({
          spentBy: 'person',
          spentByName: 'Casey Example',
          attendees: [
            { partyId: 'p', name: 'Northwind Co' },
            { partyId: null, name: 'Jordan' },
          ],
          businessPurpose: 'Kick-off',
          isMeal: true,
        }),
      ),
    ).toEqual({
      spentBy: 'Casey Example',
      attendees: 'Northwind Co, Jordan',
      purpose: 'Kick-off',
      mealHint: false,
    });
    expect(expenseLines(detail({ spentBy: 'owner' }))?.spentBy).toBe('owner');
  });

  it('keeps the meal hint, and shows nothing when there is nothing to say', () => {
    expect(expenseLines(detail({ isMeal: true, needsMealDetail: true }))?.mealHint).toBe(true);
    expect(expenseLines(detail({}))).toBeNull();
    expect(expenseLines(null)).toBeNull();
  });
});

describe('the legal setup on the phone (BIZ-21, BIZ-26)', () => {
  const registrations = { einMasked: '••-•••6789' } as never;

  it('shows the type, the return it files and the masked EIN from the server', () => {
    const s = legalSetup({ businessType: 's_corp', returnForm: 'form_1120s', registrations });
    expect(s).toEqual({ typeKey: 'setup.type.s_corp', formKey: 'setup.form.form_1120s', ein: '••-•••6789' });
    for (const key of [s.typeKey, s.formKey]) expect(catalogs.en![key]).toBeTruthy();
  });

  it('says what is assumed while the type is not set', () => {
    const s = legalSetup({
      businessType: null,
      returnForm: null,
      registrations: { einMasked: null } as never,
    });
    expect(s).toEqual({ typeKey: 'setup.type_unset_line', formKey: 'setup.form_unknown', ein: null });
    for (const key of [s.typeKey, s.formKey, 'mobile.business.legal_on_web'])
      expect(catalogs.en![key]).toBeTruthy();
  });
});
