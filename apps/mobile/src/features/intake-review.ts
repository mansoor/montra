/**
 * Statements and bills to file, on the phone's Review (ADR-0051 §5). Pure: which items this login can finish, what
 * to say about each, the accounts or providers to pick from, and what to say once it's done. The items are read and
 * resolved online, like scans; nothing here is synced.
 */
import type { IntakeDto, ScanDto } from '@montra/schemas';
import type { Abilities } from './roles';

export interface PickOption {
  id: string;
  label: string;
  /** Why it's offered: a candidate the server found, or the rest of the list. */
  suggested: boolean;
}

export interface Message {
  key: string;
  values?: Record<string, string | number>;
}

/** The items this login can finish: statements need statement imports, bills need recording (AUTH-18). */
export function fileable(
  items: readonly IntakeDto[],
  can: Pick<Abilities, 'importFiles' | 'record'>,
): IntakeDto[] {
  return items.filter(
    (i) =>
      (i.status === 'suggested' || i.status === 'review') &&
      (i.kind === 'statement' ? can.importFiles : can.record),
  );
}

/** Why it waits: the suggestion to confirm, or the reason it needs a person. */
export function whyItWaits(i: Pick<IntakeDto, 'status' | 'targetName' | 'reason'>): Message {
  if (i.status === 'suggested' && i.targetName)
    return { key: 'intakes.suggested', values: { name: i.targetName } };
  return { key: `intakes.reason.${i.reason ?? 'no_match'}` };
}

/** What the file says about itself, for the card's subtitle. */
export function detail(i: Pick<IntakeDto, 'detected' | 'kind'>): Message[] {
  const d = i.detected;
  return [
    { key: i.kind === 'statement' ? 'intakes.kind.statement' : 'intakes.kind.bill' },
    ...(d.last4 ? [{ key: 'intakes.detected_last4', values: { last4: d.last4 } }] : []),
    ...(d.issuer ? [{ key: 'intakes.detected_issuer', values: { issuer: d.issuer } }] : []),
    ...(d.billerName ? [{ key: 'intakes.detected_biller', values: { name: d.billerName } }] : []),
  ];
}

/** The accounts or providers to pick from: the candidates first, then the rest by name; archived ones left out. */
export function pickOptions(
  i: Pick<IntakeDto, 'candidates'>,
  all: readonly { id: string; name: string; archived?: boolean }[],
): PickOption[] {
  const open = new Map(all.filter((a) => !a.archived).map((a) => [a.id, a.name]));
  const first = i.candidates
    .filter((c) => open.has(c.id))
    .map((c) => ({ id: c.id, label: open.get(c.id)!, suggested: true }));
  const seen = new Set(first.map((o) => o.id));
  const rest = [...open]
    .filter(([id]) => !seen.has(id))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, label]) => ({ id, label, suggested: false }));
  return [...first, ...rest];
}

/** A bill can be filed from the phone's Review only with its amount and due date read. */
export const canFileHere = (i: Pick<IntakeDto, 'kind' | 'bill'>): boolean =>
  i.kind === 'statement' || (!!i.bill?.amount && !!i.bill.dueDate);

/**
 * What to say once it's resolved. The phone confirms statements with `commitIfClean`: a clean import is committed;
 * one with something to decide waits in its preview for the web.
 */
export function afterResolve(done: IntakeDto): Message & { stays: boolean } {
  const name = done.targetName ?? '';
  if (done.kind === 'bill') return { key: 'mobile.intakes.filed', values: { name }, stays: false };
  if (done.status === 'review') return { key: 'mobile.intakes.waiting_web', stays: true };
  // The import is checked in the worker: it's committed if clean, else it comes back to Review.
  if (done.status === 'importing') return { key: 'mobile.intakes.importing', values: { name }, stays: false };
  return { key: 'mobile.intakes.imported', values: { name }, stays: false };
}

/** A bill scan filed automatically (ADR-0051 §4): the provider's name for the message, or null. */
export function autoFiledName(scan: Pick<ScanDto, 'status' | 'bill'> | null): string | null {
  const b = scan?.bill;
  if (scan?.status !== 'used' || !b?.filed) return null;
  return b.candidates.find((c) => c.billerId === b.billerId)?.name ?? b.billerName ?? '';
}
