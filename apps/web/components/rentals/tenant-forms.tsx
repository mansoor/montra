'use client';

import { useState, type ReactNode } from 'react';
import type { TenantDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput } from '@/lib/money';
import {
  buildTenantDetails,
  mailtoHref,
  maskedDateOfBirth,
  telHref,
  type TenantFormFields,
} from '@/lib/rentals';
import { useI18n } from '../i18n';
import { Money } from '../money';
import { RevealValue } from '../payroll/reveal';
import { StatusLine, useAction } from '../use-action';

const fieldsOf = (x: TenantDto, currency: string): TenantFormFields => ({
  name: x.name,
  email: x.email ?? '',
  phone: x.phone ?? '',
  phoneAlt: x.phoneAlt ?? '',
  mailingAddress: x.mailingAddress ?? '',
  dateOfBirth: '',
  dateOfBirthChanged: false,
  emergencyName: x.emergencyName ?? '',
  emergencyRelationship: x.emergencyRelationship ?? '',
  emergencyPhone: x.emergencyPhone ?? '',
  employer: x.employer ?? '',
  monthlyIncome: x.monthlyIncome !== null ? minorToInput(BigInt(x.monthlyIncome), currency) : '',
  vehicle: x.vehicle ?? '',
  notes: x.notes ?? '',
});

