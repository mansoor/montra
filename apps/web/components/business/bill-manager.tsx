'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AccountDto, BillDto, CategoryDto, PartyDto, PaymentCandidateDto } from '@montra/api-client';
import { BILL_CHIP } from '@/lib/business';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { receiptFileProblem, RECEIPT_ACCEPT } from '@/lib/receipts';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const NEW = '__new';

/** Bills to pay (BIZ-06): nothing posts until one is paid; until then it's in the forecast and calendar. */
export function BillManager({
  workspaceId,
  entityId,
  currency,
  bills,
  vendors,
  expenseCategories,
  accounts,
  defaultAccountId,
  today,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  bills: BillDto[];
  vendors: PartyDto[];
  expenseCategories: CategoryDto[];
  accounts: AccountDto[];
  defaultAccountId: string | null;
  today: string;
}) {
  const { locale } = useI18n();
  const { run, busy, message, setMessage, t } = useAction();
  const known = vendors.filter((v) => v.id !== null && !v.archived);
  const found = vendors.filter((v) => v.id === null);
  const [partyId, setPartyId] = useState(known[0]?.id ?? NEW);
  const [newVendor, setNewVendor] = useState('');
  const [reference, setReference] = useState('');
  const [billDate, setBillDate] = useState(today);
  const [dueDate, setDueDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState(expenseCategories[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PaymentCandidateDto[]>([]);
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '');
  const [payDate, setPayDate] = useState(today);
  const name = new Map(accounts.map((a) => [a.id, a.name]));

  function add(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseAmountInput(amount, currency, locale, t);
    if (!parsed.ok) return setMessage({ tone: 'bad', text: parsed.error });
    if (parsed.minor <= 0n) return setMessage({ tone: 'bad', text: t('bills.amount_invalid') });
    if (partyId === NEW && !newVendor.trim()) {
      return setMessage({ tone: 'bad', text: t('bills.vendor_required') });
    }
    if (file) {
      const problem = receiptFileProblem(file, t);
      if (problem) return setMessage({ tone: 'bad', text: problem });
    }
    void run(async () => {
      let vendor = partyId;
      if (partyId === NEW) {
        vendor = (
          await browserApi.createParty(workspaceId, { entityId, kind: 'vendor', name: newVendor.trim() })
        ).id!;
      } else if (partyId.startsWith('key:')) {
        const p = found.find((v) => `key:${v.payeeKey}` === partyId)!;
        vendor = (
          await browserApi.createParty(workspaceId, {
            entityId,
            kind: 'vendor',
            name: p.name,
            payeeKey: p.payeeKey,
          })
        ).id!;
      }
      const fileIds = file
        ? [(await browserApi.uploadBusinessFile(workspaceId, file, file.name)).fileId]
        : [];
      return browserApi.createBill(workspaceId, {
        entityId,
        partyId: vendor,
        reference: reference.trim() || null,
        billDate,
        dueDate,
        amount: String(parsed.minor),
        expenseAccountId: categoryId,
        fileIds,
      });
    }, t('bills.added')).then((r) => {
      if (r) {
        setAmount('');
        setReference('');
        setNewVendor('');
        setFile(null);
      }
    });
  }

  async function openPay(b: BillDto) {
    setPaying(b.id);
    setCandidates(await browserApi.listBillCandidates(workspaceId, b.id));
  }

  return (
    <div className="space-y-5">
      {bills.length > 0 && (
        <section className="card-flush" aria-label={t('bills.list')}>
          <ul className="divide-y divide-line">
            {bills.map((b) => (
              <li key={b.id} className="space-y-2 px-4 py-3" data-testid="bill-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {b.partyName}
                      {b.reference && <span className="ml-2 text-sm text-muted">{b.reference}</span>}
                    </p>
                    <p className="text-xs text-muted">
                      {t('bills.due')} <DateText date={b.dueDate} />
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Money amount={b.amount} currency={b.currency} />
                    <span className={BILL_CHIP[b.status]}>{t(`bills.status.${b.status}`)}</span>
                    {(b.status === 'open' || b.status === 'overdue') && (
                      <>
                        <button type="button" className="btn-secondary" onClick={() => openPay(b)}>
                          {t('bills.pay')}
                        </button>
                        <button
                          type="button"
                          className="text-sm underline"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () =>
                                browserApi.updateBill(workspaceId, b.id, { void: true, version: b.version }),
                              t('bills.voided'),
                            )
                          }
                        >
                          {t('bills.void')}
                        </button>
                      </>
                    )}
                    {b.status === 'paid' && b.transactionId && (
                      <>
                        <Link
                          href={`/w/${workspaceId}/transactions/${b.transactionId}`}
                          className="text-sm underline"
                        >
                          {t('bills.open_transaction')}
                        </Link>
                        <button
                          type="button"
                          className="text-sm underline"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => browserApi.removeBillPayment(workspaceId, b.id),
                              t('bills.payment_removed'),
                            )
                          }
                        >
                          {t('bills.remove_payment')}
                        </button>
                      </>
                    )}
                    {b.fileIds[0] && (
                      <a
                        className="text-sm underline"
                        href={browserApi.billFilePath(workspaceId, b.id, b.fileIds[0])}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('bills.open_file')}
                      </a>
                    )}
                  </div>
                </div>
                {paying === b.id && (
                  <div className="space-y-2 rounded-md border border-line p-3">
                    {candidates.length > 0 && (
                      <ul className="divide-y divide-line">
                        {candidates.map((c) => (
                          <li
                            key={c.transactionId}
                            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                          >
                            <span>
                              <DateText date={c.date} /> · {c.payee ?? ''} · {name.get(c.accountId) ?? ''}
                            </span>
                            <button
                              type="button"
                              className="btn-secondary"
                              disabled={busy}
                              onClick={() =>
                                run(
                                  () =>
                                    browserApi.payBill(workspaceId, b.id, { transactionId: c.transactionId }),
                                  t('bills.paid'),
                                ).then(() => setPaying(null))
                              }
                            >
                              {t('bills.use_this')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <label>
                        <span className="field-label">{t('bills.pay_from')}</span>
                        <select
                          className="input"
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
                      <label>
                        <span className="field-label">{t('bills.pay_date')}</span>
                        <input
                          className="input"
                          type="date"
                          value={payDate}
                          onChange={(e) => setPayDate(e.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busy || !accountId}
                        onClick={() =>
                          run(
                            () =>
                              browserApi.payBill(workspaceId, b.id, {
                                accountId,
                                date: payDate,
                                amount: b.amount,
                              }),
                            t('bills.paid'),
                          ).then(() => setPaying(null))
                        }
                      >
                        {t('bills.record_payment')}
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => setPaying(null)}>
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="card space-y-3" aria-label={t('bills.add')} onSubmit={add}>
        <h2 className="text-base font-semibold">{t('bills.add')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label>
            <span className="field-label">{t('bills.vendor')}</span>
            <select className="input" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              {known.map((v) => (
                <option key={v.id} value={v.id!}>
                  {v.name}
                </option>
              ))}
              {found.map((v) => (
                <option key={v.payeeKey} value={`key:${v.payeeKey}`}>
                  {v.name}
                </option>
              ))}
              <option value={NEW}>{t('bills.new_vendor')}</option>
            </select>
          </label>
          {partyId === NEW && (
            <label>
              <span className="field-label">{t('bills.vendor_name')}</span>
              <input
                className="input"
                maxLength={200}
                value={newVendor}
                onChange={(e) => setNewVendor(e.target.value)}
              />
            </label>
          )}
          <label>
            <span className="field-label">{t('bills.reference')}</span>
            <input
              className="input"
              maxLength={100}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('bills.bill_date')}</span>
            <input
              className="input"
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('bills.due_date')}</span>
            <input
              className="input"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('bills.amount')}</span>
            <input
              className="input"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('bills.category')}</span>
            <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {expenseCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('bills.file')}</span>
            <input
              className="input"
              type="file"
              accept={RECEIPT_ACCEPT}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        <button type="submit" className="btn-primary" disabled={busy || !categoryId}>
          {t('bills.add')}
        </button>
      </form>
      <StatusLine message={message} />
    </div>
  );
}
