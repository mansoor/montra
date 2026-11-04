'use client';

import { useState } from 'react';
import type {
  AccountDto,
  AllocationRuleDto,
  AmortizationRowDto,
  BusinessProfileDto,
  LoanDto,
  MaintenanceDto,
  PropertyDto,
  ReminderDto,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  ALLOCATION_BASES,
  MAINTENANCE_CHIP,
  MAINTENANCE_STATUSES,
  optionalBps,
  optionalMinor,
  percentTotal,
  positiveMinor,
  REMINDER_KINDS,
} from '@/lib/rentals';
import { percentToBps } from '@/lib/business';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

// ----- Mortgages (RNT-08) --------------------------------------------------------------------------------

export function NewLoanForm({
  workspaceId,
  properties,
  loanAccounts,
  currency,
  today,
}: {
  workspaceId: string;
  properties: PropertyDto[];
  loanAccounts: AccountDto[];
  currency: string;
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '');
  const [loanAccountId, setLoanAccountId] = useState(loanAccounts[0]?.id ?? '');
  const [name, setName] = useState('');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('');
  const [term, setTerm] = useState('360');
  const [first, setFirst] = useState(today);
  const [taxes, setTaxes] = useState('');
  const [insurance, setInsurance] = useState('');
  return (
    <details className="card">
      <summary className="cursor-pointer text-base font-semibold">{t('rentals.add_loan')}</summary>
      {loanAccounts.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t('rentals.no_loan_accounts')}</p>
      ) : (
        <form
          className="mt-3 space-y-3"
          aria-label={t('rentals.add_loan')}
          onSubmit={(e) => {
            e.preventDefault();
            const p = positiveMinor(principal, currency, t);
            if (!p.ok) return setMessage({ tone: 'bad', text: p.error });
            const bps = optionalBps(rate, t);
            if (!bps.ok) return setMessage({ tone: 'bad', text: bps.error });
            const et = optionalMinor(taxes, currency, t);
            if (!et.ok) return setMessage({ tone: 'bad', text: et.error });
            const ei = optionalMinor(insurance, currency, t);
            if (!ei.ok) return setMessage({ tone: 'bad', text: ei.error });
            void run(
              () =>
                browserApi.createLoan(workspaceId, {
                  propertyId,
                  loanAccountId,
                  name: name.trim(),
                  principal: p.value,
                  rateBps: bps.value ?? 0,
                  termMonths: Number(term),
                  firstPaymentDate: first as never,
                  escrowTaxes: et.value ?? '0',
                  escrowInsurance: ei.value ?? '0',
                }),
              t('rentals.loan_added'),
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label>
              <span className="field-label">{t('rentals.property')}</span>
              <select
                className="input"
                required
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value)}
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('rentals.loan_account')}</span>
              <select
                className="input"
                required
                value={loanAccountId}
                onChange={(e) => setLoanAccountId(e.target.value)}
              >
                {loanAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('rentals.loan_name')}</span>
              <input
                className="input"
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('rentals.principal')}</span>
              <input
                className="input"
                inputMode="decimal"
                required
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('rentals.rate')}</span>
              <input
                className="input"
                inputMode="decimal"
                required
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('rentals.term_months')}</span>
              <input
                className="input"
                inputMode="numeric"
                pattern="\d{1,3}"
                required
                value={term}
                onChange={(e) => setTerm(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('rentals.first_payment')}</span>
              <input
                className="input"
                type="date"
                required
                value={first}
                onChange={(e) => setFirst(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('rentals.escrow_taxes')}</span>
              <input
                className="input"
                inputMode="decimal"
                value={taxes}
                onChange={(e) => setTaxes(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('rentals.escrow_insurance')}</span>
              <input
                className="input"
                inputMode="decimal"
                value={insurance}
                onChange={(e) => setInsurance(e.target.value)}
              />
            </label>
          </div>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('rentals.add_loan')}
          </button>
          <StatusLine message={message} />
        </form>
      )}
    </details>
  );
}

