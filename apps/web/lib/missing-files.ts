/**
 * Review → "Files to provide again" (ADR-0054 §5a): files Montra no longer holds that the household's Family Document
 * Vault didn't give back. What each was, in words a person recognises, and what to say once one is uploaded again.
 */
import type { ExportJobDto, FileProvidedAgainDto, MissingFileDto } from '@montra/api-client';

/** "Receipt: Grocer · 2026-03-14", one per record that uses the file; the file's group when nothing uses it. */
export function missingFileUses(
  f: Pick<MissingFileDto, 'usedBy' | 'group'>,
): { key: string; label: string | null }[] {
  if (f.usedBy.length)
    return f.usedBy.map((u) => ({ key: `missing_files.used_by.${u.kind}`, label: u.label || null }));
  return f.group ? [{ key: `vault.group.${f.group}`, label: null }] : [];
}

/** What to say once a file is provided again: kept, and whether it is the same file, and whether it goes back. */
export function providedAgainKey(r: Pick<FileProvidedAgainDto, 'hashChanged' | 'queuedForVault'>): string {
  if (r.hashChanged)
    return r.queuedForVault ? 'missing_files.done_changed_sent' : 'missing_files.done_changed';
  return r.queuedForVault ? 'missing_files.done_sent' : 'missing_files.done';
}

/** The file chooser's types: what the vault keeps and an upload of a paper may be. */
export const MISSING_FILE_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';

export const MISSING_FILE_USES = [
  'receipt',
  'statement',
  'payslip',
  'tax_form',
  'bill',
  'lease',
  'document',
] as const satisfies readonly MissingFileDto['usedBy'][number]['kind'][];

/**
 * The owner's clarification (2026-11-18): an upload whose bytes are a file Montra already holds, in Montra or in the
 * vault, is a possible duplicate. The API says so (409 `file.possible_duplicate`, with the other file's name in words
 * when the person may know it); the person cancels or uploads anyway. Null for any other answer.
 */
export function possibleDuplicate(err: unknown): string | null {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || e.status !== 409 || e.code !== 'file.possible_duplicate') return null;
  return typeof e.message === 'string' ? e.message : '';
}

/**
 * The same check made at an upload of a receipt, payslip or bill (`duplicateOf` on its answer): whether any of these
 * uploads repeats a file Montra already holds, so the person is asked before it is used.
 */
export function anyDuplicate(uploads: readonly { duplicateOf: unknown }[]): boolean {
  return uploads.some((u) => u.duplicateOf !== null && u.duplicateOf !== undefined);
}

/**
 * ADR-0054 §5a: an archive's screen says how many files it couldn't include, with a link to "Files to provide again".
 * Only for one that is made: one still waiting for the vault's daily reset hasn't left anything out yet.
 */
export function exportMissing(j: Pick<ExportJobDto, 'status' | 'missingFiles'>): boolean {
  return j.status === 'ready' && j.missingFiles > 0;
}
