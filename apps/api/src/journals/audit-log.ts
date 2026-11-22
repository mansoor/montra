/**
 * Reading the workspace audit log (NFR-03). The triggers and the services write it; owners and admins read it, newest
 * first, a page at a time. RLS limits it to them too.
 */
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  AUDIT_BOOKKEEPING_SUBJECTS,
  type AuditActorType,
  type AuditLogPageDto,
  type AuditLogQuery,
} from '@montra/schemas';
import type { z } from 'zod';

type Query = z.output<typeof AuditLogQuery>;

/** The trigger actions that are the ledger's own bookkeeping, hidden when asked. */
const BOOKKEEPING_ACTIONS = AUDIT_BOOKKEEPING_SUBJECTS.flatMap((s) =>
  ['insert', 'update', 'delete'].map((op) => `${s}.${op}`),
);

export async function readAuditLog(trx: Trx, workspaceId: string, q: Query): Promise<AuditLogPageDto> {
  let query = trx
    .selectFrom('app.audit_log as a')
    // RLS shows people who share the workspace, so someone who has left reads as null.
    .leftJoin('app.app_user as u', 'u.id', 'a.actor_user_id')
    .select([
      'a.id',
      'a.at',
      'a.actor_user_id',
      'a.actor_type',
      'a.action',
      'a.subject_type',
      'a.subject_id',
      'a.diff',
      'u.display_name',
      'u.email',
    ])
    .where('a.workspace_id', '=', workspaceId)
    .orderBy('a.id', 'desc')
    .limit(q.limit + 1);
  if (q.cursor) query = query.where('a.id', '<', BigInt(q.cursor));
  if (q.subjectId) query = query.where('a.subject_id', '=', q.subjectId);
  if (q.subjectType) query = query.where('a.subject_type', '=', q.subjectType);
  if (q.action) query = query.where('a.action', '=', q.action);
  if (q.actorUserId) query = query.where('a.actor_user_id', '=', q.actorUserId);
  if (q.actorType) query = query.where('a.actor_type', '=', q.actorType);
  if (q.bookkeeping === 'hide') query = query.where('a.action', 'not in', BOOKKEEPING_ACTIONS);
  // Calendar days in the workspace's time zone, both ends included.
  const zone = sql`(select w.time_zone from app.workspace w where w.id = ${workspaceId}::uuid)`;
  if (q.from) query = query.where(sql<boolean>`a.at >= (${q.from}::date)::timestamp at time zone ${zone}`);
  if (q.to) query = query.where(sql<boolean>`a.at < (${q.to}::date + 1)::timestamp at time zone ${zone}`);

  const rows = await query.execute();
  const page = rows.slice(0, q.limit);
  return {
    data: page.map((r) => ({
      id: r.id.toString(),
      at: r.at.toISOString(),
      actorUserId: r.actor_user_id,
      actorName: r.display_name || r.email || null,
      actorType: r.actor_type as AuditActorType,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      diff: r.diff ?? null,
    })),
    nextCursor: rows.length > q.limit ? page[page.length - 1]!.id.toString() : null,
  };
}
