'use client';

import Link from 'next/link';
import { useState } from 'react';
import { bpsToPercent, percentToBps, accountProfile } from '@montra/domain';
import type { AccountDto, AmortizationRowDto, LoanDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/** How many upcoming payments show before "show all". */
const UPCOMING_SHOWN = 12;

/** A tracked loan on its account's page: what's next, what's left, the schedule, and its terms. */
export function LoanPanel({
  workspaceId,
  loan,
  rows,
  accounts,
  today,
}: {
  workspaceId: string;
  loan: LoanDto;
  rows: readonly AmortizationRowDto[];
  accounts: readonly AccountDto[];
  today: string;
}) {
  const { t, locale } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const paying = accounts.filter(
    (a) =>
      !a.archived &&
      a.entityId === loan.entityId &&
      a.currency === loan.currency &&
      accountProfile(a.kind).forecast === 'cash',
  );
  const ccy = loan.currency;
  const money = (amount: string) => <Money amount={amount} currency={ccy} />;
  const next = loan.next;
  const [from, setFrom] = useState(loan.payingAccountId ?? paying[0]?.id ?? '');
  const [date, setDate] = useState(next && next.date < today ? next.date : (next?.date ?? today));
  const [extra, setExtra] = useState('');
  const paidFrom = accounts.find((a) => a.id === loan.payingAccountId);

  const recorded = rows.filter((r) => r.transactionId);
  const upcoming = rows.filter((r) => !r.transactionId);
  const lastRecorded = recorded[recorded.length - 1]?.number;
  const hasEscrow = rows.some((r) => BigInt(r.escrow) > 0n);

  const row = (r: AmortizationRowDto) => (
    <tr key={r.number} data-testid={r.transactionId ? 'loan-row-paid' : 'loan-row-upcoming'}>
      <td className="whitespace-nowrap px-4 py-2">
        <DateText date={r.date} />
      </td>
      <td className="px-4 py-2 text-right">{money(String(BigInt(r.payment) + BigInt(r.escrow)))}</td>
      <td className="px-4 py-2 text-right">{money(r.interest)}</td>
      <td className="px-4 py-2 text-right">{money(r.principal)}</td>
      {hasEscrow && <td className="px-4 py-2 text-right">{money(r.escrow)}</td>}
      <td className="px-4 py-2 text-right font-medium">{money(r.balance)}</td>
      <td className="whitespace-nowrap px-4 py-2 text-right">
        {r.transactionId ? (
          <>
            <Link href={`/w/${workspaceId}/transactions/${r.transactionId}`} className="underline">
              {t('account.loan.paid')}
            </Link>
            {r.number === lastRecorded && (
              <button
                type="button"
                className="ml-3 underline"
                disabled={busy}
                aria-label={t('account.loan.undo_label', { number: r.number })}
                onClick={() =>
                  void run(
                    () => browserApi.removeLoanPayment(workspaceId, loan.id, r.number),
                    t('account.loan.undone'),
                  )
                }
              >
                {t('account.loan.undo')}
              </button>
            )}
          </>
        ) : null}
      </td>
    </tr>
  );

  const table = (body: readonly AmortizationRowDto[], testId: string) => (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="tbl min-w-[40rem] text-sm">
        <caption className="sr-only">{t('account.loan.schedule_caption', { name: loan.name })}</caption>
        <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-2">
              {t('fields.date')}
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              {t('account.loan.payment')}
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              {t('account.loan.interest')}
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              {t('account.loan.principal')}
            </th>
            {hasEscrow && (
              <th scope="col" className="px-4 py-2 text-right">
                {t('account.loan.escrow')}
              </th>
            )}
            <th scope="col" className="px-4 py-2 text-right">
              {t('account.loan.owed_after')}
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              <span className="sr-only">{t('account.loan.status')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{body.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <>
      <section className="card space-y-4" data-testid="loan-panel" aria-label={t('account.loan.next_title')}>
        {next ? (
          <div className="flex flex-wrap items-start justify-between gap-4" data-testid="loan-next">
            <div>
              <p className="text-sm text-muted">
                {t('account.loan.next_title')}
                {next.date < today && (
                  <span className="ml-2 font-medium text-bad">{t('account.loan.overdue')}</span>
                )}
              </p>
              <p className="text-2xl font-semibold">{money(next.total)}</p>
              <p className="text-sm text-muted">
                <DateText date={next.date} />
                {paidFrom ? ` · ${t('account.loan.from_account', { name: paidFrom.name })}` : ''}
              </p>
              <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div data-testid="loan-next-principal">
                  <dt className="text-muted">{t('account.loan.principal')}</dt>
                  <dd>{money(next.principal)}</dd>
                </div>
                <div data-testid="loan-next-interest">
                  <dt className="text-muted">{t('account.loan.interest')}</dt>
                  <dd>{money(next.interest)}</dd>
                </div>
                {BigInt(next.escrow) > 0n && (
                  <div data-testid="loan-next-escrow">
                    <dt className="text-muted">{t('account.loan.escrow')}</dt>
                    <dd>{money(next.escrow)}</dd>
                  </div>
                )}
              </dl>
            </div>
            {paying.length === 0 ? (
              <p className="max-w-xs text-sm text-muted">{t('account.loan.no_paying_account')}</p>
            ) : (
              <form
                className="flex flex-wrap items-end gap-3"
                aria-label={t('account.loan.record')}
                onSubmit={(e) => {
                  e.preventDefault();
                  let extraPrincipal: string | undefined;
                  if (extra.trim()) {
                    const parsed = parseAmountInput(extra, ccy, locale);
                    if (!parsed.ok || parsed.minor < 0n) {
                      return setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
                    }
                    extraPrincipal = parsed.minor.toString();
                  }
                  void run(
                    () =>
                      browserApi.recordLoanPayment(workspaceId, loan.id, {
                        number: next.number,
                        accountId: from,
                        date: date as never,
                        ...(extraPrincipal ? { extraPrincipal } : {}),
                      }),
                    t('account.loan.recorded'),
                  ).then(() => setExtra(''));
                }}
              >
                <label>
                  <span className="field-label">{t('account.loan.paid_from')}</span>
                  <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
                    {paying.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">{t('fields.date')}</span>
                  <input
                    type="date"
                    className="input"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <label>
                  <span className="field-label">{t('account.loan.extra')}</span>
                  <input
                    className="input num w-28"
                    inputMode="decimal"
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                  />
                </label>
                <button type="submit" className="btn-primary" disabled={busy}>
                  {t('account.loan.record')}
                </button>
              </form>
            )}
          </div>
        ) : (
          <p className="font-medium" data-testid="loan-paid-off">
            {t('account.loan.paid_off')}
          </p>
        )}
        <StatusLine message={message} />
        <dl
          className="flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-3 text-sm"
          data-testid="loan-summary"
        >
          <div data-testid="loan-rate">
            <dt className="text-muted">{t('account.interest_rate')}</dt>
            <dd className="font-medium">{`${bpsToPercent(loan.rateBps)}%`}</dd>
          </div>
          <div data-testid="loan-payment">
            <dt className="text-muted">{t('account.loan.monthly')}</dt>
            <dd className="font-medium">{money(loan.totalPayment)}</dd>
          </div>
          {loan.payoffDate && (
            <div data-testid="loan-payoff">
              <dt className="text-muted">{t('account.loan.payoff')}</dt>
              <dd className="font-medium">
                <DateText date={loan.payoffDate} />
              </dd>
            </div>
          )}
          <div data-testid="loan-interest-left">
            <dt className="text-muted">{t('account.loan.interest_left')}</dt>
            <dd className="font-medium">{money(loan.interestRemaining)}</dd>
          </div>
          {BigInt(loan.interestPaid) > 0n && (
            <div data-testid="loan-interest-paid">
              <dt className="text-muted">{t('account.loan.interest_paid')}</dt>
              <dd className="font-medium">{money(loan.interestPaid)}</dd>
            </div>
          )}
        </dl>
      </section>

      {rows.length > 0 && (
        <section className="card space-y-3 p-0" data-testid="loan-schedule">
          <h2 className="px-4 pt-4 text-sm font-semibold">{t('account.loan.schedule')}</h2>
          {table([...recorded, ...upcoming.slice(0, UPCOMING_SHOWN)], 'loan-schedule-table')}
          {upcoming.length > UPCOMING_SHOWN && (
            <details className="px-4 pb-4">
              <summary className="cursor-pointer text-sm underline">
                {t('account.loan.show_all', { count: upcoming.length - UPCOMING_SHOWN })}
              </summary>
              <div className="mt-2">{table(upcoming.slice(UPCOMING_SHOWN), 'loan-schedule-rest')}</div>
            </details>
          )}
        </section>
      )}

      <LoanSettings workspaceId={workspaceId} loan={loan} paying={paying} />
    </>
  );
}

function LoanSettings({
  workspaceId,
  loan,
  paying,
}: {
  workspaceId: string;
  loan: LoanDto;
  paying: readonly AccountDto[];
}) {
  const { t, locale } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const ccy = loan.currency;
  const [rate, setRate] = useState(bpsToPercent(loan.rateBps));
  const [payment, setPayment] = useState(minorToInput(BigInt(loan.payment), ccy));
  const [from, setFrom] = useState(loan.payingAccountId ?? '');
  const [auto, setAuto] = useState(loan.autoRecord);
  return (
    <details className="card" data-testid="loan-settings">
      <summary className="cursor-pointer text-sm font-semibold">{t('account.loan.settings')}</summary>
      <form
        className="mt-3 space-y-3"
        aria-label={t('account.loan.settings')}
        onSubmit={(e) => {
          e.preventDefault();
          const bps = percentToBps(rate);
          if (bps === null || bps > 5000)
            return setMessage({ tone: 'bad', text: t('account.loan.rate_invalid') });
          const parsed = parseAmountInput(payment, ccy, locale);
          if (!parsed.ok || parsed.minor <= 0n)
            return setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
          const paymentChanged = parsed.minor !== BigInt(loan.payment);
          void run(
            () =>
              browserApi.updateLoan(workspaceId, loan.id, {
                version: loan.version,
                rateBps: bps,
                // A new rate re-levels the payment by itself, unless a new figure comes with it.
                ...(paymentChanged ? { paymentAmount: parsed.minor.toString() } : {}),
                payingAccountId: from || null,
                autoRecord: auto,
              }),
            t('common.saved'),
          );
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="field-label">{t('accounts.interest_rate')}</span>
            <input
              className="input num w-24"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('account.loan.lender_payment')}</span>
            <input
              className="input num w-32"
              inputMode="decimal"
              value={payment}
              onChange={(e) => setPayment(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('account.loan.paid_from')}</span>
            <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">{t('account.loan.paid_from_none')}</option>
              {paying.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          <span>
            {t('account.loan.auto_record')}
            <span className="block text-muted">{t('account.loan.auto_record_hint')}</span>
          </span>
        </label>
        <div className="flex flex-wrap gap-3">
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('common.save')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              void run(
                () => browserApi.updateLoan(workspaceId, loan.id, { version: loan.version, archived: true }),
                t('account.loan.stopped'),
              )
            }
          >
            {t('account.loan.stop')}
          </button>
        </div>
        <p className="text-sm text-muted">{t('account.loan.stop_help')}</p>
      </form>
      <StatusLine message={message} />
    </details>
  );
}

/** Each tracked loan's next payment, for Recurring and Upcoming. */
export function LoanPaymentsList({
  workspaceId,
  loans,
  accounts,
}: {
  workspaceId: string;
  loans: readonly LoanDto[];
  accounts: readonly AccountDto[];
}) {
  const { t } = useI18n();
  const due = loans.filter((l) => l.next);
  if (due.length === 0) return null;
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  return (
    <section className="card" data-testid="loan-payments" aria-label={t('account.loan.payments_title')}>
      <h2 className="text-sm font-semibold">{t('account.loan.payments_title')}</h2>
      <p className="text-sm text-muted">{t('account.loan.payments_help')}</p>
      <ul className="mt-2 divide-y divide-line">
        {due.map((l) => (
          <li
            key={l.id}
            className="flex flex-wrap items-baseline justify-between gap-3 py-2 text-sm"
            data-testid="loan-payment-row"
          >
            <span>
              <Link href={`/w/${workspaceId}/accounts/${l.loanAccountId}`} className="font-medium underline">
                {l.name}
              </Link>
              <span className="text-muted">
                {' · '}
                <DateText date={l.next!.date} />
                {l.payingAccountId && nameOf.has(l.payingAccountId)
                  ? ` · ${t('account.loan.from_account', { name: nameOf.get(l.payingAccountId)! })}`
                  : ''}
              </span>
            </span>
            <Money amount={l.next!.total} currency={l.currency} className="font-medium" />
          </li>
        ))}
      </ul>
    </section>
  );
}
