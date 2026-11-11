'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PayrollSettingsDto, YearEndDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

/** Year-end forms (PRL-17..20): W-2s and the W-3, 1099-NECs and the 1096, and SSA's EFW2 file. */
export function YearEnd({
  workspaceId,
  entityId,
  currency,
  year,
  summary: s,
  settings,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  year: number;
  summary: YearEndDto;
  settings: PayrollSettingsDto;
}) {
  const { t } = useI18n();
  const base = `/w/${workspaceId}/business/${entityId}/payroll/year-end`;
  return (
    <div className="space-y-6">
      <p className="card text-sm text-muted">{t('payroll.year_end.notice')}</p>
      <nav className="flex items-center gap-3 text-sm" aria-label={t('payroll.taxes.year')}>
        {[year - 1, year, year + 1].map((y) =>
          y === year ? (
            <span key={y} className="font-semibold">
              {y}
            </span>
          ) : (
            <Link key={y} href={`${base}?year=${y}`} className="underline">
              {y}
            </Link>
          ),
        )}
        <span className="text-muted">
          · {t('payroll.year_end.due')} <DateText date={s.dueDate} />
        </span>
      </nav>

      <section className="space-y-2" aria-labelledby="w2s">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="w2s" className="text-base font-semibold">
            {t('payroll.year_end.w2s')}
          </h2>
          {s.w2s.length > 0 && (
            <a
              className="text-sm underline"
              href={browserApi.w2EmployerPath(workspaceId, entityId, year)}
              target="_blank"
              rel="noreferrer"
            >
              {t('payroll.year_end.employer_copies')}
            </a>
          )}
        </div>
        {s.w2s.length === 0 ? (
          <p className="card text-sm text-muted">{t('payroll.year_end.no_w2s')}</p>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm" data-testid="w2-table">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="p-2 font-normal">{t('payroll.taxes.employee')}</th>
                  <th className="p-2 text-right font-normal">{t('payroll.year_end.box1')}</th>
                  <th className="p-2 text-right font-normal">{t('payroll.year_end.box2')}</th>
                  <th className="p-2 text-right font-normal">{t('payroll.year_end.box3_4')}</th>
                  <th className="p-2 text-right font-normal">{t('payroll.year_end.box5_6')}</th>
                  <th className="p-2 text-right font-normal">{t('payroll.year_end.box16_17')}</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {[...s.w2s.map((w) => ({ ...w, total: false })), { ...s.w3, total: true }].map((w) => {
                  const b = w.boxes;
                  const key = 'personId' in w ? w.personId : 'w3';
                  return (
                    <tr key={key} className={w.total ? 'font-semibold' : ''}>
                      <td className="p-2">
                        {'name' in w ? (
                          <>
                            {w.name}
                            <span className="block text-xs font-normal text-muted">{w.tinMasked ?? '—'}</span>
                          </>
                        ) : (
                          t('payroll.year_end.w3_total', { count: s.w3.forms })
                        )}
                      </td>
                      <td className="p-2 text-right num">
                        <Money amount={b.box1} currency={currency} />
                      </td>
                      <td className="p-2 text-right num">
                        <Money amount={b.box2} currency={currency} />
                      </td>
                      <td className="p-2 text-right num">
                        <Money amount={b.box3} currency={currency} />
                        <span className="block text-xs text-muted">
                          <Money amount={b.box4} currency={currency} />
                        </span>
                      </td>
                      <td className="p-2 text-right num">
                        <Money amount={b.box5} currency={currency} />
                        <span className="block text-xs text-muted">
                          <Money amount={b.box6} currency={currency} />
                        </span>
                      </td>
                      <td className="p-2 text-right num">
                        <Money amount={b.caWages} currency={currency} />
                        <span className="block text-xs text-muted">
                          <Money amount={b.caTax} currency={currency} />
                        </span>
                      </td>
                      <td className="p-2 text-right">
                        {'personId' in w && (
                          <a
                            className="underline"
                            href={browserApi.w2Path(workspaceId, entityId, year, w.personId)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t('payroll.year_end.w2_copies')}
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="necs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="necs" className="text-base font-semibold">
            {t('payroll.year_end.necs')}
          </h2>
          {s.form1096.forms > 0 && (
            <a
              className="text-sm underline"
              href={browserApi.necPayerPath(workspaceId, entityId, year)}
              target="_blank"
              rel="noreferrer"
            >
              {t('payroll.year_end.payer_copies')}
            </a>
          )}
        </div>
        <p className="text-xs text-muted">
          {t('payroll.year_end.threshold')} <Money amount={s.necThreshold.amount} currency={currency} />
          {!s.necThreshold.known && ` ${t('payroll.year_end.threshold_unknown')}`}
        </p>
        {s.necs.length === 0 ? (
          <p className="card text-sm text-muted">{t('payroll.year_end.no_necs')}</p>
        ) : (
          <ul className="card divide-y divide-line p-0" data-testid="nec-list">
            {s.necs.map((n) => (
              <li key={n.personId} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span>
                  {n.name}
                  <span className="block text-xs text-muted">
                    {n.tinMasked ?? '—'} · {t('payroll.year_end.payments', { count: n.payments })}
                    {!n.hasW9 && ` · ${t('payroll.year_end.no_w9')}`}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <Money amount={n.nonemployeeCompensation} currency={currency} className="font-semibold" />
                  {n.required ? (
                    <a
                      className="underline"
                      href={browserApi.necPath(workspaceId, entityId, year, n.personId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('payroll.year_end.nec_copies')}
                    </a>
                  ) : (
                    <span className="chip chip-muted">{t('payroll.year_end.under_threshold')}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {s.form1096.forms > 0 && (
          <p className="text-sm">
            {t('payroll.year_end.form1096', { count: s.form1096.forms })}{' '}
            <Money amount={s.form1096.total} currency={currency} className="font-semibold" />
          </p>
        )}
      </section>

      <section className="card space-y-3" aria-labelledby="efw2">
        <h2 id="efw2" className="text-base font-semibold">
          {t('payroll.year_end.efw2')}
        </h2>
        <p className="text-xs text-muted">{t('payroll.year_end.efw2_hint')}</p>
        {s.efw2Problems.length > 0 ? (
          <ul className="space-y-1 text-sm" aria-label={t('payroll.year_end.efw2_problems')}>
            {s.efw2Problems.map((p, i) => (
              <li key={i} className="text-bad">
                {p.where === 'submitter'
                  ? t('payroll.year_end.where_submitter')
                  : p.where === 'employer'
                    ? t('payroll.year_end.where_employer')
                    : p.where}
                {': '}
                {p.message}
              </li>
            ))}
          </ul>
        ) : (
          <a className="btn-primary inline-block" href={browserApi.efw2Path(workspaceId, entityId, year)}>
            {t('payroll.year_end.efw2_download')}
          </a>
        )}
      </section>

      {s.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-muted">
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <FilingDetails workspaceId={workspaceId} entityId={entityId} settings={settings} />
    </div>
  );
}

/** What the forms and SSA need beyond the payroll tax settings: the address in parts and the wage file's contact. */
function FilingDetails({
  workspaceId,
  entityId,
  settings,
}: {
  workspaceId: string;
  entityId: string;
  settings: PayrollSettingsDto;
}) {
  const { run, busy, message, t } = useAction();
  const a = settings.filingAddress;
  const [f, setF] = useState({
    line1: a?.line1 ?? '',
    line2: a?.line2 ?? '',
    city: a?.city ?? '',
    state: a?.state ?? 'CA',
    zip: a?.zip ?? '',
    ssaUserId: settings.ssaUserId ?? '',
    contactName: settings.contactName ?? '',
    contactPhone: settings.contactPhone ?? '',
    contactEmail: settings.contactEmail ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  function save() {
    void run(
      () =>
        browserApi.updatePayrollSettings(workspaceId, entityId, {
          filingAddress: f.line1.trim()
            ? { line1: f.line1, line2: f.line2.trim() || null, city: f.city, state: f.state, zip: f.zip }
            : null,
          ssaUserId: f.ssaUserId.trim() || null,
          contactName: f.contactName.trim() || null,
          contactPhone: f.contactPhone.trim() || null,
          contactEmail: f.contactEmail.trim() || null,
          version: settings.version,
        }),
      t('payroll.saved'),
    );
  }

  return (
    <section className="card space-y-3" aria-labelledby="filing-details">
      <h2 id="filing-details" className="text-base font-semibold">
        {t('payroll.year_end.filing_details')}
      </h2>
      <p className="text-xs text-muted">{t('payroll.year_end.filing_hint')}</p>
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        aria-label={t('payroll.year_end.filing_details')}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label={t('payroll.year_end.street')}>
          <input className="input" maxLength={100} value={f.line1} onChange={set('line1')} />
        </Field>
        <Field label={t('payroll.year_end.suite')}>
          <input className="input" maxLength={100} value={f.line2} onChange={set('line2')} />
        </Field>
        <Field label={t('payroll.year_end.city')}>
          <input className="input" maxLength={60} value={f.city} onChange={set('city')} />
        </Field>
        <Field label={t('payroll.year_end.state')}>
          <input className="input" maxLength={2} value={f.state} onChange={set('state')} />
        </Field>
        <Field label={t('payroll.year_end.zip')}>
          <input
            className="input num"
            inputMode="numeric"
            maxLength={10}
            value={f.zip}
            onChange={set('zip')}
          />
        </Field>
        <Field label={t('payroll.year_end.ssa_user_id')}>
          <input className="input" maxLength={8} value={f.ssaUserId} onChange={set('ssaUserId')} />
        </Field>
        <Field label={t('payroll.year_end.contact_name')}>
          <input className="input" maxLength={100} value={f.contactName} onChange={set('contactName')} />
        </Field>
        <Field label={t('payroll.year_end.contact_phone')}>
          <input className="input" maxLength={30} value={f.contactPhone} onChange={set('contactPhone')} />
        </Field>
        <Field label={t('payroll.year_end.contact_email')}>
          <input
            className="input"
            type="email"
            maxLength={320}
            value={f.contactEmail}
            onChange={set('contactEmail')}
          />
        </Field>
        <div className="sm:col-span-2 lg:col-span-3">
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('payroll.save')}
          </button>
        </div>
      </form>
      <StatusLine message={message} />
    </section>
  );
}
