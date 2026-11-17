/** Pure helpers for the settings pages. */
import type { EntityGrantInput, InviteRole, MemberRole, WorkspaceDto } from '@montra/api-client';

export type { InviteRole };
/** The roles an invite offers, most access first (AUTH-14). */
export const INVITE_ROLES: InviteRole[] = ['admin', 'partner', 'member', 'viewer', 'accountant'];

/** Owners and admins manage the workspace: sharing, AI, storage, billing (AUTH-14). */
export const isAdminRole = (role: MemberRole): boolean => role === 'owner' || role === 'admin';

/** Shareable accept link; email delivery isn't wired yet (AUTH-10). */
export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`;
}

export type Access = 'none' | 'read' | 'write';

/** Role defaults mirrored from the database policy (docs/design/07 §2, assumption 5; ADR-0041). */
export function defaultAccess(role: MemberRole, entityType: string): Access {
  if (isAdminRole(role)) return 'write';
  if (entityType !== 'personal') return 'none';
  return role === 'partner' || role === 'member' ? 'write' : role === 'viewer' ? 'read' : 'none';
}

/** The book access a role can be given: a viewer is read-only, always (ADR-0053 Q2; the API refuses write). */
export const accessChoices = (role: MemberRole): Access[] =>
  role === 'viewer' ? ['none', 'read'] : ['none', 'read', 'write'];

/** What a choice means for this role: write is read for a viewer. */
export const accessFor = (role: MemberRole, access: Access): Access =>
  role === 'viewer' && access === 'write' ? 'read' : access;

/** Only grants that differ from the role default are sent, so later default changes still apply. */
export function grantsFor(
  workspace: WorkspaceDto,
  role: MemberRole,
  chosen: Record<string, Access>,
): EntityGrantInput[] {
  return workspace.entities.flatMap((e) => {
    const picked = chosen[e.id];
    if (picked === undefined) return [];
    const access = accessFor(role, picked);
    return access === defaultAccess(role, e.type) ? [] : [{ entityId: e.id, access }];
  });
}
