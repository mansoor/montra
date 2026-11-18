/**
 * Files to provide again on the phone (ADR-0054 §5a, VLT-10): files Montra no longer keeps a copy of that the
 * household's Family Document Vault didn't give back. Review lists them with an Upload action; their count joins the
 * Review badge. Read online, never kept in the offline store. The server decides who sees which: owners and admins all
 * of them, anyone else the ones they uploaded, a viewer none.
 */
import type { FileProvidedAgainDto, MemberRole, MissingFileDto } from '@montra/schemas';
import { TaxFormsToCheck, type Message } from './tax-forms';

/** Viewers provide nothing, and see no list. */
export const showsMissingFiles = (role: MemberRole): boolean => role !== 'viewer';

/** What the vault keeps and an upload of a paper may be: the types the picker offers. */
export const MISSING_FILE_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

/** The second line of an entry: what uses the file ("Receipt: Grocer · 2026-03-14"), else its group. */
export function missingFileUses(
  f: Pick<MissingFileDto, 'usedBy' | 'group'>,
): { key: string; label: string | null }[] {
  if (f.usedBy.length)
    return f.usedBy.map((u) => ({ key: `missing_files.used_by.${u.kind}`, label: u.label || null }));
  return f.group ? [{ key: `vault.group.${f.group}`, label: null }] : [];
}

/** What to say once a file is provided again (the same words as the web). */
export function providedAgainMessage(
  r: Pick<FileProvidedAgainDto, 'hashChanged' | 'queuedForVault'>,
  name: string,
): Message {
  const key = r.hashChanged
    ? r.queuedForVault
      ? 'missing_files.done_changed_sent'
      : 'missing_files.done_changed'
    : r.queuedForVault
      ? 'missing_files.done_sent'
      : 'missing_files.done';
  return { key, values: { name } };
}

/**
 * The owner's clarification (2026-11-18): the API's possible-duplicate warning (409 `file.possible_duplicate`), with its
 * words, when a file provided again is the bytes of a file Montra already holds. The person cancels or uploads anyway.
 * Null for any other answer.
 */
export function possibleDuplicate(err: unknown): string | null {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || e.status !== 409 || e.code !== 'file.possible_duplicate') return null;
  return typeof e.message === 'string' ? e.message : '';
}

/**
 * The count behind the Review badge, as tax forms': read when sync runs, at most once a minute, at once after an
 * upload; a failed read (offline) keeps the last count. One per workspace and login.
 */
const counters = new Map<string, TaxFormsToCheck>();

export function missingFilesFor(key: string): TaxFormsToCheck {
  let c = counters.get(key);
  if (!c) counters.set(key, (c = new TaxFormsToCheck()));
  return c;
}
