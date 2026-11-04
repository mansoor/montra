'use client';

import { useState } from 'react';
import type { AccountDto, BusinessProfileDto } from '@montra/api-client';
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
