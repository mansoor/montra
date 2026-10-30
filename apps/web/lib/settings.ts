/** Pure helpers for the settings pages. */
import type { EntityGrantInput, WorkspaceDto } from '@montra/api-client';

/** Shareable accept link; email delivery isn't wired yet (AUTH-10). */
export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`;
}

export type Access = 'none' | 'read' | 'write';

/** Role defaults mirrored from the database policy (docs/design/07 §2, assumption 5). */
export function defaultAccess(role: 'partner' | 'viewer' | 'accountant', entityType: string): Access {
  if (entityType !== 'personal') return 'none';
  return role === 'partner' ? 'write' : role === 'viewer' ? 'read' : 'none';
}

/** Only grants that differ from the role default are sent, so later default changes still apply. */
export function grantsFor(
  workspace: WorkspaceDto,
  role: 'partner' | 'viewer' | 'accountant',
  chosen: Record<string, Access>,
): EntityGrantInput[] {
  return workspace.entities
    .filter((e) => chosen[e.id] !== undefined && chosen[e.id] !== defaultAccess(role, e.type))
    .map((e) => ({ entityId: e.id, access: chosen[e.id]! }));
}
