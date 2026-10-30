/**
 * Review queue model (AI-03/04, PLT-10): keyboard commands, confidence display and list updates. Kept free of
 * React so the shortcut map and the "accept all above X%" count can be unit-tested.
 */
import type { ReviewItemDto } from '@montra/schemas';

export type ReviewCommand =
  'next' | 'prev' | 'accept' | 'category' | 'member' | 'select' | 'acceptAbove' | 'help' | 'close';

export interface KeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The event came from a text field, select or other editable element. */
  editable?: boolean;
}

/** The queue's shortcut for a key press, or null. Modifier chords and typing in fields are left alone. */
export function reviewCommand(e: KeyInput): ReviewCommand | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape') return 'close';
  if (e.editable) return null;
  if (e.key === 'A' && e.shiftKey) return 'acceptAbove';
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      return 'next';
    case 'k':
    case 'ArrowUp':
      return 'prev';
    case 'a':
    case 'Enter':
      return 'accept';
    case 'c':
      return 'category';
    case 'm':
      return 'member';
    case 'x':
    case ' ':
      return 'select';
    case '?':
      return 'help';
    default:
      return null;
  }
}

/** The shortcut list shown by `?` (keys and i18n label keys). */
export const SHORTCUTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: 'j / ↓', label: 'review.shortcut.next' },
  { keys: 'k / ↑', label: 'review.shortcut.prev' },
  { keys: 'a / Enter', label: 'review.shortcut.accept' },
  { keys: 'c', label: 'review.shortcut.category' },
  { keys: 'm', label: 'review.shortcut.member' },
  { keys: 'x', label: 'review.shortcut.select' },
  { keys: 'Shift + A', label: 'review.shortcut.accept_above' },
  { keys: 'g r', label: 'review.shortcut.go_review' },
  { keys: '?', label: 'review.shortcut.help' },
  { keys: 'Esc', label: 'review.shortcut.close' },
];

/** Whole-percent confidence for chips ("87%"). */
/** Nearest whole number for display (scores and percentages, never money). */
export const whole = (x: number) => Math.floor(x + 0.5);

export const percent = (confidence: number) => whole(Math.max(0, Math.min(1, confidence)) * 100);

export type ConfidenceTone = 'good' | 'warn' | 'bad';
export function confidenceTone(confidence: number, threshold: number): ConfidenceTone {
  if (confidence >= threshold) return 'good';
  return confidence >= 0.5 ? 'warn' : 'bad';
}

export const confidenceOf = (item: ReviewItemDto) => item.categorization?.confidence ?? 0;

/** The category the pipeline proposes for an item (falls back to the posted one). */
export const suggestedCategoryId = (item: ReviewItemDto): string | null =>
  item.categorization?.suggested?.categoryId ?? item.categoryId;

export const suggestedMemberId = (item: ReviewItemDto): string | null =>
  item.categorization?.suggested?.memberId ?? item.memberId;

/** The pipeline's proposal only (no fallback to the posted, usually uncategorized, account). */
export const proposedCategoryId = (item: ReviewItemDto): string | null =>
  item.categorization?.suggested?.categoryId ?? null;

/** Items "accept all ≥ X%" would accept, among those loaded (the API applies it to the whole queue). */
export function countAtOrAbove(items: readonly ReviewItemDto[], min: number): number {
  return items.filter((i) => confidenceOf(i) >= min && proposedCategoryId(i) !== null).length;
}

/** Removes handled items and keeps the cursor on the item that took the current one's place. */
export function removeItems(
  items: readonly ReviewItemDto[],
  ids: ReadonlySet<string>,
  cursor: number,
): { items: ReviewItemDto[]; cursor: number } {
  const removedBefore = items.slice(0, cursor).filter((i) => ids.has(i.transactionId)).length;
  const next = items.filter((i) => !ids.has(i.transactionId));
  return { items: next, cursor: Math.max(0, Math.min(cursor - removedBefore, next.length - 1)) };
}

export const clampCursor = (cursor: number, length: number) =>
  length === 0 ? 0 : Math.max(0, Math.min(cursor, length - 1));

/**
 * Two-key "go to" sequences (`g r`): returns the target for the second key when it follows `g` within 1.5 s.
 * `state` is the previous key and its time; callers keep it between key presses.
 */
export const GO_TARGETS: Record<string, string> = {
  r: 'review',
  t: 'transactions',
  i: 'insights',
  u: 'rules',
};

export function goSequence(
  state: { key: string; at: number } | null,
  key: string,
  now: number,
): { target: string | null; state: { key: string; at: number } | null } {
  if (state?.key === 'g' && now - state.at <= 1500) {
    const target = GO_TARGETS[key] ?? null;
    return { target, state: null };
  }
  return { target: null, state: key === 'g' ? { key, at: now } : null };
}

/** True when a keyboard event's target is a field the user is typing in. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}
