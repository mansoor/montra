'use client';

import { useState } from 'react';
import type { PaycheckDto, PayRunDto } from '@montra/api-client';
import { calendarDate } from '@montra/domain';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import {
  gridDays,
  hoursText,
  parseHours,
  PAYCHECK_SECTIONS,
  periodDays,
  signedHoursText,
  type EditableKind,
} from '@/lib/payroll';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

type Row = { code: string; label: string; amount: string };

const EMPLOYEE_TAXES = ['fit', 'ss', 'medicare', 'addl_medicare', 'ca_pit', 'ca_sdi'] as const;
const EMPLOYER_TAXES = ['ss_er', 'medicare_er', 'futa', 'ca_ui', 'ca_ett'] as const;
/** Before-tax deductions the tax engine knows: 401(k)-type and cafeteria plan. */
const PRE_TAX = ['retirement', 'section125'] as const;

/** One pay run (PRL-07..09): its paychecks, editable while it's a draft, then approved and posted. */
export function PayRunEditor({
  workspaceId,
  currency,
  run,
  accounts,
  canWrite,
}: {
  workspaceId: string;
  currency: string;
  run: PayRunDto;
  accounts: { id: string; name: string }[];
  canWrite: boolean;
}) {
  const { run: act, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const draft = run.status === 'draft';
  const editable = draft && canWrite;
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [header, setHeader] = useState<{ payDate: string; payFrom: string }>({
    payDate: run.payDate,
    payFrom: run.payFromAccountId ?? '',
  });
  const TAX_NAMES: Record<string, string> = {
    fit: t('payroll.tax.fit'),
    ss: t('payroll.tax.ss'),
    medicare: t('payroll.tax.medicare'),
    addl_medicare: t('payroll.tax.addl_medicare'),
    ca_pit: t('payroll.tax.ca_pit'),
    ca_sdi: t('payroll.tax.ca_sdi'),
    ss_er: t('payroll.tax.ss_er'),
    medicare_er: t('payroll.tax.medicare_er'),
    futa: t('payroll.tax.futa'),
    ca_ui: t('payroll.tax.ca_ui'),
    ca_ett: t('payroll.tax.ca_ett'),
    retirement: t('payroll.pre_tax.retirement'),
    section125: t('payroll.pre_tax.section125'),
  };
  const SECTION: Record<PaycheckDto['lines'][number]['kind'], string> = {
    earning: t('payroll.run.earnings'),
    pre_tax_deduction: t('payroll.run.pre_tax'),
    employee_tax: t('payroll.run.taxes'),
    post_tax_deduction: t('payroll.run.post_tax'),
    reimbursement: t('payroll.run.reimbursements'),
    employer_tax: t('payroll.run.employer_taxes'),
  };

  function saveHeader() {
    void act(
      () =>
        browserApi.updatePayRun(workspaceId, run.id, {
          payDate: calendarDate(header.payDate),
          payFromAccountId: header.payFrom || null,
          version: run.version,
        }),
      t('payroll.saved'),
    );
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`chip ${draft ? 'chip-warn' : 'chip-good'}`}>
            {draft ? t('payroll.run.draft') : t('payroll.run.approved')}
          </span>
          <span className="text-sm text-muted">
            <DateText date={run.periodStart} /> – <DateText date={run.periodEnd} />
            {run.scheduleName && ` · ${run.scheduleName}`}
          </span>
        </div>
        {draft && (
          <p className="text-sm text-muted">
            {run.engine === 'manual' ? t('payroll.run.manual_taxes') : t('payroll.run.engine_taxes')}
          </p>
        )}
        {editable ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('payroll.run.payday')}>
              <input
                className="input"
                type="date"
                value={header.payDate}
                onChange={(e) => setHeader((h) => ({ ...h, payDate: e.target.value }))}
              />
            </Field>
            <Field label={t('payroll.run.pay_from')}>
              <select
                className="input"
                value={header.payFrom}
                onChange={(e) => setHeader((h) => ({ ...h, payFrom: e.target.value }))}
              >
                <option value="">{t('payroll.run.choose_later')}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <button type="button" className="btn-secondary" disabled={busy} onClick={saveHeader}>
                {t('payroll.save')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm">
            {t('payroll.run.payday')} <DateText date={run.payDate} /> ·{' '}
            {accounts.find((a) => a.id === run.payFromAccountId)?.name}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Total label={t('payroll.run.gross')} amount={run.totals.gross} currency={currency} />
          <Total
            label={t('payroll.run.withheld')}
            amount={String(
              BigInt(run.totals.employeeTaxes) + BigInt(run.totals.preTax) + BigInt(run.totals.postTax),
            )}
            currency={currency}
          />
          <Total label={t('payroll.run.net')} amount={run.totals.net} currency={currency} strong />
          <Total
            label={t('payroll.run.employer_taxes')}
            amount={run.totals.employerTaxes}
            currency={currency}
          />
        </dl>
      </section>

      {(run.paychecks ?? []).length === 0 && (
        <p className="card text-sm text-muted">{t('payroll.run.nobody')}</p>
      )}
      {(run.paychecks ?? []).map((pc) => (
        <section key={pc.id} className="card space-y-3" aria-label={pc.personName} data-testid="paycheck">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{pc.personName}</h2>
            <div className="flex items-center gap-3 text-sm">
              <span>
                {t('payroll.run.net')} <Money amount={pc.net} currency={currency} className="font-semibold" />
              </span>
              <a
                className="underline"
                href={browserApi.payslipPath(workspaceId, pc.id)}
                target="_blank"
                rel="noreferrer"
              >
                {t('payroll.run.payslip')}
              </a>
              {editable && editing !== pc.id && (
                <button type="button" className="underline" onClick={() => setEditing(pc.id)}>
                  {t('payroll.edit')}
                </button>
              )}
            </div>
          </div>
          {pc.taxNotes.length > 0 && (
            <ul className="space-y-1 text-xs text-muted" aria-label={t('payroll.run.tax_notes')}>
              {pc.taxNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {editing !== pc.id && (
            <TimeSummary
              paycheck={pc}
              editable={editable}
              busy={busy}
              onUpdate={(input) =>
                void act(
                  () =>
                    browserApi.updatePaycheck(workspaceId, run.id, pc.id, { ...input, version: pc.version }),
                  t('payroll.saved'),
                )
              }
            />
          )}
          {editing === pc.id ? (
            <PaycheckForm
              paycheck={pc}
              period={{ start: run.periodStart, end: run.periodEnd }}
              currency={currency}
              taxNames={TAX_NAMES}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={(input) => {
                void act(
                  () => browserApi.updatePaycheck(workspaceId, run.id, pc.id, input),
                  t('payroll.saved'),
                ).then((r) => {
                  if (r) setEditing(null);
                });
              }}
              onError={(text) => setMessage({ tone: 'bad', text })}
              parse={(text) => {
                const r = parseAmountInput(text, currency, locale, t);
                return r.ok ? String(r.minor) : { error: r.error };
              }}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="text-left font-normal">{t('payroll.run.line')}</th>
                  <th className="text-right font-normal">{t('payroll.run.hours')}</th>
                  <th className="text-right font-normal">{t('payroll.run.amount')}</th>
                  <th className="text-right font-normal">{t('payroll.run.ytd')}</th>
                </tr>
              </thead>
              <tbody>
                {PAYCHECK_SECTIONS.map((kind) => {
                  const lines = pc.lines.filter((l) => l.kind === kind);
                  if (!lines.length) return null;
                  return [
                    <tr key={kind}>
                      <td colSpan={4} className="pt-2 text-xs font-semibold text-muted">
                        {SECTION[kind]}
                      </td>
                    </tr>,
                    ...lines.map((l) => (
                      <tr key={l.id}>
                        <td>{l.label}</td>
                        <td className="num text-right">{l.hoursMilli ? hoursText(l.hoursMilli) : ''}</td>
                        <td className="text-right">
                          <Money
                            amount={
                              kind === 'earning' || kind === 'reimbursement' || kind === 'employer_tax'
                                ? l.amount
                                : `-${l.amount}`
                            }
                            currency={currency}
                          />
                        </td>
                        <td />
                      </tr>
                    )),
                  ];
                })}
                <tr className="border-t border-line font-semibold">
                  <td className="pt-1">{t('payroll.run.net')}</td>
                  <td />
                  <td className="text-right">
                    <Money amount={pc.net} currency={currency} />
                  </td>
                  <td className="text-right text-muted">
                    <Money amount={pc.ytd.net} currency={currency} />
                  </td>
                </tr>
                <tr className="text-muted">
                  <td>{t('payroll.run.gross')}</td>
                  <td />
                  <td className="text-right">
                    <Money amount={pc.gross} currency={currency} />
                  </td>
                  <td className="text-right">
                    <Money amount={pc.ytd.gross} currency={currency} />
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </section>
      ))}

      {canWrite && (
        <section className="card space-y-3">
          {draft ? (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                {t('payroll.run.confirm')}
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !confirmed}
                  onClick={() =>
                    void act(
                      () =>
                        browserApi.approvePayRun(workspaceId, run.id, {
                          version: run.version,
                          confirmed: true,
                        }),
                      t('payroll.run.approved_msg'),
                    )
                  }
                >
                  {t('payroll.run.approve')}
                </button>
                <button
                  type="button"
                  className="btn-ghost text-bad"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t('payroll.run.delete_confirm'))) {
                      void act(() => browserApi.deletePayRun(workspaceId, run.id)).then(() =>
                        window.location.assign('..'),
                      );
                    }
                  }}
                >
                  {t('payroll.run.delete')}
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted">{t('payroll.run.approved_hint')}</p>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('payroll.run.reopen_confirm'))) {
                    void act(
                      () => browserApi.reopenPayRun(workspaceId, run.id, run.version),
                      t('payroll.run.reopened'),
                    );
                  }
                }}
              >
                {t('payroll.run.reopen')}
              </button>
            </div>
          )}
        </section>
      )}
      <StatusLine message={message} />
    </div>
  );
}