/** The schedule: the next payments to come and the ones already made. */
export function LoanSchedule({
  workspaceId,
  loan,
  rows,
  accounts,
  base,
}: {
  workspaceId: string;
  loan: LoanDto;
  rows: AmortizationRowDto[];
  accounts: AccountDto[];
  base: string;
}) {
  const { run, busy, message, t } = useAction();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const ccy = loan.currency;
  const nextUnpaid = rows.findIndex((r) => !r.transactionId);
  const lastShown = nextUnpaid === -1 ? rows.length : nextUnpaid + 6;
  const shown = rows.slice(Math.max(0, nextUnpaid - 6), lastShown);
  return (
    <section className="card-flush" aria-label={t('rentals.schedule_for', { name: loan.name })}>
      <div className="flex flex-wrap items-end justify-between gap-2 px-4 pt-3">
        <p className="text-sm text-muted">
          {t('rentals.loan_summary', { made: loan.paymentsMade, total: rows.length })}
        </p>
        <label>
          <span className="field-label">{t('rentals.paid_from')}</span>
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th className="px-4 py-2">{t('rentals.payment_number')}</th>
              <th className="px-2 py-2">{t('rentals.date')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.interest')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.principal')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.escrow')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.balance')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => (
              <tr key={r.number} data-testid="schedule-row">
                <td className="num px-4 py-2">{r.number}</td>
                <td className="px-2 py-2">
                  <DateText date={r.date} />
                </td>
                <td className="px-2 py-2 text-right">
                  <Money amount={r.interest} currency={ccy} />
                </td>
                <td className="px-2 py-2 text-right">
                  <Money amount={r.principal} currency={ccy} />
                </td>
                <td className="px-2 py-2 text-right">
                  <Money amount={r.escrow} currency={ccy} />
                </td>
                <td className="px-2 py-2 text-right">
                  <Money amount={r.balance} currency={ccy} />
                </td>
                <td className="px-4 py-2 text-right text-sm">
                  {r.transactionId ? (
                    <span className="flex justify-end gap-3">
                      <a className="underline" href={`${base}/transactions/${r.transactionId}`}>
                        {t('rentals.paid')}
                      </a>
                      <button
                        type="button"
                        className="underline"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => browserApi.removeLoanPayment(workspaceId, loan.id, r.number),
                            t('rentals.payment_removed'),
                          )
                        }
                      >
                        {t('rentals.remove')}
                      </button>
                    </span>
                  ) : (
                    r.number === rows[nextUnpaid]?.number && (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={busy || !accountId}
                        onClick={() =>
                          run(
                            () =>
                              browserApi.recordLoanPayment(workspaceId, loan.id, {
                                number: r.number,
                                accountId,
                                date: r.date as never,
                              }),
                            t('rentals.payment_recorded'),
                          )
                        }
                      >
                        {t('rentals.record_loan_payment')}
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 pb-3">
        <StatusLine message={message} />
      </div>
    </section>
  );
}

// ----- Maintenance (RNT-13) -------------------------------------------------------------------------------

export function MaintenanceLog({
  workspaceId,
  properties,
  items,
  currency,
  today,
  fileHref,
}: {
  workspaceId: string;
  properties: PropertyDto[];
  items: MaintenanceDto[];
  currency: string;
  today: string;
  fileHref: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '');
  const [unitId, setUnitId] = useState('');
  const [issue, setIssue] = useState('');
  const [vendor, setVendor] = useState('');
  const [cost, setCost] = useState('');
  const [reportedOn, setReportedOn] = useState(today);
  const [file, setFile] = useState<File | null>(null);
  const units = properties.find((p) => p.id === propertyId)?.units ?? [];
  return (
    <div className="space-y-5">
      <form
        className="card space-y-3"
        aria-label={t('rentals.add_maintenance')}
        onSubmit={(e) => {
          e.preventDefault();
          const c = optionalMinor(cost, currency, t);
          if (!c.ok) return setMessage({ tone: 'bad', text: c.error });
          void run(async () => {
            const fileIds = file
              ? [(await browserApi.uploadRentalFile(workspaceId, file, file.name)).fileId]
              : [];
            return browserApi.createMaintenance(workspaceId, {
              propertyId,
              unitId: unitId || null,
              issue: issue.trim(),
              vendor: vendor.trim() || null,
              cost: c.value,
              reportedOn: reportedOn as never,
              fileIds,
            });
          }, t('rentals.maintenance_added')).then((r) => {
            if (r) {
              setIssue('');
              setVendor('');
              setCost('');
              setFile(null);
            }
          });
        }}
      >
        <h2 className="text-base font-semibold">{t('rentals.add_maintenance')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label>
            <span className="field-label">{t('rentals.property')}</span>
            <select
              className="input"
              required
              value={propertyId}
              onChange={(e) => {
                setPropertyId(e.target.value);
                setUnitId('');
              }}
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('rentals.unit')}</span>
            <select className="input" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">{t('rentals.whole_property')}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('rentals.issue')}</span>
            <input
              className="input"
              required
              maxLength={500}
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('rentals.vendor')}</span>
            <input
              className="input"
              maxLength={200}
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('rentals.cost')}</span>
            <input
              className="input"
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('rentals.reported_on')}</span>
            <input
              className="input"
              type="date"
              required
              value={reportedOn}
              onChange={(e) => setReportedOn(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('rentals.photo')}</span>
            <input
              className="input"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        <button type="submit" className="btn-primary" disabled={busy || !propertyId}>
          {t('rentals.add_maintenance')}
        </button>
        <StatusLine message={message} />
      </form>

      {items.length > 0 && (
        <section className="card-flush" aria-label={t('rentals.tab_maintenance')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('rentals.issue')}</th>
                <th className="px-2 py-2">{t('rentals.vendor')}</th>
                <th className="px-2 py-2 text-right">{t('rentals.cost')}</th>
                <th className="px-4 py-2">{t('rentals.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((m) => (
                <tr key={m.id} data-testid="maintenance-row">
                  <td className="px-4 py-2">
                    {m.issue}
                    <span className="block text-xs text-muted">
                      {m.propertyName}
                      {m.unitLabel ? ` · ${m.unitLabel}` : ''} · <DateText date={m.reportedOn} />
                    </span>
                    {m.fileIds.map((id, i) => (
                      <a
                        key={id}
                        className="mr-2 text-xs underline"
                        href={`${fileHref}/maintenance/${m.id}/files/${id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('rentals.file_n', { n: i + 1 })}
                      </a>
                    ))}
                  </td>
                  <td className="px-2 py-2 text-sm">{m.vendor ?? '—'}</td>
                  <td className="px-2 py-2 text-right">
                    {m.cost ? <Money amount={m.cost} currency={currency} /> : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={MAINTENANCE_CHIP[m.status]}>
                        {t(`rentals.maintenance_${m.status}`)}
                      </span>
                      <select
                        className="input w-32"
                        aria-label={t('rentals.status_of', { name: m.issue })}
                        value={m.status}
                        disabled={busy}
                        onChange={(e) =>
                          run(() =>
                            browserApi.updateMaintenance(workspaceId, m.id, {
                              status: e.target.value as MaintenanceDto['status'],
                              completedOn: (e.target.value === 'done' ? today : null) as never,
                              version: m.version,
                            }),
                          )
                        }
                      >
                        {MAINTENANCE_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(`rentals.maintenance_${s}`)}
                          </option>
                        ))}
                      </select>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

// ----- Reminders (RNT-12) ---------------------------------------------------------------------------------

export function RemindersPanel({
  workspaceId,
  entityId,
  properties,
  reminders,
  today,
}: {
  workspaceId: string;
  entityId: string;
  properties: PropertyDto[];
  reminders: ReminderDto[];
  today: string;
}) {
  const { run, busy, message, t } = useAction();
  const [kind, setKind] = useState<(typeof REMINDER_KINDS)[number]>('insurance');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(today);
  const [propertyId, setPropertyId] = useState('');
  const [leadDays, setLeadDays] = useState('30');
  return (
    <div className="space-y-5">
      {reminders.length === 0 ? (
        <p className="card text-sm text-muted">{t('rentals.no_reminders')}</p>
      ) : (
        <ul className="card divide-y divide-line p-0" aria-label={t('rentals.tab_reminders')}>
          {reminders.map((r) => (
            <li
              key={r.id ?? `lease-${r.leaseId}`}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              data-testid="reminder-row"
            >
              <div>
                <p className="text-sm font-medium">
                  {r.title} {r.overdue && <span className="chip chip-bad">{t('rentals.overdue')}</span>}
                </p>
                <p className="text-xs text-muted">
                  {t(`rentals.reminder_${r.kind}`)} · <DateText date={r.dueDate} />
                </p>
              </div>
              {r.id !== null && r.version !== null && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        browserApi.updateReminder(workspaceId, r.id!, { done: true, version: r.version! }),
                      t('rentals.reminder_done'),
                    )
                  }
                >
                  {t('rentals.mark_done')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="card flex flex-wrap items-end gap-2"
        aria-label={t('rentals.add_reminder')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              browserApi.createReminder(workspaceId, {
                entityId,
                propertyId: propertyId || null,
                kind,
                title: title.trim(),
                dueDate: dueDate as never,
                leadDays: Number(leadDays),
              }),
            t('rentals.reminder_added'),
          ).then((r) => {
            if (r) setTitle('');
          });
        }}
      >
        <label>
          <span className="field-label">{t('rentals.reminder_kind')}</span>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {REMINDER_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`rentals.reminder_${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('rentals.reminder_title')}</span>
          <input
            className="input"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.due_date')}</span>
          <input
            className="input"
            type="date"
            required
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.lead_days')}</span>
          <input
            className="input w-20"
            inputMode="numeric"
            pattern="\d{1,3}"
            required
            value={leadDays}
            onChange={(e) => setLeadDays(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.property')}</span>
          <select className="input" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">{t('rentals.whole_portfolio')}</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('rentals.add_reminder')}
        </button>
        <StatusLine message={message} />
      </form>
    </div>
  );
}

// ----- Schedule E export (UP-10) --------------------------------------------------------------------------

export function ScheduleEExport({
  workspaceId,
  entityId,
  year,
}: {
  workspaceId: string;
  entityId: string;
  year: number;
}) {
  const { run, busy, message, t } = useAction();
  const download = (format: 'csv' | 'xlsx') =>
    run(async () => {
      const { blob, fileName } = await browserApi.downloadScheduleE(workspaceId, { entityId, year, format });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return fileName;
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => download('csv')}>
        {t('rentals.export_csv')}
      </button>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => download('xlsx')}>
        {t('rentals.export_xlsx')}
      </button>
      <StatusLine message={message} />
    </div>
  );
}

// ----- Settings: tax accounts (REC-09) and shared-expense rules (RNT-07) -----------------------------------

export function RentalTaxAccounts({
  workspaceId,
  profile,
  accounts,
}: {
  workspaceId: string;
  profile: BusinessProfileDto;
  accounts: AccountDto[];
}) {
  const { run, busy, message, t } = useAction();
  const [from, setFrom] = useState(profile.defaultDepositAccountId ?? '');
  const [to, setTo] = useState(profile.taxSavingsAccountId ?? '');
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label={t('rentals.tax_accounts')}
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            browserApi.updateBusiness(workspaceId, profile.entityId, {
              defaultDepositAccountId: from || null,
              taxSavingsAccountId: to || null,
            }),
          t('rentals.tax_accounts_saved'),
        );
      }}
    >
      <label>
        <span className="field-label">{t('rentals.set_aside_from')}</span>
        <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">{t('rentals.choose')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="field-label">{t('rentals.set_aside_to')}</span>
        <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t('rentals.choose')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn-secondary" disabled={busy}>
        {t('rentals.save')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

/** Targets for a split across properties: percentages where that's the basis, or just which ones. */
function TargetPicker({
  properties,
  basis,
  chosen,
  onChange,
}: {
  properties: PropertyDto[];
  basis: (typeof ALLOCATION_BASES)[number];
  chosen: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const { t } = useAction();
  return (
    <ul className="space-y-1">
      {properties.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={p.id in chosen}
              onChange={(e) => {
                const next = { ...chosen };
                if (e.target.checked) next[p.id] = '';
                else delete next[p.id];
                onChange(next);
              }}
            />
            {p.name}
          </label>
          {basis === 'percent' && p.id in chosen && (
            <input
              className="input w-24"
              inputMode="decimal"
              aria-label={t('rentals.percent_for', { name: p.name })}
              value={chosen[p.id]}
              onChange={(e) => onChange({ ...chosen, [p.id]: e.target.value })}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Reads the picker into targets, or says what's wrong. */
function targetsOf(
  basis: (typeof ALLOCATION_BASES)[number],
  chosen: Record<string, string>,
  t: ReturnType<typeof useAction>['t'],
) {
  const ids = Object.keys(chosen);
  if (ids.length < 2) return { ok: false as const, error: t('rentals.allocation_two') };
  if (basis !== 'percent') return { ok: true as const, value: ids.map((propertyId) => ({ propertyId })) };
  if (percentTotal(ids.map((id) => chosen[id]!)) !== 10000) {
    return { ok: false as const, error: t('rentals.allocation_100') };
  }
  return {
    ok: true as const,
    value: ids.map((propertyId) => ({ propertyId, percentBps: percentToBps(chosen[propertyId]!) ?? 0 })),
  };
}

export function AllocationRules({
  workspaceId,
  entityId,
  properties,
  rules,
}: {
  workspaceId: string;
  entityId: string;
  properties: PropertyDto[];
  rules: AllocationRuleDto[];
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [name, setName] = useState('');
  const [basis, setBasis] = useState<(typeof ALLOCATION_BASES)[number]>('units');
  const [chosen, setChosen] = useState<Record<string, string>>({});
  return (
    <section className="card space-y-3" aria-labelledby="rules-title">
      <h2 id="rules-title" className="text-base font-semibold">
        {t('rentals.allocation_rules')}
      </h2>
      <p className="text-sm text-muted">{t('rentals.allocation_hint')}</p>
      {rules.length > 0 && (
        <ul className="divide-y divide-line">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2" data-testid="rule-row">
              <span className="text-sm">
                {r.name} · {t(`rentals.basis_${r.basis}`)}
              </span>
              <button
                type="button"
                className="text-sm underline"
                disabled={busy}
                aria-label={t('rentals.delete_named', { name: r.name })}
                onClick={() =>
                  run(() => browserApi.deleteAllocationRule(workspaceId, r.id), t('rentals.deleted'))
                }
              >
                {t('rentals.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-2"
        aria-label={t('rentals.add_rule')}
        onSubmit={(e) => {
          e.preventDefault();
          const targets = targetsOf(basis, chosen, t);
          if (!targets.ok) return setMessage({ tone: 'bad', text: targets.error });
          void run(
            () =>
              browserApi.createAllocationRule(workspaceId, {
                entityId,
                name: name.trim(),
                basis,
                targets: targets.value,
              }),
            t('rentals.rule_added'),
          ).then((r) => {
            if (r) {
              setName('');
              setChosen({});
            }
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label>
            <span className="field-label">{t('rentals.rule_name')}</span>
            <input
              className="input"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('rentals.split_by')}</span>
            <select
              className="input"
              value={basis}
              onChange={(e) => setBasis(e.target.value as typeof basis)}
            >
              {ALLOCATION_BASES.map((b) => (
                <option key={b} value={b}>
                  {t(`rentals.basis_${b}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <TargetPicker properties={properties} basis={basis} chosen={chosen} onChange={setChosen} />
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('rentals.add_rule')}
        </button>
        <StatusLine message={message} />
      </form>
    </section>
  );
}

/** One expense split across properties to the cent (RNT-07), on its transaction page. */
export function AllocatePanel({
  workspaceId,
  transactionId,
  properties,
  rules,
}: {
  workspaceId: string;
  transactionId: string;
  properties: PropertyDto[];
  rules: AllocationRuleDto[];
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [ruleId, setRuleId] = useState('');
  const [basis, setBasis] = useState<(typeof ALLOCATION_BASES)[number]>('percent');
  const [chosen, setChosen] = useState<Record<string, string>>({});
  return (
    <details className="card">
      <summary className="cursor-pointer text-base font-semibold">{t('rentals.allocate')}</summary>
      <form
        className="mt-3 space-y-2"
        aria-label={t('rentals.allocate')}
        onSubmit={(e) => {
          e.preventDefault();
          if (ruleId) {
            void run(
              () => browserApi.allocateTransaction(workspaceId, transactionId, { ruleId }),
              t('rentals.allocated'),
            );
            return;
          }
          const targets = targetsOf(basis, chosen, t);
          if (!targets.ok) return setMessage({ tone: 'bad', text: targets.error });
          void run(
            () =>
              browserApi.allocateTransaction(workspaceId, transactionId, {
                basis,
                targets: targets.value,
              }),
            t('rentals.allocated'),
          );
        }}
      >
        <p className="text-sm text-muted">{t('rentals.allocate_hint')}</p>
        {rules.length > 0 && (
          <label className="block max-w-xs">
            <span className="field-label">{t('rentals.saved_rule')}</span>
            <select className="input" value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
              <option value="">{t('rentals.choose_below')}</option>
              {rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!ruleId && (
          <>
            <label className="block max-w-xs">
              <span className="field-label">{t('rentals.split_by')}</span>
              <select
                className="input"
                value={basis}
                onChange={(e) => setBasis(e.target.value as typeof basis)}
              >
                {ALLOCATION_BASES.map((b) => (
                  <option key={b} value={b}>
                    {t(`rentals.basis_${b}`)}
                  </option>
                ))}
              </select>
            </label>
            <TargetPicker properties={properties} basis={basis} chosen={chosen} onChange={setChosen} />
          </>
        )}
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('rentals.allocate_action')}
        </button>
        <StatusLine message={message} />
      </form>
    </details>
  );
}
