'use client';

import { useState } from 'react';
import type { RuleSuggestionDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { useI18n } from '../i18n';

/**
 * Offer to turn repeated corrections into a rule (AI-05): accept, accept and apply to existing transactions,
 * or dismiss. `onDone` receives a short status line.
 */
export function RuleOffer({
  workspaceId,
  suggestion,
  categoryName,
  onDone,
}: {
  workspaceId: string;
  suggestion: RuleSuggestionDto;
  categoryName: (id: string) => string | null;
  onDone: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target =
    typeof suggestion.actions.categoryId === 'string' ? categoryName(suggestion.actions.categoryId) : null;

  async function run(fn: () => Promise<unknown>, message: string | null) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone(message);
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="region"
      aria-label={t('rules.suggestion.label')}
      className="rounded-md border border-brand-600/40 bg-brand-50 px-3 py-2 text-sm"
      data-testid="rule-offer"
    >
      <p>
        {target
          ? t('rules.suggestion.text', {
              payee: suggestion.name,
              category: target,
              count: suggestion.evidence,
            })
          : t('rules.suggestion.text_generic', { payee: suggestion.name, count: suggestion.evidence })}{' '}
        {suggestion.existingMatches > 0 && (
          <span className="text-muted">
            {t('rules.suggestion.existing', { count: suggestion.existingMatches })}
          </span>
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() =>
            run(
              () => browserApi.acceptRuleSuggestion(workspaceId, suggestion.id, { applyToExisting: false }),
              t('rules.suggestion.created'),
            )
          }
        >
          {t('rules.suggestion.accept')}
        </button>
        {suggestion.existingMatches > 0 && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              run(
                () => browserApi.acceptRuleSuggestion(workspaceId, suggestion.id, { applyToExisting: true }),
                t('rules.suggestion.created_applying'),
              )
            }
          >
            {t('rules.suggestion.accept_apply')}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => run(() => browserApi.dismissRuleSuggestion(workspaceId, suggestion.id), null)}
        >
          {t('rules.suggestion.dismiss')}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
