'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { LeaveKind, PersonLeaveDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseSignedHours, signedHoursText } from '@/lib/payroll';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

/**
 * An employee's vacation and sick leave (PRL-25; ADR-0036): balances, the hours behind them, and an opening balance or
 * adjustment entered by the owner. Pay runs write the rest when they're approved.
 */
export function LeavePanel({
  workspaceId,
  entityId,
  personId,
  leave: initial,
  today,
}: {
  workspaceId: string;
  entityId: string;
  personId: string;
  leave: PersonLeaveDto;
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [leave, setLeave] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    kind: 'vacation' as LeaveKind,
    source: (initial.entries.some((e) => e.source === 'opening' && e.kind === 'vacation')
      ? 'adjustment'
      : 'opening') as 'opening' | 'adjustment',
    date: today,
    hours: '',
    note: '',
  });
  const KIND: Record<LeaveKind, string> = {
    vacation: t('payroll.time.vacation'),
    sick: t('payroll.time.sick'),
  };
  const SOURCE: Record<PersonLeaveDto['entries'][number]['source'], string> = {
    opening: t('payroll.time.source_opening'),
    adjustment: t('payroll.time.source_adjustment'),
    accrual: t('payroll.time.source_accrual'),
    grant: t('payroll.time.source_grant'),
    carryover: t('payroll.time.source_carryover'),
    used: t('payroll.time.source_used'),
    payout: t('payroll.time.source_payout'),
  };
  const shown = leave.balances.filter((b) => b.tracked);

  function save() {
    const hours = parseSignedHours(form.hours);
    if (!hours || hours === '0') {
      setMessage({ tone: 'bad', text: t('payroll.run.bad_hours') });
      return;
    }
    void run(
      () =>
        browserApi.addLeaveEntry(workspaceId, personId, {
          kind: form.kind,
          source: form.source,
          date: form.date,
          hoursMilli: hours,
          note: form.note.trim() || null,
        }),
      t('payroll.saved'),
    ).then((r) => {
      if (!r) return;
      setLeave(r);
      setAdding(false);
      setForm((f) => ({ ...f, source: 'adjustment', hours: '', note: '' }));
    });
  }

  return (
    <section className="card space-y-3" aria-labelledby="leave-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="leave-heading" className="text-base font-semibold">
          {t('payroll.time.leave')}
        </h2>
        <Link href={`/w/${workspaceId}/business/${entityId}/payroll/time-off`} className="text-sm underline">
          {t('payroll.time.policies_link')}
        </Link>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{t('payroll.time.not_tracked')}</p>
      ) : (
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {shown.map((b) => (
            <div key={b.kind} data-testid={`balance-${b.kind}`}>
              <dt className="text-xs text-muted">{KIND[b.kind]}</dt>
              <dd className="text-lg font-semibold">
                {t('payroll.time.hours_n', { hours: signedHoursText(b.balanceMilli) })}
              </dd>
              <dd className="text-xs text-muted">
                {t('payroll.time.this_year', {
                  used: signedHoursText(b.usedThisYearMilli),
                  earned: signedHoursText(b.accruedThisYearMilli),
                })}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {leave.entries.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="text-left font-normal">{t('payroll.time.date')}</th>
              <th className="text-left font-normal">{t('payroll.time.kind')}</th>
              <th className="text-left font-normal">{t('payroll.time.what')}</th>
              <th className="text-right font-normal">{t('payroll.run.hours')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {leave.entries.slice(0, 50).map((e) => (
              <tr key={e.id}>
                <td>
                  <DateText date={e.date} />
                </td>
                <td>{KIND[e.kind]}</td>
                <td>
                  {e.payRunId ? (
                    <Link
                      className="underline"
                      href={`/w/${workspaceId}/business/${entityId}/payroll/runs/${e.payRunId}`}
                    >
                      {SOURCE[e.source]}
                    </Link>
                  ) : (
                    SOURCE[e.source]
                  )}
                  {e.note && <span className="text-muted"> · {e.note}</span>}
                </td>
                <td className="num text-right">{signedHoursText(e.hoursMilli)}</td>
                <td className="text-right">
                  {e.canDelete && (
                    <button
                      type="button"
                      className="text-xs underline"
                      disabled={busy}
                      onClick={() =>
                        void run(() => browserApi.deleteLeaveEntry(workspaceId, personId, e.id)).then((r) => {
                          if (r) setLeave(r);
                        })
                      }
                    >
                      {t('payroll.remove')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding ? (
        <form
          className="grid gap-3 sm:grid-cols-3"
          aria-label={t('payroll.time.add_hours')}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label={t('payroll.time.kind')}>
            <select
              className="input"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as LeaveKind }))}
            >
              <option value="vacation">{KIND.vacation}</option>
              <option value="sick">{KIND.sick}</option>
            </select>
          </Field>
          <Field label={t('payroll.time.what')}>
            <select
              className="input"
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as 'opening' | 'adjustment' }))}
            >
              <option value="opening">{SOURCE.opening}</option>
              <option value="adjustment">{SOURCE.adjustment}</option>
            </select>
          </Field>
          <Field label={t('payroll.time.date')}>
            <input
              className="input"
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.time.hours_signed')}>
            <input
              className="input num"
              inputMode="decimal"
              value={form.hours}
              onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
            />
          </Field>
          <label className="sm:col-span-2">
            <span className="field-label">{t('payroll.notes')}</span>
            <input
              className="input"
              maxLength={500}
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </label>
          <p className="text-xs text-muted sm:col-span-3">{t('payroll.time.opening_hint')}</p>
          <div className="flex gap-2 sm:col-span-3">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('payroll.save')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
          {t('payroll.time.add_hours')}
        </button>
      )}
      <p className="text-xs text-muted">{t('payroll.time.not_posted')}</p>
      <StatusLine message={message} />
    </section>
  );
}
