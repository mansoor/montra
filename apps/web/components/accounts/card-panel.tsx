'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { accountProfile, bpsToPercent, PAY_RULES, type PayRule } from '@montra/domain';
import type { AccountDto, CardStatementDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const payingFor = (account: AccountDto, accounts: readonly AccountDto[]) =>
  accounts.filter(
    (a) =>
      !a.archived &&
      a.entityId === account.entityId &&
      a.currency === account.currency &&
      accountProfile(a.kind).forecast === 'cash',
  );

/** A card or line of credit: the latest statement, what's still due, and paying it (ADR-0026). */
export function CardPanel({
  workspaceId,
  account,
  statement,
  accounts,
  today,
}: {
  workspaceId: string;
  account: AccountDto;
  statement: CardStatementDto | null;
  accounts: readonly AccountDto[];
  today: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { run, busy, message, setMessage } = useAction();
  const paying = payingFor(account, accounts);
  const ccy = account.currency;
  const money = (amount: string) => <Money amount={amount} currency={ccy} />;
  const s = statement;
  const [from, setFrom] = useState(account.cycle.payFromAccountId ?? paying[0]?.id ?? '');
  const [choice, setChoice] = useState<'due' | 'minimum' | 'other'>('due');
  const [other, setOther] = useState('');
  const amountFor = (): string | null => {
    if (!s) return null;
    if (choice === 'due') return s.due;
    if (choice === 'minimum') return s.minimumDue;
    const parsed = parseAmountInput(other, ccy, locale);
    return parsed.ok && parsed.minor > 0n ? parsed.minor.toString() : null;
  };
  return (
    <>
      <section className="card space-y-4" data-testid="card-panel" aria-label={t('card.title')}>
        {!s ? (
          <p className="text-sm text-muted" data-testid="card-unset">
            {t('card.unset')}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div data-testid="card-due">
                <p className="text-sm text-muted">
                  {t('card.due_title')}
                  {s.dueDate < today && BigInt(s.due) > 0n && (
                    <span className="ml-2 font-medium text-bad">{t('account.loan.overdue')}</span>
                  )}
                </p>
                <p className="text-2xl font-semibold">{money(s.due)}</p>
                <p className="text-sm text-muted">
                  {BigInt(s.due) > 0n ? (
                    <>
                      {t('card.due_on')} <DateText date={s.dueDate} />
                      {' · '}
                      {t('card.minimum')} {money(s.minimumDue)}
                    </>
                  ) : (
                    t('card.paid_in_full')
                  )}
                </p>
              </div>
              {BigInt(s.due) > 0n && paying.length > 0 && (
                <form
                  className="flex flex-wrap items-end gap-3"
                  aria-label={t('card.pay')}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const amount = amountFor();
                    if (!amount) return setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
                    void run(
                      () =>
                        browserApi.createTransfer(workspaceId, {
                          date: today as never,
                          fromAccountId: from,
                          toAccountId: account.id,
                          amount: { amount, currency: ccy },
                        }),
                      t('card.paid'),
                    ).then((r) => {
                      if (r) router.refresh();
                    });
                  }}
                >
                  <fieldset className="flex flex-wrap gap-3 text-sm">
                    <legend className="sr-only">{t('card.amount')}</legend>
                    {(['due', 'minimum', 'other'] as const).map((c) => (
                      <label key={c} className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="amount"
                          checked={choice === c}
                          onChange={() => setChoice(c)}
                        />
                        {t(`card.choice_${c}`)}
                      </label>
                    ))}
                  </fieldset>
                  {choice === 'other' && (
                    <label>
                      <span className="field-label">{t('card.amount')}</span>
                      <input
                        className="input num w-28"
                        inputMode="decimal"
                        value={other}
                        onChange={(e) => setOther(e.target.value)}
                      />
                    </label>
                  )}
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
                  <button type="submit" className="btn-primary" disabled={busy}>
                    {t('card.pay')}
                  </button>
                </form>
              )}
            </div>
            <StatusLine message={message} />
            <dl
              className="flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-3 text-sm"
              data-testid="card-summary"
            >
              <div data-testid="card-statement">
                <dt className="text-muted">
                  {t('card.statement_balance')} (<DateText date={s.lastClose} />)
                </dt>
                <dd className="font-medium">{money(s.statementBalance)}</dd>
              </div>
              <div data-testid="card-paid-since">
                <dt className="text-muted">{t('card.paid_since')}</dt>
                <dd className="font-medium">{money(s.paidSince)}</dd>
              </div>
              <div data-testid="card-since">
                <dt className="text-muted">{t('card.since_statement')}</dt>
                <dd className="font-medium">{money(s.sinceStatement)}</dd>
              </div>
              <div data-testid="card-next-close">
                <dt className="text-muted">{t('card.next_close')}</dt>
                <dd className="font-medium">
                  <DateText date={s.nextClose} />
                </dd>
              </div>
              {s.utilizationBps !== null && (
                <div data-testid="card-utilization">
                  <dt className="text-muted">{t('card.utilization')}</dt>
                  <dd className={`font-medium ${s.utilizationBps > 3000 ? 'text-bad' : ''}`}>
                    {`${bpsToPercent(s.utilizationBps)}%`}
                  </dd>
                </div>
              )}
            </dl>
            {s.planned && (
              <p className="text-sm text-muted" data-testid="card-planned">
                {t('card.planned', {
                  name: accounts.find((a) => a.id === s.planned!.fromAccountId)?.name ?? '',
                })}{' '}
                {money(s.planned.amount)} · <DateText date={s.planned.date} />
              </p>
            )}
          </>
        )}
      </section>
      <CardSettings workspaceId={workspaceId} account={account} paying={paying} open={!s} />
    </>
  );
}

