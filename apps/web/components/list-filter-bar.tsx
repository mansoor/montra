'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountDto, CategoryDto, WorkspaceDto } from '@montra/api-client';
import { isCalendarDate, type CalendarDate } from '@montra/domain';
import {
  activeChips,
  amountBound,
  clearFilters,
  hasFilters,
  isAmountText,
  listFiltersToParams,
  parseListFilters,
  RANGE_PRESETS,
  readStoredRange,
  storeRange,
  widen,
  withoutChip,
  type ChipKey,
  type ListFilters,
  type ListScreen,
  type Range,
} from '@/lib/list-filters';
import { groupCategories } from '@/lib/view-models';
import { useI18n } from './i18n';

const RANGE_LABEL: Record<Range, string> = {
  '7d': 'filters.range.7d',
  '30d': 'filters.range.30d',
  '60d': 'filters.range.60d',
  '90d': 'filters.range.90d',
  '6m': 'filters.range.6m',
  '1y': 'filters.range.1y',
  all: 'filters.range.all',
  custom: 'filters.range.custom',
};

const SHOWING: Record<Range, string> = {
  '7d': 'filters.showing.7d',
  '30d': 'filters.showing.30d',
  '60d': 'filters.showing.60d',
  '90d': 'filters.showing.90d',
  '6m': 'filters.showing.6m',
  '1y': 'filters.showing.1y',
  all: 'filters.showing.all',
  custom: 'filters.showing.custom',
};

const NO_MATCH: Record<ListScreen, string> = {
  transactions: 'filters.no_match.transactions',
  review: 'filters.no_match.review',
  receipts: 'filters.no_match.receipts',
};

/** A typed value follows the URL, but stays as typed while it says the same thing (a trailing space, say). */
const sync = (url: string | undefined) => (cur: string) => (cur.trim() === (url ?? '') ? cur : (url ?? ''));

/** Text filters wait for a pause in typing before they change the list. */
const DEBOUNCE_MS = 400;

/** The filters in the URL, and a way to change them (a new history entry, so Back undoes it). */
function useListFilters(screen: ListScreen, restore = false) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const key = sp.toString();
  const { filters, explicit } = useMemo(() => parseListFilters(new URLSearchParams(key)), [key]);
  const go = useCallback(
    (next: ListFilters, mode: 'push' | 'replace' = 'push') => {
      const q = listFiltersToParams(next, new URLSearchParams(key)).toString();
      router[mode](`${pathname}?${q}`, { scroll: false });
    },
    [key, pathname, router],
  );
  // A link that names no window opens on the one this person chose last time.
  useEffect(() => {
    if (!restore || explicit) return;
    const stored = readStoredRange(screen);
    if (stored && stored !== filters.range) go({ ...filters, range: stored }, 'replace');
  }, [restore, explicit, filters, go, screen]);
  return { filters, go };
}

/**
 * One filter bar for the Transactions, Review and Receipts lists: a date window (presets or a custom range), merchant
 * words, an amount range, money in or out, and on Transactions an account and a category. Active filters show as chips
 * that remove one at a time, or all at once.
 */
