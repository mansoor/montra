'use client';

import type { ProvidersDto } from '@montra/api-client';
import { useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

const SMS_KINDS = ['codes', 'security', 'reminders'] as const;

/**
 * ADR-0049 §5: each provider's state, and the settings that aren't secret. Keys are set where Montra runs, never here,
 * and this page can't change one.
 */
export function ProvidersPanel({ providers }: { providers: ProvidersDto }) {
  const { run, busy, message, t } = useAction();
  const { locale } = useI18n();
  const s = providers.settings;
  const [fromName, setFromName] = useState(s.mailFromName);
  const [fromAddress, setFromAddress] = useState(s.mailFromAddress);
  const [support, setSupport] = useState(s.supportEmail);
  const [kinds, setKinds] = useState<string[]>(s.smsKinds);
  const [countries, setCountries] = useState(s.smsCountries.join(', '));
  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
      : '—';
  return (
    <section className="space-y-4" aria-label={t('admin.tab.providers')}>
      <p className="text-sm text-muted">{t('admin.providers_hint')}</p>
      <div className="card-flush overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th className="px-3 py-2">{t('admin.provider')}</th>
              <th className="px-3 py-2">{t('admin.provider_state')}</th>
              <th className="px-3 py-2">{t('admin.provider_details')}</th>
              <th className="px-3 py-2">{t('admin.provider_last_ok')}</th>
              <th className="px-3 py-2">{t('admin.provider_last_failure')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {providers.rows.map((r) => (
              <tr key={r.key} data-testid={`provider-${r.key}`}>
                <td className="px-3 py-2 text-sm font-medium">{t(`admin.provider.${r.key}`)}</td>
                <td className="px-3 py-2 text-sm">
                  {t(r.configured ? 'admin.provider_on' : 'admin.provider_off')} · {r.mode}
                </td>
                <td className="px-3 py-2 text-xs text-muted">
                  {r.details.map((d) => `${t(`admin.provider_detail.${d.label}`)}: ${d.value}`).join(' · ')}
                  {r.key === 'email' && <span className="block">{t('admin.provider_kratos_note')}</span>}
                </td>
                <td className="px-3 py-2 text-xs">{when(r.lastOkAt)}</td>
                <td className="px-3 py-2 text-xs">
                  {when(r.lastFailureAt)}
                  {r.lastFailure && <span className="block text-muted">{r.lastFailure}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            void run(
              () => browserApi.adminTestEmail(),
              (r) => t('admin.test_sent', { to: r.to }),
            )
          }
        >
          {t('admin.test_email')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            void run(
              () => browserApi.adminTestText(),
              (r) => t('admin.test_sent', { to: r.to }),
            )
          }
        >
          {t('admin.test_text')}
        </button>
      </div>
      <form
        className="card space-y-3"
        aria-label={t('admin.provider_settings')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              browserApi.adminSaveProviderSettings({
                mailFromName: fromName,
                mailFromAddress: fromAddress,
                supportEmail: support,
                smsKinds: kinds as ProvidersDto['settings']['smsKinds'],
                smsCountries: countries
                  .split(',')
                  .map((c) => c.trim())
                  .filter(Boolean),
              }),
            t('admin.saved'),
          );
        }}
      >
        <h2 className="text-base font-semibold">{t('admin.provider_settings')}</h2>
        <div className="flex flex-wrap gap-3">
          <label>
            <span className="field-label">{t('admin.mail_from_name')}</span>
            <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t('admin.mail_from_address')}</span>
            <input
              className="input"
              type="email"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.support_email')}</span>
            <input
              className="input"
              type="email"
              value={support}
              onChange={(e) => setSupport(e.target.value)}
            />
          </label>
        </div>
        <fieldset className="flex flex-wrap gap-3 text-sm">
          <legend className="field-label">{t('admin.sms_kinds')}</legend>
          {SMS_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                onChange={(e) =>
                  setKinds((cur) => (e.target.checked ? [...cur, k] : cur.filter((x) => x !== k)))
                }
              />
              {t(`admin.sms_kind.${k}`)}
            </label>
          ))}
        </fieldset>
        <label className="block">
          <span className="field-label">{t('admin.sms_countries')}</span>
          <input className="input" value={countries} onChange={(e) => setCountries(e.target.value)} />
          <span className="block text-xs text-muted">{t('admin.sms_countries_hint')}</span>
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('admin.save')}
        </button>
      </form>
      <StatusLine message={message} />
    </section>
  );
}
