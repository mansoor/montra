import { describe, expect, it } from 'vitest';
import type { TrashItemDto } from '@montra/api-client';
import { canDeleteForever, receiptsInTrash } from './trash';

const item = (over: Partial<TrashItemDto>): TrashItemDto => ({
  kind: 'transaction',
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Mistake',
  date: '2026-11-20' as TrashItemDto['date'],
  deletedAt: '2026-11-21T10:00:00.000Z',
  removal: 'trash',
  until: '2026-12-21' as TrashItemDto['until'],
  amount: '-4500',
  currency: 'USD',
  ...over,
});

// The Trash (BAK-06) and personal receipts (RCP-10, owner 2026-11-23).
describe('the Trash', () => {
  it('offers Delete forever only for what goes after 30 days', () => {
    expect(canDeleteForever(item({}))).toBe(true);
    expect(canDeleteForever(item({ kind: 'receipt', removal: 'trash' }))).toBe(true);
    for (const removal of ['retention', 'owner_approval', 'in_use'] as const)
      expect(canDeleteForever(item({ kind: 'receipt', removal })), removal).toBe(false);
  });

  it('lists only receipts on the Receipts screen', () => {
    const r = item({ kind: 'receipt', id: '00000000-0000-4000-8000-000000000002' });
    expect(receiptsInTrash([item({}), r, item({ kind: 'tax_form', date: null })])).toEqual([r]);
  });
});
