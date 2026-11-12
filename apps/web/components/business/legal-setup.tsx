'use client';

import { useState } from 'react';
import type { BusinessProfileDto, BusinessRevealField, OtherRegistrationDto } from '@montra/api-client';
import { electsSCorp, filesScheduleC, ownerPayOf, returnFormOf } from '@montra/domain';
import { browserApi } from '@/lib/browser-api';
import {
  BUSINESS_TYPES,
  legalFormOf,
  legalPatch,
  registrationsFormOf,
  registrationsPatch,
  zipText,
  type LegalForm,
  type RegistrationsForm,
} from '@/lib/business-registration';
import { DateText, useI18n } from '../i18n';
import { RevealValue } from '../payroll/reveal';
import { StatusLine, useAction } from '../use-action';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** "July", in the reader's language. */
export function monthName(month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, month - 1, 1)),
  );
}

/**
 * BIZ-21 (ADR-0037 §1–2): the entity type, the federal return it files, the S-corp election and the fiscal year. Only an
 * owner can change the type or the fiscal year; the API says so to anyone else.
 */
export function LegalSetupForm({
  workspaceId,
  profile,
}: {
  workspaceId: string;
  profile: BusinessProfileDto;
}) {
  const { locale } = useI18n();
  const { run, busy, message, setMessage, t } = useAction();
  const [f, setF] = useState<LegalForm>(legalFormOf(profile));
  const form = returnFormOf(f.businessType || profile.businessType);
  const pay = ownerPayOf(f.businessType || profile.businessType);
  const set = (k: keyof LegalForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const legacy =
    profile.businessType && !(BUSINESS_TYPES as readonly string[]).includes(profile.businessType);

  return (
    <form
      id="legal"
      className="card space-y-3"
      aria-label={t('setup.title')}
      onSubmit={(e) => {
        e.preventDefault();
        const patch = legalPatch(profile, f);
        if (Object.keys(patch).length === 0) return setMessage({ tone: 'good', text: t('setup.saved') });
        void run(() => browserApi.updateBusiness(workspaceId, profile.entityId, patch), t('setup.saved'));
      }}
    >
      <div>
        <h2 className="text-base font-semibold">{t('setup.title')}</h2>
        <p className="text-sm text-muted">{t('setup.hint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="field-label">{t('setup.entity_type')}</span>
          <select className="input" value={f.businessType} onChange={set('businessType')}>
            {!f.businessType && <option value="">{t('setup.type_unset')}</option>}
            {legacy && (
              <option value={profile.businessType!}>{t(`setup.type.${profile.businessType}`)}</option>
            )}
            {BUSINESS_TYPES.map((k) => (
              <option key={k} value={k}>
                {t(`setup.type.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="field-label">{t('setup.return_form')}</span>
          <p className="py-2 text-sm" data-testid="return-form">
            {form ? t(`setup.form.${form}`) : t('setup.form_unknown')}
          </p>
        </div>
        {electsSCorp(f.businessType) && (
          <label>
            <span className="field-label">{t('setup.s_corp_election')}</span>
            <input
              className="input"
              type="date"
              value={f.sCorpElectionDate}
              onChange={set('sCorpElectionDate')}
            />
          </label>
        )}
        <label>
          <span className="field-label">{t('setup.fiscal_year_start')}</span>
          <select className="input" value={f.fiscalYearStartMonth} onChange={set('fiscalYearStartMonth')}>
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {monthName(m, locale)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-muted">{t('setup.fiscal_hint')}</p>
      {pay && <p className="text-sm">{t(`setup.owner_pay.${pay}`)}</p>}
      {!filesScheduleC(f.businessType || profile.businessType) && form && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn" role="note">
          {t('setup.guide_only', { form: t(`setup.form.${form}`) })}
        </p>
      )}
      <p className="text-xs text-muted">{t('setup.owner_only')}</p>
      <button type="submit" className="btn-primary" disabled={busy}>
        {t('setup.save')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

/** BIZ-22..23: federal, California and local registrations. Tax account numbers are masked; Show reveals one, logged. */
export function RegistrationsForm({
  workspaceId,
  profile,
}: {
  workspaceId: string;
  profile: BusinessProfileDto;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [f, setF] = useState<RegistrationsForm>(registrationsFormOf(profile));
  const r = profile.registrations;
  const set = (k: keyof RegistrationsForm) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const reveal = (field: BusinessRevealField) => () =>
    browserApi.revealBusinessId(workspaceId, profile.entityId, field).then((v) => v.value);

  const text = (k: keyof RegistrationsForm, label: string, max: number, extra: object = {}) => (
    <label key={k}>
      <span className="field-label">{label}</span>
      <input className="input" maxLength={max} value={f[k]} onChange={set(k)} {...extra} />
    </label>
  );
  const date = (k: keyof RegistrationsForm, label: string) => (
    <label key={k}>
      <span className="field-label">{label}</span>
      <input className="input" type="date" value={f[k]} onChange={set(k)} />
    </label>
  );
  const masked = (
    k: 'ein' | 'ftbEntityId' | 'caEmployerAccount' | 'cdtfaPermit',
    label: string,
    current: string | null,
    placeholder: string,
    format?: (v: string) => string,
  ) => (
    <div key={k}>
      <label>
        <span className="field-label">{label}</span>
        <input
          className="input num"
          autoComplete="off"
          placeholder={current ? t('registrations.keep_hint') : placeholder}
          value={f[k]}
          onChange={set(k)}
        />
      </label>
      {current && (
        <p className="mt-1 text-sm" data-testid={`registration-${k}`}>
          <RevealValue masked={current} load={reveal(k)} format={format} label={label} />
        </p>
      )}
    </div>
  );

  return (
    <form
      id="registrations"
      className="card space-y-4"
      aria-label={t('registrations.title')}
      onSubmit={(e) => {
        e.preventDefault();
        const patch = registrationsPatch(profile, f);
        if (Object.keys(patch).length === 0)
          return setMessage({ tone: 'good', text: t('registrations.saved') });
        void run(
          () => browserApi.updateBusiness(workspaceId, profile.entityId, patch),
          t('registrations.saved'),
        ).then((res) => {
          // Typed numbers are saved; the fields go back to empty under the new masked value.
          if (res) setF((x) => ({ ...x, ein: '', ftbEntityId: '', caEmployerAccount: '', cdtfaPermit: '' }));
        });
      }}
    >
      <div>
        <h2 className="text-base font-semibold">{t('registrations.title')}</h2>
        <p className="text-sm text-muted">{t('registrations.hint')}</p>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">{t('registrations.federal')}</legend>
        {masked(
          'ein',
          t('registrations.ein'),
          r.einMasked,
          '12-3456789',
          (v) => `${v.slice(0, 2)}-${v.slice(2)}`,
        )}
        {text('irsName', t('registrations.irs_name'), 200)}
        {text('naicsCode', t('registrations.naics'), 6, { inputMode: 'numeric' })}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">{t('registrations.state')}</legend>
        {text('formationState', t('registrations.formation_state'), 2, { className: 'input uppercase' })}
        {text('sosEntityNumber', t('registrations.sos_number'), 30)}
        {date('formationDate', t('registrations.formation_date'))}
        {masked('ftbEntityId', t('registrations.ftb_id'), r.ftbEntityIdMasked, '1234567')}
        {masked(
          'caEmployerAccount',
          t('registrations.edd_account'),
          r.caEmployerAccountMasked,
          '123-4567-8',
          (v) => `${v.slice(0, 3)}-${v.slice(3, 7)}-${v.slice(7)}`,
        )}
        {masked('cdtfaPermit', t('registrations.cdtfa_permit'), r.cdtfaPermitMasked, '123-456789')}
        {text('registeredAgentName', t('registrations.agent_name'), 200)}
        <label className="sm:col-span-2">
          <span className="field-label">{t('registrations.agent_address')}</span>
          <textarea
            className="input"
            rows={2}
            maxLength={1000}
            value={f.registeredAgentAddress}
            onChange={set('registeredAgentAddress')}
          />
        </label>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">{t('registrations.local')}</legend>
        {text('dbaName', t('registrations.dba_name'), 200)}
        {text('dbaCounty', t('registrations.dba_county'), 60)}
        {date('dbaExpiresOn', t('registrations.dba_expires'))}
        {text('cityLicenseNumber', t('registrations.city_license'), 50)}
        {date('cityLicenseExpiresOn', t('registrations.city_license_expires'))}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">{t('registrations.filing_address')}</legend>
        <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{t('registrations.filing_hint')}</p>
        {text('line1', t('payroll.year_end.street'), 100)}
        {text('line2', t('payroll.year_end.suite'), 100)}
        {text('city', t('payroll.year_end.city'), 60)}
        {text('state', t('payroll.year_end.state'), 2, { className: 'input uppercase' })}
        <label>
          <span className="field-label">{t('payroll.year_end.zip')}</span>
          <input
            className="input num"
            inputMode="numeric"
            maxLength={10}
            value={zipText(f.zip)}
            onChange={set('zip')}
          />
        </label>
      </fieldset>

      <button type="submit" className="btn-primary" disabled={busy}>
        {t('registrations.save')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

/** BIZ-24: registrations beyond the named ones, each with an optional expiry that gets a "renew by" reminder. */
export function OtherRegistrations({
  workspaceId,
  entityId,
  items,
  today,
}: {
  workspaceId: string;
  entityId: string;
  items: OtherRegistrationDto[];
  today: string;
}) {
  const { run, busy, message, t } = useAction();
  const blank = { label: '', number: '', issuer: '', expiresOn: '' };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <section className="card space-y-3" aria-labelledby="other-registrations">
      <h2 id="other-registrations" className="text-base font-semibold">
        {t('registrations.other')}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted">{t('registrations.other_empty')}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {items.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{o.label}</span>
                {o.number && <span className="num"> · {o.number}</span>}
                {o.issuer && <span className="text-muted"> · {o.issuer}</span>}
                {o.expiresOn && (
                  <span className={o.expiresOn < today ? 'text-bad' : 'text-muted'}>
                    {' · '}
                    {t('registrations.expires_on')} <DateText date={o.expiresOn} />
                  </span>
                )}
              </span>
              <button
                type="button"
                className="text-sm underline"
                disabled={busy}
                aria-label={`${t('registrations.remove')} ${o.label}`}
                onClick={() =>
                  void run(
                    () => browserApi.removeBusinessRegistration(workspaceId, entityId, o.id),
                    t('registrations.removed'),
                  )
                }
              >
                {t('registrations.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label={t('registrations.add')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              browserApi.addBusinessRegistration(workspaceId, entityId, {
                label: f.label.trim(),
                number: f.number.trim() || null,
                issuer: f.issuer.trim() || null,
                expiresOn: f.expiresOn || null,
              }),
            t('registrations.added'),
          ).then((res) => {
            if (res) setF(blank);
          });
        }}
      >
        <label>
          <span className="field-label">{t('registrations.label')}</span>
          <input className="input" required maxLength={200} value={f.label} onChange={set('label')} />
        </label>
        <label>
          <span className="field-label">{t('registrations.number')}</span>
          <input className="input" maxLength={100} value={f.number} onChange={set('number')} />
        </label>
        <label>
          <span className="field-label">{t('registrations.issuer')}</span>
          <input className="input" maxLength={200} value={f.issuer} onChange={set('issuer')} />
        </label>
        <label>
          <span className="field-label">{t('registrations.expires')}</span>
          <input className="input" type="date" value={f.expiresOn} onChange={set('expiresOn')} />
        </label>
        <div className="sm:col-span-2 lg:col-span-4">
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('registrations.add')}
          </button>
        </div>
      </form>
      <p className="text-xs text-muted">{t('registrations.renew_hint')}</p>
      <StatusLine message={message} />
    </section>
  );
}