function Phone({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  const href = telHref(value);
  return href ? (
    <a className="underline" href={href}>
      {value}
    </a>
  ) : (
    <>{value}</>
  );
}

/**
 * A tenant's details (RNT-17). The date of birth is never on the page: it shows masked, Show reads it after a recent
 * sign-in, and the form changes it only when a new one is typed or it's cleared.
 */
export function TenantDetails({
  workspaceId,
  tenant,
  currency,
  today,
}: {
  workspaceId: string;
  tenant: TenantDto;
  currency: string;
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { date } = useI18n();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<TenantFormFields>(() => fieldsOf(tenant, currency));
  const set = (patch: Partial<TenantFormFields>) => setF({ ...f, ...patch });
  const text = (label: string, key: keyof TenantFormFields, extra: object = {}) => (
    <label>
      <span className="field-label">{label}</span>
      <input
        className="input"
        value={f[key] as string}
        onChange={(e) => set({ [key]: e.target.value })}
        {...extra}
      />
    </label>
  );
  const row = (label: string, value: ReactNode, testId?: string) => (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd data-testid={testId}>{value ?? '—'}</dd>
    </div>
  );
  const mail = mailtoHref(tenant.email);
  return (
    <section className="card space-y-3" aria-labelledby="tenant-details-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="tenant-details-title" className="text-base font-semibold">
          {t('rentals.tenant_details')}
        </h2>
        {!editing && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setF(fieldsOf(tenant, currency));
              setEditing(true);
            }}
          >
            {t('rentals.edit_details')}
          </button>
        )}
      </div>
      {!editing ? (
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {row(
            t('rentals.email'),
            tenant.email ? (
              mail ? (
                <a className="underline" href={mail}>
                  {tenant.email}
                </a>
              ) : (
                tenant.email
              )
            ) : null,
          )}
          {row(t('rentals.phone'), <Phone value={tenant.phone} />)}
          {row(t('rentals.phone_alt'), <Phone value={tenant.phoneAlt} />)}
          {row(
            t('rentals.mailing_address'),
            tenant.mailingAddress && <span className="whitespace-pre-line">{tenant.mailingAddress}</span>,
          )}
          {row(
            t('rentals.date_of_birth'),
            tenant.hasDateOfBirth ? (
              <RevealValue
                masked={maskedDateOfBirth(tenant.hasDateOfBirth)}
                label={t('rentals.date_of_birth')}
                format={(v) => (v ? date(v) : '—')}
                load={() =>
                  browserApi.revealTenantDateOfBirth(workspaceId, tenant.id).then((r) => r.dateOfBirth)
                }
              />
            ) : null,
            'tenant-dob',
          )}
          {row(
            t('rentals.emergency_contact'),
            tenant.emergencyName ? (
              <>
                {tenant.emergencyName}
                {tenant.emergencyRelationship ? ` (${tenant.emergencyRelationship})` : ''}
                {tenant.emergencyPhone ? (
                  <>
                    {' · '}
                    <Phone value={tenant.emergencyPhone} />
                  </>
                ) : null}
              </>
            ) : null,
          )}
          {row(t('rentals.employer'), tenant.employer)}
          {row(
            t('rentals.monthly_income'),
            tenant.monthlyIncome !== null ? (
              <Money amount={tenant.monthlyIncome} currency={currency} />
            ) : null,
          )}
          {row(t('rentals.vehicle'), tenant.vehicle)}
          {row(
            t('rentals.notes'),
            tenant.notes && <span className="whitespace-pre-line">{tenant.notes}</span>,
          )}
        </dl>
      ) : (
        <form
          className="space-y-3"
          aria-label={t('rentals.edit_details')}
          onSubmit={(e) => {
            e.preventDefault();
            const res = buildTenantDetails(f, currency, today, t);
            if (!res.ok) return setMessage({ tone: 'bad', text: res.error });
            void run(
              () =>
                browserApi.updateTenant(workspaceId, tenant.id, { ...res.value, version: tenant.version }),
              t('rentals.tenant_saved'),
            ).then((r) => {
              if (r) setEditing(false);
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {text(t('rentals.tenant_name'), 'name', { required: true, maxLength: 200 })}
            {text(t('rentals.email'), 'email', { type: 'email', maxLength: 320 })}
            {text(t('rentals.phone'), 'phone', { maxLength: 50 })}
            {text(t('rentals.phone_alt'), 'phoneAlt', { maxLength: 50 })}
            <label className="sm:col-span-2">
              <span className="field-label">{t('rentals.mailing_address')}</span>
              <textarea
                className="input"
                rows={2}
                maxLength={1000}
                value={f.mailingAddress}
                onChange={(e) => set({ mailingAddress: e.target.value })}
              />
            </label>
            <div>
              <label>
                <span className="field-label">{t('rentals.date_of_birth')}</span>
                <input
                  className="input"
                  type="date"
                  max={today}
                  value={f.dateOfBirth}
                  onChange={(e) => set({ dateOfBirth: e.target.value, dateOfBirthChanged: true })}
                />
              </label>
              <span className="block text-xs text-muted">
                {tenant.hasDateOfBirth
                  ? f.dateOfBirthChanged && !f.dateOfBirth
                    ? t('rentals.dob_will_clear')
                    : t('rentals.dob_on_file')
                  : t('rentals.dob_optional')}
              </span>
              {tenant.hasDateOfBirth && !(f.dateOfBirthChanged && !f.dateOfBirth) && (
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => set({ dateOfBirth: '', dateOfBirthChanged: true })}
                >
                  {t('rentals.dob_clear')}
                </button>
              )}
            </div>
            {text(t('rentals.emergency_name'), 'emergencyName', { maxLength: 200 })}
            {text(t('rentals.emergency_relationship'), 'emergencyRelationship', { maxLength: 100 })}
            {text(t('rentals.emergency_phone'), 'emergencyPhone', { maxLength: 50 })}
            {text(t('rentals.employer'), 'employer', { maxLength: 200 })}
            {text(t('rentals.monthly_income'), 'monthlyIncome', { inputMode: 'decimal' })}
            {text(t('rentals.vehicle'), 'vehicle', { maxLength: 200 })}
            <label className="sm:col-span-2 lg:col-span-3">
              <span className="field-label">{t('rentals.notes')}</span>
              <textarea
                className="input"
                rows={3}
                maxLength={2000}
                value={f.notes}
                onChange={(e) => set({ notes: e.target.value })}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('rentals.save')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      <p className="text-xs text-muted">{t('rentals.tenant_privacy_note')}</p>
      <StatusLine message={message} />
    </section>
  );
}
