'use client';

import { useState } from 'react';
import type { PayrollPersonDto, W4Dto, W9Dto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { digitsOnly, formatTinInput } from '@/lib/payroll';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

/** Form W-4 (PRL-02): recorded as the employee signed it; a newer one takes over from its effective date. */
export function W4Panel({
  workspaceId,
  currency,
  person,
  forms,
  today,
}: {
  workspaceId: string;
  currency: string;
  person: PayrollPersonDto;
  forms: W4Dto[];
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const [open, setOpen] = useState(forms.length === 0);
  const [f, setF] = useState({
    effectiveDate: today,
    filingStatus: 'single' as W4Dto['filingStatus'],
    multipleJobs: false,
    dependents: '',
    otherIncome: '',
    deductions: '',
    extraWithholding: '',
    exempt: false,
    signedName: [person.firstName, person.lastName].join(' '),
    signedOn: today,
    attested: false,
  });
  const FILING: Record<W4Dto['filingStatus'], string> = {
    single: t('payroll.w4.single'),
    married_jointly: t('payroll.w4.married_jointly'),
    head_of_household: t('payroll.w4.head_of_household'),
  };

  function money(text: string): string | null | undefined {
    if (!text.trim()) return '0';
    const r = parseAmountInput(text, currency, locale, t);
    if (!r.ok) {
      setMessage({ tone: 'bad', text: r.error });
      return undefined;
    }
    return String(r.minor);
  }

  function save() {
    const amounts = [f.dependents, f.otherIncome, f.deductions, f.extraWithholding].map(money);
    if (amounts.some((a) => a === undefined)) return;
    const [dependents, otherIncome, deductions, extraWithholding] = amounts as string[];
    void run(
      () =>
        browserApi.createW4(workspaceId, person.id, {
          effectiveDate: f.effectiveDate,
          filingStatus: f.filingStatus,
          multipleJobs: f.multipleJobs,
          dependents,
          otherIncome,
          deductions,
          extraWithholding,
          exempt: f.exempt,
          signedName: f.signedName.trim(),
          signedOn: f.signedOn,
          attested: true,
        }),
      t('payroll.w4.saved'),
    ).then((r) => {
      if (r) setOpen(false);
    });
  }

  return (
    <section className="card space-y-3" aria-labelledby="w4-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="w4-title" className="text-base font-semibold">
          {t('payroll.w4.title')}
        </h2>
        {!open && (
          <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>
            {t('payroll.w4.record_new')}
          </button>
        )}
      </div>
      <p className="text-xs text-muted">{t('payroll.w4.hint')}</p>
      {forms.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {forms.map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="w4-row"
            >
              <span>
                {FILING[w.filingStatus]}
                {w.multipleJobs && ` · ${t('payroll.w4.multiple_jobs_short')}`}
                {w.exempt && ` · ${t('payroll.w4.exempt_short')}`}
                {BigInt(w.dependents) > 0n && (
                  <>
                    {' · '}
                    {t('payroll.w4.credits')} <Money amount={w.dependents} currency={currency} />
                  </>
                )}
                {BigInt(w.extraWithholding) > 0n && (
                  <>
                    {' · '}
                    {t('payroll.w4.extra')} <Money amount={w.extraWithholding} currency={currency} />
                  </>
                )}
                <span className="block text-xs text-muted">
                  {t('payroll.w4.from')} <DateText date={w.effectiveDate} /> · {t('payroll.signed_by')}{' '}
                  {w.signedName} <DateText date={w.signedOn} />
                </span>
              </span>
              <span className="flex items-center gap-3">
                {w.current && <span className="chip chip-good">{t('payroll.in_use')}</span>}
                <a
                  className="text-sm underline"
                  href={browserApi.w4PdfPath(workspaceId, person.id, w.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('payroll.pdf')}
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <form
          className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-3"
          aria-label={t('payroll.w4.record_new')}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label={t('payroll.w4.filing_status')}>
            <select
              className="input"
              value={f.filingStatus}
              onChange={(e) => setF((x) => ({ ...x, filingStatus: e.target.value as W4Dto['filingStatus'] }))}
            >
              {(Object.keys(FILING) as W4Dto['filingStatus'][]).map((k) => (
                <option key={k} value={k}>
                  {FILING[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('payroll.w4.dependents')}>
            <input
              className="input"
              inputMode="decimal"
              value={f.dependents}
              onChange={(e) => setF((x) => ({ ...x, dependents: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.w4.other_income')}>
            <input
              className="input"
              inputMode="decimal"
              value={f.otherIncome}
              onChange={(e) => setF((x) => ({ ...x, otherIncome: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.w4.deductions')}>
            <input
              className="input"
              inputMode="decimal"
              value={f.deductions}
              onChange={(e) => setF((x) => ({ ...x, deductions: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.w4.extra_withholding')}>
            <input
              className="input"
              inputMode="decimal"
              value={f.extraWithholding}
              onChange={(e) => setF((x) => ({ ...x, extraWithholding: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.w4.effective_date')}>
            <input
              className="input"
              type="date"
              required
              value={f.effectiveDate}
              onChange={(e) => setF((x) => ({ ...x, effectiveDate: e.target.value }))}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
            <input
              type="checkbox"
              checked={f.multipleJobs}
              onChange={(e) => setF((x) => ({ ...x, multipleJobs: e.target.checked }))}
            />
            {t('payroll.w4.multiple_jobs')}
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
            <input
              type="checkbox"
              checked={f.exempt}
              onChange={(e) => setF((x) => ({ ...x, exempt: e.target.checked }))}
            />
            {t('payroll.w4.exempt')}
          </label>
          <Field label={t('payroll.signed_name')}>
            <input
              className="input"
              required
              maxLength={300}
              value={f.signedName}
              onChange={(e) => setF((x) => ({ ...x, signedName: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.signed_on')}>
            <input
              className="input"
              type="date"
              required
              value={f.signedOn}
              onChange={(e) => setF((x) => ({ ...x, signedOn: e.target.value }))}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2 lg:col-span-3">
            <input
              type="checkbox"
              required
              checked={f.attested}
              onChange={(e) => setF((x) => ({ ...x, attested: e.target.checked }))}
            />
            {t('payroll.w4.attest')}
          </label>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
            <button type="submit" className="btn-primary" disabled={busy || !f.attested}>
              {t('payroll.w4.save')}
            </button>
            {forms.length > 0 && (
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </form>
      )}
      <StatusLine message={message} />
    </section>
  );
}

const CLASSIFICATIONS: W9Dto['taxClassification'][] = [
  'individual',
  'c_corporation',
  's_corporation',
  'partnership',
  'trust_estate',
  'llc_c',
  'llc_s',
  'llc_p',
  'other',
];

/** Form W-9 (PRL-03): the contractor's certified name and TIN, which their 1099 will use. */
export function W9Panel({
  workspaceId,
  person,
  forms,
  today,
}: {
  workspaceId: string;
  person: PayrollPersonDto;
  forms: W9Dto[];
  today: string;
}) {
  const { run, busy, message, t } = useAction();
  const [open, setOpen] = useState(forms.length === 0);
  const a = person.address;
  const [f, setF] = useState({
    legalName: [person.firstName, person.lastName].join(' '),
    businessName: person.businessName ?? '',
    taxClassification: 'individual' as W9Dto['taxClassification'],
    otherClassification: '',
    exemptPayeeCode: '',
    fatcaCode: '',
    address: [
      [a.line1, a.line2].filter(Boolean).join(', '),
      [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    ]
      .filter(Boolean)
      .join('\n'),
    tinType: (person.tinType ?? 'ssn') as 'ssn' | 'itin' | 'ein',
    tin: '',
    backupWithholding: false,
    signedName: [person.firstName, person.lastName].join(' '),
    signedOn: today,
    attested: false,
  });
  const LABEL: Record<W9Dto['taxClassification'], string> = {
    individual: t('payroll.w9.individual'),
    c_corporation: t('payroll.w9.c_corporation'),
    s_corporation: t('payroll.w9.s_corporation'),
    partnership: t('payroll.w9.partnership'),
    trust_estate: t('payroll.w9.trust_estate'),
    llc_c: t('payroll.w9.llc_c'),
    llc_s: t('payroll.w9.llc_s'),
    llc_p: t('payroll.w9.llc_p'),
    other: t('payroll.w9.other'),
  };

  function save() {
    void run(
      () =>
        browserApi.createW9(workspaceId, person.id, {
          legalName: f.legalName.trim(),
          businessName: f.businessName.trim() || null,
          taxClassification: f.taxClassification,
          otherClassification: f.otherClassification.trim() || null,
          exemptPayeeCode: f.exemptPayeeCode.trim() || null,
          fatcaCode: f.fatcaCode.trim() || null,
          address: f.address.trim(),
          tin: { type: f.tinType, value: digitsOnly(f.tin) },
          backupWithholding: f.backupWithholding,
          signedName: f.signedName.trim(),
          signedOn: f.signedOn,
          attested: true,
        }),
      t('payroll.w9.saved'),
    ).then((r) => {
      if (r) setOpen(false);
    });
  }

  return (
    <section className="card space-y-3" aria-labelledby="w9-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="w9-title" className="text-base font-semibold">
          {t('payroll.w9.title')}
        </h2>
        {!open && (
          <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>
            {t('payroll.w9.record_new')}
          </button>
        )}
      </div>
      <p className="text-xs text-muted">{t('payroll.w9.hint')}</p>
      {forms.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {forms.map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="w9-row"
            >
              <span>
                {w.legalName}
                {w.businessName && ` (${w.businessName})`} · {LABEL[w.taxClassification]} ·{' '}
                <span className="num">{w.tinMasked}</span>
                <span className="block text-xs text-muted">
                  {t('payroll.signed_by')} {w.signedName} <DateText date={w.signedOn} />
                  {w.backupWithholding && ` · ${t('payroll.w9.backup_short')}`}
                </span>
              </span>
              <span className="flex items-center gap-3">
                {w.current && <span className="chip chip-good">{t('payroll.in_use')}</span>}
                <a
                  className="text-sm underline"
                  href={browserApi.w9PdfPath(workspaceId, person.id, w.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('payroll.pdf')}
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <form
          className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2"
          aria-label={t('payroll.w9.record_new')}
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label={t('payroll.w9.legal_name')}>
            <input
              className="input"
              required
              maxLength={300}
              value={f.legalName}
              onChange={(e) => setF((x) => ({ ...x, legalName: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.w9.business_name')}>
            <input
              className="input"
              maxLength={300}
              value={f.businessName}
              onChange={(e) => setF((x) => ({ ...x, businessName: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.w9.classification')}>
            <select
              className="input"
              value={f.taxClassification}
              onChange={(e) =>
                setF((x) => ({ ...x, taxClassification: e.target.value as W9Dto['taxClassification'] }))
              }
            >
              {CLASSIFICATIONS.map((k) => (
                <option key={k} value={k}>
                  {LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          {f.taxClassification === 'other' && (
            <Field label={t('payroll.w9.other_classification')}>
              <input
                className="input"
                maxLength={100}
                value={f.otherClassification}
                onChange={(e) => setF((x) => ({ ...x, otherClassification: e.target.value }))}
              />
            </Field>
          )}
          <Field label={t('payroll.w9.exempt_payee')}>
            <input
              className="input"
              maxLength={4}
              value={f.exemptPayeeCode}
              onChange={(e) => setF((x) => ({ ...x, exemptPayeeCode: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.w9.fatca')}>
            <input
              className="input"
              maxLength={4}
              value={f.fatcaCode}
              onChange={(e) => setF((x) => ({ ...x, fatcaCode: e.target.value }))}
            />
          </Field>
          <label className="sm:col-span-2">
            <span className="field-label">{t('payroll.w9.address')}</span>
            <textarea
              className="input"
              rows={2}
              required
              maxLength={1000}
              value={f.address}
              onChange={(e) => setF((x) => ({ ...x, address: e.target.value }))}
            />
          </label>
          <Field label={t('payroll.tin_type')}>
            <select
              className="input"
              value={f.tinType}
              onChange={(e) =>
                setF((x) => ({ ...x, tinType: e.target.value as 'ssn' | 'itin' | 'ein', tin: '' }))
              }
            >
              <option value="ssn">{t('payroll.ssn')}</option>
              <option value="itin">{t('payroll.itin')}</option>
              <option value="ein">{t('payroll.ein')}</option>
            </select>
          </Field>
          <Field label={t('payroll.w9.tin')}>
            <input
              className="input num"
              required
              inputMode="numeric"
              autoComplete="off"
              value={f.tin}
              onChange={(e) => setF((x) => ({ ...x, tin: formatTinInput(x.tinType, e.target.value) }))}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={f.backupWithholding}
              onChange={(e) => setF((x) => ({ ...x, backupWithholding: e.target.checked }))}
            />
            {t('payroll.w9.backup')}
          </label>
          <Field label={t('payroll.signed_name')}>
            <input
              className="input"
              required
              maxLength={300}
              value={f.signedName}
              onChange={(e) => setF((x) => ({ ...x, signedName: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.signed_on')}>
            <input
              className="input"
              type="date"
              required
              value={f.signedOn}
              onChange={(e) => setF((x) => ({ ...x, signedOn: e.target.value }))}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              required
              checked={f.attested}
              onChange={(e) => setF((x) => ({ ...x, attested: e.target.checked }))}
            />
            {t('payroll.w9.attest')}
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" className="btn-primary" disabled={busy || !f.attested}>
              {t('payroll.w9.save')}
            </button>
            {forms.length > 0 && (
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </form>
      )}
      <StatusLine message={message} />
    </section>
  );
}
