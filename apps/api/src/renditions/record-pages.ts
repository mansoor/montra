/**
 * A receipt's or bill's pages fixed after capture (ADR-0059 §4, VLT-15): moved up or down, or removed.
 *
 * The record keeps only pages it holds already, each once, and at least one (deleting the record is how the last page
 * goes). A page removed goes to the Trash (`deleted_at`), and the retention run deletes it for good 30 days later,
 * as any file in the Trash. Nothing is read again: the totals stay as they were read.
 *
 * The vault is told in the same transaction (`app.vault_pages_changed`): pages still waiting are looked at again, and
 * pages the vault has had make the record's PDF again, sent as a new document. A record the vault never had is not
 * sent because its pages moved.
 */
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { unprocessable } from '../common/errors.js';

type Ctx = { workspaceId: string; userId: string };

/**
 * Checks `next` against the record's pages `current` and, when they differ, moves the pages left out to the Trash and
 * tells the vault. The caller writes `next` on the record in the same transaction. Answers whether anything changed.
 */
export async function changePages(
  trx: Trx,
  ctx: Ctx,
  current: readonly string[],
  next: readonly string[],
): Promise<{ changed: boolean; removed: string[] }> {
  const held = new Set(current);
  if (!next.length) throw unprocessable('pages.last', 'A record keeps at least one page; delete it instead');
  if (new Set(next).size !== next.length) throw unprocessable('pages.repeated', 'A page can be listed once');
  if (next.some((id) => !held.has(id)))
    throw unprocessable('pages.unknown', 'Only the pages this record holds can be moved or removed');
  const changed = next.length !== current.length || next.some((id, i) => id !== current[i]);
  if (!changed) return { changed: false, removed: [] };
  const keep = new Set(next);
  const removed = current.filter((id) => !keep.has(id));
  if (removed.length) {
    await trx
      .updateTable('app.file')
      .set({ deleted_at: new Date() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', removed)
      .where('deleted_at', 'is', null)
      .execute();
  }
  await sql`select app.vault_pages_changed(${[...next]}::uuid[])`.execute(trx);
  return { changed: true, removed };
}
