'use client';

import Link from 'next/link';
import { useState } from 'react';
import type {
  DepositObligationDto,
  PayrollSettingsDto,
  PayrollTaxesDto,
  WorksheetDto,
  WorksheetForm,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

interface Option {
  id: string;
  name: string;
}

const STATUS_CHIP: Record<DepositObligationDto['status'], string> = {
  overdue: 'chip-bad',
  due_soon: 'chip-warn',
  upcoming: 'chip-muted',
  paid: 'chip-good',
  carried: 'chip-muted',
};

/** Employer tax (PRL-12..16): the business's settings, what to deposit and when, and the worksheets. */
export function PayrollTaxes({
  workspaceId,
  entityId,
  currency,
  taxes,
  worksheet,
  form,
  quarter,
  accounts,
  today,
  canWrite,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  taxes: PayrollTaxesDto;
  worksheet: WorksheetDto;
  form: WorksheetForm;
  quarter: number;
  accounts: Option[];
  today: string;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const base = `/w/${workspaceId}/business/${entityId}/payroll/taxes`;
  const href = (p: { year?: number; form?: WorksheetForm; quarter?: number }) =>
    `${base}?year=${p.year ?? taxes.year}&form=${p.form ?? form}&quarter=${p.quarter ?? quarter}`;
  return (
    <div className="space-y-6">
      <p className="card text-sm text-muted">{t('payroll.taxes.notice')}</p>
      <SettingsCard
        workspaceId={workspaceId}
        entityId={entityId}
        settings={taxes.settings}
        canWrite={canWrite}
      />
      <Deposits
        workspaceId={workspaceId}
        entityId={entityId}
        currency={currency}
        taxes={taxes}
        accounts={accounts}
        today={today}
        canWrite={canWrite}
        yearLinks={[taxes.year - 1, taxes.year, taxes.year + 1].map((y) => ({
          year: y,
          href: href({ year: y }),
        }))}
      />
      <Worksheet
        worksheet={worksheet}
        currency={currency}
        form={form}
        quarter={quarter}
        formLinks={(['941', '940', 'de9', 'de9c'] as const).map((f) => ({
          form: f,
          href: href({ form: f }),
        }))}
        quarterLinks={[1, 2, 3, 4].map((q) => ({ quarter: q, href: href({ quarter: q }) }))}
      />
    </div>
  );
}

function SettingsCard({
  workspaceId,
  entityId,
  settings,
  canWrite,
}: {
  workspaceId: string;
  entityId: string;
  settings: PayrollSettingsDto;
  canWrite: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const [open, setOpen] = useState(canWrite && settings.version === 0);
  const [f, setF] = useState({
    ein: settings.ein ? `${settings.ein.slice(0, 2)}-${settings.ein.slice(2)}` : '',
    caEmployerAccount: settings.caEmployerAccount ?? '',
    caUiRate: settings.caUiRate ?? '',
    caEttRate: settings.caEttRate,
    federalDepositSchedule: settings.federalDepositSchedule,
    caDepositSchedule: settings.caDepositSchedule,
  });
  const SCHEDULES: Record<string, string> = {
    monthly: t('payroll.taxes.monthly'),
    semiweekly: t('payroll.taxes.semiweekly'),
    quarterly: t('payroll.taxes.quarterly'),
  };

  function save() {
    void run(
      () =>
        browserApi.updatePayrollSettings(workspaceId, entityId, {
          ein: f.ein.trim() || null,
          caEmployerAccount: f.caEmployerAccount.trim() || null,
          caUiRate: f.caUiRate.trim() || null,
          caEttRate: f.caEttRate.trim() || '0.1',
          federalDepositSchedule: f.federalDepositSchedule,
          caDepositSchedule: f.caDepositSchedule,
          version: settings.version,
        }),
      t('payroll.saved'),
    ).then((r) => {
      if (r) setOpen(false);
    });
  }

  return (
    <section className="card space-y-3" aria-labelledby="tax-settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="tax-settings" className="text-base font-semibold">
          {t('payroll.taxes.settings')}
        </h2>
        {canWrite && !open && (
          <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>
            {t('payroll.edit')}
          </button>
        )}
      </div>
      {!open ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <Item label={t('payroll.taxes.ein')} value={f.ein || t('payroll.taxes.not_set')} />
          <Item
            label={t('payroll.taxes.edd_account')}
            value={f.caEmployerAccount || t('payroll.taxes.not_set')}
          />
          <Item
            label={t('payroll.taxes.ui_rate')}
            value={
              settings.caUiRate
                ? `${settings.caUiRate}%`
                : t('payroll.taxes.ui_default', { rate: settings.caUiRateDefault })
            }
          />
          <Item label={t('payroll.taxes.ett_rate')} value={`${settings.caEttRate}%`} />
          <Item
            label={t('payroll.taxes.federal_schedule')}
            value={SCHEDULES[settings.federalDepositSchedule]!}
          />
          <Item label={t('payroll.taxes.ca_schedule')} value={SCHEDULES[settings.caDepositSchedule]!} />
        </dl>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          aria-label={t('payroll.taxes.settings')}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label={t('payroll.taxes.ein')}>
            <input
              className="input num"
              placeholder="12-3456789"
              value={f.ein}
              onChange={(e) => setF((x) => ({ ...x, ein: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.taxes.edd_account')}>
            <input
              className="input num"
              placeholder="123-4567-8"
              value={f.caEmployerAccount}
              onChange={(e) => setF((x) => ({ ...x, caEmployerAccount: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.taxes.ui_rate_input')}>
            <input
              className="input num"
              inputMode="decimal"
              placeholder={settings.caUiRateDefault}
              value={f.caUiRate}
              onChange={(e) => setF((x) => ({ ...x, caUiRate: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.taxes.ett_rate_input')}>
            <input
              className="input num"
              inputMode="decimal"
              value={f.caEttRate}
              onChange={(e) => setF((x) => ({ ...x, caEttRate: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.taxes.federal_schedule')}>
            <select
              className="input"
              value={f.federalDepositSchedule}
              onChange={(e) =>
                setF((x) => ({
                  ...x,
                  federalDepositSchedule: e.target.value as PayrollSettingsDto['federalDepositSchedule'],
                }))
              }
            >
              <option value="monthly">{SCHEDULES.monthly}</option>
              <option value="semiweekly">{SCHEDULES.semiweekly}</option>
            </select>
          </Field>
          <Field label={t('payroll.taxes.ca_schedule')}>
            <select
              className="input"
              value={f.caDepositSchedule}
              onChange={(e) =>
                setF((x) => ({
                  ...x,
                  caDepositSchedule: e.target.value as PayrollSettingsDto['caDepositSchedule'],
                }))
              }
            >
              <option value="quarterly">{SCHEDULES.quarterly}</option>
              <option value="monthly">{SCHEDULES.monthly}</option>
              <option value="semiweekly">{SCHEDULES.semiweekly}</option>
            </select>
          </Field>
          <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{t('payroll.taxes.schedule_hint')}</p>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('payroll.save')}
            </button>
            {settings.version > 0 && (
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

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Deposits({
  workspaceId,
  entityId,
  currency,
  taxes,
  accounts,
  today,
  canWrite,
  yearLinks,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  taxes: PayrollTaxesDto;
  accounts: Option[];
  today: string;
  canWrite: boolean;
  yearLinks: { year: number; href: string }[];
}) {
  const { run, busy, message, t } = useAction();
  const [recording, setRecording] = useState<string | null>(null);
  const [d, setD] = useState({ paidOn: today, payFromAccountId: accounts[0]?.id ?? '', confirmation: '' });
  const TAX: Record<DepositObligationDto['tax'], string> = {
    federal_941: t('payroll.taxes.federal_941'),
    federal_940: t('payroll.taxes.federal_940'),
    ca_pit_sdi: t('payroll.taxes.ca_pit_sdi'),
    ca_ui_ett: t('payroll.taxes.ca_ui_ett'),
  };
  const STATUS: Record<DepositObligationDto['status'], string> = {
    overdue: t('payroll.taxes.overdue'),
    due_soon: t('payroll.taxes.due_soon'),
    upcoming: t('payroll.taxes.upcoming'),
    paid: t('payroll.taxes.paid'),
    carried: t('payroll.taxes.carried'),
  };
  const key = (o: DepositObligationDto) => `${o.tax}:${o.periodStart}:${o.periodEnd}:${o.status}`;

  function record(o: DepositObligationDto) {
    void run(
      () =>
        browserApi.recordPayrollDeposit(workspaceId, {
          entityId,
          tax: o.tax,
          periodStart: o.periodStart,
          paidOn: d.paidOn,
          payFromAccountId: d.payFromAccountId,
          confirmation: d.confirmation.trim() || null,
        }),
      t('payroll.taxes.recorded'),
    ).then((r) => {
      if (r) setRecording(null);
    });
  }

  return (
    <section className="space-y-2" aria-labelledby="deposits">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="deposits" className="text-base font-semibold">
          {t('payroll.taxes.deposits', { year: taxes.year })}
        </h2>
        <nav className="flex gap-3 text-sm" aria-label={t('payroll.taxes.year')}>
          {yearLinks.map((y) =>
            y.year === taxes.year ? (
              <span key={y.year} className="font-semibold">
                {y.year}
              </span>
            ) : (
              <Link key={y.year} href={y.href} className="underline">
                {y.year}
              </Link>
            ),
          )}
        </nav>
      </div>
      {taxes.obligations.length === 0 ? (
        <p className="card text-sm text-muted">{t('payroll.taxes.none')}</p>
      ) : (
        <ul className="card divide-y divide-line p-0">
          {taxes.obligations.map((o) => (
            <li key={key(o)} className="space-y-2 p-3" data-testid="deposit-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{TAX[o.tax]}</p>
                  <p className="text-xs text-muted">
                    <DateText date={o.periodStart} /> – <DateText date={o.periodEnd} /> ·{' '}
                    {o.status === 'carried' ? t('payroll.taxes.carried_hint') : t('payroll.taxes.due')}{' '}
                    {o.status !== 'carried' && <DateText date={o.dueDate} />}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Money amount={o.amount} currency={currency} className="font-semibold" />
                  <span className={`chip ${STATUS_CHIP[o.status]}`}>{STATUS[o.status]}</span>
                  {canWrite && !o.deposit && o.status !== 'carried' && recording !== key(o) && (
                    <button type="button" className="text-sm underline" onClick={() => setRecording(key(o))}>
                      {t('payroll.taxes.record')}
                    </button>
                  )}
                </div>
              </div>
              {o.nextDay && <p className="text-xs text-bad">{t('payroll.taxes.next_day')}</p>}
              {o.deposit && (
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {t('payroll.taxes.paid_on')} <DateText date={o.deposit.paidOn} />
                  {o.deposit.confirmation && ` · ${o.deposit.confirmation}`}
                  {BigInt(o.difference) !== 0n && (
                    <span className="text-bad">
                      {t('payroll.taxes.difference')} <Money amount={o.difference} currency={currency} />
                    </span>
                  )}
                  {canWrite && (
                    <button
                      type="button"
                      className="underline"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t('payroll.taxes.remove_confirm'))) {
                          void run(() => browserApi.deletePayrollDeposit(workspaceId, o.deposit!.id));
                        }
                      }}
                    >
                      {t('payroll.taxes.remove')}
                    </button>
                  )}
                </p>
              )}
              {recording === key(o) && (
                <form
                  className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3"
                  aria-label={t('payroll.taxes.record')}
                  onSubmit={(e) => {
                    e.preventDefault();
                    record(o);
                  }}
                >
                  <Field label={t('payroll.taxes.paid_on_input')}>
                    <input
                      className="input"
                      type="date"
                      required
                      max={today}
                      value={d.paidOn}
                      onChange={(e) => setD((x) => ({ ...x, paidOn: e.target.value }))}
                    />
                  </Field>
                  <Field label={t('payroll.run.pay_from')}>
                    <select
                      className="input"
                      required
                      value={d.payFromAccountId}
                      onChange={(e) => setD((x) => ({ ...x, payFromAccountId: e.target.value }))}
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('payroll.taxes.confirmation')}>
                    <input
                      className="input"
                      maxLength={100}
                      value={d.confirmation}
                      onChange={(e) => setD((x) => ({ ...x, confirmation: e.target.value }))}
                    />
                  </Field>
                  <p className="text-xs text-muted sm:col-span-3">{t('payroll.taxes.record_hint')}</p>
                  <div className="flex gap-2 sm:col-span-3">
                    <button type="submit" className="btn-primary" disabled={busy || !d.payFromAccountId}>
                      {t('payroll.taxes.record')}
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => setRecording(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <StatusLine message={message} />
    </section>
  );
}

function Worksheet({
  worksheet: w,
  currency,
  form,
  quarter,
  formLinks,
  quarterLinks,
}: {
  worksheet: WorksheetDto;
  currency: string;
  form: WorksheetForm;
  quarter: number;
  formLinks: { form: WorksheetForm; href: string }[];
  quarterLinks: { quarter: number; href: string }[];
}) {
  const { t } = useI18n();
  const NAMES: Record<WorksheetForm, string> = {
    '941': 'Form 941',
    '940': 'Form 940',
    de9: 'DE 9',
    de9c: 'DE 9C',
  };
  return (
    <section className="card space-y-3" aria-labelledby="worksheet">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="worksheet" className="text-base font-semibold">
          {t('payroll.taxes.worksheets')}
        </h2>
        <nav className="flex flex-wrap gap-3 text-sm" aria-label={t('payroll.taxes.worksheets')}>
          {formLinks.map((f) =>
            f.form === form ? (
              <span key={f.form} className="font-semibold">
                {NAMES[f.form]}
              </span>
            ) : (
              <Link key={f.form} href={f.href} className="underline">
                {NAMES[f.form]}
              </Link>
            ),
          )}
        </nav>
      </div>
      {form !== '940' && (
        <nav className="flex gap-3 text-sm" aria-label={t('payroll.taxes.quarter')}>
          {quarterLinks.map((q) =>
            q.quarter === quarter ? (
              <span key={q.quarter} className="font-semibold">
                {t('payroll.taxes.quarter_n', { n: q.quarter })}
              </span>
            ) : (
              <Link key={q.quarter} href={q.href} className="underline">
                {t('payroll.taxes.quarter_n', { n: q.quarter })}
              </Link>
            ),
          )}
        </nav>
      )}
      <p className="text-sm">
        {w.employer.name}
        {w.employer.ein && ` · EIN ${w.employer.ein}`}
        {(form === 'de9' || form === 'de9c') &&
          w.employer.caEmployerAccount &&
          ` · ${t('payroll.taxes.edd_account')} ${w.employer.caEmployerAccount}`}
        <span className="block text-xs text-muted">
          {t('payroll.taxes.file_by')} <DateText date={w.dueDate} />
        </span>
      </p>
      <table className="w-full text-sm" data-testid="worksheet">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="w-20 py-1 font-normal">{t('payroll.run.line')}</th>
            <th className="py-1 font-normal">{t('payroll.taxes.description')}</th>
            <th className="py-1 text-right font-normal">{t('payroll.run.amount')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {w.lines.map((l, i) => (
            <tr key={`${l.line}:${i}`}>
              <td className="py-1 num">{l.line}</td>
              <td className="py-1">
                {l.label}
                {l.rate && <span className="text-xs text-muted"> ({l.rate}%)</span>}
              </td>
              <td className="py-1 text-right num">
                {l.amount !== null ? <Money amount={l.amount} currency={currency} /> : (l.count ?? '')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {w.liabilities.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {form === '940' ? t('payroll.taxes.by_quarter') : t('payroll.taxes.liability')}
          </h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-4">
            {w.liabilities.map((l) => (
              <div key={l.label}>
                <dt className="text-xs text-muted">
                  {/^\d{4}-/.test(l.label) ? <DateText date={l.label} /> : l.label}
                </dt>
                <dd className="num">
                  <Money amount={l.amount} currency={currency} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {w.employees && w.employees.length > 0 && (
        <table className="w-full text-sm" data-testid="de9c-employees">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-normal">{t('payroll.taxes.employee')}</th>
              <th className="py-1 font-normal">{t('payroll.ssn')}</th>
              <th className="py-1 text-right font-normal">{t('payroll.taxes.subject_wages')}</th>
              <th className="py-1 text-right font-normal">{t('payroll.taxes.pit_wages')}</th>
              <th className="py-1 text-right font-normal">{t('payroll.taxes.pit_withheld')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {w.employees.map((e) => (
              <tr key={e.personId}>
                <td className="py-1">{e.name}</td>
                <td className="py-1 num">{e.tinMasked ?? '—'}</td>
                <td className="py-1 text-right num">
                  <Money amount={e.subjectWages} currency={currency} />
                </td>
                <td className="py-1 text-right num">
                  <Money amount={e.pitWages} currency={currency} />
                </td>
                <td className="py-1 text-right num">
                  <Money amount={e.pitWithheld} currency={currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {w.notes.map((n) => (
        <p key={n} className="text-xs text-muted">
          {n}
        </p>
      ))}
      <p className="text-xs text-muted">{t('payroll.taxes.worksheet_hint')}</p>
    </section>
  );
}
