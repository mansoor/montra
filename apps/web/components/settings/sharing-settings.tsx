'use client';

import { useState, type FormEvent } from 'react';
import type { CreatedInviteDto, InviteDto, MemberDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { defaultAccess, grantsFor, inviteLink, type Access } from '@/lib/settings';
import { StatusLine, useAction } from '../use-action';

type InviteRole = 'partner' | 'viewer' | 'accountant';

const ROLE_HINT: Record<InviteRole, string> = {
  partner: 'Day-to-day use of the household books',
  viewer: 'Read-only',
  accountant: 'Selected books only; MFA required',
};

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
  const { busy, message, run } = useAction();
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
      (r) => `Invite created for ${r.email}. Share the link below; it expires in 7 days.`,
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
          People with access
        </h2>
        <ul className="divide-y divide-line" aria-label="Members">
          {members.map((m) => (
            <MemberItem key={m.userId} workspace={workspace} member={m} isOwner={isOwner} />
          ))}
        </ul>
      </section>

      {isOwner && (
        <form onSubmit={onInvite} className="card space-y-4" aria-labelledby="invite-heading" noValidate>
          <h2 id="invite-heading" className="text-base font-semibold">
            Invite someone
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="inv-email" className="field-label">
                Email
              </label>
              <input id="inv-email" name="email" type="email" className="input" required />
            </div>
            <div>
              <label htmlFor="inv-role" className="field-label">
                Role
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
                <option value="partner">Partner</option>
                <option value="viewer">Viewer</option>
                <option value="accountant">Accountant</option>
              </select>
              <p id="inv-role-hint" className="mt-1 text-xs text-muted">
                {ROLE_HINT[role]}
              </p>
            </div>
          </div>
          <fieldset>
            <legend className="field-label">Access per book</legend>
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
                    <option value="none">No access</option>
                    <option value="read">Read</option>
                    <option value="write">Read and write</option>
                  </select>
                </div>
              ))}
            </div>
          </fieldset>
          <button type="submit" className="btn-primary" disabled={busy}>
            Create invite
          </button>
          <StatusLine message={message} />
          {created && (
            <div className="space-y-2 rounded-md border border-line bg-brand-50 p-3">
              <label htmlFor="inv-link" className="field-label">
                Invite link for {created.email}
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
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-muted">This link is shown once. Email delivery comes later.</p>
            </div>
          )}
        </form>
      )}

      {isOwner && invites.length > 0 && (
        <section className="card space-y-2" aria-labelledby="invites-heading">
          <h2 id="invites-heading" className="text-base font-semibold">
            Invites
          </h2>
          <ul className="divide-y divide-line">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-medium">{i.email}</span>
                <span className="text-muted">
                  {i.role} · {i.status}
                </span>
                {i.status === 'pending' && (
                  <button
                    type="button"
                    className="btn-secondary ml-auto"
                    disabled={busy}
                    onClick={() =>
                      run(() => browserApi.revokeInvite(workspace.id, i.id), `Revoked invite for ${i.email}.`)
                    }
                  >
                    Revoke
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
  const { busy, message, run } = useAction();
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
          · {member.role}
          {member.status !== 'active' && ` (${member.status})`}
        </span>
        {editable && role && member.status === 'active' && (
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor={`role-${member.userId}`} className="sr-only">
              Role for {member.email}
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
                  'Role updated.',
                )
              }
            >
              <option value="partner">Partner</option>
              <option value="viewer">Viewer</option>
              <option value="accountant">Accountant</option>
            </select>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Remove ${member.email} from this workspace?`)) {
                  void run(
                    () => browserApi.updateMember(workspace.id, member.userId, { status: 'revoked' }),
                    'Access removed.',
                  );
                }
              }}
            >
              Remove
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
                <option value="none">No access</option>
                <option value="read">Read</option>
                <option value="write">Read and write</option>
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
                'Access updated.',
              )
            }
          >
            Save access
          </button>
        </div>
      )}
      <StatusLine message={message} />
    </li>
  );
}
