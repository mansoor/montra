'use client';

import { useState } from 'react';
import type { BusinessProfileDto, TaxLineDto, TaxLineSuggestionDto } from '@montra/api-client';
import { bpsToPercent, percentToBps } from '@/lib/business';
import { browserApi } from '@/lib/browser-api';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/** BIZ-09: the user's own effective rate. A tax estimate is only as good as this number, so it's theirs to set. */
export function TaxRateForm({ workspaceId, profile }: { workspaceId: string; profile: BusinessProfileDto }) {
  const { run, busy, message, setMessage, t } = useAction();
  const [rate, setRate] = useState(
    profile.taxRateBps !== null ? bpsToPercent(profile.taxRateBps) || '0' : '',
  );
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const bps = rate.trim() ? percentToBps(rate) : null;
        if (rate.trim() && bps === null) return setMessage({ tone: 'bad', text: t('taxes.rate_invalid') });
        void run(
          () => browserApi.updateBusiness(workspaceId, profile.entityId, { taxRateBps: bps }),
          t('taxes.rate_saved'),
        );
      }}
    >
      <label>
        <span className="field-label">{t('taxes.rate')}</span>
        <input
          className="input w-28"
          inputMode="decimal"
          value={rate}
          placeholder="25"
          onChange={(e) => setRate(e.target.value)}
        />
      </label>
      <button type="submit" className="btn-secondary" disabled={busy}>
        {t('taxes.save_rate')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

/**
 * AI-10: spending in categories with no tax line isn't on the form until it's mapped. The user picks a line, or asks AI to
 * propose them; a proposal does nothing until it's accepted.
 */
export function UnmappedCategories({
  workspaceId,
  entityId,
  currency,
  unmapped,
  lines,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  unmapped: { categoryId: string; name: string; amount: string }[];
  lines: TaxLineDto[];
}) {
  const { run, busy, message, t } = useAction();
  const [suggestions, setSuggestions] = useState<Map<string, TaxLineSuggestionDto>>(new Map());
  const [asked, setAsked] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});

  return (
    <section className="card space-y-3" aria-labelledby="unmapped">
      <h2 id="unmapped" className="text-base font-semibold">
        {t('taxes.unmapped_title')}
      </h2>
      <p className="text-sm text-muted">{t('taxes.unmapped_hint')}</p>
      <ul className="divide-y divide-line">
        {unmapped.map((u) => {
          const s = suggestions.get(u.categoryId);
          const value = chosen[u.categoryId] ?? s?.code ?? '';
          return (
            <li key={u.categoryId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {u.name} · <Money amount={u.amount} currency={currency} />
                </p>
                {s && <p className="text-xs text-muted">{s.explanation}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-64"
                  aria-label={t('taxes.line_for', { name: u.name })}
                  value={value}
                  onChange={(e) => setChosen((c) => ({ ...c, [u.categoryId]: e.target.value }))}
                >
                  <option value="">{t('taxes.choose_line')}</option>
                  {lines.map((l) => (
                    <option key={l.code} value={l.code}>
                      {t('taxes.line_option', { line: l.line, label: l.label })}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || !value}
                  onClick={() =>
                    run(
                      () => browserApi.setTaxLine(workspaceId, u.categoryId, value),
                      t('taxes.mapped', { name: u.name }),
                    )
                  }
                >
                  {t('taxes.map')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const res = await browserApi.suggestTaxLines(workspaceId, entityId);
            setSuggestions(new Map(res.map((s) => [s.categoryId, s])));
            setAsked(true);
            return res;
          })
        }
      >
        {t('taxes.suggest')}
      </button>
      {asked && suggestions.size === 0 && <p className="text-sm text-muted">{t('taxes.no_suggestions')}</p>}
      <StatusLine message={message} />
    </section>
  );
}
