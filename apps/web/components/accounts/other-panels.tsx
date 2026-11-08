'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { accountProfile } from '@montra/domain';
import type { AccountDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/** A home, car or other asset: what it cost, the loan against it, and the equity (ADR-0027). */
export function AssetPanel({
  workspaceId,
  account,
  accounts,
}: {
  workspaceId: string;
  account: AccountDto;
  accounts: readonly AccountDto[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { run, busy, message, setMessage } = useAction();
  const ccy = account.currency;
  const loans = accounts.filter(
    (a) =>
      !a.archived &&
      a.id !== account.id &&
      a.entityId === account.entityId &&
      accountProfile(a.kind).side === 'liability',
  );
  const loan = loans.find((l) => l.id === account.loanAccountId) ?? null;
  const value = BigInt(account.balance.amount);
  const owed = loan ? BigInt(loan.balance.amount) : null;
  const [price, setPrice] = useState(
    account.purchasePrice ? minorToInput(BigInt(account.purchasePrice), ccy) : '',
  );
  const [date, setDate] = useState(account.purchaseDate ?? '');
  const [loanId, setLoanId] = useState(account.loanAccountId ?? '');
  const money = (n: bigint) => <Money amount={String(n)} currency={ccy} />;
  return (
    <section className="card space-y-4" data-testid="asset-panel" aria-label={t('asset.title')}>
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div data-testid="asset-value">
          <dt className="text-muted">{t('asset.value')}</dt>
          <dd className="text-lg font-semibold">{money(value)}</dd>
        </div>
        {owed !== null && (
          <>
            <div data-testid="asset-owed">
              <dt className="text-muted">{t('asset.owed', { name: loan!.name })}</dt>
              <dd className="font-medium">{money(owed)}</dd>
            </div>
            <div data-testid="asset-equity">
              <dt className="text-muted">{t('asset.equity')}</dt>
              <dd className={`text-lg font-semibold ${value - owed < 0n ? 'text-bad' : ''}`}>
                {money(value - owed)}
              </dd>
            </div>
          </>
        )}
        {account.purchasePrice !== null && (
          <>
            <div data-testid="asset-paid">
              <dt className="text-muted">
                {t('asset.paid')}
                {account.purchaseDate && (
                  <>
                    {' '}
                    (<DateText date={account.purchaseDate} />)
                  </>
                )}
              </dt>
              <dd className="font-medium">{money(BigInt(account.purchasePrice))}</dd>
            </div>
            <div data-testid="asset-change">
              <dt className="text-muted">{t('asset.change')}</dt>
              <dd className="font-medium">
                <Money amount={String(value - BigInt(account.purchasePrice))} currency={ccy} signed />
              </dd>
            </div>
          </>
        )}
      </dl>
      <details open={account.purchasePrice === null && account.loanAccountId === null}>
        <summary className="cursor-pointer text-sm font-semibold">{t('asset.settings')}</summary>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          aria-label={t('asset.settings')}
          onSubmit={(e) => {
            e.preventDefault();
            let purchasePrice: string | null = null;
            if (price.trim()) {
              const parsed = parseAmountInput(price, ccy, locale);
              if (!parsed.ok || parsed.minor < 0n)
                return setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
              purchasePrice = parsed.minor.toString();
            }
            void run(
              () =>
                browserApi.updateAccount(workspaceId, account.id, {
                  purchasePrice,
                  purchaseDate: (date || null) as never,
                  loanAccountId: loanId || null,
                }),
              t('common.saved'),
            ).then((r) => {
              if (r) router.refresh();
            });
          }}
        >
          <label>
            <span className="field-label">{t('asset.paid')}</span>
            <input
              className="input num w-32"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('asset.bought_on')}</span>
            <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t('asset.loan')}</span>
            <select className="input" value={loanId} onChange={(e) => setLoanId(e.target.value)}>
              <option value="">{t('asset.loan_none')}</option>
              {loans.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('common.save')}
          </button>
        </form>
        <p className="mt-2 text-sm text-muted">{t('asset.value_help')}</p>
      </details>
      <StatusLine message={message} />
    </section>
  );
}

/** Cash: count what's there, and the balance follows (ADR-0027). */
export function CashCount({
  workspaceId,
  account,
  today,
}: {
  workspaceId: string;
  account: AccountDto;
  today: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { run, busy, message, setMessage } = useAction();
  const [counted, setCounted] = useState('');
  return (
    <section className="card space-y-2" data-testid="cash-count" aria-label={t('cash.title')}>
      <h2 className="text-sm font-semibold">{t('cash.title')}</h2>
      <p className="text-sm text-muted">{t('cash.help')}</p>
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t('cash.title')}
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = parseAmountInput(counted, account.currency, locale);
          if (!parsed.ok || parsed.minor < 0n)
            return setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
          void run(
            () =>
              browserApi.adjustBalance(workspaceId, account.id, {
                date: today as never,
                balance: { amount: parsed.minor.toString(), currency: account.currency },
                note: t('cash.note'),
              }),
            t('cash.done'),
          ).then((r) => {
            if (r) {
              setCounted('');
              router.refresh();
            }
          });
        }}
      >
        <label>
          <span className="field-label">{t('cash.counted')}</span>
          <input
            className="input num w-32"
            inputMode="decimal"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
          />
        </label>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('cash.save')}
        </button>
      </form>
      <StatusLine message={message} />
    </section>
  );
}

/** Money owed outside a bank: to whom, and when it's due (ADR-0027). */
export function DebtPanel({
  workspaceId,
  account,
  today,
}: {
  workspaceId: string;
  account: AccountDto;
  today: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { run, busy, message } = useAction();
  const [due, setDue] = useState(account.dueDate ?? '');
  const late = account.dueDate !== null && account.dueDate < today && BigInt(account.balance.amount) > 0n;
  return (
    <section className="card space-y-3" data-testid="debt-panel" aria-label={t('debt.title')}>
      {account.dueDate ? (
        <p className="text-sm" data-testid="debt-due">
          {t('debt.due')} <DateText date={account.dueDate} />
          {late && <span className="ml-2 font-medium text-bad">{t('account.loan.overdue')}</span>}
        </p>
      ) : (
        <p className="text-sm text-muted">{t('debt.no_due')}</p>
      )}
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t('debt.title')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => browserApi.updateAccount(workspaceId, account.id, { dueDate: (due || null) as never }),
            t('common.saved'),
          ).then((r) => {
            if (r) router.refresh();
          });
        }}
      >
        <label>
          <span className="field-label">{t('debt.due_date')}</span>
          <input type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('common.save')}
        </button>
      </form>
      <StatusLine message={message} />
    </section>
  );
}
