'use client';

import { useState } from 'react';
import type { AccountDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/** Inputs to planning (Phase 6): card limit, APR and minimum payment (debt payoff), low-balance warning. */
export function AccountPlanning({ workspaceId, account }: { workspaceId: string; account: AccountDto }) {
  const { t, locale } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const p = account.planning;
  const ccy = account.currency;
  const show = (v: string | null) => (v === null ? '' : minorToInput(BigInt(v), ccy));
  const [limit, setLimit] = useState(show(p.creditLimit));
  const [apr, setApr] = useState(p.interestRateBps === null ? '' : (p.interestRateBps / 100).toFixed(2));
  const [minPay, setMinPay] = useState(show(p.minPayment));
  const [low, setLow] = useState(show(p.lowBalance));
  const debt = account.type === 'liability';

  function amount(raw: string, allowNegative = false): string | null | undefined {
    if (!raw.trim()) return null;
    const r = parseAmountInput(raw, ccy, locale);
    return r.ok && (allowNegative || r.minor >= 0n) ? String(r.minor) : undefined;
  }

  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted">{t('accounts.planning')}</summary>
      <form
        className="mt-2 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const creditLimit = amount(limit);
          const minPayment = amount(minPay);
          const lowBalance = amount(low, true);
          const bps = apr.trim() === '' ? null : Number(apr.replace(',', '.')) * 100;
          if (
            creditLimit === undefined ||
            minPayment === undefined ||
            lowBalance === undefined ||
            (bps !== null && (!Number.isFinite(bps) || bps < 0 || bps > 10_000))
          ) {
            setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
            return;
          }
          void run(
            () =>
              browserApi.updateAccount(workspaceId, account.id, {
                ...(debt
                  ? { creditLimit, minPayment, interestRateBps: bps === null ? null : Math.trunc(bps) }
                  : {}),
                lowBalance: lowBalance ?? '0',
              }),
            t('common.saved'),
          );
        }}
      >
        {debt && (
          <>
            {account.kind === 'credit_card' && (
              <label>
                <span className="field-label">{t('accounts.credit_limit')}</span>
                <input
                  className="input num w-32"
                  inputMode="decimal"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                />
              </label>
            )}
            <label>
              <span className="field-label">{t('accounts.apr')}</span>
              <input
                className="input num w-24"
                inputMode="decimal"
                value={apr}
                onChange={(e) => setApr(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('accounts.min_payment')}</span>
              <input
                className="input num w-32"
                inputMode="decimal"
                value={minPay}
                onChange={(e) => setMinPay(e.target.value)}
              />
            </label>
          </>
        )}
        {!debt && (
          <label>
            <span className="field-label">{t('accounts.low_balance')}</span>
            <input
              className="input num w-32"
              inputMode="decimal"
              value={low}
              onChange={(e) => setLow(e.target.value)}
            />
          </label>
        )}
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('common.save')}
        </button>
      </form>
      <StatusLine message={message} />
    </details>
  );
}
