/**
 * Statements on the phone (IMP-09): the import history as a list, newest first, each with its file, account,
 * the day it was imported, its status and how many rows it brought in. The web's history page shows the same
 * (`apps/web/app/w/[workspaceId]/imports/page.tsx`); undo stays on the web.
 */
import type { ImportBatchDto } from '@montra/schemas';

export type StatementTone = 'good' | 'warn' | 'bad' | 'muted';

/** The status colours of the web's history page (`BATCH_TONE` in `apps/web/lib/imports.ts`). */
export const STATEMENT_TONE: Record<ImportBatchDto['status'], StatementTone> = {
  uploaded: 'muted',
  parsing: 'muted',
  needs_mapping: 'warn',
  preview: 'warn',
  committing: 'muted',
  committed: 'good',
  failed: 'bad',
  undone: 'muted',
  discarded: 'muted',
};

/** Statuses during which the server is still working on the statement, so the list looks again. */
export const isBusy = (status: ImportBatchDto['status']): boolean =>
  status === 'uploaded' || status === 'parsing' || status === 'committing';

export interface StatementRow {
  id: string;
  fileName: string;
  /** The account's name, or null when this phone doesn't know the account. */
  accountName: string | null;
  /** The day it was imported, in the phone's time zone (`YYYY-MM-DD`). */
  importedOn: string;
  /** i18n key of the status (`imports.status.*`, shared with the web). */
  statusKey: string;
  tone: StatementTone;
  /** What the count line says, or null when there's nothing to count. */
  count: { key: string; count: number } | null;
  busy: boolean;
}

/** The local calendar day of a timestamp. This is when a file was uploaded, not a transaction date. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Rows imported for an imported statement; rows read for one waiting to be mapped or checked. */
function countOf(b: Pick<ImportBatchDto, 'status' | 'counts'>): StatementRow['count'] {
  if (b.status === 'committed') return { key: 'mobile.statements.rows_added', count: b.counts.added };
  if ((b.status === 'preview' || b.status === 'needs_mapping') && b.counts.read > 0)
    return { key: 'mobile.statements.rows_read', count: b.counts.read };
  return null;
}

type BatchFields = Pick<ImportBatchDto, 'id' | 'fileName' | 'accountId' | 'status' | 'counts' | 'createdAt'>;

/** The import history as list rows, newest first, with account names from `accountNames` (id → name). */
export function statementRows(
  batches: readonly BatchFields[],
  accountNames: ReadonlyMap<string, string>,
): StatementRow[] {
  return [...batches]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((b) => ({
      id: b.id,
      fileName: b.fileName,
      accountName: accountNames.get(b.accountId) ?? null,
      importedOn: localDay(b.createdAt),
      statusKey: `imports.status.${b.status}`,
      tone: STATEMENT_TONE[b.status],
      count: countOf(b),
      busy: isBusy(b.status),
    }));
}
