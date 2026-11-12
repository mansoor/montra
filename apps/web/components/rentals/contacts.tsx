'use client';

import { useState } from 'react';
import type { RentalContactDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  buildContact,
  CONTACT_ROLES,
  contactFields,
  contactsForProperty,
  contactsToLink,
  emptyContact,
  mailtoHref,
  telHref,
  websiteHref,
  type ContactFormFields,
} from '@/lib/rentals';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/** The contact form's fields, shared by adding and editing. */
function ContactFieldset({
  f,
  onChange,
}: {
  f: ContactFormFields;
  onChange: (next: ContactFormFields) => void;
}) {
  const { t } = useI18n();
  const text = (label: string, key: Exclude<keyof ContactFormFields, 'role'>, extra: object = {}) => (
    <label>
      <span className="field-label">{label}</span>
      <input
        className="input"
        value={f[key]}
        onChange={(e) => onChange({ ...f, [key]: e.target.value })}
        {...extra}
      />
    </label>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label>
        <span className="field-label">{t('rentals.contact_role')}</span>
        <select
          className="input"
          value={f.role}
          onChange={(e) => onChange({ ...f, role: e.target.value as ContactFormFields['role'] })}
        >
          {CONTACT_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`rentals.contact_role_${r}`)}
            </option>
          ))}
        </select>
      </label>
      {text(t('rentals.company_name'), 'companyName', { required: true, maxLength: 200 })}
      {text(t('rentals.contact_person'), 'contactPerson', { maxLength: 200 })}
      {text(t('rentals.phone'), 'phone', { maxLength: 50, type: 'tel' })}
      {text(t('rentals.email'), 'email', { maxLength: 320, type: 'email' })}
      {text(t('rentals.website'), 'website', { maxLength: 500, placeholder: 'example.com' })}
      {text(t('rentals.account_number'), 'accountNumber', { maxLength: 100 })}
      <label className="sm:col-span-2">
        <span className="field-label">{t('rentals.notes')}</span>
        <input
          className="input"
          maxLength={2000}
          value={f.notes}
          onChange={(e) => onChange({ ...f, notes: e.target.value })}
        />
      </label>
    </div>
  );
}

function ContactRow({
  workspaceId,
  contact: c,
  propertyId,
}: {
  workspaceId: string;
  contact: RentalContactDto;
  propertyId: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<ContactFormFields>(() => contactFields(c));
  const tel = telHref(c.phone);
  const mail = mailtoHref(c.email);
  const web = websiteHref(c.website);
  const others = c.propertyIds.filter((id) => id !== propertyId).length;
  return (
    <li className="space-y-2 py-3" data-testid="contact-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-sm">
          <span className="chip mr-2">{t(`rentals.contact_role_${c.role}`)}</span>
          <span className="font-medium">{c.companyName}</span>
          {c.contactPerson && <span className="text-muted"> · {c.contactPerson}</span>}
          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {c.phone &&
              (tel ? (
                <a className="underline" href={tel} data-testid="contact-phone">
                  {c.phone}
                </a>
              ) : (
                <span>{c.phone}</span>
              ))}
            {c.email &&
              (mail ? (
                <a className="underline" href={mail} data-testid="contact-email">
                  {c.email}
                </a>
              ) : (
                <span>{c.email}</span>
              ))}
            {c.website &&
              (web ? (
                <a
                  className="underline"
                  href={web}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="contact-website"
                >
                  {c.website}
                </a>
              ) : (
                <span>{c.website}</span>
              ))}
          </span>
          {c.accountNumber && (
            <span className="block text-xs text-muted">
              {t('rentals.account_number')}: {c.accountNumber}
            </span>
          )}
          {c.notes && <span className="block text-xs text-muted">{c.notes}</span>}
          {others > 0 && (
            <span className="block text-xs text-muted">{t('rentals.contact_shared', { count: others })}</span>
          )}
        </div>
        <span className="flex flex-wrap gap-3 text-sm">
          <button
            type="button"
            className="underline"
            disabled={busy}
            onClick={() => {
              setF(contactFields(c));
              setEditing(!editing);
            }}
          >
            {t('rentals.edit')}
          </button>
          <button
            type="button"
            className="underline"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  browserApi.updateRentalContact(workspaceId, c.id, {
                    propertyIds: c.propertyIds.filter((id) => id !== propertyId),
                    version: c.version,
                  }),
                t('rentals.contact_unlinked'),
              )
            }
          >
            {t('rentals.unlink')}
          </button>
          <button
            type="button"
            className="underline"
            disabled={busy}
            aria-label={t('rentals.delete_named', { name: c.companyName })}
            onClick={() => {
              if (!window.confirm(t('rentals.contact_delete_confirm', { name: c.companyName }))) return;
              void run(() => browserApi.deleteRentalContact(workspaceId, c.id), t('rentals.deleted'));
            }}
          >
            {t('rentals.delete')}
          </button>
        </span>
      </div>
      {editing && (
        <form
          className="space-y-2"
          aria-label={t('rentals.edit_contact')}
          onSubmit={(e) => {
            e.preventDefault();
            const res = buildContact(f, t);
            if (!res.ok) return setMessage({ tone: 'bad', text: res.error });
            void run(
              () => browserApi.updateRentalContact(workspaceId, c.id, { ...res.value, version: c.version }),
              t('rentals.contact_saved'),
            ).then((r) => {
              if (r) setEditing(false);
            });
          }}
        >
          <ContactFieldset f={f} onChange={setF} />
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('rentals.save')}
          </button>
        </form>
      )}
      <StatusLine message={message} />
    </li>
  );
}

