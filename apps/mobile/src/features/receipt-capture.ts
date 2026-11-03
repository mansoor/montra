/**
 * Receipt capture on the phone (TXN-08/09): the per-frame verdict shown after each shot, how upload errors are
 * treated by the offline queue, and the review edits. Pure, so it runs in tests.
 */
import type { ErrorKind } from '@montra/sync';
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
export function classifyUploadError(err: unknown): ErrorKind {
  if (err instanceof ApiError) {
    if (err.offline) return 'offline';
    if (err.status >= 500 || err.status === 429 || err.status === 408) return 'retry';
    return 'permanent';
  }
  return 'retry';
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
