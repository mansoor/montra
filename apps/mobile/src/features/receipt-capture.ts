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
 * when), gave up, waiting for a connection, or uploaded and waiting for the person because it looks like a duplicate of
 * a file already in Montra (ADR-0054, 2026-11-18).
 */
export type QueuedStatus =
  | { kind: 'uploading' }
  | { kind: 'duplicate' }
  | { kind: 'retrying'; error: string; at: Date }
  | { kind: 'failed'; error: string }
  | { kind: 'offline' };

export function queuedStatus(
  item: Pick<QueuedReceipt, 'state' | 'error' | 'nextAttemptAt'>,
  online: boolean,
  now: Date,
): QueuedStatus {
  if (item.state === 'duplicate') return { kind: 'duplicate' };
  if (item.state === 'failed') return { kind: 'failed', error: item.error ?? '' };
  if (!online) return { kind: 'offline' };
  if (item.error && item.nextAttemptAt && new Date(item.nextAttemptAt) > now)
    return { kind: 'retrying', error: item.error, at: new Date(item.nextAttemptAt) };
  return { kind: 'uploading' };
}

/** The reminder amounts offered on the phone (minor units of the base currency), plus one set on the web. */
export function reminderChoices(current: string | null): Array<string | null> {
  const preset = ['1000', '2500', '5000'];
  const extra = current !== null && !preset.includes(current) ? [current] : [];
  return [null, ...[...preset, ...extra].sort((a, b) => Number(BigInt(a) - BigInt(b)))];
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

/**
 * The receipt's totals under its lines, as the web shows them (owner, 2026-11-18), so the lines visibly add up to
 * the total: the subtotal (Σ line totals less line discounts, unless the receipt printed one), then the order discount,
 * tax ("included" on a VAT-style receipt, where it isn't added), fees and tip when there are any, and the total.
 */
export function receiptTotals(
  r: Pick<ReceiptDto, 'subtotal' | 'discount' | 'tax' | 'taxIncluded' | 'fees' | 'tip' | 'total' | 'lines'>,
): Array<{ key: string; amount: string }> {
  const subtotal =
    r.subtotal ?? String(r.lines.reduce((t, l) => t + BigInt(l.lineTotal) - BigInt(l.discount), 0n));
  const out = [{ key: 'mobile.receipts.subtotal', amount: subtotal }];
  if (BigInt(r.discount) !== 0n) out.push({ key: 'receipts.discount', amount: String(-BigInt(r.discount)) });
  if (BigInt(r.tax) !== 0n || r.taxIncluded)
    out.push({ key: r.taxIncluded ? 'mobile.receipts.tax_included' : 'receipts.tax', amount: r.tax });
  if (BigInt(r.fees) !== 0n) out.push({ key: 'receipts.fees', amount: r.fees });
  if (BigInt(r.tip) !== 0n) out.push({ key: 'receipts.tip', amount: r.tip });
  if (r.total !== null) out.push({ key: 'receipts.total', amount: r.total });
  return out;
}

/** "2 × $0.81": a line's quantity and unit price, or null when either isn't known (owner, 2026-11-18). */
export function lineQuantityText(
  l: Pick<ReceiptDto['lines'][number], 'qty' | 'unitPrice'>,
  money: (minor: string) => string,
): string | null {
  return l.qty !== null && l.unitPrice !== null ? `${l.qty} × ${money(l.unitPrice)}` : null;
}

/** The lines still without a category (the phone's review stack walks through these). */
export const uncategorizedLines = (r: ReceiptDto) => r.lines.filter((l) => !l.categoryId);

const STALLED: Record<
  NonNullable<ReceiptDto['stalled']>['worker'],
  Record<NonNullable<ReceiptDto['stalled']>['reason'], string>
> = {
  documents: {
    waiting: 'mobile.receipts.stalled.documents_waiting',
    failed: 'mobile.receipts.stalled.documents_failed',
  },
  jobs: { waiting: 'mobile.receipts.stalled.jobs_waiting', failed: 'mobile.receipts.stalled.jobs_failed' },
};

/**
 * What to say about a receipt nothing is reading (no worker has picked up its job, or the job failed), as a
 * message key with the fix; null while it's being read normally or once it's read.
 */
export function stalledMessage(r: Pick<ReceiptDto, 'status' | 'stalled'>): string | null {
  return r.status === 'processing' && r.stalled ? STALLED[r.stalled.worker][r.stalled.reason] : null;
}

/** The status word for a receipt row: "Not being read" rather than "Reading" when nothing is reading it. */
export const receiptStatusKey = (r: Pick<ReceiptDto, 'status' | 'stalled'>) =>
  stalledMessage(r) ? 'mobile.receipts.status.stalled' : `mobile.receipts.status.${r.status}`;

/** A receipt the server is still reading: processing, and not stuck (a stuck one says so on its own row). */
export const beingRead = (r: Pick<ReceiptDto, 'status' | 'stalled'>) =>
  r.status === 'processing' && !r.stalled;

/**
 * The note after a capture (TXN-09): shown while the capture is still waiting to upload, or the server is still reading
 * a receipt; gone once it's read. `queued` is what the capture screen passed: `offline` or `uploading`.
 * `receipts` is null until the list has loaded.
 */
export function captureNotice(
  queued: string | undefined,
  waiting: number,
  receipts: ReadonlyArray<Pick<ReceiptDto, 'status' | 'stalled'>> | null,
): 'offline' | 'uploading' | null {
  if (!queued) return null;
  if (waiting > 0) return queued === 'offline' ? 'offline' : 'uploading';
  if (receipts === null || receipts.some(beingRead)) return 'uploading';
  return null;
}
