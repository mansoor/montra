import { describe, expect, it } from 'vitest';
import type { IntakeDto, ScanDto } from '@montra/schemas';
import {
  afterResolve,
  autoFiledName,
  canFileHere,
  detail,
  fileable,
  pickOptions,
  whyItWaits,
} from '../src/features/intake-review';

// Statements and bills to file on the phone's Review (ADR-0051 §5).
const item = (over: Partial<IntakeDto> = {}): IntakeDto => ({
  id: 'i1',
  kind: 'statement',
  status: 'review',
  reason: 'several',
  fileName: 'scan.pdf',
  fileType: 'pdf',
  fileIds: ['f1'],
  detected: { last4: '1234', issuer: null, fileNamePattern: null, billerName: null },
  candidates: [
    { id: 'sav', name: 'Savings', last4: null, reason: 'learned' },
    { id: 'chk', name: 'Checking', last4: '1234', reason: 'last4' },
  ],
  targetId: null,
  targetName: null,
  automatic: false,
  learning: null,
  importBatchId: null,
  bill: null,
  filed: null,
  duplicateOf: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  resolvedAt: null,
  ...over,
});

const owner = { importFiles: true, record: true };
const member = { importFiles: false, record: true };
const viewer = { importFiles: false, record: false };

describe('the review item model', () => {
  it('shows each login only what it can finish', () => {
    const bill = item({ id: 'b', kind: 'bill' });
    const done = item({ id: 'd', status: 'done' });
    expect(fileable([item(), bill, done], owner).map((i) => i.id)).toEqual(['i1', 'b']);
    expect(fileable([item(), bill], member).map((i) => i.id)).toEqual(['b']);
    expect(fileable([item(), bill], viewer)).toEqual([]);
  });

  it('says why it waits', () => {
    expect(whyItWaits(item())).toEqual({ key: 'intakes.reason.several' });
    expect(whyItWaits(item({ status: 'suggested', reason: null, targetName: 'Checking' }))).toEqual({
      key: 'intakes.suggested',
      values: { name: 'Checking' },
    });
    expect(whyItWaits(item({ reason: null }))).toEqual({ key: 'intakes.reason.no_match' });
  });

  it('says what the file names', () => {
    expect(detail(item())).toEqual([
      { key: 'intakes.kind.statement' },
      { key: 'intakes.detected_last4', values: { last4: '1234' } },
    ]);
  });

  it('offers the candidates first, then the rest by name, without archived ones', () => {
    const opts = pickOptions(item(), [
      { id: 'chk', name: 'Checking' },
      { id: 'amex', name: 'Amex' },
      { id: 'sav', name: 'Savings' },
      { id: 'old', name: 'Old', archived: true },
    ]);
    expect(opts).toEqual([
      { id: 'sav', label: 'Savings', suggested: true },
      { id: 'chk', label: 'Checking', suggested: true },
      { id: 'amex', label: 'Amex', suggested: false },
    ]);
  });

  it('files a bill here only with its amount and due date', () => {
    const bill = (amount: string | null) =>
      item({
        kind: 'bill',
        bill: {
          amount,
          currency: 'USD',
          dueDate: '2026-12-01' as never,
          billDate: null,
          periodStart: null,
          periodEnd: null,
          memberId: null,
        },
      });
    expect(canFileHere(bill('4000'))).toBe(true);
    expect(canFileHere(bill(null))).toBe(false);
    expect(canFileHere(item())).toBe(true);
  });

  it('says what happened after resolving', () => {
    expect(afterResolve(item({ status: 'importing', targetName: 'Checking' }))).toEqual({
      key: 'mobile.intakes.importing',
      values: { name: 'Checking' },
      stays: false,
    });
    expect(afterResolve(item({ status: 'review', reason: 'duplicates' }))).toMatchObject({
      key: 'mobile.intakes.waiting_web',
      stays: true,
    });
    expect(afterResolve(item({ kind: 'bill', status: 'done', targetName: 'SDG&E' }))).toMatchObject({
      key: 'mobile.intakes.filed',
      values: { name: 'SDG&E' },
    });
  });

  it('names the provider of a bill filed automatically', () => {
    const scan = {
      status: 'used',
      bill: {
        billerName: 'XFINITY',
        billerId: 'cc',
        candidates: [{ billerId: 'cc', name: 'Comcast', categoryId: 'cat', reason: 'account' }],
        filed: { kind: 'household', id: 'h', entityId: 'e' },
      },
    } as unknown as ScanDto;
    expect(autoFiledName(scan)).toBe('Comcast');
    expect(autoFiledName({ ...scan, status: 'ready' })).toBeNull();
    expect(autoFiledName(null)).toBeNull();
  });
});