function Total({
  label,
  amount,
  currency,
  strong,
}: {
  label: string;
  amount: string;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={strong ? 'font-semibold' : ''}>
        <Money amount={amount} currency={currency} />
      </dd>
    </div>
  );
}

/**
 * Staff time on a paycheck (PRL-26, PRL-27; ADR-0036): how overtime was worked out, vacation and sick balances with
 * their warnings, and on a final paycheck the vacation that can be paid out.
 */
function TimeSummary({
  paycheck: pc,
  editable,
  busy,
  onUpdate,
}: {
  paycheck: PaycheckDto;
  editable: boolean;
  busy: boolean;
  onUpdate: (input: { vacationPayoutHoursMilli?: string; allowLeaveOverBalance?: boolean }) => void;
}) {
  const { t } = useI18n();
  const KIND: Record<string, string> = { vacation: t('payroll.time.vacation'), sick: t('payroll.time.sick') };
  const WARNING: Record<PaycheckDto['leave'][number]['warnings'][number], (kind: string) => string> = {
    over_balance: (kind) => t('payroll.time.warning_over_balance', { kind }),
    over_use_cap: (kind) => t('payroll.time.warning_over_use_cap', { kind }),
    waiting_period: (kind) => t('payroll.time.warning_waiting_period', { kind }),
  };
  const over = pc.leave.some((l) => l.warnings.includes('over_balance'));
  const payable = pc.finalPay ? BigInt(pc.finalPay.vacationPayableMilli) : 0n;
  const paidOut = BigInt(pc.vacationPayoutHoursMilli);
  return (
    <div className="space-y-2">
      {pc.overtimeRules && (
        <p className="text-xs text-muted" data-testid="overtime-method">
          {pc.overtimeMethod === 'daily'
            ? pc.overtimeRules === 'california'
              ? t('payroll.time.method_daily_ca')
              : t('payroll.time.method_daily_federal')
            : t('payroll.time.method_manual')}
        </p>
      )}
      {pc.leave.length > 0 && (
        <table className="w-full text-sm" aria-label={t('payroll.time.leave')}>
          <thead className="text-xs text-muted">
            <tr>
              <th className="text-left font-normal">{t('payroll.time.leave')}</th>
              <th className="text-right font-normal">{t('payroll.time.before')}</th>
              <th className="text-right font-normal">{t('payroll.time.used')}</th>
              <th className="text-right font-normal">{t('payroll.time.earned')}</th>
              <th className="text-right font-normal">{t('payroll.time.paid_out_col')}</th>
              <th className="text-right font-normal">{t('payroll.time.available')}</th>
            </tr>
          </thead>
          <tbody>
            {pc.leave.map((l) => (
              <tr key={l.kind} data-testid={`leave-${l.kind}`}>
                <td>{KIND[l.kind]}</td>
                <td className="num text-right">{signedHoursText(l.beforeMilli)}</td>
                <td className="num text-right">{signedHoursText(l.usedMilli)}</td>
                <td className="num text-right">{signedHoursText(l.accruedMilli)}</td>
                <td className="num text-right">{signedHoursText(l.paidOutMilli)}</td>
                <td className="num text-right font-semibold">{signedHoursText(l.afterMilli)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pc.leave.flatMap((l) =>
        l.warnings.map((w) => (
          <p key={`${l.kind}-${w}`} className="text-xs text-warn" role="status">
            {WARNING[w](KIND[l.kind] ?? l.kind)}
          </p>
        )),
      )}
      {over &&
        (pc.leaveOverAllowed ? (
          <p className="text-xs text-muted">{t('payroll.time.allowed_over')}</p>
        ) : (
          editable && (
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy}
              onClick={() => onUpdate({ allowLeaveOverBalance: true })}
            >
              {t('payroll.time.allow_over')}
            </button>
          )
        ))}
      {pc.finalPay && (
        <div className="rounded border border-line p-2 text-sm" data-testid="final-pay">
          <p>
            {t('payroll.time.final_pay', { date: pc.finalPay.endDate })}{' '}
            {pc.finalPay.payoutRequired ? t('payroll.time.final_pay_ca') : t('payroll.time.final_pay_other')}{' '}
            {t('payroll.time.sick_not_paid')}
          </p>
          {paidOut > 0n ? (
            <p className="mt-1">
              {t('payroll.time.paid_out', { hours: hoursText(String(paidOut)) })}{' '}
              {editable && (
                <button
                  type="button"
                  className="underline"
                  disabled={busy}
                  onClick={() => onUpdate({ vacationPayoutHoursMilli: '0' })}
                >
                  {t('payroll.time.undo_payout')}
                </button>
              )}
            </p>
          ) : (
            editable &&
            payable > 0n && (
              <button
                type="button"
                className="btn-secondary mt-1 text-sm"
                disabled={busy}
                onClick={() => onUpdate({ vacationPayoutHoursMilli: String(payable) })}
              >
                {t('payroll.time.pay_out', { hours: hoursText(String(payable)) })}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** Hours and the lines entered by hand on one draft paycheck. */
function PaycheckForm({
  paycheck,
  period,
  currency,
  taxNames,
  busy,
  onSave,
  onCancel,
  onError,
  parse,
}: {
  paycheck: PaycheckDto;
  period: { start: string; end: string };
  currency: string;
  taxNames: Record<string, string>;
  busy: boolean;
  onSave: (input: Parameters<typeof browserApi.updatePaycheck>[3]) => void;
  onCancel: () => void;
  onError: (text: string) => void;
  parse: (text: string) => string | { error: string };
}) {
  const { t } = useI18n();
  const manual = (kind: EditableKind): Row[] =>
    paycheck.lines
      .filter((l) => l.kind === kind && l.source === 'manual')
      .map((l) => ({ code: l.code, label: l.label, amount: minorToInput(BigInt(l.amount), currency) }));
  const regular = paycheck.lines.find((l) => l.code === 'regular');
  const overtime = paycheck.lines.find((l) => l.code === 'overtime');
  const [hours, setHours] = useState(regular?.hoursMilli ? hoursText(regular.hoursMilli) : '');
  const [ot, setOt] = useState(overtime?.hoursMilli ? hoursText(overtime.hoursMilli) : '');
  const leaveText = (milli: string) => (milli === '0' ? '' : hoursText(milli));
  const [vacation, setVacation] = useState(leaveText(paycheck.vacationHoursMilli));
  const [sick, setSick] = useState(leaveText(paycheck.sickHoursMilli));
  const [daily, setDaily] = useState(paycheck.overtimeMethod === 'daily');
  const [grid, setGrid] = useState<Record<string, string>>(
    Object.fromEntries(paycheck.days.map((d) => [d.date, hoursText(d.hoursMilli)])),
  );
  const [rows, setRows] = useState<Record<EditableKind, Row[]>>({
    earning: manual('earning'),
    pre_tax_deduction: manual('pre_tax_deduction'),
    employee_tax: manual('employee_tax'),
    post_tax_deduction: manual('post_tax_deduction'),
    employer_tax: manual('employer_tax'),
  });
  const TITLES: Record<EditableKind, string> = {
    earning: t('payroll.run.other_earnings'),
    pre_tax_deduction: t('payroll.run.pre_tax'),
    employee_tax: t('payroll.run.taxes'),
    post_tax_deduction: t('payroll.run.post_tax'),
    employer_tax: t('payroll.run.employer_taxes'),
  };
  const codes = (kind: EditableKind): readonly string[] | null =>
    kind === 'employee_tax'
      ? EMPLOYEE_TAXES
      : kind === 'employer_tax'
        ? EMPLOYER_TAXES
        : kind === 'pre_tax_deduction'
          ? PRE_TAX
          : null;

  function submit() {
    const out: Record<string, { code: string; label: string; amount: string }[]> = {};
    for (const kind of Object.keys(rows) as EditableKind[]) {
      const list = [];
      for (const r of rows[kind]) {
        if (!r.amount.trim()) continue;
        const amount = parse(r.amount);
        if (typeof amount !== 'string') return onError(amount.error);
        const label = r.label.trim() || taxNames[r.code] || r.code;
        list.push({
          code:
            r.code ||
            label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '_')
              .slice(0, 40) ||
            'other',
          label,
          amount,
        });
      }
      out[kind] = list;
    }
    const h = hours.trim() ? parseHours(hours) : null;
    const o = ot.trim() ? parseHours(ot) : null;
    const v = vacation.trim() ? parseHours(vacation) : '0';
    const s = sick.trim() ? parseHours(sick) : '0';
    if (h === undefined || o === undefined || v === undefined || s === undefined) {
      return onError(t('payroll.run.bad_hours'));
    }
    const days = daily ? gridDays(grid) : paycheck.overtimeMethod === 'daily' ? null : undefined;
    if (days === undefined && daily) return onError(t('payroll.run.bad_hours'));
    onSave({
      ...(paycheck.payType === 'hourly' && !daily ? { hoursMilli: h, overtimeHoursMilli: o } : {}),
      ...(paycheck.payType ? { vacationHoursMilli: v, sickHoursMilli: s } : {}),
      ...(days !== undefined ? { days } : {}),
      earnings: out.earning,
      preTaxDeductions: out.pre_tax_deduction,
      employeeTaxes: out.employee_tax,
      postTaxDeductions: out.post_tax_deduction,
      employerTaxes: out.employer_tax,
      version: paycheck.version,
    });
  }

  return (
    <form
      className="space-y-3"
      aria-label={t('payroll.run.edit_paycheck', { name: paycheck.personName })}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {paycheck.overtimeRules && (
        <fieldset className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={daily} onChange={(e) => setDaily(e.target.checked)} />
            {t('payroll.time.daily_toggle')}
          </label>
          {daily && (
            <>
              <p className="text-xs text-muted">
                {paycheck.overtimeRules === 'california'
                  ? t('payroll.time.daily_hint_ca')
                  : t('payroll.time.daily_hint_federal')}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-7">
                {periodDays(period.start, period.end).map((d) => (
                  <label key={d} className="text-xs">
                    <span className="field-label">
                      <DateText date={d} />
                    </span>
                    <input
                      className="input num"
                      inputMode="decimal"
                      aria-label={t('payroll.time.hours_on', { date: d })}
                      value={grid[d] ?? ''}
                      onChange={(e) => setGrid((g) => ({ ...g, [d]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>
      )}
      {paycheck.payType && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('payroll.time.vacation_hours')}>
            <input
              className="input num"
              inputMode="decimal"
              value={vacation}
              onChange={(e) => setVacation(e.target.value)}
            />
          </Field>
          <Field label={t('payroll.time.sick_hours')}>
            <input
              className="input num"
              inputMode="decimal"
              value={sick}
              onChange={(e) => setSick(e.target.value)}
            />
          </Field>
          {paycheck.payType === 'salary' && (
            <p className="self-end text-xs text-muted sm:col-span-1">{t('payroll.time.salary_leave_hint')}</p>
          )}
        </div>
      )}
      {paycheck.payType === 'hourly' && !daily && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('payroll.run.regular_hours')}>
            <input
              className="input num"
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </Field>
          <Field label={t('payroll.run.overtime_hours')}>
            <input
              className="input num"
              inputMode="decimal"
              value={ot}
              onChange={(e) => setOt(e.target.value)}
            />
          </Field>
        </div>
      )}
      {(Object.keys(rows) as EditableKind[]).map((kind) => (
        <fieldset key={kind} className="space-y-2">
          <legend className="text-xs font-semibold text-muted">{TITLES[kind]}</legend>
          {rows[kind].map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_8rem_auto]">
              {codes(kind) ? (
                <select
                  className="input"
                  aria-label={
                    kind === 'pre_tax_deduction'
                      ? t('payroll.run.which_deduction')
                      : t('payroll.run.which_tax')
                  }
                  value={r.code}
                  onChange={(e) =>
                    setRows((x) => ({
                      ...x,
                      [kind]: x[kind].map((y, j) =>
                        j === i
                          ? { ...y, code: e.target.value, label: taxNames[e.target.value] ?? y.label }
                          : y,
                      ),
                    }))
                  }
                >
                  {codes(kind)!.map((c) => (
                    <option key={c} value={c}>
                      {taxNames[c]}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  aria-label={t('payroll.run.line_name')}
                  placeholder={t('payroll.run.line_name')}
                  maxLength={100}
                  value={r.label}
                  onChange={(e) =>
                    setRows((x) => ({
                      ...x,
                      [kind]: x[kind].map((y, j) =>
                        j === i ? { ...y, label: e.target.value, code: '' } : y,
                      ),
                    }))
                  }
                />
              )}
              <span className="hidden sm:block" />
              <input
                className="input num"
                aria-label={t('payroll.run.amount')}
                inputMode="decimal"
                value={r.amount}
                onChange={(e) =>
                  setRows((x) => ({
                    ...x,
                    [kind]: x[kind].map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)),
                  }))
                }
              />
              <button
                type="button"
                className="text-sm underline"
                onClick={() => setRows((x) => ({ ...x, [kind]: x[kind].filter((_, j) => j !== i) }))}
              >
                {t('payroll.remove')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-sm underline"
            onClick={() =>
              setRows((x) => {
                const first = codes(kind)?.find((c) => !x[kind].some((y) => y.code === c)) ?? '';
                return {
                  ...x,
                  [kind]: [
                    ...x[kind],
                    { code: first, label: first ? (taxNames[first] ?? '') : '', amount: '' },
                  ],
                };
              })
            }
          >
            {t('payroll.run.add_line')}
          </button>
        </fieldset>
      ))}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('payroll.save')}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
