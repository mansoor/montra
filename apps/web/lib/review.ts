/**
 * Review queue model (AI-03/04, PLT-10): keyboard commands, confidence display and list updates. Kept free of
 * React so the shortcut map and the "accept all above X%" count can be unit-tested.
 */
import type { AccountDto, MakeTransferDto, MoneyDto, ReviewItemDto } from '@montra/schemas';

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

/** A suggested transfer (step 3): the other account, and its other side when that's already recorded. Accepting it
 * makes the transaction a transfer. */
export const proposedTransfer = (
  item: ReviewItemDto,
): { accountId: string; transactionId: string | null } | null =>
  item.categorization?.step === 'transfer' ? (item.categorization.transfer ?? null) : null;

/** Items "accept all ≥ X%" would accept, among those loaded (the API applies it to the whole queue). */
export function countAtOrAbove(items: readonly ReviewItemDto[], min: number): number {
  return items.filter(
    (i) => confidenceOf(i) >= min && (proposedCategoryId(i) !== null || proposedTransfer(i) !== null),
  ).length;
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

/**
 * The Review badge's number: transactions to review, tax forms to check and files to provide again (ADR-0054 §5a). A
 * count that failed to load (null) adds nothing; null when none loaded, so the badge stays hidden rather than showing a
 * wrong 0.
 */
export function reviewBadgeTotal(
  transactions: number | null,
  taxForms: number | null,
  missingFiles: number | null = null,
  feedImports: number | null = null,
): number | null {
  const parts = [transactions, taxForms, missingFiles, feedImports];
  if (parts.every((n) => n === null)) return null;
  return parts.reduce<number>((t, n) => t + (n ?? 0), 0);
}

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

type T = (key: string, values?: Record<string, string | number>) => string;

/** How "Make transfer…" groups the other accounts: cards first, then loans, bank accounts, everything else. */
export type TransferGroup = 'cards' | 'loans' | 'bank' | 'other';
const GROUP_ORDER: TransferGroup[] = ['cards', 'loans', 'bank', 'other'];

export interface TransferTarget {
  accountId: string;
  name: string;
  group: TransferGroup;
  /** Money out goes to the other account; money in comes from it. */
  direction: 'to' | 'from';
  /** A loan whose payments are tracked: the line becomes its scheduled payment when one matches. */
  trackedLoan: boolean;
}

const groupOf = (a: Pick<AccountDto, 'kind' | 'loanId'>): TransferGroup =>
  a.loanId || a.kind === 'loan' || a.kind === 'mortgage'
    ? 'loans'
    : a.kind === 'credit_card' || a.kind === 'line_of_credit'
      ? 'cards'
      : a.kind === 'checking' || a.kind === 'savings' || a.kind === 'cash'
        ? 'bank'
        : 'other';

/**
 * The accounts a plain transaction can be made a transfer to or from ("Make transfer…"): the person's other open
 * accounts in the same currency (between currencies the amount that arrived is needed, which this doesn't ask).
 */
export function transferTargets(
  accounts: readonly AccountDto[],
  line: { accountId: string | null; amount: MoneyDto | null },
): TransferTarget[] {
  if (!line.accountId || !line.amount) return [];
  const direction = line.amount.amount.startsWith('-') ? 'to' : 'from';
  return accounts
    .filter((a) => !a.archived && a.id !== line.accountId && a.currency === line.amount!.currency)
    .map((a): TransferTarget => ({
      accountId: a.id,
      name: a.name,
      group: groupOf(a),
      direction,
      trackedLoan: a.loanId !== null,
    }))
    .sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.name.localeCompare(b.name),
    );
}

/** Picker options for `transferTargets`, in words: "Transfer to Chase Sapphire", grouped as Cards, Loans… */
export const transferOptions = (targets: readonly TransferTarget[], t: T) =>
  targets.map((x) => ({
    id: x.accountId,
    label: t(x.direction === 'to' ? 'review.transfer_to' : 'review.transfer_from', { account: x.name }),
    group: t(`review.transfer_group.${x.group}`),
  }));

/** What "Make transfer…" did, in words: a transfer, a loan's scheduled payment, or a transfer because none matched. */
export function madeTransferMessage(
  result: Pick<MakeTransferDto, 'absorbedId' | 'loan'>,
  account: string,
  t: T,
): string {
  if (result.loan?.number != null)
    return t('review.made_loan_payment', { loan: result.loan.name, number: result.loan.number });
  if (result.loan) return t('review.made_transfer_no_loan_payment', { loan: result.loan.name });
  return t(result.absorbedId ? 'review.made_transfer_matched' : 'review.made_transfer', { account });
}
