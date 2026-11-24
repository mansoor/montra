import { describe, expect, it } from 'vitest';
import type { ReceiptDto } from '@montra/api-client';
import {
  amountToInput,
  AUTOMATIC_MEMBER,
  buildUpdate,
  newLine,
  previewSplits,
  recalcLine,
  receiptFileProblem,
  rowsOf,
  stalledReasons,
} from './receipts';
import { delayedWorkers } from './status';

const receipt: ReceiptDto = {
  id: 'r1',
  entityId: 'e1',
  status: 'needs_review',
  source: 'upload',
  fileIds: ['f1'],
  merchant: 'Walmart',
  storeAddress: null,
  storePhone: null,
  storeWebsite: null,
  receiptDate: '2026-10-05',
  localTime: '14:32',
  currency: 'USD',
  subtotal: '2696',
  tax: '175',
  taxIncluded: false,
  discount: '0',
  fees: '0',
  tip: '0',
  total: '2871',
  cardLast4: '1234',
  validationGap: '0',
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      rawText: 'GV 2% MLK GAL',
      expandedName: 'Great Value 2% milk',
      qty: null,
      unitPrice: null,
      lineTotal: '348',
      discount: '0',
      taxable: false,
      isReturn: false,
      categoryId: 'groceries',
      entityId: 'e1',
      memberId: null,
      categorization: null,
      memberReason: null,
    },
  ],
  groups: [],
  transactionId: null,
  matchScore: null,
  candidates: [],
  fxRate: null,
  tripId: null,
  orderRef: null,
  extraction: null,
  stalled: null,
  likelyDuplicates: [],
  retainUntil: '2033-11-02',
  createdAt: '2026-11-02T10:00:00.000Z',
  version: '3',
};

