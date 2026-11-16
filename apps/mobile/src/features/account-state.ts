/**
 * When the server won't open the account or the workspace (ADR-0049 §4, BAK-09), as the web's `/account-closed` and
 * `/account-deleting` pages say it:
 * - `suspended`: Montra support suspended this person (`account.suspended`).
 * - `workspace`: the workspace's owner is suspended, so it's closed to every member (`workspace.suspended`).
 * - `deleting`: the account is being deleted, at its own request or support's (`account.deleting`), and can be kept.
 * Nothing is deleted by any of them, and none goes away by trying again, so the phone stops asking (the sync engine's
 * `closed` event) until the person does something.
 */
import { CLOSED_CODES } from '@montra/sync';

export type ClosedKind = 'suspended' | 'workspace' | 'deleting';

export interface Closed {
  kind: ClosedKind;
  /** The server's sentence, which names the support address when one is set. */
  message: string;
}

const KIND_OF: Record<string, ClosedKind> = {
  'account.suspended': 'suspended',
  'workspace.suspended': 'workspace',
  'account.deleting': 'deleting',
};

/** The refusal behind an API or sync failure (anything with `status` and `code`), or null for any other failure. */
export function closedFrom(err: unknown): Closed | null {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || e.status !== 403 || typeof e.code !== 'string' || !CLOSED_CODES.has(e.code)) return null;
  return closedOf(e.code, typeof e.message === 'string' ? e.message : '');
}

/** From a refusal's code, as the sync engine reports it. Null for a code that isn't one of these. */
export function closedOf(code: string, message = ''): Closed | null {
  const kind = KIND_OF[code];
  return kind ? { kind, message } : null;
}

/**
 * A whole-account refusal outranks a workspace one: another workspace won't open either. Otherwise the first one
 * stays, so the screen doesn't change under the person's finger.
 */
export function strongerClosed(current: Closed | null, next: Closed): Closed {
  if (!current) return next;
  return current.kind === 'workspace' && next.kind !== 'workspace' ? next : current;
}

/** The support address in the server's sentence ("Contact support at help@example.test."), if it names one. */
export function supportAddress(message: string): string | null {
  const m = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/i.exec(message);
  return m ? m[0].replace(/\.+$/, '') : null;
}

/** Workspaces still worth offering: with the account itself fine, any other one may open. */
export function otherWorkspaces<W extends { id: string }>(
  closed: Closed | null,
  workspaces: readonly W[],
  currentId: string | null,
): W[] {
  if (closed?.kind !== 'workspace') return [];
  return workspaces.filter((w) => w.id !== currentId);
}

/** The title and body keys, the same strings the web's pages use. */
export function closedCopy(kind: ClosedKind): { title: string; body: string } {
  if (kind === 'deleting') return { title: 'account_deleting.title', body: 'account_deleting.hint' };
  if (kind === 'workspace') return { title: 'closed.workspace_title', body: 'closed.workspace_body' };
  return { title: 'closed.account_title', body: 'closed.account_body' };
}
