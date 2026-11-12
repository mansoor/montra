'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PayrollPersonDto } from '@montra/api-client';
import { ownerEmployeeNote } from '@montra/domain';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { i9Overdue, missingSteps, type OnboardingStep } from '@/lib/payroll';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/** Employees and contractors of one business (PRL-01), with what each still needs to start. */
export function PeopleList({
  workspaceId,
  entityId,
  currency,
  people,
  today,
  businessType,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  people: PayrollPersonDto[];
  today: string;
  /** ADR-0037 §4: whether an owner can be on payroll depends on it. */
  businessType: string | null;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const [adding, setAdding] = useState<'employee' | 'contractor' | null>(null);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    businessName: '',
    email: '',
    hireDate: today,
    payType: 'hourly' as 'hourly' | 'salary',
    rate: '',
    workState: '',
    isOwner: false,
  });
  const ownerNote = adding === 'employee' && form.isOwner ? ownerEmployeeNote(businessType) : null;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const base = `/w/${workspaceId}/business/${entityId}/people`;

  const STEP: Record<OnboardingStep, string> = {
    details: t('payroll.step_details'),
    w4: t('payroll.step_w4'),
    w9: t('payroll.step_w9'),
    i9_section1: t('payroll.step_i9_section1'),
    i9_section2: t('payroll.step_i9_section2'),
  };
  const STATUS: Record<PayrollPersonDto['status'], string> = {
    active: t('payroll.status_active'),
    starting: t('payroll.status_starting'),
    ended: t('payroll.status_ended'),
  };

  function save(kind: 'employee' | 'contractor') {
    let rate: string | null = null;
    if (form.rate.trim()) {
      const parsed = parseAmountInput(form.rate, currency, locale, t);
      if (!parsed.ok) {
        setMessage({ tone: 'bad', text: parsed.error });
        return;
      }
      rate = String(parsed.minor);
    }
    void run(
      () =>
        browserApi.createPayrollPerson(workspaceId, {
          entityId,
          kind,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          businessName: kind === 'contractor' ? form.businessName.trim() || null : null,
          email: form.email.trim() || null,
          hireDate: form.hireDate || null,
          payType: kind === 'employee' ? form.payType : null,
          rate,
          workState: form.workState.trim() || null,
          isOwner: form.isOwner,
        }),
      (p) => t('payroll.added', { name: p.displayName }),
    ).then((p) => {
      if (p) {
        setAdding(null);
        window.location.assign(`${base}/${p.id}`);
      }
    });
  }

  const groups: { kind: 'employee' | 'contractor'; title: string; empty: string }[] = [
    { kind: 'employee', title: t('payroll.employees'), empty: t('payroll.no_employees') },
    { kind: 'contractor', title: t('payroll.contractors'), empty: t('payroll.no_contractors') },
  ];

  return (
    <div className="space-y-5">
      <p className="card text-sm text-muted" data-testid="payroll-notice">
        {t('payroll.notice')}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={() => setAdding('employee')}>
          {t('payroll.add_employee')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setAdding('contractor')}>
          {t('payroll.add_contractor')}
        </button>
      </div>
      {adding && (
        <form
          className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          aria-label={adding === 'employee' ? t('payroll.add_employee') : t('payroll.add_contractor')}
          onSubmit={(e) => {
            e.preventDefault();
            save(adding);
          }}
        >
          <label>
            <span className="field-label">{t('payroll.first_name')}</span>
            <input
              className="input"
              required
              maxLength={100}
              value={form.firstName}
              onChange={set('firstName')}
            />
          </label>
          <label>
            <span className="field-label">{t('payroll.last_name')}</span>
            <input
              className="input"
              required
              maxLength={100}
              value={form.lastName}
              onChange={set('lastName')}
            />
          </label>
          {adding === 'contractor' && (
            <label>
              <span className="field-label">{t('payroll.business_name')}</span>
              <input
                className="input"
                maxLength={200}
                value={form.businessName}
                onChange={set('businessName')}
              />
            </label>
          )}
          <label>
            <span className="field-label">{t('payroll.email')}</span>
            <input className="input" type="email" value={form.email} onChange={set('email')} />
          </label>
          <label>
            <span className="field-label">
              {adding === 'employee' ? t('payroll.hire_date') : t('payroll.start_date')}
            </span>
            <input className="input" type="date" value={form.hireDate} onChange={set('hireDate')} />
          </label>
          {adding === 'employee' && (
            <>
              <label>
                <span className="field-label">{t('payroll.pay_type')}</span>
                <select className="input" value={form.payType} onChange={set('payType')}>
                  <option value="hourly">{t('payroll.pay_hourly')}</option>
                  <option value="salary">{t('payroll.pay_salary')}</option>
                </select>
              </label>
              <label>
                <span className="field-label">
                  {form.payType === 'hourly' ? t('payroll.rate_hourly') : t('payroll.rate_salary')}
                </span>
                <input className="input" inputMode="decimal" value={form.rate} onChange={set('rate')} />
              </label>
              <label>
                <span className="field-label">{t('payroll.work_state')}</span>
                <input
                  className="input uppercase"
                  maxLength={2}
                  value={form.workState}
                  onChange={set('workState')}
                />
              </label>
            </>
          )}
          <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
            <input
              type="checkbox"
              checked={form.isOwner}
              onChange={(e) => setForm((f) => ({ ...f, isOwner: e.target.checked }))}
            />
            {t('payroll.is_owner')}
          </label>
          {ownerNote && (
            <p
              className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn sm:col-span-2 lg:col-span-3"
              role="alert"
              data-testid="owner-warning"
            >
              {t(`payroll.owner_note.${ownerNote}`)}
            </p>
          )}
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('payroll.save_and_continue')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      <StatusLine message={message} />
      {groups.map((g) => {
        const list = people.filter((p) => p.kind === g.kind);
        return (
          <section key={g.kind} className="space-y-2" aria-label={g.title}>
            <h2 className="text-base font-semibold">{g.title}</h2>
            {list.length === 0 ? (
              <p className="card text-sm text-muted">{g.empty}</p>
            ) : (
              <ul className="card-flush divide-y divide-line">
                {list.map((p) => {
                  const missing = missingSteps(p);
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      data-testid="person-row"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`${base}/${p.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {p.displayName}
                        </Link>
                        <span className="chip ml-2">{STATUS[p.status]}</span>
                        <p className="text-xs text-muted">
                          {[p.tinMasked, p.workState].filter(Boolean).join(' · ')}
                          {p.hireDate && (
                            <>
                              {p.tinMasked || p.workState ? ' · ' : ''}
                              {g.kind === 'employee' ? t('payroll.hired') : t('payroll.started')}{' '}
                              <DateText date={p.hireDate} />
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        {p.rate && (
                          <span className="text-right">
                            <Money amount={p.rate} currency={currency} />
                            <span className="block text-xs text-muted">
                              {p.payType === 'salary' ? t('payroll.per_year') : t('payroll.per_hour')}
                            </span>
                          </span>
                        )}
                        {missing.length === 0 ? (
                          <span className="chip chip-good">{t('payroll.ready')}</span>
                        ) : (
                          missing.map((s) => (
                            <span key={s} className="chip chip-warn">
                              {STEP[s]}
                            </span>
                          ))
                        )}
                        {i9Overdue(p, today) && (
                          <span className="chip chip-bad">{t('payroll.i9_overdue')}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
