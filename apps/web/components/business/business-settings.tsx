'use client';

import { useRef, useState } from 'react';
import type { AccountDto, BusinessProfileDto } from '@montra/api-client';
import { normalizeDomain } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage, errorAction } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { amountToInput } from '@/lib/receipts';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

const FORMATS = ['csv', 'xlsx', 'quickbooks_iif', 'xero_csv'] as const;

/** BIZ-01: how the business appears on invoices, and the accounts and thresholds it uses. */
export function BusinessProfileForm({
  workspaceId,
  profile,
  accounts,
}: {
  workspaceId: string;
  profile: BusinessProfileDto;
  accounts: AccountDto[];
}) {
  const { locale } = useI18n();
  const { run, busy, message, setMessage, t } = useAction();
  const [f, setF] = useState({
    legalName: profile.legalName ?? '',
    address: profile.address ?? '',
    email: profile.email ?? '',
    invoicePrefix: profile.invoicePrefix,
    terms: String(profile.defaultTermsDays),
    deposit: profile.defaultDepositAccountId ?? '',
    savings: profile.taxSavingsAccountId ?? '',
    threshold: amountToInput(profile.receiptThreshold, profile.currency),
    domain: profile.domain ?? '',
  });
  const set =
    (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <form
      className="card space-y-3"
      aria-label={t('business.profile')}
      onSubmit={(e) => {
        e.preventDefault();
        const threshold = parseAmountInput(f.threshold, profile.currency, locale, t);
        if (!threshold.ok) return setMessage({ tone: 'bad', text: threshold.error });
        const domain = f.domain.trim() ? normalizeDomain(f.domain) : null;
        if (f.domain.trim() && !domain)
          return setMessage({ tone: 'bad', text: t('business.domain_invalid') });
        if (domain) setF((x) => ({ ...x, domain }));
        void run(
          () =>
            browserApi.updateBusiness(workspaceId, profile.entityId, {
              legalName: f.legalName.trim() || null,
              address: f.address.trim() || null,
              email: f.email.trim() || null,
              invoicePrefix: f.invoicePrefix.trim(),
              defaultTermsDays: Number(f.terms),
              defaultDepositAccountId: f.deposit || null,
              taxSavingsAccountId: f.savings || null,
              receiptThreshold: String(threshold.minor),
              domain,
            }),
          t('business.profile_saved'),
        );
      }}
    >
      <h2 className="text-base font-semibold">{t('business.profile')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="field-label">{t('business.legal_name')}</span>
          <input className="input" maxLength={200} value={f.legalName} onChange={set('legalName')} />
        </label>
        <label>
          <span className="field-label">{t('business.email')}</span>
          <input className="input" type="email" value={f.email} onChange={set('email')} />
        </label>
        <label>
          <span className="field-label">{t('business.domain')}</span>
          <input
            className="input"
            maxLength={300}
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="example.com"
            aria-describedby="domain-hint"
            value={f.domain}
            onChange={set('domain')}
          />
          <span id="domain-hint" className="text-xs text-muted">
            {t('business.domain_hint')}
          </span>
        </label>
        <label className="sm:col-span-2">
          <span className="field-label">{t('business.address')}</span>
          <textarea className="input" rows={2} maxLength={1000} value={f.address} onChange={set('address')} />
        </label>
        <label>
          <span className="field-label">{t('business.invoice_prefix')}</span>
          <input className="input" maxLength={20} value={f.invoicePrefix} onChange={set('invoicePrefix')} />
        </label>
        <label>
          <span className="field-label">{t('business.terms')}</span>
          <input className="input" type="number" min={0} max={365} value={f.terms} onChange={set('terms')} />
        </label>
        <label>
          <span className="field-label">{t('business.deposit_account')}</span>
          <select className="input" value={f.deposit} onChange={set('deposit')}>
            <option value="">{t('business.none')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('business.tax_savings_account')}</span>
          <select className="input" value={f.savings} onChange={set('savings')}>
            <option value="">{t('business.none')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('business.receipt_threshold')}</span>
          <input className="input" inputMode="decimal" value={f.threshold} onChange={set('threshold')} />
        </label>
      </div>
      <button type="submit" className="btn-primary" disabled={busy}>
        {t('business.save_profile')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

/** ADR-0032: the logo on invoices. A PNG or JPEG up to 1 MB; the server checks what the file really is. */
export function BusinessLogoForm({
  workspaceId,
  profile,
}: {
  workspaceId: string;
  profile: BusinessProfileDto;
}) {
  const { run, busy, message, t } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const src = profile.logoFileId
    ? `/api${browserApi.businessLogoPath(workspaceId, profile.entityId, profile.logoFileId)}`
    : null;

  return (
    <section className="card space-y-3" aria-labelledby="logo-title" data-testid="business-logo">
      <div>
        <h2 id="logo-title" className="text-base font-semibold">
          {t('business.logo')}
        </h2>
        <p className="text-sm text-muted">{t('business.logo_hint')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-16 w-40 items-center justify-center rounded-lg border border-line bg-white p-2">
          {src ? (
            // A plain img: next/image would fetch it on the server, without the session.
            <img src={src} alt={t('business.logo_alt')} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-muted">{t('business.no_logo')}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg"
            className="sr-only"
            aria-label={t('business.logo_choose')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void run(
                () => browserApi.setBusinessLogo(workspaceId, profile.entityId, file, file.name),
                t('business.logo_saved'),
              );
            }}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {src ? t('business.logo_replace') : t('business.logo_choose')}
          </button>
          {src && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => browserApi.removeBusinessLogo(workspaceId, profile.entityId),
                  t('business.logo_removed'),
                )
              }
            >
              {t('business.logo_remove')}
            </button>
          )}
        </div>
      </div>
      <StatusLine message={message} />
    </section>
  );
}

/** BIZ-13: the journal as a file for an accountant or another system. */
export function ExportForm({
  workspaceId,
  entityId,
  from: defaultFrom,
  to: defaultTo,
}: {
  workspaceId: string;
  entityId: string;
  from: string;
  to: string;
}) {
  const { t } = useI18n();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('csv');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; action?: { href: string; label: string } } | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = await browserApi.downloadAccountingExport(workspaceId, {
        entityId,
        from,
        to,
        format,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError({ text: friendlyMessage(err, t), action: errorAction(err, t) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3" aria-labelledby="export-title">
      <h2 id="export-title" className="text-base font-semibold">
        {t('business.export')}
      </h2>
      <p className="text-sm text-muted">{t('business.export_hint')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="field-label">{t('business.export_from')}</span>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t('business.export_to')}</span>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t('business.export_format')}</span>
          <select
            className="input"
            value={format}
            onChange={(e) => setFormat(e.target.value as (typeof FORMATS)[number])}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {t(`business.format_${f}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="button" className="btn-primary" disabled={busy} onClick={download}>
        {t('business.export_download')}
      </button>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error.text}{' '}
          {error.action && (
            <a href={error.action.href} className="font-medium underline">
              {error.action.label}
            </a>
          )}
        </p>
      )}
    </section>
  );
}
