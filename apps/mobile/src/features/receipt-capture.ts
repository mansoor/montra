/**
 * Receipt capture on the phone (TXN-08/09): the per-frame verdict shown after each shot, how upload errors are
 * treated by the offline queue, and the review edits. Pure, so it runs in tests.
 */
import type { ErrorKind, QueuedReceipt } from '@montra/sync';
import type { ReceiptDto } from '@montra/schemas';
import { ApiError, type ReceiptReviewInput } from '../api/client';
import type { FrameQuality } from './camera-metrics';

export type FrameVerdict = 'ok' | 'blurry' | 'glare';

/** Blur first: a blurry frame can't be read even without glare (thresholds from the camera spike). */
export function frameVerdict(q: FrameQuality): FrameVerdict {
  if (!q.sharp) return 'blurry';
  if (!q.glareOk) return 'glare';
  return 'ok';
}

/** No network → wait; server trouble or throttling → retry later; anything the server rejected → show it. */
export function classifyUploadError(err: unknown, online = false): ErrorKind {
  if (err instanceof ApiError) {
    // With a connection, "couldn't reach the server" is a failure to show and retry, not a reason to wait quietly.
    if (err.offline) return online ? 'retry' : 'offline';
    if (err.status >= 500 || err.status === 429 || err.status === 408) return 'retry';
    return 'permanent';
  }
  return 'retry';
}

/**
 * What a capture waiting on the phone is doing: uploading now, waiting to retry after an error (with the error and
 * when), gave up, or waiting for a connection.
 */
export type QueuedStatus =
  | { kind: 'uploading' }
  | { kind: 'retrying'; error: string; at: Date }
  | { kind: 'failed'; error: string }
  | { kind: 'offline' };

export function queuedStatus(
  item: Pick<QueuedReceipt, 'state' | 'error' | 'nextAttemptAt'>,
  online: boolean,
  now: Date,
): QueuedStatus {
  if (item.state === 'failed') return { kind: 'failed', error: item.error ?? '' };
  if (!online) return { kind: 'offline' };
  if (item.error && item.nextAttemptAt && new Date(item.nextAttemptAt) > now)
    return { kind: 'retrying', error: item.error, at: new Date(item.nextAttemptAt) };
  return { kind: 'uploading' };
}

/** File name for page `n` (1-based) of a capture. */
export const pageName = (n: number) => `page-${String(n).padStart(2, '0')}.jpg`;

/** The PATCH for changing line categories on the phone; amounts and texts are sent back unchanged. */
export function reviewEdits(
  r: ReceiptDto,
  categories: ReadonlyMap<string, string | null>,
): ReceiptReviewInput {
  return {
    version: r.version,
    lines: r.lines.map((l) => ({
      id: l.id,
      rawText: l.rawText,
      expandedName: l.expandedName,
      lineTotal: l.lineTotal,
      discount: l.discount,
      taxable: l.taxable,
      categoryId: categories.has(l.id) ? categories.get(l.id)! : l.categoryId,
      memberId: l.memberId,
    })),
  };
}

/** The lines still without a category (the phone's review stack walks through these). */
export const uncategorizedLines = (r: ReceiptDto) => r.lines.filter((l) => !l.categoryId);
