/**
 * A possible duplicate (ADR-0054, the owner's clarification of 2026-11-18): a paper uploaded again whose bytes are the
 * same as a file the workspace already holds, in Montra or only in the vault. Montra keeps each file's hash wherever its
 * bytes are, so one lookup covers both. A missing file (§5a) isn't held anywhere and isn't a duplicate: it is the one to
 * provide again. This is the check receipts and statements already made at upload; payslips, bills and "Files to provide
 * again" use it too, and the person decides (cancel, or upload anyway).
 */
import type { Trx } from '@montra/db';
import type { StorageFileKind } from '@montra/schemas';

export interface DuplicateFile {
  fileId: string;
  fileName: string;
  uploadedAt: Date;
  uploadedBy: string | null;
  location: 'montra' | 'vault';
}

/**
 * The earliest file of the workspace with these bytes, of one of `kinds` (any paper when not given), not in the trash,
 * not missing, and not `except` (the file being provided again). Under the caller's row-level security.
 */
export async function findDuplicate(
  trx: Trx,
  workspaceId: string,
  sha256: string,
  opts: { kinds?: readonly StorageFileKind[]; except?: string } = {},
): Promise<DuplicateFile | null> {
  let q = trx
    .selectFrom('app.file')
    .select(['id', 'file_name', 'created_at', 'uploaded_by', 'location'])
    .where('workspace_id', '=', workspaceId)
    .where('sha256', '=', sha256)
    .where('deleted_at', 'is', null)
    .where('missing_since', 'is', null)
    .where('sealed', '=', false);
  if (opts.kinds) q = q.where('kind', 'in', [...opts.kinds]);
  else q = q.where('kind', 'not in', ['export', 'logo']);
  if (opts.except) q = q.where('id', '<>', opts.except);
  const r = await q.orderBy('created_at').orderBy('id').executeTakeFirst();
  return r
    ? {
        fileId: r.id,
        fileName: r.file_name,
        uploadedAt: r.created_at,
        uploadedBy: r.uploaded_by,
        location: r.location,
      }
    : null;
}
