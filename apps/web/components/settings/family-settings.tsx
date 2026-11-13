'use client';

import { useState, type FormEvent } from 'react';
import type { AccountDto, FamilyMemberDto, InviteDto, MemberDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { isAdminRole } from '@/lib/settings';
import { StatusLine, useAction } from '../use-action';
import { InviteForm } from './invite-form';

const RELATIONSHIPS = ['self', 'spouse_partner', 'child', 'parent', 'other'] as const;
type Relationship = (typeof RELATIONSHIPS)[number];

/**
 * Family members are profiles; inviting one links them to a login, so each person is one entry here and under
 * Sharing (FAM-01, FAM-02, FAM-04, FAM-11, AUTH-16).
 */
export function FamilySettings({
  workspace,
  members,
  accounts,
  logins,
  invites,
}: {
  workspace: WorkspaceDto;
  members: FamilyMemberDto[];
  accounts: AccountDto[];
  logins: MemberDto[];
  invites: InviteDto[];
}) {
  const workspaceId = workspace.id;
  const { busy, message, run, t } = useAction();
  const active = members.filter((m) => m.status === 'active');

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const created = await run(
      () =>
        browserApi.createFamilyMember(workspaceId, {
          name: String(f.get('name') ?? '').trim(),
          relationship: String(f.get('relationship')) as Relationship,
          isDependent: f.get('isDependent') === 'on',
        }),
      (m) => t('members.added', { name: m.name }),
    );
    if (created) form.reset();
  }

  return (
    <div className="space-y-6">
      <section className="card space-y-3" aria-labelledby="fam-heading">
        <h2 id="fam-heading" className="text-base font-semibold">
          {t('settings.tab.family')}
        </h2>
        <p className="text-sm text-muted">{t('members.intro')}</p>
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              workspace={workspace}
              member={m}
              family={members}
              login={logins.find((l) => l.userId === m.linkedUserId && l.status === 'active') ?? null}
              invite={invites.find((i) => i.familyMemberId === m.id && i.status === 'pending') ?? null}
            />
          ))}
        </ul>
        <form
          onSubmit={onAdd}
          className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
          aria-label={t('members.add_label')}
        >
          <div className="min-w-40 flex-1">
            <label htmlFor="fam-name" className="field-label">
              {t('fields.name')}
            </label>
            <input id="fam-name" name="name" className="input" required maxLength={100} />
          </div>
          <div>
            <label htmlFor="fam-rel" className="field-label">
              {t('members.relationship_label')}
            </label>
            <select id="fam-rel" name="relationship" className="input" defaultValue="child">
              {RELATIONSHIPS.map((v) => (
                <option key={v} value={v}>
                  {t(`members.relationship.${v}`)}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isDependent" /> {t('members.dependent')}
          </label>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('members.add')}
          </button>
        </form>
        <StatusLine message={message} />
      </section>

      <section className="card space-y-3" aria-labelledby="fam-default">
        <h2 id="fam-default" className="text-base font-semibold">
          {t('members.default_title')}
        </h2>
        <p className="text-sm text-muted">{t('members.default_intro')}</p>
        <ul className="divide-y divide-line">
          {accounts
            .filter((a) => !a.archived)
            .map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <label htmlFor={`dm-${a.id}`} className="text-sm">
                  {a.name}
                </label>
                <select
                  id={`dm-${a.id}`}
                  className="input w-48"
                  value={a.defaultMemberId ?? ''}
                  disabled={busy}
                  onChange={(e) =>
                    run(
                      () =>
                        browserApi.updateAccount(workspaceId, a.id, {
                          defaultMemberId: e.target.value || null,
                        }),
                      t('members.updated_account', { name: a.name }),
                    )
                  }
                >
                  <option value="">{t('members.household')}</option>
                  {active.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function MemberRow({
  workspace,
  member,
  family,
  login,
  invite,
}: {
  workspace: WorkspaceDto;
  member: FamilyMemberDto;
  family: FamilyMemberDto[];
  login: MemberDto | null;
  invite: InviteDto | null;
}) {
  const workspaceId = workspace.id;
  const { busy, message, run, t } = useAction();
  const [inviting, setInviting] = useState(false);
  const canInvite =
    isAdminRole(workspace.role) && member.status === 'active' && member.relationship !== 'self' && !login;
  const [name, setName] = useState(member.name);
  const [relationship, setRelationship] = useState<Relationship>(member.relationship);
  const dirty = name.trim() !== member.name || relationship !== member.relationship;
  return (
    <li className="flex flex-wrap items-end gap-2 py-3">
      <div className="min-w-40 flex-1">
        <label htmlFor={`fm-name-${member.id}`} className="field-label">
          {t('fields.name')}
        </label>
        <input
          id={`fm-name-${member.id}`}
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`fm-rel-${member.id}`} className="field-label">
          {t('members.relationship_label')}
        </label>
        <select
          id={`fm-rel-${member.id}`}
          className="input"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value as Relationship)}
        >
          {RELATIONSHIPS.map((v) => (
            <option key={v} value={v}>
              {t(`members.relationship.${v}`)}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy || !dirty || !name.trim()}
        onClick={() =>
          run(
            () => browserApi.updateFamilyMember(workspaceId, member.id, { name: name.trim(), relationship }),
            t('common.saved'),
          )
        }
      >
        {t('common.save')}
      </button>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() =>
          run(
            () =>
              browserApi.updateFamilyMember(workspaceId, member.id, {
                status: member.status === 'active' ? 'inactive' : 'active',
              }),
            member.status === 'active' ? t('common.archived_kept') : t('common.restored'),
          )
        }
      >
        {member.status === 'active' ? t('common.archive') : t('common.restore')}
      </button>
      {member.status === 'inactive' && (
        <span className="pb-2 text-xs text-muted">{t('common.archived')}</span>
      )}
      <p className="w-full text-sm text-muted" data-testid="family-login">
        {login
          ? t('members.signs_in_as', { role: t(`role.${login.role}`), email: login.email })
          : invite
            ? t('members.invited_as', { role: t(`role.${invite.role}`), email: invite.email })
            : member.relationship === 'self'
              ? null
              : t('members.no_login')}
      </p>
      {canInvite && !inviting && (
        <button type="button" className="btn-secondary" onClick={() => setInviting(true)}>
          {invite ? t('members.invite_again') : t('members.invite', { name: member.name })}
        </button>
      )}
      {inviting && (
        <div className="w-full rounded-md border border-line p-3">
          <InviteForm
            workspace={workspace}
            family={family}
            person={member}
            idPrefix={`fam-inv-${member.id}`}
            onCancel={() => setInviting(false)}
          />
        </div>
      )}
      <div className="w-full">
        <StatusLine message={message} />
      </div>
    </li>
  );
}
