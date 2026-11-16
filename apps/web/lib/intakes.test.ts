import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import type { IntakeDto } from '@montra/schemas';
import {
  billNeedsInput,
  canFile,
  detectedLines,
  initialTarget,
  isSettled,
  isWorking,
  targetOptions,
  waitingImport,
} from './intakes';

const intake = (over: Partial<IntakeDto> = {}): IntakeDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'statement',
  status: 'suggested',
  reason: null,
  fileName: 'Chase1234_Activity.csv',
  fileType: 'csv',
  fileIds: ['00000000-0000-4000-8000-000000000002'],
  detected: { last4: '1234', issuer: null, fileNamePattern: 'chase#_activity', billerName: null },
  candidates: [{ id: 'chk', name: 'Checking', last4: '1234', reason: 'last4' }],
  targetId: 'chk',
  targetName: 'Checking',
  automatic: false,
  learning: { confirmations: 1, needed: 3 },
  importBatchId: null,
  bill: null,
  filed: null,
  duplicateOf: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  resolvedAt: null,
  ...over,
});

const accounts = [
  { id: 'sav', name: 'Savings' },
  { id: 'chk', name: 'Checking' },
  { id: 'amex', name: 'Amex' },
  { id: 'old', name: 'Old card', archived: true },
];

describe('statements and bills to file (ADR-0051)', () => {
  it('lists the candidates first with why, then the rest by name', () => {
    const opts = targetOptions(intake(), accounts);
    expect(opts.map((o) => o.id)).toEqual(['chk', 'amex', 'sav']);
    expect(opts[0]!.hint).toEqual({ key: 'intakes.candidate.last4', values: { last4: '1234' } });
    expect(opts[1]!.hint).toBeNull();
  });

  it('leaves out archived accounts and candidates it does not know', () => {
    const opts = targetOptions(
      intake({
        candidates: [
          { id: 'old', name: 'Old card', last4: null, reason: 'learned' },
          { id: 'gone', name: 'Gone', last4: null, reason: 'recent' },
          { id: 'sav', name: 'Savings', last4: null, reason: 'profile' },
        ],
      }),
      accounts,
    );
    expect(opts.map((o) => o.id)).toEqual(['sav', 'amex', 'chk']);
    expect(opts[0]!.hint).toEqual({ key: 'intakes.candidate.profile' });
  });

  it('starts on the suggestion, else the first candidate', () => {
    expect(initialTarget(intake())).toBe('chk');
    expect(initialTarget(intake({ targetId: null }))).toBe('chk');
    expect(initialTarget(intake({ targetId: null, candidates: [] }))).toBe('');
  });

  it('lets only those who import files finish a statement, and members file bills', () => {
    expect(canFile('accountant', 'statement')).toBe(true);
    expect(canFile('member', 'statement')).toBe(false);
    expect(canFile('member', 'bill')).toBe(true);
    expect(canFile('viewer', 'bill')).toBe(false);
    expect(canFile(undefined, 'bill')).toBe(false);
  });

  it('opens the import when it waits for a decision', () => {
    expect(waitingImport(intake({ importBatchId: 'b1', reason: 'duplicates' }))).toBe('b1');
    expect(waitingImport(intake({ importBatchId: 'b1', reason: 'undone' }))).toBeNull();
    expect(waitingImport(intake({ importBatchId: null, reason: 'duplicates' }))).toBeNull();
  });

  it('says what the file names', () => {
    expect(detectedLines(intake())).toEqual([{ key: 'intakes.detected_last4', values: { last4: '1234' } }]);
    expect(
      detectedLines(
        intake({ detected: { last4: null, issuer: 'Chase', fileNamePattern: null, billerName: 'SDG&E' } }),
      ),
    ).toEqual([
      { key: 'intakes.detected_issuer', values: { issuer: 'Chase' } },
      { key: 'intakes.detected_biller', values: { name: 'SDG&E' } },
    ]);
  });

  it('asks for what a bill is missing', () => {
    const bill = intake({
      kind: 'bill',
      bill: {
        amount: null,
        currency: 'USD',
        dueDate: calendarDate('2026-12-01'),
        billDate: null,
        periodStart: null,
        periodEnd: null,
        memberId: null,
      },
    });
    expect(billNeedsInput(bill)).toEqual({ amount: true, dueDate: false });
    expect(billNeedsInput(intake())).toEqual({ amount: false, dueDate: false });
  });

  it('knows when to stop polling', () => {
    expect(isWorking(intake({ status: 'reading' }))).toBe(true);
    expect(isWorking(intake({ status: 'importing' }))).toBe(true);
    expect(isSettled(intake({ status: 'done' }))).toBe(true);
    expect(isSettled(intake({ status: 'review' }))).toBe(false);
  });
});
