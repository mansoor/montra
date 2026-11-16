/**
 * Statements and bills to file (ADR-0051): what the web shows for an intake, and the choices it offers. Pure, so the
 * Statements screen and Review share it.
 */
import type { IntakeCandidateDto, IntakeDto } from '@montra/schemas';

export interface TargetOption {
  id: string;
  label: string;
  /** Why it's offered, as a message key and its values; null for the rest of the list. */
  hint: { key: string; values?: Record<string, string> } | null;
}

/** Who may finish an intake: statements by those who import files, bills also by members (AUTH-18). */
export function canFile(role: string | undefined, kind: IntakeDto['kind']): boolean {
  const statement = ['owner', 'admin', 'partner', 'accountant'];
  return !!role && (kind === 'statement' ? statement : [...statement, 'member']).includes(role);
}

/** Why a candidate is offered. */
export function candidateHint(c: IntakeCandidateDto): TargetOption['hint'] {
  if (c.reason === 'last4' && c.last4) return { key: 'intakes.candidate.last4', values: { last4: c.last4 } };
  return { key: `intakes.candidate.${c.reason}` };
}

/**
 * The accounts or billers to pick from: the candidates first, in the order found, then every other one by name.
 * Archived ones are left out.
 */
export function targetOptions(
  intake: Pick<IntakeDto, 'candidates'>,
  all: readonly { id: string; name: string; archived?: boolean }[],
): TargetOption[] {
  const known = new Map(all.filter((a) => !a.archived).map((a) => [a.id, a.name]));
  const first = intake.candidates
    .filter((c) => known.has(c.id))
    .map((c) => ({ id: c.id, label: known.get(c.id)!, hint: candidateHint(c) }));
  const taken = new Set(first.map((o) => o.id));
  const rest = [...known]
    .filter(([id]) => !taken.has(id))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, label]) => ({ id, label, hint: null }));
  return [...first, ...rest];
}

/** The account or biller to start the picker on: the suggestion, else the first candidate, else nothing. */
export function initialTarget(intake: Pick<IntakeDto, 'targetId' | 'candidates'>): string {
  return intake.targetId ?? intake.candidates[0]?.id ?? '';
}

/** What the file says about itself, as message keys: digits, issuer, provider. */
export function detectedLines(
  intake: Pick<IntakeDto, 'detected'>,
): { key: string; values: Record<string, string> }[] {
  const d = intake.detected;
  return [
    ...(d.last4 ? [{ key: 'intakes.detected_last4', values: { last4: d.last4 } }] : []),
    ...(d.issuer ? [{ key: 'intakes.detected_issuer', values: { issuer: d.issuer } }] : []),
    ...(d.billerName ? [{ key: 'intakes.detected_biller', values: { name: d.billerName } }] : []),
  ];
}

/** Reasons that come from an import waiting in preview: it can be opened and finished there. */
const IMPORT_REASONS = new Set(['needs_mapping', 'duplicates', 'errors', 'balance', 'nothing_new']);

/** The import to open for an intake whose import is waiting for a decision. */
export function waitingImport(intake: Pick<IntakeDto, 'importBatchId' | 'reason'>): string | null {
  return intake.importBatchId && intake.reason && IMPORT_REASONS.has(intake.reason)
    ? intake.importBatchId
    : null;
}

/** Whether the person must type the amount or due date of a bill before filing it. */
export function billNeedsInput(intake: Pick<IntakeDto, 'kind' | 'bill'>): {
  amount: boolean;
  dueDate: boolean;
} {
  if (intake.kind !== 'bill') return { amount: false, dueDate: false };
  return { amount: !intake.bill?.amount, dueDate: !intake.bill?.dueDate };
}

/** An intake is settled for the screen once it's imported, filed or put aside. */
export const isSettled = (i: Pick<IntakeDto, 'status'>) => i.status === 'done' || i.status === 'dismissed';

/** Still being read or imported: the screen polls it. */
export const isWorking = (i: Pick<IntakeDto, 'status'>) => i.status === 'reading' || i.status === 'importing';
