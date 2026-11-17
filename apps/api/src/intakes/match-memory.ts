/**
 * The match memory (ADR-0051 §3): per workspace, kind and signal, the account or biller it points to and how many
 * confirmations in a row. The rule itself (`learnMatch`) is pure, in `@montra/importers`; this is its storage, and the
 * hooks the import and bill paths call when a person confirms or undoes.
 */
import { forgetMatch, learnMatch, type MatchMemoryState } from '@montra/importers';
import type { MatchMemoryRow, Trx } from '@montra/db';

export type MatchKind = 'statement' | 'bill' | 'tax_issuer' | 'tax_person';
type Ctx = { workspaceId: string; userId: string };

export async function readMemory(
  trx: Trx,
  ctx: Ctx,
  kind: MatchKind,
  signal: string | null,
): Promise<MatchMemoryRow | undefined> {
  if (!signal) return undefined;
  return trx
    .selectFrom('app.match_memory')
    .selectAll()
    .where('workspace_id', '=', ctx.workspaceId)
    .where('kind', '=', kind)
    .where('signal', '=', signal)
    .executeTakeFirst();
}

/** A stored memory as the pure rule sees it. */
export const memoryState = (m: MatchMemoryRow | undefined): MatchMemoryState | null =>
  m ? { targetId: m.target_id, confirmations: m.confirmations } : null;

/** A person chose `targetId` for a document with this signal: a confirmation, or a correction that starts again. */
export async function confirmMatch(
  trx: Trx,
  ctx: Ctx,
  kind: MatchKind,
  signal: string | null,
  targetId: string,
): Promise<MatchMemoryState | null> {
  if (!signal) return null;
  const prev = await readMemory(trx, ctx, kind, signal);
  const next = learnMatch(memoryState(prev), targetId);
  const now = new Date();
  if (prev) {
    await trx
      .updateTable('app.match_memory')
      .set({
        target_id: next.targetId,
        confirmations: next.confirmations,
        last_confirmed_at: now,
        updated_at: now,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', prev.id)
      .execute();
  } else {
    await trx
      .insertInto('app.match_memory')
      .values({
        workspace_id: ctx.workspaceId,
        kind,
        signal,
        target_id: next.targetId,
        confirmations: next.confirmations,
        last_confirmed_at: now,
      })
      // Two first confirmations at once: one of them stands.
      .onConflict((oc) =>
        oc
          .columns(['workspace_id', 'kind', 'signal'])
          .doUpdateSet({ target_id: next.targetId, last_confirmed_at: now, updated_at: now }),
      )
      .execute();
  }
  return { targetId: next.targetId, confirmations: next.confirmations };
}

/** An automatic match was undone: confirmed three times again before it's automatic. */
export async function forgetSignal(
  trx: Trx,
  ctx: Ctx,
  kind: MatchKind,
  signal: string | null,
): Promise<void> {
  const prev = await readMemory(trx, ctx, kind, signal);
  if (!prev) return;
  await trx
    .updateTable('app.match_memory')
    .set({ confirmations: forgetMatch(memoryState(prev)!).confirmations, updated_at: new Date() })
    .where('workspace_id', '=', ctx.workspaceId)
    .where('id', '=', prev.id)
    .execute();
}

/**
 * An import made from an intake was committed by a person: the intake is done, and when the memory picked its account
 * the commit confirms it.
 */
export async function intakeImportCommitted(trx: Trx, ctx: Ctx, batchId: string): Promise<void> {
  const intake = await trx
    .selectFrom('app.document_intake')
    .select(['id', 'signal', 'target_id', 'status'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('import_batch_id', '=', batchId)
    .where('status', 'in', ['review', 'importing'])
    .executeTakeFirst();
  if (!intake) return;
  if (intake.target_id) await confirmMatch(trx, ctx, 'statement', intake.signal, intake.target_id);
  await trx
    .updateTable('app.document_intake')
    .set({
      status: 'done',
      reason: null,
      resolved_by: ctx.userId,
      resolved_at: new Date(),
      updated_at: new Date(),
    })
    .where('workspace_id', '=', ctx.workspaceId)
    .where('id', '=', intake.id)
    .execute();
}

/** An import made automatically was undone: its signal is forgotten and the statement goes back to Review. */
export async function intakeImportUndone(trx: Trx, ctx: Ctx, batchId: string): Promise<void> {
  const intake = await trx
    .selectFrom('app.document_intake')
    .select(['id', 'signal', 'automatic'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('import_batch_id', '=', batchId)
    .where('status', '=', 'done')
    .executeTakeFirst();
  if (!intake?.automatic) return;
  await forgetSignal(trx, ctx, 'statement', intake.signal);
  await trx
    .updateTable('app.document_intake')
    .set({ status: 'review', reason: 'undone', resolved_by: null, resolved_at: null, updated_at: new Date() })
    .where('workspace_id', '=', ctx.workspaceId)
    .where('id', '=', intake.id)
    .execute();
}
