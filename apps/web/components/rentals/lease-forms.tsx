'use client';

import { useState } from 'react';
import type {
  AccountDto,
  LeaseCandidateDto,
  LeaseDto,
  PropertyDto,
  RentPaymentDto,
  TenantDto,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { buildLease, positiveMinor } from '@/lib/rentals';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/** Tenants of a portfolio (RNT-03). */
export function TenantManager({
  workspaceId,
  entityId,
  tenants,
}: {
  workspaceId: string;
  entityId: string;
  tenants: TenantDto[];
}) {
  const { run, busy, message, t } = useAction();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  return (
    <div className="space-y-5">
      <form
        className="card flex flex-wrap items-end gap-2"
        aria-label={t('rentals.add_tenant')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              browserApi.createTenant(workspaceId, {
                entityId,
                name: name.trim(),
                email: email.trim() || null,
                phone: phone.trim() || null,
              }),
            t('rentals.tenant_added'),
          ).then((r) => {
            if (r) {
              setName('');
              setEmail('');
              setPhone('');
            }
          });
        }}
      >
        <label>
          <span className="field-label">{t('rentals.tenant_name')}</span>
          <input
            className="input"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.email')}</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t('rentals.phone')}</span>
          <input className="input" maxLength={50} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('rentals.add_tenant')}
        </button>
        <StatusLine message={message} />
      </form>
      {tenants.length > 0 && (
        <section className="card-flush" aria-label={t('rentals.tab_tenants')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('rentals.tenant_name')}</th>
                <th className="px-2 py-2">{t('rentals.email')}</th>
                <th className="px-4 py-2">{t('rentals.phone')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {tenants.map((x) => (
                <tr key={x.id} data-testid="tenant-row">
                  <td className="px-4 py-2 font-medium">{x.name}</td>
                  <td className="px-2 py-2 text-sm">{x.email ?? '—'}</td>
                  <td className="px-4 py-2 text-sm">{x.phone ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/** A new lease on one of this property's units. Writing it writes its rent charges (RNT-03, RNT-04). */
export function NewLeaseForm({
  workspaceId,
  property,
  tenants,
  accounts,
  currency,
  today,
}: {
  workspaceId: string;
  property: PropertyDto;
  tenants: TenantDto[];
  accounts: AccountDto[];
  currency: string;
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [unitId, setUnitId] = useState(property.units.find((u) => u.status !== 'occupied')?.id ?? '');
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [newTenant, setNewTenant] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState('');
  const [rent, setRent] = useState('');
  const [dueDay, setDueDay] = useState('1');
  const [graceDays, setGraceDays] = useState('5');
  const [lateFeeFlat, setLateFeeFlat] = useState('');
  const [lateFeePercent, setLateFeePercent] = useState('');
  const [lateFeeCap, setLateFeeCap] = useState('');
  const [deposit, setDeposit] = useState('');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const text = (label: string, value: string, on: (x: string) => void, extra: object = {}) => (
    <label>
      <span className="field-label">{label}</span>
      <input className="input" value={value} onChange={(e) => on(e.target.value)} {...extra} />
    </label>
  );

  return (
    <details className="card">
      <summary className="cursor-pointer text-base font-semibold">{t('rentals.add_lease')}</summary>
      <form
        className="mt-3 space-y-3"
        aria-label={t('rentals.add_lease')}
        onSubmit={(e) => {
          e.preventDefault();
          const typed = newTenant.trim();
          const res = buildLease(
            {
              unitId,
              // A name typed here is checked below, once it has an id.
              tenantIds: typed ? [...tenantIds, 'new'] : tenantIds,
              startDate,
              endDate,
              rent,
              dueDay,
              graceDays,
              lateFeeFlat,
              lateFeePercent,
              lateFeeCap,
              deposit,
              depositAccountId,
              fileIds: [],
            },
            currency,
            t,
          );
          if (!res.ok) return setMessage({ tone: 'bad', text: res.error });
          void run(async () => {
            const ids = [...tenantIds];
            if (typed) {
              ids.push(
                (await browserApi.createTenant(workspaceId, { entityId: property.entityId, name: typed })).id,
              );
            }
            const fileIds = file
              ? [(await browserApi.uploadRentalFile(workspaceId, file, file.name)).fileId]
              : [];
            return browserApi.createLease(workspaceId, { ...res.value, tenantIds: ids, fileIds });
          }, t('rentals.lease_added')).then((r) => {
            if (r) {
              setNewTenant('');
              setTenantIds([]);
              setRent('');
              setFile(null);
            }
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label>
            <span className="field-label">{t('rentals.unit')}</span>
            <select className="input" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">{t('rentals.choose')}</option>
              {property.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
          {text(t('rentals.new_tenant'), newTenant, setNewTenant, { maxLength: 200 })}
          {text(t('rentals.start_date'), startDate, setStartDate, { type: 'date', required: true })}
          {text(t('rentals.end_date'), endDate, setEndDate, { type: 'date' })}
          {text(t('rentals.rent'), rent, setRent, { inputMode: 'decimal', required: true })}
          {text(t('rentals.due_day'), dueDay, setDueDay, { inputMode: 'numeric', required: true })}
          {text(t('rentals.grace_days'), graceDays, setGraceDays, { inputMode: 'numeric', required: true })}
          {text(t('rentals.late_fee_flat'), lateFeeFlat, setLateFeeFlat, { inputMode: 'decimal' })}
          {text(t('rentals.late_fee_percent'), lateFeePercent, setLateFeePercent, { inputMode: 'decimal' })}
          {text(t('rentals.late_fee_cap'), lateFeeCap, setLateFeeCap, { inputMode: 'decimal' })}
          {text(t('rentals.deposit'), deposit, setDeposit, { inputMode: 'decimal' })}
          <label>
            <span className="field-label">{t('rentals.rent_account')}</span>
            <select
              className="input"
              value={depositAccountId}
              onChange={(e) => setDepositAccountId(e.target.value)}
            >
              <option value="">{t('rentals.any_account')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('rentals.lease_document')}</span>
            <input
              className="input"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        {tenants.length > 0 && (
          <fieldset>
            <legend className="field-label">{t('rentals.tenants')}</legend>
            <div className="flex flex-wrap gap-3">
              {tenants.map((x) => (
                <label key={x.id} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={tenantIds.includes(x.id)}
                    onChange={(e) =>
                      setTenantIds(
                        e.target.checked ? [...tenantIds, x.id] : tenantIds.filter((id) => id !== x.id),
                      )
                    }
                  />
                  {x.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('rentals.add_lease')}
        </button>
        <StatusLine message={message} />
      </form>
    </details>
  );
}

/** Rent received: entered here, or a line already in the bank feed (RNT-04). */
export function RecordRent({
  workspaceId,
  leaseId,
  accounts,
  currency,
  today,
  suggested,
}: {
  workspaceId: string;
  leaseId: string;
  accounts: AccountDto[];
  currency: string;
  today: string;
  suggested: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [amount, setAmount] = useState(suggested);
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [candidates, setCandidates] = useState<LeaseCandidateDto[] | null>(null);
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('rentals.record_payment')}
        onSubmit={(e) => {
          e.preventDefault();
          const a = positiveMinor(amount, currency, t);
          if (!a.ok) return setMessage({ tone: 'bad', text: a.error });
          void run(
            () =>
              browserApi.recordRentPayment(workspaceId, leaseId, {
                accountId,
                date: date as never,
                amount: a.value,
              }),
            t('rentals.payment_recorded'),
          );
        }}
      >
        <label>
          <span className="field-label">{t('rentals.amount')}</span>
          <input
            className="input w-32"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.date')}</span>
          <input
            className="input"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.into_account')}</span>
          <select className="input" required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('rentals.record_payment')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const list = await browserApi.listLeaseCandidates(workspaceId, leaseId);
              setCandidates(list);
              return list;
            })
          }
        >
          {t('rentals.find_bank_line')}
        </button>
      </form>
      {candidates && candidates.length === 0 && (
        <p className="text-sm text-muted">{t('rentals.no_candidates')}</p>
      )}
      {candidates && candidates.length > 0 && (
        <ul className="divide-y divide-line" aria-label={t('rentals.bank_lines')}>
          {candidates.map((c) => (
            <li
              key={c.transactionId}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="candidate-row"
            >
              <span className="text-sm">
                <DateText date={c.date} /> · {c.payer ?? '—'} ·{' '}
                <Money amount={c.amount} currency={currency} />
              </span>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  run(
                    () =>
                      browserApi.recordRentPayment(workspaceId, leaseId, { transactionId: c.transactionId }),
                    t('rentals.payment_recorded'),
                  ).then((r) => {
                    if (r) setCandidates(null);
                  })
                }
              >
                {t('rentals.link_line')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <StatusLine message={message} />
    </div>
  );
}

/** Payments on a lease; removing one gives a bank line back as it was (RNT-04). */
export function PaymentList({
  workspaceId,
  leaseId,
  payments,
  currency,
  base,
}: {
  workspaceId: string;
  leaseId: string;
  payments: RentPaymentDto[];
  currency: string;
  base: string;
}) {
  const { run, busy, message, t } = useAction();
  if (payments.length === 0) return <p className="text-sm text-muted">{t('rentals.no_payments')}</p>;
  return (
    <>
      <ul className="divide-y divide-line">
        {payments.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
            data-testid="payment-row"
          >
            <a className="text-sm underline" href={`${base}/transactions/${p.transactionId}`}>
              <DateText date={p.date} /> · <Money amount={p.amount} currency={currency} />
            </a>
            <span className="flex items-center gap-3">
              {p.source === 'auto' && <span className="chip">{t('rentals.linked_automatically')}</span>}
              <button
                type="button"
                className="text-sm underline"
                disabled={busy}
                onClick={() =>
                  run(
                    () => browserApi.removeRentPayment(workspaceId, leaseId, p.id),
                    t('rentals.payment_removed'),
                  )
                }
              >
                {t('rentals.remove')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <StatusLine message={message} />
    </>
  );
}

/** What's held for a lease. It's owed back, so it's a liability, and income only once forfeited (RNT-10). */
export function DepositPanel({
  workspaceId,
  lease,
  accounts,
  today,
}: {
  workspaceId: string;
  lease: LeaseDto;
  accounts: AccountDto[];
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const ccy = lease.currency;
  const [kind, setKind] = useState<'received_new' | 'returned' | 'forfeited'>(
    BigInt(lease.depositHeld) > 0n ? 'returned' : 'received_new',
  );
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [notes, setNotes] = useState('');
  return (
    <section className="card space-y-3" aria-labelledby="deposit-title">
      <h2 id="deposit-title" className="text-base font-semibold">
        {t('rentals.security_deposit')}
      </h2>
      <p className="text-sm" data-testid="deposit-held">
        {t('rentals.deposit_held')}: <Money amount={lease.depositHeld} currency={ccy} />{' '}
        <span className="text-muted">
          ({t('rentals.deposit_terms')}: <Money amount={lease.deposit} currency={ccy} />)
        </span>
      </p>
      <p className="text-xs text-muted">{t('rentals.deposit_note')}</p>
      {lease.depositEvents.length > 0 && (
        <ul className="divide-y divide-line">
          {lease.depositEvents.map((ev) => (
            <li
              key={ev.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="deposit-event"
            >
              <span className="text-sm">
                <DateText date={ev.date} /> · {t(`rentals.deposit_${ev.kind}`)} ·{' '}
                <Money amount={ev.amount} currency={ccy} />
                {ev.notes ? ` · ${ev.notes}` : ''}
              </span>
              <button
                type="button"
                className="text-sm underline"
                disabled={busy}
                onClick={() =>
                  run(() => browserApi.removeDepositEvent(workspaceId, lease.id, ev.id), t('rentals.deleted'))
                }
              >
                {t('rentals.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('rentals.deposit_add')}
        onSubmit={(e) => {
          e.preventDefault();
          const a = positiveMinor(amount, ccy, t);
          if (!a.ok) return setMessage({ tone: 'bad', text: a.error });
          const common = { date: date as never, amount: a.value };
          void run(
            () =>
              browserApi.addDepositEvent(
                workspaceId,
                lease.id,
                kind === 'forfeited'
                  ? { kind, ...common, ...(notes.trim() ? { notes: notes.trim() } : {}) }
                  : kind === 'returned'
                    ? { kind, accountId, ...common, ...(notes.trim() ? { notes: notes.trim() } : {}) }
                    : { kind, accountId, ...common },
              ),
            t('rentals.deposit_saved'),
          ).then((r) => {
            if (r) {
              setAmount('');
              setNotes('');
            }
          });
        }}
      >
        <label>
          <span className="field-label">{t('rentals.deposit_what')}</span>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="received_new">{t('rentals.deposit_received')}</option>
            <option value="returned">{t('rentals.deposit_returned')}</option>
            <option value="forfeited">{t('rentals.deposit_forfeited')}</option>
          </select>
        </label>
        <label>
          <span className="field-label">{t('rentals.amount')}</span>
          <input
            className="input w-32"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.date')}</span>
          <input
            className="input"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {kind !== 'forfeited' && (
          <label>
            <span className="field-label">{t('rentals.account')}</span>
            <select
              className="input"
              required
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind !== 'received_new' && (
          <label>
            <span className="field-label">{t('rentals.notes')}</span>
            <input
              className="input"
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
        )}
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('rentals.deposit_add')}
        </button>
      </form>
      <StatusLine message={message} />
    </section>
  );
}

/** Ending a lease stops future rent; what was owed stays owed. */
export function EndLeaseForm({
  workspaceId,
  lease,
  today,
}: {
  workspaceId: string;
  lease: LeaseDto;
  today: string;
}) {
  const { run, busy, message, t } = useAction();
  const [date, setDate] = useState(today);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label={t('rentals.end_lease')}
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            browserApi.updateLease(workspaceId, lease.id, { endedOn: date as never, version: lease.version }),
          t('rentals.lease_was_ended'),
        );
      }}
    >
      <label>
        <span className="field-label">{t('rentals.moved_out')}</span>
        <input
          className="input"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <button type="submit" className="btn-secondary" disabled={busy}>
        {t('rentals.end_lease')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

/** Forgiving a charge, or taking that back (RNT-05). */
export function WaiveCharge({
  workspaceId,
  chargeId,
  version,
  waived,
}: {
  workspaceId: string;
  chargeId: string;
  version: number;
  waived: boolean;
}) {
  const { run, busy, message, t } = useAction();
  return (
    <>
      <button
        type="button"
        className="text-sm underline"
        disabled={busy}
        onClick={() =>
          run(
            () => browserApi.updateRentCharge(workspaceId, chargeId, { waived: !waived, version }),
            waived ? t('rentals.unwaived') : t('rentals.waived'),
          )
        }
      >
        {waived ? t('rentals.unwaive') : t('rentals.waive')}
      </button>
      <StatusLine message={message} />
    </>
  );
}
