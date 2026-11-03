'use client';

import { useState } from 'react';
import type { AccountDto, BudgetPeriodDto, ExpectedIncomeDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const SOURCES = ['salary', 'business', 'rent', 'other'] as const;
const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'] as const;

/**
 * Expected take-home income (BUD-03): the paydays the budget plans from. Each one is matched to the deposit
 * that fulfils it; the period can also override its expected income.
 */
export function IncomeManager({
  workspaceId,
  entityId,
  currency,
  items,
  accounts,
  period,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  items: ExpectedIncomeDto[];
  accounts: AccountDto[];
  period: BudgetPeriodDto;
}) {
  const { t, locale } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const [form, setForm] = useState({
    name: '',
    sourceType: 'salary' as (typeof SOURCES)[number],
    amount: '',
    cadence: 'monthly' as (typeof CADENCES)[number],
    nextDate: period.start,
    accountId: accounts.find((a) => a.kind === 'checking')?.id ?? '',
    payee: '',
  });
  const [override, setOverride] = useState(
    period.income.expected === '0' ? '' : minorToInput(BigInt(period.income.expected), currency),
  );
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="space-y-5">
      <section className="card space-y-3" aria-label={t('income.this_period')}>
        <h2 className="text-base font-semibold">{t('income.this_period')}</h2>
        {period.income.items.length === 0 ? (
          <p className="text-sm text-muted">{t('income.none_this_period')}</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col" className="px-2 py-1.5">
                  {t('income.name')}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  {t('income.date')}
                </th>
                <th scope="col" className="px-2 py-1.5 text-right">
                  {t('income.expected')}
                </th>
                <th scope="col" className="px-2 py-1.5 text-right">
                  {t('income.actual')}
                </th>
              </tr>
            </thead>
            <tbody>
              {period.income.items.map((i) => (
                <tr key={`${i.expectedIncomeId}-${i.date}`}>
                  <td className="px-2 py-1.5">{i.name}</td>
                  <td className="px-2 py-1.5">
                    <DateText date={i.date} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Money amount={i.expected} currency={currency} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {i.actual ? (
                      <Money amount={i.actual} currency={currency} />
                    ) : (
                      <span className="chip chip-muted">{t('income.not_yet')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            let expectedIncome: string | null = null;
            if (override.trim()) {
              const parsed = parseAmountInput(override, currency, locale);
              if (!parsed.ok || parsed.minor < 0n) {
                setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
                return;
              }
              expectedIncome = String(parsed.minor);
            }
            void run(
              () =>
                browserApi.updateBudgetPeriod(workspaceId, period.budget.id, period.start, {
                  expectedIncome,
                  version: period.budget.version,
                }),
              t('income.override_saved'),
            );
          }}
        >
          <label>
            <span className="field-label">{t('income.override')}</span>
            <input
              className="input num w-40"
              inputMode="decimal"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('common.save')}
          </button>
          <span className="text-xs text-muted">{t('income.override_hint')}</span>
        </form>
      </section>

      <section className="card-flush" aria-label={t('income.title')}>
        <h2 className="border-b border-line px-4 py-2.5 text-base font-semibold">{t('income.title')}</h2>
        {items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">{t('income.empty')}</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col" className="px-4 py-2">
                  {t('income.name')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('income.cadence')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('income.next')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('income.amount')}
                </th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">{t('budget.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className={i.active ? '' : 'opacity-60'}>
                  <td className="px-4 py-2">
                    <span className="font-medium">{i.name}</span>
                    <span className="block text-xs text-muted">{t(`income.source_${i.sourceType}`)}</span>
                  </td>
                  <td className="px-2 py-2">{t(`cadence.${i.cadence}`)}</td>
                  <td className="px-2 py-2">
                    <DateText date={i.nextDate} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={i.amount} currency={i.currency} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          browserApi.updateExpectedIncome(workspaceId, i.id, {
                            active: !i.active,
                            version: i.version,
                          }),
                        )
                      }
                    >
                      {i.active ? t('income.pause') : t('income.resume')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="grid gap-3 border-t border-line p-4 sm:grid-cols-2 lg:grid-cols-4"
          aria-label={t('income.add')}
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = parseAmountInput(form.amount, currency, locale);
            if (!parsed.ok || parsed.minor <= 0n) {
              setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
              return;
            }
            void run(
              () =>
                browserApi.createExpectedIncome(workspaceId, {
                  entityId,
                  name: form.name,
                  sourceType: form.sourceType,
                  amount: String(parsed.minor),
                  currency,
                  cadence: form.cadence,
                  nextDate: form.nextDate,
                  accountId: form.accountId || null,
                  payee: form.payee || null,
                }),
              t('income.added'),
            ).then((r) => r && setForm({ ...form, name: '', amount: '', payee: '' }));
          }}
        >
          <label>
            <span className="field-label">{t('income.name')}</span>
            <input
              className="input"
              required
              value={form.name}
              onChange={set('name')}
              placeholder={t('income.name_placeholder')}
            />
          </label>
          <label>
            <span className="field-label">{t('income.source')}</span>
            <select className="input" value={form.sourceType} onChange={set('sourceType')}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`income.source_${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('income.amount')}</span>
            <input
              className="input num"
              inputMode="decimal"
              required
              value={form.amount}
              onChange={set('amount')}
            />
          </label>
          <label>
            <span className="field-label">{t('income.cadence')}</span>
            <select className="input" value={form.cadence} onChange={set('cadence')}>
              {CADENCES.map((c) => (
                <option key={c} value={c}>
                  {t(`cadence.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('income.next')}</span>
            <input type="date" className="input" required value={form.nextDate} onChange={set('nextDate')} />
          </label>
          <label>
            <span className="field-label">{t('income.account')}</span>
            <select className="input" value={form.accountId} onChange={set('accountId')}>
              <option value="">{t('common.choose')}</option>
              {accounts
                .filter((a) => a.type === 'asset')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="sm:col-span-2">
            <span className="field-label">{t('income.payee')}</span>
            <input
              className="input"
              value={form.payee}
              onChange={set('payee')}
              placeholder={t('income.payee_placeholder')}
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('income.add')}
            </button>
          </div>
        </form>
      </section>
      <StatusLine message={message} />
    </div>
  );
}