export function ListFilterBar({
  screen,
  workspace,
  merchantHint,
  showDirection = false,
  accounts,
  categories,
}: {
  screen: ListScreen;
  workspace: WorkspaceDto;
  /** What else the merchant words match, such as the payee and description. */
  merchantHint?: string;
  showDirection?: boolean;
  accounts?: AccountDto[];
  categories?: CategoryDto[];
}) {
  const { t, money, date, locale } = useI18n();
  const { filters, go } = useListFilters(screen, true);
  const currency = workspace.baseCurrency;
  const [merchant, setMerchant] = useState(filters.merchant ?? '');
  const [min, setMin] = useState(filters.min ?? '');
  const [max, setMax] = useState(filters.max ?? '');

  // The URL wins when it changes from outside (a chip removed, Back pressed).
  useEffect(() => setMerchant(sync(filters.merchant)), [filters.merchant]);
  useEffect(() => setMin(sync(filters.min)), [filters.min]);
  useEffect(() => setMax(sync(filters.max)), [filters.max]);

  const valid = (v: string) => !v.trim() || isAmountText(v, currency, locale);
  const minOk = valid(min);
  const maxOk = valid(max);

  useEffect(() => {
    const m = merchant.trim();
    const lo = min.trim();
    const hi = max.trim();
    if (m === (filters.merchant ?? '') && lo === (filters.min ?? '') && hi === (filters.max ?? '')) return;
    if (!minOk || !maxOk) return;
    const timer = setTimeout(
      () => go({ ...filters, merchant: m || undefined, min: lo || undefined, max: hi || undefined }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [merchant, min, max, minOk, maxOk, filters, go]);

  const setRange = (range: Range) => {
    if (range === 'custom') return go({ ...filters, range });
    storeRange(screen, range);
    go({ ...filters, range, from: undefined, to: undefined });
  };
  const setDate = (k: 'from' | 'to', v: string) =>
    go({ ...filters, range: 'custom', [k]: isCalendarDate(v) ? (v as CalendarDate) : undefined });

  const accountName = accounts?.find((a) => a.id === filters.account)?.name ?? '';
  const categoryName = categories?.find((c) => c.id === filters.category)?.name ?? '';
  const amount = (v: string | undefined) => {
    const minor = amountBound(v, currency, locale);
    return minor ? money(minor, currency) : '';
  };
  const chipLabel = (chip: ChipKey): string => {
    switch (chip) {
      case 'dates':
        return filters.from && filters.to
          ? t('filters.chip.dates_between', { from: date(filters.from), to: date(filters.to) })
          : filters.from
            ? t('filters.chip.dates_from', { from: date(filters.from) })
            : t('filters.chip.dates_until', { to: date(filters.to ?? '') });
      case 'merchant':
        return t('filters.chip.merchant', { value: filters.merchant ?? '' });
      case 'amount':
        return filters.min && filters.max
          ? t('filters.chip.amount_between', { min: amount(filters.min), max: amount(filters.max) })
          : filters.min
            ? t('filters.chip.amount_min', { min: amount(filters.min) })
            : t('filters.chip.amount_max', { max: amount(filters.max) });
      case 'dir':
        return filters.dir === 'in' ? t('filters.direction.in') : t('filters.direction.out');
      case 'account':
        return t('filters.chip.account', { value: accountName });
      case 'category':
        return t('filters.chip.category', { value: categoryName });
    }
  };
  const chips = activeChips(filters);

  return (
    <div className="space-y-2" data-testid="list-filters">
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('filters.label')}
        onSubmit={(e) => e.preventDefault()}
      >
        <label>
          <span className="field-label">{t('filters.period')}</span>
          <select
            className="input"
            value={filters.range}
            onChange={(e) => setRange(e.target.value as Range)}
            data-testid="filter-range"
          >
            {[...RANGE_PRESETS, 'custom' as const].map((r) => (
              <option key={r} value={r}>
                {t(RANGE_LABEL[r])}
              </option>
            ))}
          </select>
        </label>
        {filters.range === 'custom' && (
          <>
            <label>
              <span className="field-label">{t('filters.since')}</span>
              <input
                className="input"
                type="date"
                value={filters.from ?? ''}
                max={filters.to}
                onChange={(e) => setDate('from', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('filters.until')}</span>
              <input
                className="input"
                type="date"
                value={filters.to ?? ''}
                min={filters.from}
                onChange={(e) => setDate('to', e.target.value)}
              />
            </label>
          </>
        )}
        <label>
          <span className="field-label">{t('filters.merchant')}</span>
          <input
            className="input w-48"
            type="search"
            maxLength={100}
            placeholder={merchantHint}
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('filters.at_least')}</span>
          <input
            className="input w-28"
            inputMode="decimal"
            value={min}
            aria-invalid={!minOk || undefined}
            aria-describedby={!minOk ? `${screen}-amount-error` : undefined}
            onChange={(e) => setMin(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('filters.at_most')}</span>
          <input
            className="input w-28"
            inputMode="decimal"
            value={max}
            aria-invalid={!maxOk || undefined}
            aria-describedby={!maxOk ? `${screen}-amount-error` : undefined}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
        {showDirection && (
          <label>
            <span className="field-label">{t('filters.in_or_out')}</span>
            <select
              className="input"
              value={filters.dir ?? ''}
              onChange={(e) => go({ ...filters, dir: (e.target.value || undefined) as ListFilters['dir'] })}
            >
              <option value="">{t('filters.direction.any')}</option>
              <option value="out">{t('filters.direction.out')}</option>
              <option value="in">{t('filters.direction.in')}</option>
            </select>
          </label>
        )}
        {accounts && (
          <label>
            <span className="field-label">{t('filters.account')}</span>
            <select
              className="input"
              value={filters.account ?? ''}
              onChange={(e) => go({ ...filters, account: e.target.value || undefined })}
            >
              <option value="">{t('filters.all_accounts')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {categories && (
          <label>
            <span className="field-label">{t('filters.category')}</span>
            <select
              className="input"
              value={filters.category ?? ''}
              onChange={(e) => go({ ...filters, category: e.target.value || undefined })}
            >
              <option value="">{t('filters.all_categories')}</option>
              {groupCategories(workspace, categories).map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </form>
      {(!minOk || !maxOk) && (
        <p id={`${screen}-amount-error`} className="field-error">
          {t('filters.amount_invalid')}
        </p>
      )}
      {chips.length > 0 && (
        <ul className="flex flex-wrap items-center gap-2" aria-label={t('filters.active')}>
          {chips.map((chip) => {
            const label = chipLabel(chip);
            return (
              <li key={chip} className="chip chip-muted gap-1" data-testid="filter-chip">
                {label}
                <button
                  type="button"
                  className="ml-1 rounded-full px-1 leading-none"
                  aria-label={t('filters.remove', { label })}
                  onClick={() => go(withoutChip(filters, chip))}
                >
                  ×
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className="text-sm font-medium text-brand-600 underline"
              onClick={() => go(clearFilters(filters))}
            >
              {t('filters.clear_all')}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * Under the list: which window it shows, and one step older ("Showing the last 90 days. Show older"). `note` adds a
 * line, such as how many items the window leaves out.
 */
export function ListWindowFooter({ screen, note }: { screen: ListScreen; note?: string }) {
  const { t } = useI18n();
  const { filters, go } = useListFilters(screen);
  const wider = widen(filters);
  if (!wider && !note) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted" data-testid="list-window">
      <span>{t(SHOWING[filters.range])}</span>
      {note && <span>{note}</span>}
      {wider && (
        <button type="button" className="font-medium text-brand-600 underline" onClick={() => go(wider)}>
          {t('filters.show_older')}
        </button>
      )}
    </p>
  );
}

/** When filters hide everything: say so, with a way back. Without filters, the usual empty text. */
export function ListEmpty({ screen, fallback }: { screen: ListScreen; fallback: string }) {
  const { t } = useI18n();
  const { filters, go } = useListFilters(screen);
  if (!hasFilters(filters)) return <p className="card text-sm text-muted">{fallback}</p>;
  return (
    <div
      className="card flex flex-wrap items-center justify-between gap-2 text-sm"
      data-testid="list-no-match"
    >
      <p className="font-medium">{t(NO_MATCH[screen])}</p>
      <button type="button" className="btn-secondary" onClick={() => go(clearFilters(filters))}>
        {t('filters.clear')}
      </button>
    </div>
  );
}
