'use client';

import { useState, type FormEvent } from 'react';
import type { CreatedInviteDto, FamilyMemberDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  defaultAccess,
  grantsFor,
  INVITE_ROLES,
  inviteLink,
  isAdminRole,
  type Access,
  type InviteRole,
} from '@/lib/settings';
import { StatusLine, useAction } from '../use-action';

const RELATIONSHIPS = ['spouse_partner', 'child', 'parent', 'other'] as const;
type Relationship = (typeof RELATIONSHIPS)[number];

/** `new` adds a person to the Family list; '' is someone who isn't family, such as an accountant. */
type Who = string;

/**
 * Invites someone with a role, per-book access and, for family, the person in the Family list they are (AUTH-10,
 * AUTH-16). From a Family row, `person` is fixed and the "Who is this?" choice is left out.
 */
export function InviteForm({
  workspace,
  family,
  person,
  idPrefix = 'inv',
  onCancel,
}: {
  workspace: WorkspaceDto;
  family: FamilyMemberDto[];
  person?: FamilyMemberDto;
  idPrefix?: string;
  onCancel?: () => void;
}) {
  const { busy, message, run, t } = useAction();
  const [role, setRole] = useState<InviteRole>('partner');
  const [who, setWho] = useState<Who>(person ? person.id : 'new');
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [created, setCreated] = useState<CreatedInviteDto | null>(null);
  const [copied, setCopied] = useState(false);
  const id = (k: string) => `${idPrefix}-${k}`;
  // People who don't sign in yet; someone already linked keeps their own login.
  const unlinked = family.filter(
    (f) => f.status === 'active' && !f.linkedUserId && f.relationship !== 'self',
  );
  const link = created
    ? inviteLink(typeof window === 'undefined' ? '' : window.location.origin, created.token)
    : '';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const email = String(f.get('email') ?? '').trim();
    const familyMember =
      who === 'new'
        ? {
            name: String(f.get('personName') ?? '').trim(),
            relationship: String(f.get('relationship')) as Relationship,
          }
        : who
          ? { id: who }
          : undefined;
    const invite = await run(
      () =>
        browserApi.createInvite(workspace.id, {
          email,
          role,
          entityGrants: isAdminRole(role) ? [] : grantsFor(workspace, role, access),
          ...(familyMember ? { familyMember } : {}),
        }),
      (r) => t('sharing.invite_sent', { email: r.email }),
    );
    if (invite) {
      setCreated(invite);
      setCopied(false);
      form.reset();
      setAccess({});
      if (!person) setWho('new');
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label={t('sharing.invite_title')} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={id('email')} className="field-label">
            {t('auth.email')}
          </label>
          <input id={id('email')} name="email" type="email" className="input" required />
        </div>
        <div>
          <label htmlFor={id('role')} className="field-label">
            {t('sharing.role')}
          </label>
          <select
            id={id('role')}
            className="input"
            value={role}
            onChange={(e) => {
              const next = e.target.value as InviteRole;
              setRole(next);
              setAccess({});
              // An accountant is rarely family; everyone else usually is.
              if (!person) setWho(next === 'accountant' ? '' : who || 'new');
            }}
            aria-describedby={id('role-hint')}
          >
            {INVITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`)}
              </option>
            ))}
          </select>
          <p id={id('role-hint')} className="mt-1 text-xs text-muted">
            {t(`sharing.role_hint.${role}`)}
          </p>
        </div>
      </div>

      {!person && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={id('who')} className="field-label">
              {t('sharing.who')}
            </label>
            <select
              id={id('who')}
              className="input"
              value={who}
              onChange={(e) => setWho(e.target.value)}
              aria-describedby={id('who-hint')}
            >
              <option value="new">{t('sharing.who_new')}</option>
              {unlinked.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
              <option value="">{t('sharing.who_none')}</option>
            </select>
            <p id={id('who-hint')} className="mt-1 text-xs text-muted">
              {t('sharing.who_hint')}
            </p>
          </div>
          {who === 'new' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={id('person')} className="field-label">
                  {t('sharing.person_name')}
                </label>
                <input id={id('person')} name="personName" className="input" required maxLength={100} />
              </div>
              <div>
                <label htmlFor={id('rel')} className="field-label">
                  {t('members.relationship_label')}
                </label>
                <select id={id('rel')} name="relationship" className="input" defaultValue="spouse_partner">
                  {RELATIONSHIPS.map((v) => (
                    <option key={v} value={v}>
                      {t(`members.relationship.${v}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {isAdminRole(role) ? (
        <p className="text-sm text-muted">{t('sharing.admin_all_books')}</p>
      ) : (
        <fieldset>
          <legend className="field-label">{t('sharing.access_per_book')}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {workspace.entities.map((e) => (
              <div key={e.id}>
                <label htmlFor={id(`acc-${e.id}`)} className="text-sm">
                  {e.name}
                </label>
                <select
                  id={id(`acc-${e.id}`)}
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
      )}

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('sharing.create_invite')}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
      </div>
      <StatusLine message={message} />
      {created && (
        <div className="space-y-2 rounded-md border border-line bg-brand-50 p-3">
          <label htmlFor={id('link')} className="field-label">
            {t('sharing.invite_link_for', { email: created.email })}
          </label>
          <div className="flex gap-2">
            <input
              id={id('link')}
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
  );
}
