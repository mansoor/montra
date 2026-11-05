'use client';

import type { AccountDto } from '@montra/api-client';
import { Money } from '../money';
import { useI18n } from '../i18n';
import { depositRest, type DepositRow } from '@/lib/payslips';

/**
 * Fixed amounts to other accounts, with the rest going to the main one (ADR-0022). The same control for an employer's plan and for one
 * payslip. `net` is left out where there's no pay to take away from yet.
 */
export function DepositSplitEditor({
  rows,
  onChange,
  accounts,
  mainAccountId,
  currency,
  net,
  disabled,
}: {
  rows: DepositRow[];
  onChange: (rows: DepositRow[]) => void;
  accounts: AccountDto[];
  mainAccountId: string;
  currency: string;
  net?: string;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const mainName = accounts.find((a) => a.id === mainAccountId)?.name ?? '';
  const taken = new Set(rows.map((r) => r.accountId));
  const free = accounts.filter((a) => a.id !== mainAccountId && !taken.has(a.id));
  const set = (key: string, patch: Partial<DepositRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const rest = net === undefined ? null : depositRest(net, rows, currency, locale);
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={r.key} className="flex flex-wrap items-end gap-2" data-testid="deposit-split-row">
          <label className="min-w-0 flex-1">
            <span className="field-label">{t('deposits.account')}</span>
            <select
              className="input"
              disabled={disabled}
              aria-label={t('deposits.account_n', { n: i + 1 })}
              value={r.accountId}
              onChange={(e) => set(r.key, { accountId: e.target.value })}
            >
              {accounts
                .filter((a) => a.id !== mainAccountId && (a.id === r.accountId || !taken.has(a.id)))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="w-32">
            <span className="field-label">{t('deposits.amount')}</span>
            <input
              className="input"
              inputMode="decimal"
              disabled={disabled}
              aria-label={t('deposits.amount_n', { n: i + 1 })}
              value={r.amount}
              onChange={(e) => set(r.key, { amount: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="text-sm underline"
            disabled={disabled}
            aria-label={t('deposits.remove_n', { n: i + 1 })}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          >
            {t('deposits.remove')}
          </button>
        </div>
      ))}
      {free.length > 0 && !disabled && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            onChange([
              ...rows,
              { key: `new-${Date.now()}-${rows.length}`, accountId: free[0]!.id, amount: '' },
            ])
          }
        >
          {t('deposits.add')}
        </button>
      )}
      {accounts.filter((a) => a.id !== mainAccountId).length === 0 && (
        <p className="text-sm text-muted">{t('deposits.no_other_accounts')}</p>
      )}
      <p className="text-sm" data-testid="deposit-rest">
        {rest === null ? (
          t('deposits.rest_to', { name: mainName })
        ) : (
          <>
            {t('deposits.rest_to_amount', { name: mainName })}{' '}
            <span className={rest <= 0n && rows.length > 0 ? 'font-semibold text-bad' : 'font-semibold'}>
              <Money amount={rest} currency={currency} />
            </span>
          </>
        )}
      </p>
      {rest !== null && rest <= 0n && rows.length > 0 && (
        <p className="text-sm text-bad" role="alert">
          {t('deposits.too_much')}
        </p>
      )}
    </div>
  );
}
