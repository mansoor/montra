'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AskAnswerDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { drillHref } from '@/lib/planning';
import { barPercent } from '@/lib/reports';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';

/**
 * Ask-your-data (RPT-06). AI turns the words into a plan; every number comes from a query on the books, and each links to the
 * transactions behind it, so an answer can always be checked.
 */
export function AskBox({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AskAnswerDto | null>(null);
  const base = `/w/${workspaceId}`;

  const ask = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await browserApi.ask(workspaceId, { question: text }));
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
      {answer?.understood && (
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
