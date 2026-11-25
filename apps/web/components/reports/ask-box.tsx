'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { accountProfile } from '@montra/domain';
import type { AskAccountDto, AskAnswerDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { drillHref } from '@/lib/planning';
import { barPercent } from '@/lib/reports';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';

/**
 * Ask-your-data (RPT-06). AI turns the words into a plan; every number comes from a query on the books, and each links to the
 * transactions behind it, so an answer can always be checked. A question about one account (ADR-0058) is answered with the
 * account page's own figures and a link to it; when several accounts fit, each is a button that asks again about that one.
 */
export function AskBox({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AskAnswerDto | null>(null);
  const base = `/w/${workspaceId}`;

  const ask = async (text: string, accountId?: string) => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await browserApi.ask(workspaceId, { question: text, ...(accountId ? { accountId } : {}) }));
    } catch (err) {
      setAnswer(null);
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  };
  const largest = answer
    ? answer.periods.reduce((m, p) => (BigInt(p.amount) > m ? BigInt(p.amount) : m), 0n)
    : 0n;

  return (
    <div className="space-y-5">
      <form
        className="card space-y-3"
        aria-label={t('ask.title')}
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim().length >= 3) void ask(question.trim());
        }}
      >
        <label className="block">
          <span className="field-label">{t('ask.question')}</span>
          <input
            className="input"
            maxLength={500}
            value={question}
            placeholder={t('ask.example')}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy || question.trim().length < 3}>
          {busy ? t('ask.thinking') : t('ask.submit')}
        </button>
        <p className="text-xs text-muted">{t('ask.privacy')}</p>
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
      </form>

      {answer && !answer.understood && (
        <p className="card text-sm" role="status" data-testid="ask-unknown">
          {t('ask.not_understood')}
        </p>
      )}
      {answer?.understood && answer.kind === 'account' && answer.account && (
        <AccountAnswer
          base={base}
          answer={answer.account}
          busy={busy}
          onPick={(accountId) => void ask(answer.question, accountId)}
        />
      )}
      {answer?.understood && answer.kind !== 'account' && (
        <section className="card space-y-3" aria-label={t('ask.answer')} data-testid="ask-answer">
          <p className="text-sm text-muted">
            {t(`ask.metric_${answer.metric}`)}
            {answer.categories.length > 0 && ` · ${answer.categories.join(', ')}`}
            {answer.payee && ` · ${answer.payee}`}
          </p>
          <ul className="space-y-2">
            {answer.periods.map((p) => (
              <li key={`${p.label}-${p.from}`} data-testid="ask-period">
                <div className="flex items-baseline justify-between gap-2">
                  <Link className="text-sm underline" href={drillHref(base, p.drill)}>
                    {p.label}
                  </Link>
                  <span className="font-display text-xl font-semibold">
                    <Money amount={p.amount} currency={answer.currency!} />
                  </span>
                </div>
                {answer.periods.length > 1 && (
                  <div className="mt-1 h-2 rounded bg-sunken" aria-hidden>
                    <div
                      className="h-2 rounded bg-brand-600"
                      style={{ width: `${barPercent(BigInt(p.amount), largest)}%` }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {answer.transactions.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm underline">
                {t('ask.behind_it', { count: answer.transactions.length })}
              </summary>
              <ul className="mt-2 divide-y divide-line">
                {answer.transactions.map((x) => (
                  <li key={x.id} className="flex justify-between gap-2 py-1 text-sm">
                    <Link className="underline" href={`${base}/transactions/${x.id}`}>
                      <DateText date={x.date} /> · {x.payee || x.description}
                    </Link>
                    {x.amount && x.currency && <Money amount={x.amount} currency={x.currency} />}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

/** One account's answer (ADR-0058): a sentence, the figures, and a link to the account's page. */
export function AccountAnswer({
  base,
  answer: a,
  busy = false,
  onPick,
}: {
  base: string;
  answer: AskAccountDto;
  busy?: boolean;
  onPick: (accountId: string) => void;
}) {
  const { t, date } = useI18n();
  if (a.outcome === 'choose') {
    return (
      <section className="card space-y-3" aria-label={t('ask.answer')} data-testid="ask-account-choose">
        <p className="text-sm">{t('ask.account_choose', { phrase: a.phrase })}</p>
        <div className="flex flex-wrap gap-2">
          {a.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => onPick(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      </section>
    );
  }
  const { account, currency: ccy } = a;
  if (a.outcome === 'no_match' || !account || !ccy) {
    return (
      <p className="card text-sm" role="status" data-testid="ask-account-none">
        {t('ask.account_no_match', { phrase: a.phrase })}
      </p>
    );
  }
  const name = account.name;
  const money = (amount: string) => <Money amount={amount} currency={ccy} />;
  const balance: [string, string, ReactNode] | null =
    a.balance === null
      ? null
      : ['balance', t(`account.balance_word.${accountProfile(account.kind).balanceWord}`), money(a.balance)];

  let sentence: string | null = null;
  const figures: [string, string, ReactNode][] = [];
  let note: string | null = null;
  if (a.outcome === 'paid_off') {
    sentence = t('ask.account_paid_off', { name });
  } else if (a.outcome === 'needs_tracking' || a.outcome === 'not_applicable') {
    sentence =
      a.outcome === 'needs_tracking'
        ? t('ask.account_needs_tracking', { name })
        : t('ask.account_not_applicable', { name });
    if (balance) figures.push(balance);
  } else if (a.topic === 'payoff' && a.payoffDate) {
    sentence = t('ask.account_payoff', { name, date: date(a.payoffDate) });
    if (a.paymentsLeft !== null) {
      figures.push(['left', t('ask.account_payments_left', { count: a.paymentsLeft }), null]);
    }
    if (balance) figures.push(balance);
    if (a.interestRemaining !== null) {
      figures.push(['interest-left', t('account.loan.interest_left'), money(a.interestRemaining)]);
    }
  } else if (a.topic === 'next_payment' && a.next) {
    sentence = t('ask.account_next', { name, date: date(a.next.date) });
    figures.push(['total', t('ask.account_next_total'), money(a.next.total)]);
    figures.push(['principal', t('account.loan.principal'), money(a.next.principal)]);
    figures.push(['interest', t('account.loan.interest'), money(a.next.interest)]);
    if (BigInt(a.next.escrow) > 0n) figures.push(['escrow', t('account.loan.escrow'), money(a.next.escrow)]);
  } else if (a.topic === 'interest_paid' && a.interestPaid !== null) {
    if (a.interestPeriods.length > 0) {
      sentence = t('ask.account_interest_paid_in', { name });
      for (const p of a.interestPeriods) figures.push([`period-${p.from}`, p.label, money(p.amount)]);
    } else {
      sentence = t('ask.account_interest_paid', { name });
      figures.push(['interest-paid', t('account.loan.interest'), money(a.interestPaid)]);
      if (a.paymentsBefore) note = t('ask.account_interest_before', { count: a.paymentsBefore });
    }
  } else if (balance) {
    figures.push(balance);
  }

  return (
    <section className="card space-y-3" aria-label={t('ask.answer')} data-testid="ask-account">
      {sentence ? (
        <p className="font-medium" data-testid="ask-account-sentence">
          {sentence}
        </p>
      ) : (
        <p className="text-sm text-muted">{name}</p>
      )}
      {figures.length > 0 && (
        <dl className="space-y-2">
          {figures.map(([key, label, value]) => (
            <div
              key={key}
              className="flex items-baseline justify-between gap-2"
              data-testid={`ask-account-${key}`}
            >
              <dt className={value === null ? 'font-medium' : 'text-sm text-muted'}>{label}</dt>
              {value !== null && <dd className="font-display text-xl font-semibold">{value}</dd>}
            </div>
          ))}
        </dl>
      )}
      {note && <p className="text-xs text-muted">{note}</p>}
      <Link
        className="text-sm underline"
        href={`${base}/accounts/${account.id}`}
        data-testid="ask-account-link"
      >
        {t('ask.account_open', { name })}
      </Link>
    </section>
  );
}
