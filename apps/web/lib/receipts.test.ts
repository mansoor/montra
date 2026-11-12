import { describe, expect, it } from 'vitest';
import type { ReceiptDto } from '@montra/api-client';
import { amountToInput, buildUpdate, receiptFileProblem, rowsOf, stalledReasons } from './receipts';
import { delayedWorkers } from './status';

const receipt: ReceiptDto = {
  id: 'r1',
  entityId: 'e1',
  status: 'needs_review',
  source: 'upload',
  fileIds: ['f1'],
  merchant: 'Walmart',
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
            lineTotal: '348',
            discount: '0',
            taxable: false,
            categoryId: 'dairy',
            memberId: null,
          },
          {
            rawText: 'BANANAS',
            expandedName: null,
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
