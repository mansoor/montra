'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { AccountDto, InvoiceDto, PaymentCandidateDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { amountToInput } from '@/lib/receipts';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/** Sending, voiding and payments on one invoice (BIZ-05). */
export function InvoiceActions({
  workspaceId,
  invoice,
  accounts,
  defaultAccountId,
  customerEmail,
  today,
}: {
  workspaceId: string;
  invoice: InvoiceDto;
  accounts: AccountDto[];
  defaultAccountId: string | null;
  customerEmail: string | null;
  today: string;
}) {
  const router = useRouter();
  const { locale } = useI18n();
  const { run, busy, message, setMessage, t } = useAction();
  const [to, setTo] = useState(customerEmail ?? '');
  const [note, setNote] = useState('');
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(amountToInput(invoice.open, invoice.currency));
  const [candidates, setCandidates] = useState<PaymentCandidateDto[]>([]);
  const ccy = invoice.currency;
  const draft = invoice.status === 'draft';
  const open = BigInt(invoice.open);
  const payable = !draft && invoice.status !== 'void' && open > 0n;
  const name = new Map(accounts.map((a) => [a.id, a.name]));

  useEffect(() => {
    setAmount(amountToInput(invoice.open, invoice.currency));
    if (!payable) return;
    let live = true;
    void browserApi.listInvoiceCandidates(workspaceId, invoice.id).then((c) => {
      if (live) setCandidates(c);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, invoice.id, invoice.open, invoice.currency, payable]);

  const send = (email: boolean) =>
    run(
      () =>
        browserApi.sendInvoice(workspaceId, invoice.id, {
          version: invoice.version,
          email,
          ...(email && to.trim() ? { to: to.trim() } : {}),
          ...(note.trim() ? { message: note.trim() } : {}),
        }),
      email ? t('invoices.sent_to', { to: to.trim() }) : t('invoices.marked_sent'),
    );

  function record() {
    const parsed = parseAmountInput(amount, ccy, locale, t);
    if (!parsed.ok) return setMessage({ tone: 'bad', text: parsed.error });
    void run(
      () =>
        browserApi.recordInvoicePayment(workspaceId, invoice.id, {
          accountId,
          date,
          amount: String(parsed.minor),
        }),
      t('invoices.payment_recorded'),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="btn-secondary"
          href={browserApi.invoicePdfPath(workspaceId, invoice.id)}
          target="_blank"
          rel="noreferrer"
        >
          {draft ? t('invoices.preview_pdf') : t('invoices.open_pdf')}
        </a>
        {draft && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={async () => {
              const done = await run(async () => {
                await browserApi.deleteInvoice(workspaceId, invoice.id);
                return true;
              });
              if (done) router.push(`/w/${workspaceId}/business/${invoice.entityId}/invoices`);
            }}
          >
            {t('invoices.delete_draft')}
          </button>
        )}
        {!draft && invoice.status !== 'void' && invoice.payments.length === 0 && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() =>
              run(
                () => browserApi.voidInvoice(workspaceId, invoice.id, { version: invoice.version }),
                t('invoices.voided'),
              )
            }
          >
            {t('invoices.void')}
          </button>
        )}
      </div>

      {invoice.status !== 'void' && invoice.status !== 'paid' && (
        <section className="card space-y-3" aria-labelledby="invoice-send">
          <h2 id="invoice-send" className="text-sm font-semibold">
            {draft ? t('invoices.send_title') : t('invoices.resend_title')}
          </h2>
          {invoice.sentAt && (
            <p className="text-sm text-muted">
              {invoice.sentTo
                ? t('invoices.last_sent_to', { to: invoice.sentTo })
                : t('invoices.marked_sent')}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="field-label">{t('invoices.send_to')}</span>
              <input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label>
              <span className="field-label">{t('invoices.send_message')}</span>
              <input
                className="input"
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !to.trim()}
              onClick={() => send(true)}
            >
              {t('invoices.send_email')}
            </button>
            {draft && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => send(false)}>
                {t('invoices.mark_sent')}
              </button>
            )}
          </div>
        </section>
      )}

      {payable && (
        <section className="card space-y-3" aria-labelledby="invoice-pay">
          <h2 id="invoice-pay" className="text-sm font-semibold">
            {t('invoices.record_payment')}
          </h2>
          {candidates.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm text-muted">{t('invoices.candidates_hint')}</p>
              <ul className="divide-y divide-line">
                {candidates.map((c) => (
                  <li
                    key={c.transactionId}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="text-sm">
                      <DateText date={c.date} /> · {c.payee ?? t('invoices.deposit')} ·{' '}
                      <Money amount={c.amount} currency={ccy} /> · {name.get(c.accountId) ?? ''}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            browserApi.recordInvoicePayment(workspaceId, invoice.id, {
                              transactionId: c.transactionId,
                            }),
                          t('invoices.payment_linked'),
                        )
                      }
                    >
                      {t('invoices.use_deposit')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-muted">{t('invoices.manual_payment_hint')}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className="field-label">{t('invoices.payment_account')}</span>
              <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('invoices.payment_date')}</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              <span className="field-label">{t('invoices.payment_amount')}</span>
              <input
                className="input"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          </div>
          <button type="button" className="btn-secondary" disabled={busy || !accountId} onClick={record}>
            {t('invoices.record_payment')}
          </button>
        </section>
      )}

      {invoice.payments.length > 0 && (
        <section className="card space-y-2" aria-labelledby="invoice-payments">
          <h2 id="invoice-payments" className="text-sm font-semibold">
            {t('invoices.payments')}
          </h2>
          <ul className="divide-y divide-line">
            {invoice.payments.map((p, i) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <DateText date={p.date} /> · <Money amount={p.amount} currency={ccy} />
                  {p.source === 'auto' && <span className="chip ml-2">{t('invoices.linked_auto')}</span>}
                </span>
                <span className="flex items-center gap-3">
                  <Link href={`/w/${workspaceId}/transactions/${p.transactionId}`} className="underline">
                    {t('invoices.open_transaction')}
                  </Link>
                  {/* Later payments were split from the earlier ones, so only the latest can go. */}
                  {i === invoice.payments.length - 1 && (
                    <button
                      type="button"
                      className="underline"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => browserApi.removeInvoicePayment(workspaceId, invoice.id, p.id),
                          t('invoices.payment_removed'),
                        )
                      }
                    >
                      {t('invoices.remove_payment')}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <StatusLine message={message} />
    </div>
  );
}
