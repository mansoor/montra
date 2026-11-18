/**
 * Review → "Files to provide again" (ADR-0054 §5a): files Montra no longer holds that the household's Family Document
 * Vault didn't give back. What each was, in words a person recognises, and what to say once one is uploaded again.
 */
import type { FileProvidedAgainDto, MissingFileDto } from '@montra/api-client';

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