function CardSettings({
  workspaceId,
  account,
  paying,
  open,
}: {
  workspaceId: string;
  account: AccountDto;
  paying: readonly AccountDto[];
  open: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { run, busy, message, setMessage } = useAction();
  const c = account.cycle;
  const [statementDay, setStatementDay] = useState(c.statementDay ? String(c.statementDay) : '');
  const [dueDay, setDueDay] = useState(c.dueDay ? String(c.dueDay) : '');
  const [from, setFrom] = useState(c.payFromAccountId ?? '');
  const [rule, setRule] = useState<PayRule | ''>(c.payRule ?? '');
  const [fixed, setFixed] = useState(c.payFixed ? minorToInput(BigInt(c.payFixed), account.currency) : '');
  const day = (v: string) => (v ? Number(v) : null);
  return (
    <details className="card" data-testid="card-settings" open={open}>
      <summary className="cursor-pointer text-sm font-semibold">{t('card.settings')}</summary>
      <form
        className="mt-3 space-y-3"
        aria-label={t('card.settings')}
        onSubmit={(e) => {
          e.preventDefault();
          let payFixed: string | null = null;
          if (rule === 'fixed') {
            const parsed = parseAmountInput(fixed, account.currency, locale);
            if (!parsed.ok || parsed.minor <= 0n)
              return setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
            payFixed = parsed.minor.toString();
          }
          void run(
            () =>
              browserApi.updateAccount(workspaceId, account.id, {
                statementDay: day(statementDay),
                dueDay: day(dueDay),
                payFromAccountId: from || null,
                payRule: rule || null,
                payFixed,
              }),
            t('common.saved'),
          ).then((r) => {
            if (r) router.refresh();
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="field-label">{t('card.statement_day')}</span>
            <DaySelect value={statementDay} onChange={setStatementDay} />
          </label>
          <label>
            <span className="field-label">{t('card.due_day')}</span>
            <DaySelect value={dueDay} onChange={setDueDay} />
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="field-label">{t('card.rule')}</span>
            <select className="input" value={rule} onChange={(e) => setRule(e.target.value as PayRule | '')}>
              <option value="">{t('card.rule_none')}</option>
              {PAY_RULES.map((r) => (
                <option key={r} value={r}>
                  {t(`card.rule_${r}`)}
                </option>
              ))}
            </select>
          </label>
          {rule === 'fixed' && (
            <label>
              <span className="field-label">{t('card.amount')}</span>
              <input
                className="input num w-28"
                inputMode="decimal"
                value={fixed}
                onChange={(e) => setFixed(e.target.value)}
              />
            </label>
          )}
          {rule && (
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
          )}
        </div>
        <p className="text-sm text-muted">{t('card.rule_help')}</p>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('common.save')}
        </button>
      </form>
      <StatusLine message={message} />
    </details>
  );
}

function DaySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <select className="input w-28" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('account.plan.unset')}</option>
      {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
        <option key={d} value={d}>
          {d}
        </option>
      ))}
    </select>
  );
}

/** Each card's latest statement still due, for Upcoming. */
export function CardDuesList({
  workspaceId,
  statements,
}: {
  workspaceId: string;
  statements: readonly CardStatementDto[];
}) {
  const { t } = useI18n();
  const due = statements.filter((s) => BigInt(s.due) > 0n);
  if (due.length === 0) return null;
  return (
    <section className="card" data-testid="card-dues" aria-label={t('card.dues_title')}>
      <h2 className="text-sm font-semibold">{t('card.dues_title')}</h2>
      <ul className="mt-2 divide-y divide-line">
        {due.map((s) => (
          <li
            key={s.accountId}
            className="flex flex-wrap items-baseline justify-between gap-3 py-2 text-sm"
            data-testid="card-due-row"
          >
            <span>
              <Link href={`/w/${workspaceId}/accounts/${s.accountId}`} className="font-medium underline">
                {s.name}
              </Link>
              <span className="text-muted">
                {' · '}
                {t('card.due_on')} <DateText date={s.dueDate} />
                {' · '}
                {t('card.minimum')} <Money amount={s.minimumDue} currency={s.currency} />
              </span>
            </span>
            <Money amount={s.due} currency={s.currency} className="font-medium" />
          </li>
        ))}
      </ul>
    </section>
  );
}
