'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PayRunDto, PayScheduleDto, PayrollPersonDto, ReimbursementDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

interface Option {
  id: string;
  name: string;
}

/** Payroll for one business (PRL-06..11): schedules, pay runs and reimbursement requests. */
export function PayrollHome({
  workspaceId,
  entityId,
  currency,
  schedules,
  runs,
  reimbursements,
  people,
  accounts,
  categories,
  today,
  canWrite,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  schedules: PayScheduleDto[];
  runs: PayRunDto[];
  reimbursements: ReimbursementDto[];
  people: PayrollPersonDto[];
  accounts: Option[];
  categories: Option[];
  today: string;
  canWrite: boolean;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const base = `/w/${workspaceId}/business/${entityId}/payroll`;
  const [addingSchedule, setAddingSchedule] = useState(schedules.length === 0 && canWrite);
  const [sched, setSched] = useState({
    name: t('payroll.run.default_schedule_name'),
    frequency: 'biweekly' as PayScheduleDto['frequency'],
    anchorDate: today,
    payLagDays: '0',
    payFromAccountId: accounts[0]?.id ?? '',
  });
  const [addingClaim, setAddingClaim] = useState(false);
  const [claim, setClaim] = useState({
    personId: people[0]?.id ?? '',
    spentOn: today,
    description: '',
    amount: '',
    expenseAccountId: categories[0]?.id ?? '',
  });
  const [receipts, setReceipts] = useState<File[]>([]);
  const FREQUENCY: Record<PayScheduleDto['frequency'], string> = {
    biweekly: t('payroll.run.biweekly'),
    semimonthly: t('payroll.run.semimonthly'),
    monthly: t('payroll.run.monthly'),
  };
  const STATUS: Record<ReimbursementDto['status'], string> = {
    submitted: t('payroll.claim.submitted'),
    approved: t('payroll.claim.approved'),
    declined: t('payroll.claim.declined'),
    paid: t('payroll.claim.paid'),
  };

  function saveSchedule() {
    void run(
      () =>
        browserApi.createPaySchedule(workspaceId, {
          entityId,
          name: sched.name.trim(),
          frequency: sched.frequency,
          anchorDate: sched.anchorDate,
          payLagDays: Number(sched.payLagDays) || 0,
          payFromAccountId: sched.payFromAccountId || null,
        }),
      t('payroll.run.schedule_saved'),
    ).then((r) => {
      if (r) setAddingSchedule(false);
    });
  }

  async function saveClaim() {
    const parsed = parseAmountInput(claim.amount, currency, locale, t);
    if (!parsed.ok) {
      setMessage({ tone: 'bad', text: parsed.error });
      return;
    }
    const fileIds: string[] = [];
    for (const f of receipts) {
      const up = await run(() => browserApi.uploadReceiptForReimbursement(workspaceId, entityId, f, f.name));
      if (!up) return;
      fileIds.push(up.fileId);
    }
    const r = await run(
      () =>
        browserApi.createReimbursement(workspaceId, {
          entityId,
          personId: claim.personId,
          spentOn: claim.spentOn,
          description: claim.description.trim(),
          amount: String(parsed.minor),
          expenseAccountId: claim.expenseAccountId,
          fileIds,
        }),
      t('payroll.claim.saved'),
    );
    if (r) {
      setAddingClaim(false);
      setClaim((c) => ({ ...c, description: '', amount: '' }));
      setReceipts([]);
    }
  }

  const waiting = reimbursements.filter((r) => r.status === 'submitted');

  return (
    <div className="space-y-6">
      <p className="card text-sm text-muted" data-testid="payroll-run-notice">
        {t('payroll.run.notice')}
      </p>
      <p className="text-sm">
        <Link href={`${base}/taxes`} className="underline">
          {t('payroll.taxes.link')}
        </Link>
      </p>

      <section className="space-y-2" aria-labelledby="pay-runs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pay-runs" className="text-base font-semibold">
            {t('payroll.run.runs')}
          </h2>
          {canWrite &&
            schedules
              .filter((s) => !s.archived)
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void run(() => browserApi.createPayRun(workspaceId, { entityId, scheduleId: s.id })).then(
                      (r) => {
                        if (r) window.location.assign(`${base}/runs/${r.id}`);
                      },
                    )
                  }
                >
                  {t('payroll.run.start', { name: s.name })}
                </button>
              ))}
        </div>
        {runs.length === 0 ? (
          <p className="card text-sm text-muted">{t('payroll.run.none')}</p>
        ) : (
          <ul className="card-flush divide-y divide-line">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                data-testid="pay-run-row"
              >
                <div>
                  <Link href={`${base}/runs/${r.id}`} className="font-medium hover:underline">
                    {t('payroll.run.payday')} <DateText date={r.payDate} />
                  </Link>
                  <span className={`chip ml-2 ${r.status === 'approved' ? 'chip-good' : 'chip-warn'}`}>
                    {r.status === 'approved' ? t('payroll.run.approved') : t('payroll.run.draft')}
                  </span>
                  <p className="text-xs text-muted">
                    <DateText date={r.periodStart} /> – <DateText date={r.periodEnd} />
                    {r.scheduleName && ` · ${r.scheduleName}`} ·{' '}
                    {t('payroll.run.paychecks', { n: r.totals.paychecks })}
                  </p>
                </div>
                <div className="flex gap-4 text-right text-sm">
                  <span>
                    <Money amount={r.totals.gross} currency={currency} />
                    <span className="block text-xs text-muted">{t('payroll.run.gross')}</span>
                  </span>
                  <span>
                    <Money amount={r.totals.net} currency={currency} />
                    <span className="block text-xs text-muted">{t('payroll.run.net')}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="reimbursements">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="reimbursements" className="text-base font-semibold">
            {t('payroll.claim.title')}
            {waiting.length > 0 && (
              <span className="chip chip-warn ml-2">{t('payroll.claim.waiting', { n: waiting.length })}</span>
            )}
          </h2>
          {canWrite && !addingClaim && people.length > 0 && (
            <button type="button" className="btn-secondary" onClick={() => setAddingClaim(true)}>
              {t('payroll.claim.new')}
            </button>
          )}
        </div>
        <p className="text-xs text-muted">{t('payroll.claim.hint')}</p>
        {addingClaim && (
          <form
            className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            aria-label={t('payroll.claim.new')}
            onSubmit={(e) => {
              e.preventDefault();
              void saveClaim();
            }}
          >
            <Field label={t('payroll.claim.person')}>
              <select
                className="input"
                value={claim.personId}
                onChange={(e) => setClaim((c) => ({ ...c, personId: e.target.value }))}
              >
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('payroll.claim.spent_on')}>
              <input
                className="input"
                type="date"
                required
                max={today}
                value={claim.spentOn}
                onChange={(e) => setClaim((c) => ({ ...c, spentOn: e.target.value }))}
              />
            </Field>
            <Field label={t('payroll.claim.amount')}>
              <input
                className="input"
                inputMode="decimal"
                required
                value={claim.amount}
                onChange={(e) => setClaim((c) => ({ ...c, amount: e.target.value }))}
              />
            </Field>
            <Field label={t('payroll.claim.description')}>
              <input
                className="input"
                required
                maxLength={500}
                value={claim.description}
                onChange={(e) => setClaim((c) => ({ ...c, description: e.target.value }))}
              />
            </Field>
            <Field label={t('payroll.claim.category')}>
              <select
                className="input"
                value={claim.expenseAccountId}
                onChange={(e) => setClaim((c) => ({ ...c, expenseAccountId: e.target.value }))}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('payroll.claim.receipt')}>
              <input
                className="input"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => setReceipts([...(e.target.files ?? [])].slice(0, 6))}
              />
            </Field>
            <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
              <button type="submit" className="btn-primary" disabled={busy}>
                {t('payroll.claim.submit')}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setAddingClaim(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
        {reimbursements.length === 0 ? (
          <p className="card text-sm text-muted">{t('payroll.claim.none')}</p>
        ) : (
          <ul className="card-flush divide-y divide-line">
            {reimbursements.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                data-testid="reimbursement-row"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {r.description}
                    <span
                      className={`chip ml-2 ${
                        r.status === 'paid'
                          ? 'chip-good'
                          : r.status === 'declined'
                            ? 'chip-bad'
                            : r.status === 'approved'
                              ? 'chip-muted'
                              : 'chip-warn'
                      }`}
                    >
                      {STATUS[r.status]}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    {r.personName} · <DateText date={r.spentOn} />
                    {r.payVia === 'pay_run' && ` · ${t('payroll.claim.via_pay_run')}`}
                    {r.payVia === 'bill' && ` · ${t('payroll.claim.via_bill')}`}
                    {r.declineReason && ` · ${r.declineReason}`}
                    {r.files.map((f, i) => (
                      <span key={f.id}>
                        {' · '}
                        <a
                          className="underline"
                          href={browserApi.reimbursementFilePath(workspaceId, r.id, f.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('payroll.claim.receipt_n', { n: i + 1 })}
                        </a>
                      </span>
                    ))}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Money amount={r.amount} currency={r.currency} />
                  {canWrite && r.status === 'submitted' && (
                    <>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              browserApi.decideReimbursement(workspaceId, r.id, {
                                decision: 'approve',
                                version: r.version,
                              }),
                            t('payroll.claim.approved_msg'),
                          )
                        }
                      >
                        {t('payroll.claim.approve')}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt(t('payroll.claim.decline_reason')) ?? null;
                          if (reason === null) return;
                          void run(
                            () =>
                              browserApi.decideReimbursement(workspaceId, r.id, {
                                decision: 'decline',
                                reason: reason.trim() || null,
                                version: r.version,
                              }),
                            t('payroll.claim.declined_msg'),
                          );
                        }}
                      >
                        {t('payroll.claim.decline')}
                      </button>
                    </>
                  )}
                  {r.payRunId && (
                    <Link className="text-sm underline" href={`${base}/runs/${r.payRunId}`}>
                      {t('payroll.claim.open_run')}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="pay-schedules">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pay-schedules" className="text-base font-semibold">
            {t('payroll.run.schedules')}
          </h2>
          {canWrite && !addingSchedule && (
            <button type="button" className="btn-secondary" onClick={() => setAddingSchedule(true)}>
              {t('payroll.run.add_schedule')}
            </button>
          )}
        </div>
        {addingSchedule && (
          <form
            className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            aria-label={t('payroll.run.add_schedule')}
            onSubmit={(e) => {
              e.preventDefault();
              saveSchedule();
            }}
          >
            <Field label={t('payroll.run.schedule_name')}>
              <input
                className="input"
                required
                maxLength={100}
                value={sched.name}
                onChange={(e) => setSched((s) => ({ ...s, name: e.target.value }))}
              />
            </Field>
            <Field label={t('payroll.run.frequency')}>
              <select
                className="input"
                value={sched.frequency}
                onChange={(e) =>
                  setSched((s) => ({ ...s, frequency: e.target.value as PayScheduleDto['frequency'] }))
                }
              >
                {(Object.keys(FREQUENCY) as PayScheduleDto['frequency'][]).map((k) => (
                  <option key={k} value={k}>
                    {FREQUENCY[k]}
                  </option>
                ))}
              </select>
            </Field>
            {sched.frequency === 'biweekly' && (
              <Field label={t('payroll.run.anchor')}>
                <input
                  className="input"
                  type="date"
                  required
                  value={sched.anchorDate}
                  onChange={(e) => setSched((s) => ({ ...s, anchorDate: e.target.value }))}
                />
              </Field>
            )}
            <Field label={t('payroll.run.lag')}>
              <input
                className="input"
                type="number"
                min={0}
                max={31}
                value={sched.payLagDays}
                onChange={(e) => setSched((s) => ({ ...s, payLagDays: e.target.value }))}
              />
            </Field>
            <Field label={t('payroll.run.pay_from')}>
              <select
                className="input"
                value={sched.payFromAccountId}
                onChange={(e) => setSched((s) => ({ ...s, payFromAccountId: e.target.value }))}
              >
                <option value="">{t('payroll.run.choose_later')}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end gap-2">
              <button type="submit" className="btn-primary" disabled={busy}>
                {t('payroll.save')}
              </button>
              {schedules.length > 0 && (
                <button type="button" className="btn-ghost" onClick={() => setAddingSchedule(false)}>
                  {t('common.cancel')}
                </button>
              )}
            </div>
          </form>
        )}
        {schedules.length > 0 && (
          <ul className="card-flush divide-y divide-line">
            {schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span>
                  <span className="font-medium">{s.name}</span> · {FREQUENCY[s.frequency]} ·{' '}
                  {t('payroll.run.people_on', { n: s.people })}
                  {s.archived && <span className="chip ml-2">{t('common.archived')}</span>}
                </span>
                <span className="text-muted">
                  {t('payroll.run.next')} <DateText date={s.nextPeriod.start} /> –{' '}
                  <DateText date={s.nextPeriod.end} />, {t('payroll.run.paid_on')}{' '}
                  <DateText date={s.nextPeriod.payDate} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {schedules.length > 0 && <p className="text-xs text-muted">{t('payroll.run.assign_hint')}</p>}
      </section>
      <StatusLine message={message} />
    </div>
  );
}