/**
 * A property's contacts (RNT-21): its manager, handyman, insurer, HOA, utilities and so on. A contact belongs to the
 * portfolio, so one insurer can serve several properties; linking and unlinking here changes only this property.
 */
export function PropertyContacts({
  workspaceId,
  entityId,
  propertyId,
  contacts,
}: {
  workspaceId: string;
  entityId: string;
  propertyId: string;
  /** All of the portfolio's contacts. */
  contacts: RentalContactDto[];
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const here = contactsForProperty(contacts, propertyId);
  const linkable = contactsToLink(contacts, propertyId);
  const [f, setF] = useState<ContactFormFields>(emptyContact());
  const [linkId, setLinkId] = useState('');
  return (
    <section className="card space-y-3" aria-labelledby="contacts-title">
      <h2 id="contacts-title" className="text-base font-semibold">
        {t('rentals.contacts')}
      </h2>
      {here.length === 0 ? (
        <p className="text-sm text-muted">{t('rentals.no_contacts')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {here.map((c) => (
            <ContactRow
              key={`${c.id}-${c.version}`}
              workspaceId={workspaceId}
              contact={c}
              propertyId={propertyId}
            />
          ))}
        </ul>
      )}
      {linkable.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
          aria-label={t('rentals.link_contact')}
          onSubmit={(e) => {
            e.preventDefault();
            const c = linkable.find((x) => x.id === linkId);
            if (!c) return setMessage({ tone: 'bad', text: t('rentals.choose_contact') });
            void run(
              () =>
                browserApi.updateRentalContact(workspaceId, c.id, {
                  propertyIds: [...c.propertyIds, propertyId],
                  version: c.version,
                }),
              t('rentals.contact_linked'),
            ).then((r) => {
              if (r) setLinkId('');
            });
          }}
        >
          <label>
            <span className="field-label">{t('rentals.existing_contact')}</span>
            <select className="input" value={linkId} onChange={(e) => setLinkId(e.target.value)}>
              <option value="">{t('rentals.choose')}</option>
              {linkable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName} ({t(`rentals.contact_role_${c.role}`)})
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('rentals.link_contact')}
          </button>
        </form>
      )}
      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer text-sm font-semibold">{t('rentals.add_contact')}</summary>
        <form
          className="mt-3 space-y-3"
          aria-label={t('rentals.add_contact')}
          onSubmit={(e) => {
            e.preventDefault();
            const res = buildContact(f, t);
            if (!res.ok) return setMessage({ tone: 'bad', text: res.error });
            void run(
              () =>
                browserApi.createRentalContact(workspaceId, {
                  entityId,
                  ...res.value,
                  propertyIds: [propertyId],
                }),
              t('rentals.contact_added'),
            ).then((r) => {
              if (r) setF(emptyContact(f.role));
            });
          }}
        >
          <ContactFieldset f={f} onChange={setF} />
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('rentals.add_contact')}
          </button>
        </form>
      </details>
      <StatusLine message={message} />
    </section>
  );
}
