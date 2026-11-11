'use client';

import { useState } from 'react';
import type { De4Dto, PayrollPersonDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

/**
 * California's DE 4 (PRL-14): the employee's state withholding allowances, recorded as signed. Without one, California
 * tax is withheld as single with no allowances.
 */
export function De4Panel({
  workspaceId,
  currency,
  person,
  forms,
  today,
}: {
  workspaceId: string;
  currency: string;
  person: PayrollPersonDto;
  forms: De4Dto[];
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    effectiveDate: today,
    filingStatus: 'single' as De4Dto['filingStatus'],
    allowances: '0',
    estimatedDeductionAllowances: '0',
    extraWithholding: '',
    exempt: false,
    signedName: [person.firstName, person.lastName].join(' '),
    signedOn: today,
    attested: false,
  });
  const FILING: Record<De4Dto['filingStatus'], string> = {
    single: t('payroll.de4.single'),
    married: t('payroll.de4.married'),
    head_of_household: t('payroll.de4.head_of_household'),
  };

  function save() {
    let extra = '0';
    if (f.extraWithholding.trim()) {
      const r = parseAmountInput(f.extraWithholding, currency, locale, t);
      if (!r.ok) {
        setMessage({ tone: 'bad', text: r.error });
        return;
      }
      extra = String(r.minor);
    }
    void run(
      () =>
        browserApi.createDe4(workspaceId, person.id, {
          effectiveDate: f.effectiveDate,
          filingStatus: f.filingStatus,
          allowances: Number(f.allowances || '0'),
          estimatedDeductionAllowances: Number(f.estimatedDeductionAllowances || '0'),
          extraWithholding: extra,
          exempt: f.exempt,
          signedName: f.signedName.trim(),
          signedOn: f.signedOn,
          attested: true,
        }),
      t('payroll.de4.saved'),
    ).then((r) => {
      if (r) setOpen(false);
    });
  }

  return (
    <section className="card space-y-3" aria-labelledby="de4-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="de4-title" className="text-base font-semibold">
          {t('payroll.de4.title')}
        </h2>
        {!open && (
          <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>
            {t('payroll.de4.record_new')}
          </button>
        )}
      </div>
      <p className="text-xs text-muted">{forms.length ? t('payroll.de4.hint') : t('payroll.de4.none')}</p>
      {forms.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {forms.map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="de4-row"
            >
              <span>
                {FILING[w.filingStatus]}
                {' · '}
                {t('payroll.de4.allowances_count', { count: w.allowances })}
                {w.estimatedDeductionAllowances > 0 &&
                  ` · ${t('payroll.de4.estimated_count', { count: w.estimatedDeductionAllowances })}`}
                {w.exempt && ` · ${t('payroll.w4.exempt_short')}`}
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
                  href={browserApi.de4PdfPath(workspaceId, person.id, w.id)}
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
          aria-label={t('payroll.de4.record_new')}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label={t('payroll.de4.filing_status')}>
            <select
              className="input"
              value={f.filingStatus}
              onChange={(e) =>
                setF((x) => ({ ...x, filingStatus: e.target.value as De4Dto['filingStatus'] }))
              }
            >
              {(Object.keys(FILING) as De4Dto['filingStatus'][]).map((k) => (
                <option key={k} value={k}>
                  {FILING[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('payroll.de4.allowances')}>
            <input
              className="input"
              type="number"
              min={0}
              max={99}
              value={f.allowances}
              onChange={(e) => setF((x) => ({ ...x, allowances: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.de4.estimated')}>
            <input
              className="input"
              type="number"
              min={0}
              max={99}
              value={f.estimatedDeductionAllowances}
              onChange={(e) => setF((x) => ({ ...x, estimatedDeductionAllowances: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.de4.extra_withholding')}>
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
              checked={f.exempt}
              onChange={(e) => setF((x) => ({ ...x, exempt: e.target.checked }))}
            />
            {t('payroll.de4.exempt')}
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
            {t('payroll.de4.attest')}
          </label>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
            <button type="submit" className="btn-primary" disabled={busy || !f.attested}>
              {t('payroll.de4.save')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      <StatusLine message={message} />
    </section>
  );
}
