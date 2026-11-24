/** The Trash (BAK-06): pure helpers for its lists. */
import type { TrashItemDto } from '@montra/api-client';

/**
 * Whether "Delete forever" is offered: only for what would go after 30 days anyway (transactions, tax forms, personal
 * receipts). A business or rental receipt is a tax record: it keeps its retention date and the owner's approval.
 */
export const canDeleteForever = (item: Pick<TrashItemDto, 'removal'>): boolean => item.removal === 'trash';

/** The Receipts screen's Trash: deleted receipts only. */
export const receiptsInTrash = (items: readonly TrashItemDto[]): TrashItemDto[] =>
  items.filter((i) => i.kind === 'receipt');
