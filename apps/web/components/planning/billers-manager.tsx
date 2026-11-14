'use client';

import { useState } from 'react';
import type { BillerDto, FamilyMemberDto, HouseholdBillDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const CADENCES = ['monthly', 'bimonthly', 'quarterly', 'semiannual', 'yearly'] as const;

/**
 * The providers that send the budget's bills (ADR-0048 §4): "SDG&E" on Utilities, "GEICO" on Auto insurance. Each
 * one's next bill is estimated from its recent payments, and shows in upcoming, the calendar and the forecast; a
 * scanned bill gives the exact amount and date. Only the account number's last four digits are kept, for matching.
 */
export function BillersManager({
  workspaceId,
  categories,
  billers,
  members,
  bills = [],
}: {
  workspaceId: string;
  /** The budget's spending categories, by group. */
  categories: { id: string; name: string; group: string }[];
  billers: BillerDto[];
  members: FamilyMemberDto[];
  /** Bills filed for these providers (scanned on the phone, or typed in). */
  bills?: HouseholdBillDto[];
}) {
  const { t } = useI18n();
  const { run, busy, message } = useAction();
  const utilities = categories.find((c) => c.name === 'Utilities') ?? categories[0];
  const blank = {
    name: '',
    categoryId: utilities?.id ?? '',
    dueDay: '',
    accountLast4: '',
    cadence: 'monthly' as (typeof CADENCES)[number],
    memberId: '',
  };
  const [form, setForm] = useState(blank);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const active = billers.filter((b) => !b.archived);

  return (
    <div className="space-y-5">
      <section className="card-flush" aria-label={t('billers.title')}>
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="text-base font-semibold">{t('billers.title')}</h2>
          <p className="text-xs text-muted">{t('billers.hint')}</p>
        </div>
        {active.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">{t('billers.empty')}</p>
        ) : (
          <table className="tbl" data-testid="billers">
            <thead>
              <tr>
                <th scope="col" className="px-4 py-2">
                  {t('billers.name')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('billers.category')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('billers.next')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('billers.expected')}
                </th>
                <th scope="col" className="w-24 px-2 py-2">
                  <span className="sr-only">{t('budget.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {active.map((b) => (
                <tr key={b.id} data-testid="biller-row">
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    {b.name}
                    <span className="block text-xs font-normal text-muted">
                      {[
                        t(`billers.cadence_${b.cadence}`),
                        b.dueDay ? t('billers.due_day_n', { day: b.dueDay }) : null,
                        b.accountLast4 ? t('billers.account_ending', { last4: b.accountLast4 }) : null,
                        members.find((m) => m.id === b.memberId)?.name ?? null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </th>
                  <td className="px-2 py-2">{categoryName.get(b.categoryId) ?? '—'}</td>
                  <td className="px-2 py-2">
                    {b.next ? <DateText date={b.next.date} /> : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {b.next ? (
                      <span title={t('billers.estimate_hint', { count: b.next.basedOn })}>
                        ≈ <Money amount={b.next.amount} currency={b.next.currency} />
                      </span>
                    ) : (
                      <span className="text-xs text-muted">{t('billers.no_payments')}</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            browserApi.updateBiller(workspaceId, b.id, {
                              archived: true,
                              version: b.version,
                            }),
                          t('billers.removed', { name: b.name }),
                        )
                      }
                    >
                      {t('billers.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {bills.length > 0 && (
        <section className="card-flush" aria-label={t('billers.bills')}>
          <h2 className="border-b border-line px-4 py-2.5 text-base font-semibold">{t('billers.bills')}</h2>
          <table className="tbl" data-testid="household-bills">
            <thead>
              <tr>
                <th scope="col" className="px-4 py-2">
                  {t('billers.name')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('billers.due_date')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('billers.amount')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('billers.status')}
                </th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id}>
                  <td className="px-4 py-2 font-medium">{b.billerName}</td>
                  <td className="px-2 py-2">
                    <DateText date={b.dueDate} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={b.amount} currency={b.currency} />
                  </td>
                  <td className="px-2 py-2">
                    <span
                      className={`chip ${b.status === 'overdue' ? 'chip-bad' : b.status === 'paid' ? 'chip-good' : 'chip-muted'}`}
                    >
                      {t(`billers.status_${b.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card space-y-3" aria-label={t('billers.add')}>
        <h2 className="text-base font-semibold">{t('billers.add')}</h2>
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                browserApi.createBiller(workspaceId, {
                  name: form.name,
                  categoryId: form.categoryId,
                  cadence: form.cadence,
                  dueDay: form.dueDay ? Number(form.dueDay) : null,
                  accountLast4: form.accountLast4 || null,
                  memberId: form.memberId || null,
                }),
              t('billers.added', { name: form.name }),
            ).then((r) => {
              if (r) setForm(blank);
            });
          }}
        >
          <label>
            <span className="field-label">{t('billers.name')}</span>
            <input
              className="input"
              required
              maxLength={200}
              placeholder={t('billers.name_hint')}
              value={form.name}
              onChange={set('name')}
            />
          </label>
          <label>
            <span className="field-label">{t('billers.category')}</span>
            <select className="input" value={form.categoryId} onChange={set('categoryId')} required>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.group} · {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('billers.cadence')}</span>
            <select className="input" value={form.cadence} onChange={set('cadence')}>
              {CADENCES.map((c) => (
                <option key={c} value={c}>
                  {t(`billers.cadence_${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('billers.due_day')}</span>
            <input
              className="input num"
              type="number"
              min={1}
              max={31}
              inputMode="numeric"
              value={form.dueDay}
              onChange={set('dueDay')}
            />
          </label>
          <label>
            <span className="field-label">{t('billers.last4')}</span>
            <input
              className="input num"
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              value={form.accountLast4}
              onChange={set('accountLast4')}
            />
          </label>
          {members.length > 0 && (
            <label>
              <span className="field-label">{t('billers.member')}</span>
              <select className="input" value={form.memberId} onChange={set('memberId')}>
                <option value="">{t('members.household')}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="sm:col-span-3">
            <button type="submit" className="btn-primary" disabled={busy || !form.name.trim()}>
              {t('billers.add_button')}
            </button>
          </div>
        </form>
        <StatusLine message={message} />
      </section>
    </div>
  );
}
