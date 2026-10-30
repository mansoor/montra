import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './types.js';

export interface DbContext {
  workspaceId?: string | null;
  userId?: string | null;
  actorType?: 'user' | 'system' | 'support' | 'worker';
  /** Only for the audited unlock path (DE-10). */
  allowLockedEdit?: boolean;
}

export type Trx = Transaction<Database>;

/**
 * Runs `fn` in one database transaction with the RLS context set via SET LOCAL (design 02 §5). Every
 * query in a request or job goes through here, so tenant isolation holds even if a query forgets a filter.
 */
export async function withContext<T>(db: Kysely<Database>, ctx: DbContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setContext(trx, ctx);
    return fn(trx);
  });
}

export async function setContext(trx: Trx, ctx: DbContext): Promise<void> {
  await sql`select
      set_config('app.workspace_id', ${ctx.workspaceId ?? ''}, true),
      set_config('app.user_id', ${ctx.userId ?? ''}, true),
      set_config('app.actor_type', ${ctx.actorType ?? 'user'}, true),
      set_config('app.allow_locked_edit', ${ctx.allowLockedEdit ? 'on' : ''}, true)`.execute(trx);
}
