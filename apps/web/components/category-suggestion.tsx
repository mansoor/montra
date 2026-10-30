'use client';

import { useEffect, useState } from 'react';
import type { SuggestionDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { percent } from '@/lib/review';
import { useI18n } from './i18n';

const DELAY_MS = 400;

/**
 * Category suggestion for the transaction editor (AI-01/06): once payee, amount and account are filled and no
 * category is chosen, asks the pipeline and offers its pick with the one-line reason.
 */
export function CategorySuggestion({
  workspaceId,
  payee,
  amountMinor,
  currency,
  accountId,
  date,
  categoryName,
  onApply,
}: {
  workspaceId: string;
  payee: string;
  /** Signed minor units, or null while the amount is not a valid number. */
  amountMinor: bigint | null;
  currency: string;
  accountId: string;
  date: string;
  categoryName: (id: string) => string | null;
  onApply: (s: SuggestionDto) => void;
}) {
  const { t } = useI18n();
  const [suggestion, setSuggestion] = useState<SuggestionDto | null>(null);
  const ready = payee.trim().length > 0 && amountMinor !== null && amountMinor !== 0n && accountId !== '';
  const key = ready ? `${payee.trim()}|${amountMinor}|${currency}|${accountId}|${date}` : '';

  useEffect(() => {
    setSuggestion(null);
    if (!key) return;
    let alive = true;
    const timer = setTimeout(() => {
      browserApi
        .suggestCategory(workspaceId, {
          payee: payee.trim(),
          amount: { amount: amountMinor!.toString(), currency },
          accountId,
          date,
        })
        .then(
          (s) => alive && setSuggestion(s.categoryId ? s : null),
          () => undefined,
        );
    }, DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, workspaceId]); // the key captures every input

  if (!suggestion?.categoryId) return null;
  const name = categoryName(suggestion.categoryId);
  if (!name) return null;
  return (
    <p
      className="mt-1 flex flex-wrap items-center gap-2 text-xs"
      role="status"
      data-testid="category-suggestion"
    >
      <span>
        {t('editor.suggested', { category: name, percent: percent(suggestion.confidence) })}
        <span className="block text-muted">{suggestion.explanation}</span>
      </span>
      <button type="button" className="btn-secondary px-2 py-1" onClick={() => onApply(suggestion)}>
        {t('editor.apply_suggestion')}
      </button>
    </p>
  );
}