describe('receipt helpers (RCP-06)', () => {
  it('checks picked files before uploading', () => {
    expect(receiptFileProblem({ name: 'r.JPG', size: 10 })).toBeNull();
    expect(receiptFileProblem({ name: 'invoice.pdf', size: 10 })).toBeNull();
    expect(receiptFileProblem({ name: 'r.gif', size: 10 })).toMatch(/JPEG/);
    expect(receiptFileProblem({ name: 'r.png', size: 0 })).toMatch(/empty/);
    expect(receiptFileProblem({ name: 'r.png', size: 26 * 1024 * 1024 })).toMatch(/25 MB/);
  });

  it('shows minor units in each currency’s decimals', () => {
    expect(amountToInput('2871', 'USD')).toBe('28.71');
    expect(amountToInput('-1499', 'USD')).toBe('-14.99');
    expect(amountToInput('728', 'JPY')).toBe('728');
    expect(amountToInput(null, 'USD')).toBe('');
  });

  it('round-trips the review form into an update with minor units', () => {
    const { header, lines } = rowsOf(receipt);
    expect(header).toMatchObject({ total: '28.71', tax: '1.75', currency: 'USD' });
    lines[0]!.categoryId = 'dairy';
    lines.push({
      rawText: 'BANANAS',
      expandedName: '',
      qty: '2',
      unitPrice: '0.81',
      lineTotal: '1.62',
      discount: '',
      taxable: false,
      categoryId: '',
      memberId: '',
    });
    const res = buildUpdate(receipt.version, header, lines);
    expect(res).toEqual({
      ok: true,
      input: {
        version: '3',
        merchant: 'Walmart',
        receiptDate: '2026-10-05',
        localTime: '14:32',
        currency: 'USD',
        tax: '175',
        taxIncluded: false,
        discount: '0',
        fees: '0',
        tip: '0',
        total: '2871',
        lines: [
          {
            id: 'l1',
            rawText: 'GV 2% MLK GAL',
            expandedName: 'Great Value 2% milk',
            qty: null,
            unitPrice: null,
            lineTotal: '348',
            discount: '0',
            taxable: false,
            categoryId: 'dairy',
            memberId: null,
          },
          {
            rawText: 'BANANAS',
            expandedName: null,
            qty: '2',
            unitPrice: '81',
            lineTotal: '162',
            discount: '0',
            taxable: false,
            categoryId: null,
            memberId: null,
          },
        ],
      },
    });
  });

  it('keeps quantity × unit price = total as one is edited (owner, 2026-11-18)', () => {
    const row = {
      rawText: 'APPLES',
      expandedName: '',
      qty: '3',
      unitPrice: '0.99',
      lineTotal: '',
      discount: '',
      taxable: true,
      categoryId: '',
      memberId: '',
    };
    // A quantity or unit price sets the total.
    expect(recalcLine(row, 'unitPrice', 'USD').lineTotal).toBe('2.97');
    expect(recalcLine({ ...row, qty: '0.452', unitPrice: '2.99' }, 'qty', 'USD').lineTotal).toBe('1.35');
    // A total sets the unit price when the quantity divides it exactly, else leaves it empty rather than guess.
    expect(recalcLine({ ...row, lineTotal: '4.50' }, 'lineTotal', 'USD').unitPrice).toBe('1.50');
    expect(recalcLine({ ...row, lineTotal: '10.00' }, 'lineTotal', 'USD').unitPrice).toBe('');
    // What can't be read yet stays as typed.
    expect(recalcLine({ ...row, qty: 'x' }, 'qty', 'USD')).toEqual({ ...row, qty: 'x' });
    // A quantity the API can't take is a field error.
    const res = buildUpdate('1', { ...rowsOf(receipt).header }, [{ ...row, qty: 'two', lineTotal: '1.00' }]);
    expect(res.ok ? null : res.errors).toEqual({ 'qty.0': 'Enter a quantity, such as 2 or 0.452.' });
  });

  it('reports bad fields by line', () => {
    const { header, lines } = rowsOf(receipt);
    lines[0]!.lineTotal = '3.4.8';
    lines[0]!.rawText = ' ';
    const res = buildUpdate('3', { ...header, total: '' }, lines);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(Object.keys(res.errors).sort()).toEqual(['lineTotal.0', 'rawText.0']);
    expect(buildUpdate('3', { ...header, currency: 'XX' }, lines)).toMatchObject({
      ok: false,
      errors: { currency: expect.any(String) },
    });
  });

  it('leaves "For" out for a new line on Automatic, and sends Household as null (owner, 2026-11-24)', () => {
    const { header, lines } = rowsOf(receipt);
    const auto = { ...newLine(), rawText: 'GUM', lineTotal: '1.00' };
    expect(auto.memberId).toBe(AUTOMATIC_MEMBER);
    const household = { ...auto, rawText: 'MINTS', memberId: '' };
    const res = buildUpdate('3', header, [...lines, auto, household]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sent = res.input.lines!;
    expect(sent[0]).toHaveProperty('memberId', null);
    expect(sent.find((l) => l.rawText === 'GUM')).not.toHaveProperty('memberId');
    expect(sent.find((l) => l.rawText === 'MINTS')).toHaveProperty('memberId', null);
  });
});

describe('splits while the review form is edited', () => {
  // The owner's case (2026-11-21): one line already Groceries, two picked as Groceries afterwards.
  const r: ReceiptDto = {
    ...receipt,
    subtotal: null,
    tax: '0',
    total: '1290',
    lines: [
      { ...receipt.lines[0]!, id: 'fries', rawText: 'FRIES', lineTotal: '726', categoryId: 'dining' },
      {
        ...receipt.lines[0]!,
        id: 'beans1',
        rawText: 'COFFEE',
        lineTotal: '282',
        categoryId: null,
        entityId: null,
      },
      {
        ...receipt.lines[0]!,
        id: 'beans2',
        rawText: 'COFFEE',
        lineTotal: '282',
        categoryId: null,
        entityId: null,
      },
    ],
  };
  const categories = [
    { id: 'groceries', entityId: 'e1' },
    { id: 'dining', entityId: 'e1' },
    { id: 'supplies', entityId: 'biz' },
  ];

  it('groups the lines as they would be saved', () => {
    const { header, lines } = rowsOf(r);
    expect(previewSplits(r, header, lines, categories)?.map((g) => [g.categoryId, g.total])).toEqual([
      ['dining', '726'],
      [null, '564'],
    ]);
    const picked = lines.map((l) => ({ ...l, categoryId: 'groceries' }));
    expect(previewSplits(r, header, picked, categories)).toEqual([
      { key: 'groceries|e1|', categoryId: 'groceries', entityId: 'e1', memberId: null, total: '1290' },
    ]);
  });

  it("takes the category's entity, and allocates tax", () => {
    const { header, lines } = rowsOf({ ...r, tax: '100', total: '1390' });
    const out = previewSplits(
      r,
      header,
      lines.map((l, i) => ({ ...l, categoryId: i === 0 ? 'supplies' : 'groceries', taxable: true })),
      categories,
    );
    expect(out?.map((g) => [g.entityId, g.total])).toEqual([
      ['biz', '782'],
      ['e1', '608'],
    ]);
  });

  it("gives up while an amount doesn't parse", () => {
    const { header, lines } = rowsOf(r);
    expect(
      previewSplits(r, header, [{ ...lines[0]!, lineTotal: '7.2.6' }, ...lines.slice(1)], categories),
    ).toBe(null);
  });
});

describe('receipts nothing is reading', () => {
  const since = '2026-11-09T10:00:00.000Z';
  const reading = (stalled: ReceiptDto['stalled'], status: ReceiptDto['status'] = 'processing') => ({
    status,
    stalled,
  });

  it('names each reason once, only for receipts still being read', () => {
    expect(stalledReasons([])).toEqual([]);
    expect(stalledReasons([reading(null)])).toEqual([]);
    expect(
      stalledReasons([
        reading({ worker: 'documents', reason: 'waiting', since }),
        reading({ worker: 'documents', reason: 'waiting', since }),
        reading({ worker: 'jobs', reason: 'failed', since }),
        reading({ worker: 'jobs', reason: 'waiting', since }, 'inbox'),
      ]),
    ).toEqual(['documents_waiting', 'jobs_failed']);
  });

  it('says which background workers aren’t picking up work', () => {
    expect(delayedWorkers({ workers: { documents: 'ok', jobs: 'ok' } })).toEqual([]);
    expect(delayedWorkers({ workers: { documents: 'delayed', jobs: 'ok' } })).toEqual(['documents']);
    expect(delayedWorkers({ workers: { documents: 'delayed', jobs: 'delayed' } })).toEqual([
      'documents',
      'jobs',
    ]);
  });
});
