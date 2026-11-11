'use client';

import { useState } from 'react';
import type { PayrollPersonDto, UpdatePersonInput } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { digitsOnly, formatTinInput, hoursText, parseHours } from '@/lib/payroll';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { Reveal, tinText } from './reveal';

/**
 * A person's record (PRL-01, PRL-05): contact and pay details, and the tax ID, birth date and bank details, which are
 * shown masked and changed by typing a new value. Nothing secret is ever put back into a form.
 */
export function PersonDetails({
  workspaceId,
  currency,
  person,
  schedules = [],
}: {
  workspaceId: string;
  currency: string;
  person: PayrollPersonDto;
  /** Pay schedules of the business, to put an employee on one (PRL-06). */
  schedules?: { id: string; name: string }[];
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const [editing, setEditing] = useState<'details' | 'secret' | null>(null);
  const p = person;
  const [form, setForm] = useState(() => initial(p, currency));
  const [secret, setSecret] = useState({
    tinType: (p.tinType ?? (p.kind === 'contractor' ? 'ein' : 'ssn')) as 'ssn' | 'itin' | 'ein',
    tin: '',
    birthDate: '',
    routing: '',
    account: '',
    accountType: (p.bank?.accountType ?? 'checking') as 'checking' | 'savings',
    clearBank: false,
  });
  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  const isEmployee = p.kind === 'employee';

  function saveDetails() {
    let rate: string | null = null;
    if (form.rate.trim()) {
      const parsed = parseAmountInput(form.rate, currency, locale, t);
      if (!parsed.ok) {
        setMessage({ tone: 'bad', text: parsed.error });
        return;
      }
      rate = String(parsed.minor);
    }
    const usualHours = form.defaultHours.trim() ? parseHours(form.defaultHours) : null;
    if (usualHours === undefined) {
      setMessage({ tone: 'bad', text: t('payroll.run.bad_hours') });
      return;
    }
    const input: UpdatePersonInput = {
      firstName: form.firstName.trim(),
      middleName: form.middleName.trim() || null,
      lastName: form.lastName.trim(),
      businessName: form.businessName.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      address: {
        line1: form.line1.trim() || null,
        line2: form.line2.trim() || null,
        city: form.city.trim() || null,
        region: form.region.trim() || null,
        postalCode: form.postalCode.trim() || null,
      },
      hireDate: form.hireDate || null,
      endDate: form.endDate || null,
      payType: isEmployee ? (form.payType as 'hourly' | 'salary') : null,
      rate,
      workState: form.workState.trim() || null,
      notes: form.notes.trim() || null,
      ...(isEmployee ? { payScheduleId: form.payScheduleId || null, defaultHoursMilli: usualHours } : {}),
      version: p.version,
    };
    void run(() => browserApi.updatePayrollPerson(workspaceId, p.id, input), t('payroll.saved')).then((r) => {
      if (r) setEditing(null);
    });
  }

  function saveSecret() {
    const input: UpdatePersonInput = { version: p.version };
    if (secret.tin.trim()) input.tin = { type: secret.tinType, value: digitsOnly(secret.tin) };
    if (secret.birthDate) input.birthDate = secret.birthDate;
    if (secret.clearBank) input.bank = null;
    else if (secret.routing.trim() || secret.account.trim()) {
      input.bank = { routing: secret.routing, account: secret.account, accountType: secret.accountType };
    }
    void run(() => browserApi.updatePayrollPerson(workspaceId, p.id, input), t('payroll.saved')).then((r) => {
      if (r) {
        setEditing(null);
        setSecret((s) => ({ ...s, tin: '', birthDate: '', routing: '', account: '', clearBank: false }));
      }
    });
  }

  const address = [
    p.address.line1,
    p.address.line2,
    [p.address.city, p.address.region, p.address.postalCode].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="space-y-4">
      <section className="card space-y-3" aria-labelledby="person-details">
        <div className="flex items-center justify-between gap-2">
          <h2 id="person-details" className="text-base font-semibold">
            {t('payroll.details')}
          </h2>
          {editing !== 'details' && (
            <button
              type="button"
              className="text-sm underline"
              onClick={() => {
                setForm(initial(p, currency));
                setEditing('details');
              }}
            >
              {t('payroll.edit')}
            </button>
          )}
        </div>
        {editing === 'details' ? (
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveDetails();
            }}
          >
            <Field label={t('payroll.first_name')}>
              <input
                className="input"
                required
                maxLength={100}
                value={form.firstName}
                onChange={set('firstName')}
              />
            </Field>
            <Field label={t('payroll.middle_name')}>
              <input className="input" maxLength={100} value={form.middleName} onChange={set('middleName')} />
            </Field>
            <Field label={t('payroll.last_name')}>
              <input
                className="input"
                required
                maxLength={100}
                value={form.lastName}
                onChange={set('lastName')}
              />
            </Field>
            {!isEmployee && (
              <Field label={t('payroll.business_name')}>
                <input
                  className="input"
                  maxLength={200}
                  value={form.businessName}
                  onChange={set('businessName')}
                />
              </Field>
            )}
            <Field label={t('payroll.email')}>
              <input className="input" type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label={t('payroll.phone')}>
              <input className="input" maxLength={50} value={form.phone} onChange={set('phone')} />
            </Field>
            <Field label={t('payroll.address_line1')}>
              <input className="input" maxLength={200} value={form.line1} onChange={set('line1')} />
            </Field>
            <Field label={t('payroll.address_line2')}>
              <input className="input" maxLength={200} value={form.line2} onChange={set('line2')} />
            </Field>
            <Field label={t('payroll.city')}>
              <input className="input" maxLength={100} value={form.city} onChange={set('city')} />
            </Field>
            <Field label={t('payroll.state')}>
              <input
                className="input uppercase"
                maxLength={50}
                value={form.region}
                onChange={set('region')}
              />
            </Field>
            <Field label={t('payroll.zip')}>
              <input className="input" maxLength={20} value={form.postalCode} onChange={set('postalCode')} />
            </Field>
            <Field label={isEmployee ? t('payroll.hire_date') : t('payroll.start_date')}>
              <input className="input" type="date" value={form.hireDate} onChange={set('hireDate')} />
            </Field>
            <Field label={t('payroll.end_date')}>
              <input className="input" type="date" value={form.endDate} onChange={set('endDate')} />
            </Field>
            {isEmployee && (
              <>
                <Field label={t('payroll.pay_type')}>
                  <select className="input" value={form.payType} onChange={set('payType')}>
                    <option value="hourly">{t('payroll.pay_hourly')}</option>
                    <option value="salary">{t('payroll.pay_salary')}</option>
                  </select>
                </Field>
                <Field
                  label={form.payType === 'salary' ? t('payroll.rate_salary') : t('payroll.rate_hourly')}
                >
                  <input className="input" inputMode="decimal" value={form.rate} onChange={set('rate')} />
                </Field>
                <Field label={t('payroll.work_state')}>
                  <input
                    className="input uppercase"
                    maxLength={2}
                    value={form.workState}
                    onChange={set('workState')}
                  />
                </Field>
                <Field label={t('payroll.run.schedule')}>
                  <select className="input" value={form.payScheduleId} onChange={set('payScheduleId')}>
                    <option value="">{t('payroll.run.no_schedule')}</option>
                    {schedules.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {form.payType === 'hourly' && (
                  <Field label={t('payroll.run.usual_hours')}>
                    <input
                      className="input num"
                      inputMode="decimal"
                      value={form.defaultHours}
                      onChange={set('defaultHours')}
                    />
                  </Field>
                )}
              </>
            )}
            <label className="sm:col-span-2 lg:col-span-3">
              <span className="field-label">{t('payroll.notes')}</span>
              <textarea
                className="input"
                rows={2}
                maxLength={2000}
                value={form.notes}
                onChange={set('notes')}
              />
            </label>
            <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
              <button type="submit" className="btn-primary" disabled={busy}>
                {t('payroll.save')}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Item label={t('payroll.email')}>{p.email}</Item>
            <Item label={t('payroll.phone')}>{p.phone}</Item>
            <Item label={t('payroll.address')}>{address || null}</Item>
            <Item label={isEmployee ? t('payroll.hire_date') : t('payroll.start_date')}>
              {p.hireDate ? <DateText date={p.hireDate} /> : null}
            </Item>
            <Item label={t('payroll.end_date')}>{p.endDate ? <DateText date={p.endDate} /> : null}</Item>
            {isEmployee && (
              <>
                <Item label={t('payroll.pay')}>
                  {p.rate ? (
                    <>
                      <Money amount={p.rate} currency={currency} />{' '}
                      {p.payType === 'salary' ? t('payroll.per_year') : t('payroll.per_hour')}
                    </>
                  ) : null}
                </Item>
                <Item label={t('payroll.work_state')}>{p.workState}</Item>
                <Item label={t('payroll.run.schedule')}>
                  {schedules.find((s) => s.id === p.payScheduleId)?.name ?? null}
                  {p.defaultHoursMilli &&
                    ` · ${t('payroll.run.hours_each', { hours: hoursText(p.defaultHoursMilli) })}`}
                </Item>
              </>
            )}
            {p.notes && <Item label={t('payroll.notes')}>{p.notes}</Item>}
          </dl>
        )}
      </section>

      <section className="card space-y-3" aria-labelledby="person-private">
        <div className="flex items-center justify-between gap-2">
          <h2 id="person-private" className="text-base font-semibold">
            {t('payroll.private_details')}
          </h2>
          {editing !== 'secret' && (
            <button type="button" className="text-sm underline" onClick={() => setEditing('secret')}>
              {t('payroll.change')}
            </button>
          )}
        </div>
        <p className="text-xs text-muted">{t('payroll.private_hint')}</p>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Item label={p.tinType === 'ein' ? t('payroll.ein') : t('payroll.ssn')}>
            <Reveal
              workspaceId={workspaceId}
              personId={p.id}
              masked={p.tinMasked}
              request={{ field: 'tin' }}
              format={tinText(p.tinType)}
            />
          </Item>
          {isEmployee && (
            <Item label={t('payroll.birth_date')}>
              <Reveal
                workspaceId={workspaceId}
                personId={p.id}
                masked={p.hasBirthDate ? '••/••/••••' : null}
                request={{ field: 'birthDate' }}
              />
            </Item>
          )}
          <Item label={t('payroll.bank')}>
            {p.bank ? (
              <span className="space-y-1">
                <span className="block">
                  {p.bank.accountType === 'savings' ? t('payroll.savings') : t('payroll.checking')}{' '}
                  <Reveal
                    workspaceId={workspaceId}
                    personId={p.id}
                    masked={`•••• ${p.bank.last4}`}
                    request={{ field: 'bankAccount' }}
                  />
                </span>
                <span className="block text-xs text-muted">
                  {t('payroll.routing')}{' '}
                  <Reveal
                    workspaceId={workspaceId}
                    personId={p.id}
                    masked="•••••••••"
                    request={{ field: 'bankRouting' }}
                  />
                </span>
              </span>
            ) : (
              <span className="text-muted">{t('payroll.not_recorded')}</span>
            )}
          </Item>
        </dl>
        {editing === 'secret' && (
          <form
            className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-3"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              saveSecret();
            }}
          >
            <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{t('payroll.change_hint')}</p>
            <Field label={t('payroll.tin_type')}>
              <select
                className="input"
                value={secret.tinType}
                onChange={(e) =>
                  setSecret((s) => ({ ...s, tinType: e.target.value as 'ssn' | 'itin' | 'ein' }))
                }
              >
                <option value="ssn">{t('payroll.ssn')}</option>
                <option value="itin">{t('payroll.itin')}</option>
                {!isEmployee && <option value="ein">{t('payroll.ein')}</option>}
              </select>
            </Field>
            <Field label={t('payroll.new_tin')}>
              <input
                className="input num"
                inputMode="numeric"
                autoComplete="off"
                value={secret.tin}
                onChange={(e) => setSecret((s) => ({ ...s, tin: formatTinInput(s.tinType, e.target.value) }))}
              />
            </Field>
            {isEmployee && (
              <Field label={t('payroll.birth_date')}>
                <input
                  className="input"
                  type="date"
                  value={secret.birthDate}
                  onChange={(e) => setSecret((s) => ({ ...s, birthDate: e.target.value }))}
                />
              </Field>
            )}
            <Field label={t('payroll.routing')}>
              <input
                className="input num"
                inputMode="numeric"
                autoComplete="off"
                maxLength={9}
                value={secret.routing}
                onChange={(e) => setSecret((s) => ({ ...s, routing: digitsOnly(e.target.value) }))}
              />
            </Field>
            <Field label={t('payroll.account_number')}>
              <input
                className="input num"
                inputMode="numeric"
                autoComplete="off"
                maxLength={17}
                value={secret.account}
                onChange={(e) => setSecret((s) => ({ ...s, account: digitsOnly(e.target.value) }))}
              />
            </Field>
            <Field label={t('payroll.account_type')}>
              <select
                className="input"
                value={secret.accountType}
                onChange={(e) =>
                  setSecret((s) => ({ ...s, accountType: e.target.value as 'checking' | 'savings' }))
                }
              >
                <option value="checking">{t('payroll.checking')}</option>
                <option value="savings">{t('payroll.savings')}</option>
              </select>
            </Field>
            {p.bank && (
              <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
                <input
                  type="checkbox"
                  checked={secret.clearBank}
                  onChange={(e) => setSecret((s) => ({ ...s, clearBank: e.target.checked }))}
                />
                {t('payroll.remove_bank')}
              </label>
            )}
            <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{t('payroll.bank_hint')}</p>
            <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
              <button type="submit" className="btn-primary" disabled={busy}>
                {t('payroll.save')}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
      </section>
      <StatusLine message={message} />
    </div>
  );
}

function initial(p: PayrollPersonDto, currency: string) {
  return {
    firstName: p.firstName,
    middleName: p.middleName ?? '',
    lastName: p.lastName,
    businessName: p.businessName ?? '',
    email: p.email ?? '',
    phone: p.phone ?? '',
    line1: p.address.line1 ?? '',
    line2: p.address.line2 ?? '',
    city: p.address.city ?? '',
    region: p.address.region ?? '',
    postalCode: p.address.postalCode ?? '',
    hireDate: p.hireDate ?? '',
    endDate: p.endDate ?? '',
    payType: p.payType ?? 'hourly',
    rate: p.rate ? minorToInput(BigInt(p.rate), currency) : '',
    workState: p.workState ?? '',
    notes: p.notes ?? '',
    payScheduleId: p.payScheduleId ?? '',
    defaultHours: p.defaultHoursMilli ? hoursText(p.defaultHoursMilli) : '',
  };
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd>{children ?? <span className="text-muted">—</span>}</dd>
    </div>
  );
}
