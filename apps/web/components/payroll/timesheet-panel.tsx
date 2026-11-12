'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ContractorTimesheetDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { hoursText, parseHours } from '@/lib/payroll';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { Field } from './person-details';

/**
 * A contractor's timesheet (PRL-28; ADR-0036 §5): hours by day with a note and, optionally, the customer they were for.
 * "Bill these hours" makes one bill to the contractor's vendor record; billed hours are locked until the bill is voided.
 */
export function TimesheetPanel({
  workspaceId,
  entityId,
  personId,
  currency,
  sheet: initial,
  customers,
  today,
}: {
  workspaceId: string;
  entityId: string;
  personId: string;
  currency: string;
  sheet: ContractorTimesheetDto;
  customers: { id: string; name: string }[];
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [sheet, setSheet] = useState(initial);
  const [form, setForm] = useState({ workDate: today, hours: '', note: '', customerPartyId: '' });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [billDate, setBillDate] = useState(today);
  const base = `/w/${workspaceId}/business/${entityId}`;
  const unbilled = sheet.entries.filter((e) => !e.billId);
  const chosenHours = unbilled.filter((e) => chosen.has(e.id)).reduce((s, e) => s + BigInt(e.hoursMilli), 0n);
  const STATUS: Record<'open' | 'paid' | 'overdue', string> = {
    open: t('payroll.time.bill_open'),
    paid: t('payroll.time.bill_paid'),
    overdue: t('payroll.time.bill_overdue'),
  };

  function add() {
    const hours = parseHours(form.hours);
    if (!hours || hours === '0' || BigInt(hours) > 24000n) {
      setMessage({ tone: 'bad', text: t('payroll.run.bad_hours') });
      return;
    }
    void run(
      () =>
        browserApi.addTimeEntry(workspaceId, personId, {
          workDate: form.workDate,
          hoursMilli: hours,
          note: form.note.trim() || null,
          customerPartyId: form.customerPartyId || null,
        }),
      t('payroll.saved'),
    ).then((r) => {
      if (!r) return;
      setSheet(r);
      setForm((f) => ({ ...f, hours: '', note: '' }));
    });
  }

  function bill() {
    void run(
      () => browserApi.billTime(workspaceId, personId, { entryIds: [...chosen], billDate }),
      (r) => t('payroll.time.billed_msg', { hours: hoursText(r.hoursMilli) }),
    ).then((r) => {
      if (!r) return;
      setSheet(r.timesheet);
      setChosen(new Set());
    });
  }

  return (
    <section className="card space-y-3" aria-labelledby="timesheet-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="timesheet-heading" className="text-base font-semibold">
          {t('payroll.time.timesheet')}
        </h2>
        <span className="text-sm text-muted">
          {sheet.rate ? (
            <>
              <Money amount={sheet.rate} currency={currency} /> {t('payroll.per_hour')}
            </>
          ) : (
            t('payroll.time.no_rate')
          )}
        </span>
      </div>
      {!sheet.vendorPartyId && <p className="text-sm text-warn">{t('payroll.time.no_vendor')}</p>}

      <form
        className="grid gap-3 sm:grid-cols-4"
        aria-label={t('payroll.time.add_time')}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label={t('payroll.time.date')}>
          <input
            className="input"
            type="date"
            value={form.workDate}
            onChange={(e) => setForm((f) => ({ ...f, workDate: e.target.value }))}
          />
        </Field>
        <Field label={t('payroll.run.hours')}>
          <input
            className="input num"
            inputMode="decimal"
            value={form.hours}
            onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
          />
        </Field>
        <Field label={t('payroll.time.project')}>
          <input
            className="input"
            maxLength={500}
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </Field>
        <Field label={t('payroll.time.customer')}>
          <select
            className="input"
            value={form.customerPartyId}
            onChange={(e) => setForm((f) => ({ ...f, customerPartyId: e.target.value }))}
          >
            <option value="">{t('payroll.time.no_customer')}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-4">
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('payroll.time.add_time')}
          </button>
        </div>
      </form>

      {sheet.entries.length === 0 ? (
        <p className="text-sm text-muted">{t('payroll.time.no_entries')}</p>
      ) : (
        <table className="w-full text-sm" aria-label={t('payroll.time.timesheet')}>
          <thead className="text-xs text-muted">
            <tr>
              <th className="w-8" />
              <th className="text-left font-normal">{t('payroll.time.date')}</th>
              <th className="text-left font-normal">{t('payroll.time.project')}</th>
              <th className="text-right font-normal">{t('payroll.run.hours')}</th>
              <th className="text-right font-normal">{t('payroll.run.amount')}</th>
              <th className="text-right font-normal">{t('payroll.time.billed')}</th>
            </tr>
          </thead>
          <tbody>
            {sheet.entries.map((e) => (
              <tr key={e.id} data-testid="time-entry">
                <td>
                  {!e.billId && (
                    <input
                      type="checkbox"
                      aria-label={t('payroll.time.choose', { date: e.workDate })}
                      checked={chosen.has(e.id)}
                      onChange={(ev) =>
                        setChosen((s) => {
                          const n = new Set(s);
                          if (ev.target.checked) n.add(e.id);
                          else n.delete(e.id);
                          return n;
                        })
                      }
                    />
                  )}
                </td>
                <td>
                  <DateText date={e.workDate} />
                </td>
                <td>
                  {e.note}
                  {e.customerName && (
                    <span className="text-muted">
                      {e.note ? ' · ' : ''}
                      {e.customerName}{' '}
                      <Link
                        className="underline"
                        href={`${base}/invoices/new?customer=${encodeURIComponent(e.customerPartyId ?? '')}`}
                      >
                        {t('payroll.time.invoice_customer')}
                      </Link>
                    </span>
                  )}
                </td>
                <td className="num text-right">{hoursText(e.hoursMilli)}</td>
                <td className="text-right">
                  {e.amount ? <Money amount={e.amount} currency={currency} /> : '—'}
                </td>
                <td className="text-right">
                  {e.billId && e.billStatus ? (
                    <Link className="underline" href={`${base}/bills`}>
                      {STATUS[e.billStatus]}
                    </Link>
                  ) : (
                    !e.billId && (
                      <button
                        type="button"
                        className="text-xs underline"
                        disabled={busy}
                        onClick={() =>
                          void run(() => browserApi.deleteTimeEntry(workspaceId, e.id)).then((r) => {
                            if (r) setSheet(r);
                          })
                        }
                      >
                        {t('payroll.remove')}
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {unbilled.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <p className="text-sm">
            {t('payroll.time.unbilled', { hours: hoursText(sheet.unbilledHoursMilli) })}
            {sheet.unbilledAmount && (
              <>
                {' · '}
                <Money amount={sheet.unbilledAmount} currency={currency} />
              </>
            )}
          </p>
          <button
            type="button"
            className="text-sm underline"
            onClick={() => setChosen(new Set(unbilled.map((e) => e.id)))}
          >
            {t('payroll.time.choose_all')}
          </button>
          <Field label={t('payroll.time.bill_date')}>
            <input
              className="input"
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
            />
          </Field>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || chosen.size === 0 || !sheet.rate || !sheet.vendorPartyId}
            onClick={bill}
          >
            {chosen.size
              ? t('payroll.time.bill_hours_n', { hours: hoursText(String(chosenHours)) })
              : t('payroll.time.bill_hours')}
          </button>
        </div>
      )}
      <p className="text-xs text-muted">{t('payroll.time.bill_hint')}</p>
      <StatusLine message={message} />
    </section>
  );
}
