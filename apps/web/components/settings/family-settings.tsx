'use client';

import { useState, type FormEvent } from 'react';
import type { AccountDto, FamilyMemberDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { StatusLine, useAction } from '../use-action';

const RELATIONSHIPS = [
  ['self', 'Self'],
  ['spouse_partner', 'Spouse / partner'],
  ['child', 'Child'],
  ['parent', 'Parent'],
  ['other', 'Other'],
] as const;
type Relationship = (typeof RELATIONSHIPS)[number][0];

/** Family members are profiles, not logins (FAM-01, FAM-02, FAM-04, FAM-11). */
export function FamilySettings({
  workspaceId,
  members,
  accounts,
}: {
  workspaceId: string;
  members: FamilyMemberDto[];
  accounts: AccountDto[];
}) {
  const { busy, message, run } = useAction();
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
      (m) => `Added ${m.name}.`,
    );
    if (created) form.reset();
  }

  return (
    <div className="space-y-6">
      <section className="card space-y-3" aria-labelledby="fam-heading">
        <h2 id="fam-heading" className="text-base font-semibold">
          Family members
        </h2>
        <p className="text-sm text-muted">
          Untagged spending counts as Household. Tag a member to see what they cost, even without income.
        </p>
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <MemberRow key={m.id} workspaceId={workspaceId} member={m} />
          ))}
        </ul>
        <form
          onSubmit={onAdd}
          className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
          aria-label="Add family member"
        >
          <div className="min-w-40 flex-1">
            <label htmlFor="fam-name" className="field-label">
              Name
            </label>
            <input id="fam-name" name="name" className="input" required maxLength={100} />
          </div>
          <div>
            <label htmlFor="fam-rel" className="field-label">
              Relationship
            </label>
            <select id="fam-rel" name="relationship" className="input" defaultValue="child">
              {RELATIONSHIPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isDependent" /> Dependent
          </label>
          <button type="submit" className="btn-primary" disabled={busy}>
            Add member
          </button>
        </form>
        <StatusLine message={message} />
      </section>

      <section className="card space-y-3" aria-labelledby="fam-default">
        <h2 id="fam-default" className="text-base font-semibold">
          Default member per account
        </h2>
        <p className="text-sm text-muted">
          New transactions on these accounts are tagged automatically (e.g. a child’s card).
        </p>
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
                      `Updated ${a.name}.`,
                    )
                  }
                >
                  <option value="">Household</option>
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

function MemberRow({ workspaceId, member }: { workspaceId: string; member: FamilyMemberDto }) {
  const { busy, message, run } = useAction();
  const [name, setName] = useState(member.name);
  const [relationship, setRelationship] = useState<Relationship>(member.relationship);
  const dirty = name.trim() !== member.name || relationship !== member.relationship;
  return (
    <li className="flex flex-wrap items-end gap-2 py-3">
      <div className="min-w-40 flex-1">
        <label htmlFor={`fm-name-${member.id}`} className="field-label">
          Name
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
          Relationship
        </label>
        <select
          id={`fm-rel-${member.id}`}
          className="input"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value as Relationship)}
        >
          {RELATIONSHIPS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
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
            'Saved.',
          )
        }
      >
        Save
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
            member.status === 'active' ? 'Archived. History is kept.' : 'Restored.',
          )
        }
      >
        {member.status === 'active' ? 'Archive' : 'Restore'}
      </button>
      {member.status === 'inactive' && <span className="pb-2 text-xs text-muted">archived</span>}
      <div className="w-full">
        <StatusLine message={message} />
      </div>
    </li>
  );
}
