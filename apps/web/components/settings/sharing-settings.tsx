'use client';

import { useState, type FormEvent } from 'react';
import type { CreatedInviteDto, InviteDto, MemberDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { defaultAccess, grantsFor, inviteLink, type Access } from '@/lib/settings';
import { StatusLine, useAction } from '../use-action';

type InviteRole = 'partner' | 'viewer' | 'accountant';

/** Household and accountant sharing (UP-04, AUTH-10, BIZ-13). */
export function SharingSettings({
  workspace,
  members,
  invites,
  isOwner,
}: {
  workspace: WorkspaceDto;
  members: MemberDto[];
  invites: InviteDto[];
  isOwner: boolean;
}) {
  const { busy, message, run, t } = useAction();
  const [role, setRole] = useState<InviteRole>('partner');
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [created, setCreated] = useState<CreatedInviteDto | null>(null);
  const [copied, setCopied] = useState(false);
  const link = created
    ? inviteLink(typeof window === 'undefined' ? '' : window.location.origin, created.token)
    : '';

  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get('email') ?? '').trim();
    const invite = await run(
      () =>
        browserApi.createInvite(workspace.id, {
          email,
          role,
          entityGrants: grantsFor(workspace, role, access),
        }),
      (r) => t('sharing.invite_sent', { email: r.email }),
    );
    if (invite) {
      setCreated(invite);
      setCopied(false);
      form.reset();
      setAccess({});
    }
  }

  return (
    <div className="space-y-6">
      <section className="card space-y-3" aria-labelledby="members-heading">
        <h2 id="members-heading" className="text-base font-semibold">
          {t('sharing.people')}
        </h2>
        <ul className="divide-y divide-line" aria-label={t('sharing.members')}>
          {members.map((m) => (
            <MemberItem key={m.userId} workspace={workspace} member={m} isOwner={isOwner} />
          ))}
        </ul>
      </section>

      {isOwner && (
        <form onSubmit={onInvite} className="card space-y-4" aria-labelledby="invite-heading" noValidate>
          <h2 id="invite-heading" className="text-base font-semibold">
            {t('sharing.invite_title')}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="inv-email" className="field-label">
                {t('auth.email')}
              </label>
              <input id="inv-email" name="email" type="email" className="input" required />
            </div>
            <div>
              <label htmlFor="inv-role" className="field-label">
                {t('sharing.role')}
              </label>
              <select
                id="inv-role"
                className="input"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as InviteRole);
                  setAccess({});
                }}
                aria-describedby="inv-role-hint"
              >
                <option value="partner">{t('role.partner')}</option>
                <option value="viewer">{t('role.viewer')}</option>
                <option value="accountant">{t('role.accountant')}</option>
              </select>
              <p id="inv-role-hint" className="mt-1 text-xs text-muted">
                {t(`sharing.role_hint.${role}`)}
              </p>
            </div>
          </div>
          <fieldset>
            <legend className="field-label">{t('sharing.access_per_book')}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {workspace.entities.map((e) => (
                <div key={e.id}>
                  <label htmlFor={`inv-acc-${e.id}`} className="text-sm">
                    {e.name}
                  </label>
                  <select
                    id={`inv-acc-${e.id}`}
                    className="input"
                    value={access[e.id] ?? defaultAccess(role, e.type)}
                    onChange={(ev) => setAccess((a) => ({ ...a, [e.id]: ev.target.value as Access }))}
                  >
                    <option value="none">{t('access.none')}</option>
                    <option value="read">{t('access.read')}</option>
                    <option value="write">{t('access.write')}</option>
                  </select>
                </div>
              ))}
            </div>
          </fieldset>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('sharing.create_invite')}
          </button>
          <StatusLine message={message} />
          {created && (
            <div className="space-y-2 rounded-md border border-line bg-brand-50 p-3">
              <label htmlFor="inv-link" className="field-label">
                {t('sharing.invite_link_for', { email: created.email })}
              </label>
              <div className="flex gap-2">
                <input
                  id="inv-link"
                  className="input font-mono text-xs"
                  readOnly
                  value={link}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? t('common.copied') : t('common.copy')}
                </button>
              </div>
              <p className="text-xs text-muted">{t('sharing.link_once')}</p>
            </div>
          )}
        </form>
      )}

      {isOwner && invites.length > 0 && (
        <section className="card space-y-2" aria-labelledby="invites-heading">
          <h2 id="invites-heading" className="text-base font-semibold">
            {t('sharing.invites')}
          </h2>
          <ul className="divide-y divide-line">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-medium">{i.email}</span>
                <span className="text-muted">
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
  isOwner,
}: {
  workspace: WorkspaceDto;
  member: MemberDto;
  isOwner: boolean;
}) {
  const { busy, message, run, t } = useAction();
  const editable = isOwner && member.role !== 'owner';
  const granted = new Map(member.grants.map((g) => [g.entityId, g.access]));
  const [grants, setGrants] = useState<Record<string, Access>>(() =>
    Object.fromEntries(
      workspace.entities.map((e) => [
        e.id,
        granted.get(e.id) ??
          (member.role === 'owner' ? 'write' : defaultAccess(member.role as InviteRole, e.type)),
      ]),
    ),
  );
  const role = member.role === 'owner' ? null : (member.role as InviteRole);

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{member.displayName || member.email}</span>
        <span className="text-sm text-muted">{member.email}</span>
        <span className="text-sm text-muted">
          · {t(`role.${member.role}`)}
          {member.status !== 'active' && ` (${t(`sharing.member_status.${member.status}`)})`}
        </span>
        {editable && role && member.status === 'active' && (
          <div className="ml-auto flex items-center gap-2">
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
              <option value="partner">{t('role.partner')}</option>
              <option value="viewer">{t('role.viewer')}</option>
              <option value="accountant">{t('role.accountant')}</option>
            </select>
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
      {editable && role && member.status === 'active' && (
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
