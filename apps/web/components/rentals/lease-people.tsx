'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AccountDto, LeaseDto, RentalContactDto, TenantDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  brokerContacts,
  buildLeasePerson,
  emptyPerson,
  LEASE_COST_KINDS,
  mailtoHref,
  maskedDateOfBirth,
  peopleByRole,
  positiveMinor,
  telHref,
  type PersonFormFields,
} from '@/lib/rentals';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { RevealValue } from '../payroll/reveal';
import { StatusLine, useAction } from '../use-action';

/** A phone and email as links, for whoever is on the line. */
function ContactLinks({ phone, email }: { phone: string | null; email: string | null }) {
  const tel = telHref(phone);
  const mail = mailtoHref(email);
  return (
    <>
      {phone &&
        (tel ? (
          <a className="underline" href={tel}>
            {phone}
          </a>
        ) : (
          <span>{phone}</span>
        ))}
      {phone && email ? ' · ' : ''}
      {email &&
        (mail ? (
          <a className="underline" href={mail}>
            {email}
          </a>
        ) : (
          <span>{email}</span>
        ))}
    </>
  );
}

/** The signed lease: attach a PDF or photo, and download what's attached (RNT-19). */
export function LeaseDocuments({ workspaceId, lease }: { workspaceId: string; lease: LeaseDto }) {
  const { run, busy, message, setMessage, t } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const href = (id: string) => `/api/v1/workspaces/${workspaceId}/rentals/leases/${lease.id}/files/${id}`;
  return (
    <section className="card space-y-3" aria-labelledby="signed-lease-title">
      <h2 id="signed-lease-title" className="text-base font-semibold">
        {t('rentals.signed_lease')}
      </h2>
      {lease.fileIds.length === 0 ? (
        <p className="text-sm text-muted">{t('rentals.no_signed_lease')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {lease.fileIds.map((id, i) => (
            <li
              key={id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="lease-file"
            >
              <a className="text-sm underline" href={href(id)} target="_blank" rel="noreferrer" download>
                {t('rentals.download_lease_file', { n: i + 1 })}
              </a>
              <button
                type="button"
                className="text-sm underline"
                disabled={busy}
                onClick={() =>
                  run(
                    () =>
                      browserApi.updateLease(workspaceId, lease.id, {
                        fileIds: lease.fileIds.filter((f) => f !== id),
                        version: lease.version,
                      }),
                    t('rentals.lease_file_removed'),
                  )
                }
              >
                {t('rentals.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('rentals.attach_signed_lease')}
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) return setMessage({ tone: 'bad', text: t('rentals.choose_file') });
          void run(async () => {
            const { fileId } = await browserApi.uploadRentalFile(workspaceId, file, file.name);
            return browserApi.updateLease(workspaceId, lease.id, {
              fileIds: [...lease.fileIds, fileId],
              version: lease.version,
            });
          }, t('rentals.lease_file_attached')).then((r) => {
            if (r) setFile(null);
          });
        }}
      >
        <label>
          <span className="field-label">{t('rentals.lease_file_pick')}</span>
          <input
            className="input"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('rentals.attach_signed_lease')}
        </button>
      </form>
      <StatusLine message={message} />
    </section>
  );
}

/** Who's on the lease, by role: the tenants who sign (and pay), co-signers and occupants (RNT-18). */
export function LeasePeople({
  workspaceId,
  lease,
  tenants,
  tenantHref,
  today,
}: {
  workspaceId: string;
  lease: LeaseDto;
  tenants: TenantDto[];
  /** The tenant page's path, without the id. */
  tenantHref: string;
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { date } = useI18n();
  const [draft, setDraft] = useState<PersonFormFields>(emptyPerson('cosigner'));
  const groups = peopleByRole(lease);
  const set = (patch: Partial<PersonFormFields>) => setDraft({ ...draft, ...patch });
  const remove = (id: string) =>
    run(() => browserApi.removeLeasePerson(workspaceId, id), t('rentals.person_removed'));
  const field = (label: string, key: keyof PersonFormFields, extra: object = {}) => (
    <label>
      <span className="field-label">{label}</span>
      <input
        className="input"
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        {...extra}
      />
    </label>
  );
  return (
    <section className="card space-y-4" aria-labelledby="people-title">
      <h2 id="people-title" className="text-base font-semibold">
        {t('rentals.people_on_lease')}
      </h2>
      <div>
        <h3 className="text-sm font-semibold">{t('rentals.signers')}</h3>
        <p className="text-xs text-muted">{t('rentals.signers_note')}</p>
        <ul className="divide-y divide-line">
          {groups.signers.map((x) => (
            <li key={x.id} className="py-2 text-sm" data-testid="lease-signer">
              <Link className="underline" href={`${tenantHref}/${x.id}`}>
                {x.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-semibold">{t('rentals.cosigners')}</h3>
        <p className="text-xs text-muted">{t('rentals.cosigners_note')}</p>
        {groups.cosigners.length === 0 ? (
          <p className="text-sm text-muted">{t('rentals.none_listed')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {groups.cosigners.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                data-testid="lease-cosigner"
              >
                <span>
                  {p.tenantId ? (
                    <Link className="font-medium underline" href={`${tenantHref}/${p.tenantId}`}>
                      {p.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{p.name}</span>
                  )}{' '}
                  <span className="text-muted">
                    <ContactLinks phone={p.phone} email={p.email} />
                  </span>
                </span>
                <button type="button" className="underline" disabled={busy} onClick={() => remove(p.id)}>
                  {t('rentals.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="text-sm font-semibold">{t('rentals.occupants')}</h3>
        <p className="text-xs text-muted">{t('rentals.occupants_note')}</p>
        {groups.occupants.length === 0 ? (
          <p className="text-sm text-muted">{t('rentals.none_listed')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {groups.occupants.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                data-testid="lease-occupant"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  {p.relationship && <span className="text-muted">{p.relationship}</span>}
                  {p.hasDateOfBirth && (
                    <span className="text-muted">
                      {t('rentals.date_of_birth')}:{' '}
                      <RevealValue
                        masked={maskedDateOfBirth(p.hasDateOfBirth)}
                        label={t('rentals.date_of_birth')}
                        format={(v) => (v ? date(v) : '—')}
                        load={() =>
                          browserApi
                            .revealLeasePersonDateOfBirth(workspaceId, p.id)
                            .then((r) => r.dateOfBirth)
                        }
                      />
                    </span>
                  )}
                </span>
                <button type="button" className="underline" disabled={busy} onClick={() => remove(p.id)}>
                  {t('rentals.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        className="space-y-2 border-t border-line pt-3"
        aria-label={t('rentals.add_person')}
        onSubmit={(e) => {
          e.preventDefault();
          const built = buildLeasePerson(draft, today, t);
          if (!built.ok) return setMessage({ tone: 'bad', text: built.error });
          void run(
            () => browserApi.addLeasePerson(workspaceId, lease.id, built.value),
            t('rentals.person_added'),
          ).then((r) => {
            if (r) setDraft(emptyPerson(draft.role));
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label>
            <span className="field-label">{t('rentals.person_role')}</span>
            <select
              className="input"
              value={draft.role}
              onChange={(e) => setDraft(emptyPerson(e.target.value as PersonFormFields['role']))}
            >
              <option value="cosigner">{t('rentals.person_role_cosigner')}</option>
              <option value="occupant">{t('rentals.person_role_occupant')}</option>
            </select>
          </label>
          {draft.role === 'cosigner' && tenants.length > 0 && (
            <label>
              <span className="field-label">{t('rentals.existing_tenant')}</span>
              <select
                className="input"
                value={draft.tenantId}
                onChange={(e) => set({ tenantId: e.target.value })}
              >
                <option value="">{t('rentals.someone_new')}</option>
                {tenants
                  .filter((x) => !lease.tenants.some((s) => s.id === x.id))
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {!draft.tenantId && field(t('rentals.person_name'), 'name', { maxLength: 200 })}
          {draft.role === 'occupant' && field(t('rentals.relationship'), 'relationship', { maxLength: 100 })}
          {draft.role === 'cosigner' &&
            !draft.tenantId &&
            field(t('rentals.phone'), 'phone', { maxLength: 50 })}
          {draft.role === 'cosigner' &&
            !draft.tenantId &&
            field(t('rentals.email'), 'email', { type: 'email' })}
          {draft.role === 'occupant' && field(t('rentals.date_of_birth'), 'dateOfBirth', { type: 'date' })}
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('rentals.add_person')}
          </button>
        </div>
      </form>
      <StatusLine message={message} />
    </section>
  );
}

/**
 * The broker and what the lease cost to set up (RNT-19): a broker's fee goes to Commissions (Schedule E line 8) and
 * legal or document fees to Legal & professional (line 10), tagged to the property and unit.
 */
export function LeaseCosts({
  workspaceId,
  lease,
  contacts,
  accounts,
  today,
  base,
}: {
  workspaceId: string;
  lease: LeaseDto;
  contacts: RentalContactDto[];
  accounts: AccountDto[];
  today: string;
  /** The workspace's path, for links to transactions. */
  base: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const ccy = lease.currency;
  const brokers = brokerContacts(contacts);
  const live = contacts.filter((c) => !c.archived);
  const [brokerId, setBrokerId] = useState(lease.brokerContactId ?? '');
  const [kind, setKind] = useState<(typeof LEASE_COST_KINDS)[number]>('broker_fee');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [contactId, setContactId] = useState(lease.brokerContactId ?? '');
  const [notes, setNotes] = useState('');
  return (
    <section className="card space-y-3" aria-labelledby="costs-title">
      <h2 id="costs-title" className="text-base font-semibold">
        {t('rentals.broker_and_costs')}
      </h2>
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('rentals.broker')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              browserApi.updateLease(workspaceId, lease.id, {
                brokerContactId: brokerId || null,
                version: lease.version,
              }),
            t('rentals.broker_saved'),
          );
        }}
      >
        <label>
          <span className="field-label">{t('rentals.broker')}</span>
          <select className="input" value={brokerId} onChange={(e) => setBrokerId(e.target.value)}>
            <option value="">{t('rentals.no_broker')}</option>
            {brokers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName}
                {c.contactPerson ? ` (${c.contactPerson})` : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('rentals.save')}
        </button>
        {brokers.length === 0 && <span className="text-xs text-muted">{t('rentals.broker_hint')}</span>}
      </form>
      {lease.costs.length > 0 && (
        <ul className="divide-y divide-line">
          {lease.costs.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="lease-cost"
            >
              <a className="text-sm underline" href={`${base}/transactions/${c.transactionId}`}>
                <DateText date={c.date} /> · {t(`rentals.cost_kind_${c.kind}`)} ·{' '}
                <Money amount={c.amount} currency={ccy} />
                {c.contactName ? ` · ${c.contactName}` : ''}
                {c.notes ? ` · ${c.notes}` : ''}
              </a>
              <button
                type="button"
                className="text-sm underline"
                disabled={busy}
                onClick={() =>
                  run(
                    () => browserApi.removeLeaseCost(workspaceId, lease.id, c.id),
                    t('rentals.cost_removed'),
                  )
                }
              >
                {t('rentals.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('rentals.record_cost')}
        onSubmit={(e) => {
          e.preventDefault();
          const a = positiveMinor(amount, ccy, t);
          if (!a.ok) return setMessage({ tone: 'bad', text: a.error });
          void run(
            () =>
              browserApi.addLeaseCost(workspaceId, lease.id, {
                kind,
                accountId,
                date: date as never,
                amount: a.value,
                contactId: contactId || null,
                notes: notes.trim() || null,
              }),
            t('rentals.cost_recorded'),
          ).then((r) => {
            if (r) {
              setAmount('');
              setNotes('');
            }
          });
        }}
      >
        <label>
          <span className="field-label">{t('rentals.cost_kind')}</span>
          <select
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof LEASE_COST_KINDS)[number])}
          >
            {LEASE_COST_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`rentals.cost_kind_${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('rentals.amount')}</span>
          <input
            className="input w-32"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.date')}</span>
          <input
            className="input"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.paid_from')}</span>
          <select className="input" required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('rentals.paid_to')}</span>
          <select className="input" value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">{t('rentals.no_contact')}</option>
            {live.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('rentals.notes')}</span>
          <input className="input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button type="submit" className="btn-secondary" disabled={busy || !accountId}>
          {t('rentals.record_cost')}
        </button>
      </form>
      <p className="text-xs text-muted">{t('rentals.cost_posting_note')}</p>
      <p className="text-xs text-muted" data-testid="amortization-note">
        {t('rentals.commission_amortization_note')}
      </p>
      <StatusLine message={message} />
    </section>
  );
}
