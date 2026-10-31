/** Swipe review stack (AI-04, 08 §3): right = accept the suggestion, left = choose a category. Pure model. */
import type { LocalTransaction } from '@montra/sync';

export type SwipeOutcome = 'accept' | 'edit' | 'cancel';

/** A swipe commits past 35% of the card width, or on a fast fling (> 800 px/s) in the same direction. */
export function swipeOutcome(dx: number, vx: number, width: number): SwipeOutcome {
  const far = Math.abs(dx) > width * 0.35;
  const fling = Math.abs(vx) > 800 && Math.sign(vx) === Math.sign(dx);
  if (!far && !fling) return 'cancel';
  return dx > 0 ? 'accept' : 'edit';
}

/** Accept needs a suggestion; without one a right swipe opens the picker instead. */
export const effectiveOutcome = (o: SwipeOutcome, t: LocalTransaction): SwipeOutcome =>
  o === 'accept' && !t.suggestedCategoryId ? 'edit' : o;

/** Items needing review, most confident suggestions first (fast wins), then newest. */
export function reviewQueue(rows: readonly LocalTransaction[]): LocalTransaction[] {
  return rows
    .filter((t) => t.reviewState === 'needs_review' && t.status !== 'void')
    .sort(
      (a, b) =>
        (b.confidence ?? -1) - (a.confidence ?? -1) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0),
    );
}

export const confidenceLabel = (c: number | null): string | null =>
  c === null ? null : `${Math.trunc(Math.min(1, Math.max(0, c)) * 100)}%`;
