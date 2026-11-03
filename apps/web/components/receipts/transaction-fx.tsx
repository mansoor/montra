'use client';

import { useState } from 'react';
import type { TransactionDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { useI18n } from '../i18n';

function useActionWithLocale() {
  return { ...useAction(), locale: useI18n().locale };
}

/**
 * Foreign amounts on a transaction (CUR-03/05): the original amount and the rate it was converted at, and
 * on a foreign-currency account a rate the user can override (re-posts the entries) or clear. A purchase on
 * a home-currency card can record what it cost abroad and the foreign transaction fee (CUR-03).
 */
export function TransactionFx({
  workspaceId,
  transaction,
  foreignAccount,
}: {
  workspaceId: string;
  transaction: TransactionDto;
  /** The paying account is in another currency than its entity (rates apply to the postings). */
  foreignAccount: boolean;
}) {
  const { run, busy, message, setMessage, t, locale } = useActionWithLocale();
  const fx = transaction.foreign;
  const [rate, setRate] = useState(fx?.rateSource === 'user' ? fx.rate : '');
  const [abroad, setAbroad] = useState({ amount: '', currency: '', fee: '' });
  const charge = transaction.amount;
  const valid = /^\d{1,10}(\.\d{1,10})?$/.test(rate.trim());
  const spending = charge !== null && BigInt(charge.amount) < 0n;
  // Changing the fee re-splits: the fee gets its own Bank fees split, the category covers the rest.
  const single = transaction.splits?.length === 1 ? transaction.splits[0]!.accountId : null;

  async function recordAbroad() {
    if (!charge) return;
    const currency = abroad.currency.trim().toUpperCase();
    const original = parseAmountInput(abroad.amount, currency, locale, t);
    if (!original.ok) return setMessage({ tone: 'bad', text: original.error });
    let fee: { amount: string; currency: string } | undefined;
    if (abroad.fee.trim()) {
      const f = parseAmountInput(abroad.fee, charge.currency, locale, t);
      if (!f.ok) return setMessage({ tone: 'bad', text: f.error });
      fee = { amount: f.minor.toString(), currency: charge.currency };
    }
    await run(
      () =>
        browserApi.updateTransaction(workspaceId, transaction.id, transaction.version, {
          foreign: { original: { amount: original.minor.toString(), currency }, ...(fee ? { fee } : {}) },
          ...(fee && single ? { categoryId: single } : {}),
        }),
      t('fx.abroad_saved'),
    );
  }
  return (
    <section
      className="card space-y-2"
      aria-labelledby="fx-title"
      hidden={!fx && !foreignAccount && !spending}
    >
      <h2 id="fx-title" className="font-medium">
        {t('fx.title')}
      </h2>
      {fx && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">{t('fx.original')}</dt>
          <dd>
            <Money amount={fx.original.amount} currency={fx.original.currency} />
          </dd>
          <dt className="text-muted">{t('fx.rate')}</dt>
          <dd>
            <span className="num">{fx.rate}</span>{' '}
            <span className="chip chip-muted">{t(`fx.source.${fx.rateSource}`)}</span>
          </dd>
          {fx.fee && (
            <>
              <dt className="text-muted">{t('fx.fee')}</dt>
              <dd>
                <Money amount={fx.fee.amount} currency={fx.fee.currency} />
              </dd>
            </>
          )}
        </dl>
      )}
      {foreignAccount && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="field-label">{t('fx.override')}</span>
            <input
              className="input num w-36"
              inputMode="decimal"
              value={rate}
              placeholder={fx?.rate ?? '1.0000'}
              onChange={(e) => setRate(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !valid}
            onClick={() =>
              run(
                () =>
                  browserApi.updateTransaction(workspaceId, transaction.id, transaction.version, {
                    fxRate: rate.trim(),
                  }),
                t('fx.saved'),
              )
            }
          >
            {t('fx.use_rate')}
          </button>
          {fx?.rateSource === 'user' && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    browserApi.updateTransaction(workspaceId, transaction.id, transaction.version, {
                      fxRate: null,
                    }),
                  t('fx.cleared'),
                )
              }
            >
              {t('fx.use_reference')}
            </button>
          )}
        </div>
      )}
      {!foreignAccount && !fx && spending && (
        <details className="text-sm">
          <summary className="cursor-pointer">{t('fx.abroad')}</summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label>
              <span className="field-label">{t('fx.abroad_amount')}</span>
              <input
                className="input num w-32"
                inputMode="decimal"
                value={abroad.amount}
                onChange={(e) => setAbroad({ ...abroad, amount: e.target.value })}
              />
            </label>
            <label>
              <span className="field-label">{t('fx.abroad_currency')}</span>
              <input
                className="input w-20"
                maxLength={3}
                placeholder="EUR"
                value={abroad.currency}
                onChange={(e) => setAbroad({ ...abroad, currency: e.target.value })}
              />
            </label>
            <label>
              <span className="field-label">{t('fx.abroad_fee', { currency: charge!.currency })}</span>
              <input
                className="input num w-28"
                inputMode="decimal"
                placeholder={t('common.optional')}
                value={abroad.fee}
                onChange={(e) => setAbroad({ ...abroad, fee: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="btn-secondary"
              disabled={
                busy ||
                !abroad.amount.trim() ||
                abroad.currency.trim().length !== 3 ||
                (Boolean(abroad.fee.trim()) && !single)
              }
              onClick={recordAbroad}
            >
              {t('fx.abroad_save')}
            </button>
          </div>
          {abroad.fee.trim() && !single && (
            <p className="mt-1 text-xs text-muted">{t('fx.abroad_fee_split')}</p>
          )}
        </details>
      )}
      <StatusLine message={message} />
    </section>
  );
}
