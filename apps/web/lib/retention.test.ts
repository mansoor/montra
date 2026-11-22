import { describe, expect, it } from 'vitest';
import type { RetentionItemDto } from '@montra/api-client';
import { retentionKey, retentionRefs, waitingItems } from './retention';

const item = (kind: 'receipt' | 'file', id: string, approvedAt: string | null = null): RetentionItemDto => ({
  kind,
  id,
  retainUntil: '2020-01-01' as RetentionItemDto['retainUntil'],
  title: id,
  fileKind: kind === 'file' ? 'invoice' : null,
  date: null,
  amount: null,
  currency: null,
  transaction: null,
  approvedAt,
});

describe('the retention review (RCP-10)', () => {
  const items = [item('receipt', 'r1'), item('file', 'f1'), item('receipt', 'r2', '2026-11-22T10:00:00Z')];

  it('acts on exactly the waiting items listed, leaving approved ones alone', () => {
    expect(waitingItems(items).map((i) => i.id)).toEqual(['r1', 'f1']);
    expect(retentionRefs(items)).toEqual([
      { kind: 'receipt', id: 'r1' },
      { kind: 'file', id: 'f1' },
    ]);
  });

  it('keeps only the selected ones for longer', () => {
    const selected = new Set([retentionKey(items[1]!), retentionKey(items[2]!)]);
    expect(retentionRefs(items, selected)).toEqual([{ kind: 'file', id: 'f1' }]);
  });
});
