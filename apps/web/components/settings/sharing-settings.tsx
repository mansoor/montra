'use client';

import { useState } from 'react';
import type { FamilyMemberDto, InviteDto, MemberDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  defaultAccess,
  grantsFor,
  INVITE_ROLES,
  isAdminRole,
  type Access,
  type InviteRole,
} from '@/lib/settings';
import { StatusLine, useAction } from '../use-action';
import { InviteForm } from './invite-form';

/** Household and accountant sharing, and who in the Family list each login is (UP-04, AUTH-10, AUTH-14..16). */
export function SharingSettings({
  workspace,
  members,
  invites,
  family,
  currentUserId,
}: {
  workspace: WorkspaceDto;
  members: MemberDto[];
  invites: InviteDto[];
  family: FamilyMemberDto[];
  currentUserId: string;
}) {
  const { busy, run, t } = useAction();
  const canManage = isAdminRole(workspace.role);
  const personName = (id: string | null) => family.find((f) => f.id === id)?.name ?? null;

  return (
    <div className="space-y-6">
      <section className="card space-y-3" aria-labelledby="members-heading">
        <h2 id="members-heading" className="text-base font-semibold">
          {t('sharing.people')}
        </h2>
        <ul className="divide-y divide-line" aria-label={t('sharing.members')}>
          {members.map((m) => (
            <MemberItem
              key={m.userId}
              workspace={workspace}
              member={m}
              person={personName(m.familyMemberId)}
              canManage={canManage && m.userId !== currentUserId}
            />
          ))}
        </ul>
      </section>

      {canManage && (
        <section className="card space-y-3" aria-labelledby="invite-heading">
          <h2 id="invite-heading" className="text-base font-semibold">
            {t('sharing.invite_title')}
          </h2>
          <InviteForm workspace={workspace} family={family} />
        </section>
      )}

      {canManage && invites.length > 0 && (
        <section className="card space-y-2" aria-labelledby="invites-heading">
          <h2 id="invites-heading" className="text-base font-semibold">
            {t('sharing.invites')}
          </h2>
          <ul className="divide-y divide-line">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-medium">{i.email}</span>
                <span className="text-muted">
                  {personName(i.familyMemberId) && `${personName(i.familyMemberId)} · `}
                  {t(`role.${i.role}`)} · {t(`sharing.invite_status.${i.status}`)}
                </span>
                {i.status === 'pending' && (
                  <button
                    type="button"
                    className="btn-secondary ml-auto"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => browserApi.revokeInvite(workspace.id, i.id),
                        t('sharing.revoked', { email: i.email }),
                      )
                    }
                  >
                    {t('sharing.revoke')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MemberItem({
  workspace,
  member,
  person,
  canManage,
}: {
  workspace: WorkspaceDto;
  member: MemberDto;
  person: string | null;
  canManage: boolean;
}) {
  const { busy, message, run, t } = useAction();
  // Nobody but the owner changes the owner, and that is by handing over (AUTH-15).
  const editable = canManage && member.role !== 'owner' && member.status === 'active';
  const granted = new Map(member.grants.map((g) => [g.entityId, g.access]));
  const [grants, setGrants] = useState<Record<string, Access>>(() =>
    Object.fromEntries(
      workspace.entities.map((e) => [e.id, granted.get(e.id) ?? defaultAccess(member.role, e.type)]),
    ),
  );
  const role = member.role === 'owner' ? null : (member.role as InviteRole);
  const canHandOver = workspace.role === 'owner' && member.role === 'admin' && member.status === 'active';

  return (
    <li className="space-y-2 py-3" data-testid="sharing-member">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{member.displayName || member.email}</span>
        <span className="text-sm text-muted">{member.email}</span>
        <span className="text-sm text-muted">
          · {t(`role.${member.role}`)}
          {member.status !== 'active' && ` (${t(`sharing.member_status.${member.status}`)})`}
        </span>
        {person && <span className="chip">{t('sharing.is_person', { name: person })}</span>}
        {editable && role && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label htmlFor={`role-${member.userId}`} className="sr-only">
              {t('sharing.role_for', { email: member.email })}
            </label>
            <select
              id={`role-${member.userId}`}
              className="input w-36"
              value={role}
              disabled={busy}
              onChange={(e) =>
                run(
                  () =>
                    browserApi.updateMember(workspace.id, member.userId, {
                      role: e.target.value as InviteRole,
                    }),
                  t('sharing.role_updated'),
                )
              }
            >
              {INVITE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`)}
                </option>
              ))}
            </select>
            {canHandOver && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('sharing.confirm_hand_over', { email: member.email }))) {
                    void run(
                      () => browserApi.updateMember(workspace.id, member.userId, { role: 'owner' }),
                      t('sharing.handed_over', { email: member.email }),
                    );
                  }
                }}
              >
                {t('sharing.hand_over')}
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('sharing.confirm_remove', { email: member.email }))) {
                  void run(
                    () => browserApi.updateMember(workspace.id, member.userId, { status: 'revoked' }),
                    t('sharing.access_removed'),
                  );
                }
              }}
            >
              {t('sharing.remove')}
            </button>
          </div>
        )}
      </div>
      {editable && role && !isAdminRole(role) && (
        <div className="flex flex-wrap items-end gap-2">
          {workspace.entities.map((e) => (
            <div key={e.id}>
              <label htmlFor={`g-${member.userId}-${e.id}`} className="text-xs text-muted">
                {e.name}
              </label>
              <select
                id={`g-${member.userId}-${e.id}`}
                className="input"
                value={grants[e.id]}
                onChange={(ev) => setGrants((g) => ({ ...g, [e.id]: ev.target.value as Access }))}
              >
                <option value="none">{t('access.none')}</option>
                <option value="read">{t('access.read')}</option>
                <option value="write">{t('access.write')}</option>
              </select>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              run(
                () => browserApi.setGrants(workspace.id, member.userId, grantsFor(workspace, role, grants)),
                t('sharing.access_updated'),
              )
            }
          >
            {t('sharing.save_access')}
          </button>
        </div>
      )}
      <StatusLine message={message} />
    </li>
  );
}
