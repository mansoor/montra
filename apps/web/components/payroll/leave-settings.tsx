'use client';

import Link from 'next/link';
import { useState } from 'react';
import type {
  LeaveBalancesRowDto,
  LeavePolicyDto,
  LeaveSettingsDto,
  UpdateLeaveSettingsInput,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { hoursText, parseHours, signedHoursText } from '@/lib/payroll';
import { DateText, useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

type PolicyInput = NonNullable<UpdateLeaveSettingsInput['vacation']>;
type PolicyForm = {
  method: LeavePolicyDto['method'];
  accrue: string;
  per: string;
  grant: string;
  max: string;
  carryover: string;
  useCap: string;
};

const toForm = (p: LeavePolicyDto): PolicyForm => {
  const h = (v: string | null) => (v === null ? '' : hoursText(v));
  return {
    method: p.method,
    accrue: h(p.accrueMilli),
    per: h(p.perHoursMilli),
    grant: h(p.grantMilli),
    max: h(p.maxBalanceMilli),
    carryover: h(p.carryoverMaxMilli),
    useCap: h(p.useCapMilli),
  };
};

/** Vacation and sick leave policies and every employee's balances (PRL-23..25; ADR-0036). */
export function LeaveSettings({
  workspaceId,
  entityId,
  settings,
  balances,
  canWrite,
  today,
}: {
  workspaceId: string;
  entityId: string;
  settings: LeaveSettingsDto;
  balances: LeaveBalancesRowDto[] | null;
  canWrite: boolean;
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [vacation, setVacation] = useState(toForm(settings.vacation));
  const [sick, setSick] = useState(toForm(settings.sick));
  const [week, setWeek] = useState(String(settings.workweekStarts));
  const rule = settings.caSickRule;
  const WEEKDAYS = [
    t('payroll.time.monday'),
    t('payroll.time.tuesday'),
    t('payroll.time.wednesday'),
    t('payroll.time.thursday'),
    t('payroll.time.friday'),
    t('payroll.time.saturday'),
    t('payroll.time.sunday'),
  ];

  /** The form as a policy; undefined when an hours field isn't a number. */
  function input(f: PolicyForm, carryover: boolean): PolicyInput | undefined {
    const h = (s: string) => (s.trim() ? parseHours(s) : null);
    const values = [f.accrue, f.per, f.grant, f.max, f.carryover, f.useCap].map(h);
    if (values.includes(undefined)) return undefined;
    const [accrue, per, grant, max, carry, useCap] = values as (string | null)[];
    return {
      method: f.method,
      accrueMilli: f.method === 'accrual' ? accrue : null,
      perHoursMilli: f.method === 'accrual' ? per : null,
      grantMilli: f.method === 'grant' ? grant : null,
      maxBalanceMilli: max,
      carryoverMaxMilli: carryover ? carry : null,
      useCapMilli: useCap,
    };
  }

  function save() {
    const v = input(vacation, true);
    // Accrued sick leave carries over; only a front-loaded policy may drop it.
    const s = input(sick, sick.method === 'grant');
    if (!v || !s) {
      setMessage({ tone: 'bad', text: t('payroll.run.bad_hours') });
      return;
    }
    void run(
      () =>
        browserApi.updateLeaveSettings(workspaceId, entityId, {
          vacation: v,
          sick: s,
          workweekStarts: Number(week),
        }),
      t('payroll.saved'),
    );
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3" aria-labelledby="policies">
        <h2 id="policies" className="text-base font-semibold">
          {t('payroll.time.policies')}
        </h2>
        <PolicyFields
          kind="vacation"
          title={t('payroll.time.vacation')}
          form={vacation}
          setForm={setVacation}
          disabled={!canWrite}
        />
        <p className="text-xs text-muted">{t('payroll.time.vacation_ca_note')}</p>
        <PolicyFields
          kind="sick"
          title={t('payroll.time.sick_policy')}
          form={sick}
          setForm={setSick}
          disabled={!canWrite}
        />
        <div className="rounded border border-line p-3 text-xs" data-testid="ca-sick-note">
          <p className="font-semibold">{t('payroll.time.ca_sick_title', { from: rule.from })}</p>
          <p>
            {t('payroll.time.ca_sick_rule', {
              min: hoursText(rule.minHoursMilli),
              days: String(rule.minDays),
              per: hoursText(rule.perHoursMilli),
              cap: hoursText(rule.accrualCapHoursMilli),
              capDays: String(rule.accrualCapDays),
              use: hoursText(rule.useCapHoursMilli),
              useDays: String(rule.useCapDays),
              day: String(rule.usableFromDay),
            })}
          </p>
          <p className="text-muted">{t('payroll.time.ca_sick_more')}</p>
          <p className="text-muted">
            {t('payroll.time.source')}{' '}
            <a
              className="underline"
              href="https://www.dir.ca.gov/dlse/paid_sick_leave.htm"
              rel="noreferrer"
              target="_blank"
            >
              {rule.source}
            </a>
          </p>
          {settings.sick.isDefault && <p>{t('payroll.time.sick_default')}</p>}
          {settings.sick.shortfalls.length > 0 && <p className="text-bad">{t('payroll.time.sick_short')}</p>}
        </div>
        <Field label={t('payroll.time.workweek')}>
          <select
            className="input"
            value={week}
            disabled={!canWrite}
            onChange={(e) => setWeek(e.target.value)}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={String(i)}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted">{t('payroll.time.workweek_hint')}</p>
        {canWrite && (
          <button type="button" className="btn-primary" disabled={busy} onClick={save}>
            {t('payroll.save')}
          </button>
        )}
        <p className="text-xs text-muted">{t('payroll.time.not_posted')}</p>
        <StatusLine message={message} />
      </section>

      {balances && (
        <section className="card space-y-2" aria-labelledby="balances">
          <h2 id="balances" className="text-base font-semibold">
            {t('payroll.time.balances')}
          </h2>
          {balances.length === 0 ? (
            <p className="text-sm text-muted">{t('payroll.time.no_employees')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="text-left font-normal">{t('payroll.employee')}</th>
                  <th className="text-right font-normal">{t('payroll.time.vacation')}</th>
                  <th className="text-right font-normal">{t('payroll.time.sick')}</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b) => {
                  const of = (k: 'vacation' | 'sick') => {
                    const x = b.balances.find((y) => y.kind === k);
                    return x?.tracked ? signedHoursText(x.balanceMilli) : '—';
                  };
                  return (
                    <tr key={b.personId}>
                      <td>
                        <Link
                          className="underline"
                          href={`/w/${workspaceId}/business/${entityId}/people/${b.personId}`}
                        >
                          {b.personName}
                        </Link>
                      </td>
                      <td className="num text-right">{of('vacation')}</td>
                      <td className="num text-right">{of('sick')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="text-xs text-muted">
            {t('payroll.time.balances_as_of')} <DateText date={today} />
          </p>
        </section>
      )}
    </div>
  );
}

function PolicyFields({
  kind,
  title,
  form,
  setForm,
  disabled,
}: {
  kind: 'vacation' | 'sick';
  title: string;
  form: PolicyForm;
  setForm: (f: PolicyForm) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const set = (k: keyof PolicyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });
  return (
    <fieldset className="grid gap-3 sm:grid-cols-4" disabled={disabled} aria-label={title}>
      <legend className="mb-1 text-sm font-semibold">{title}</legend>
      <Field label={t('payroll.time.method')}>
        <select className="input" value={form.method} onChange={set('method')}>
          {kind === 'vacation' && <option value="none">{t('payroll.time.method_none')}</option>}
          <option value="accrual">{t('payroll.time.method_accrual')}</option>
          <option value="grant">
            {kind === 'sick' ? t('payroll.time.method_front_load') : t('payroll.time.method_grant')}
          </option>
        </select>
      </Field>
      {form.method === 'accrual' && (
        <>
          <Field label={t('payroll.time.accrue')}>
            <input className="input num" inputMode="decimal" value={form.accrue} onChange={set('accrue')} />
          </Field>
          <Field label={t('payroll.time.per_worked')}>
            <input className="input num" inputMode="decimal" value={form.per} onChange={set('per')} />
          </Field>
        </>
      )}
      {form.method === 'grant' && (
        <Field label={t('payroll.time.grant')}>
          <input className="input num" inputMode="decimal" value={form.grant} onChange={set('grant')} />
        </Field>
      )}
      {form.method !== 'none' && (
        <>
          <Field label={t('payroll.time.max_balance')}>
            <input className="input num" inputMode="decimal" value={form.max} onChange={set('max')} />
          </Field>
          {(kind === 'vacation' || form.method === 'grant') && (
            <Field label={t('payroll.time.carryover')}>
              <input
                className="input num"
                inputMode="decimal"
                value={form.carryover}
                onChange={set('carryover')}
              />
            </Field>
          )}
          <Field label={t('payroll.time.use_cap')}>
            <input className="input num" inputMode="decimal" value={form.useCap} onChange={set('useCap')} />
          </Field>
        </>
      )}
    </fieldset>
  );
}
