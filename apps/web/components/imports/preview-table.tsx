'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { CategoryDto, ImportBatchDto, ImportRowDto, ImportRowStatus } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { rowDisplay } from '@/lib/imports';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';

const ROW_HEIGHT = 64;
const VIEWPORT = 448;
const OVERSCAN = 6;
const PAGE = 200;

const FILTERS: { status: ImportRowStatus | null; label: string; count: keyof ImportBatchDto['counts'] }[] = [
  { status: null, label: 'imports.filter.all', count: 'read' },
  { status: 'new', label: 'imports.row_status.new', count: 'new' },
  { status: 'match', label: 'imports.row_status.match', count: 'match' },
  {
    status: 'probable_duplicate',
    label: 'imports.row_status.probable_duplicate',
    count: 'probableDuplicate',
  },
  { status: 'duplicate', label: 'imports.row_status.duplicate', count: 'duplicate' },
  { status: 'error', label: 'imports.row_status.error', count: 'error' },
];

/**
 * Import preview (IMP-06): every parsed row with its status and what commit will do, virtualized for long
 * statements. Rows can be skipped or imported and given a category (defaulting to the suggestion).
 */
export function PreviewTable({
  workspaceId,
  batch,
  categories,
  onBulkDone,
  onEditMapping,
}: {
  workspaceId: string;
  batch: ImportBatchDto;
  categories: CategoryDto[];
  onBulkDone: () => void;
  onEditMapping?: () => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<ImportRowStatus | null>(null);
  const [rows, setRows] = useState<ImportRowDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const base = `/w/${workspaceId}`;

  const fetchPage = useCallback(
    async (status: ImportRowStatus | null, after: string | null) => {
      setLoading(true);
      try {
        const page = await browserApi.listImportRows(workspaceId, batch.id, {
          status: status ?? undefined,
          cursor: after ?? undefined,
          limit: PAGE,
        });
        setRows((prev) => (after ? [...prev, ...page.data] : page.data));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(friendlyMessage(err, t));
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, batch.id, t],
  );

  useEffect(() => {
    setScrollTop(0);
    void fetchPage(filter, null);
  }, [filter, fetchPage]);

  async function patch(row: ImportRowDto, input: Parameters<typeof browserApi.updateImportRow>[3]) {
    setError(null);
    try {
      const next = await browserApi.updateImportRow(workspaceId, batch.id, row.id, input);
      setRows((list) => list.map((r) => (r.id === next.id ? next : r)));
    } catch (err) {
      setError(friendlyMessage(err, t));
    }
  }

  async function skipProbableDuplicates() {
    setBulkBusy(true);
    setError(null);
    try {
      let after: string | null = null;
      do {
        const page = await browserApi.listImportRows(workspaceId, batch.id, {
          status: 'probable_duplicate',
          cursor: after ?? undefined,
          limit: PAGE,
        });
        for (const r of page.data)
          if (r.effective !== 'skip')
            await browserApi.updateImportRow(workspaceId, batch.id, r.id, { decision: 'skip' });
        after = page.nextCursor;
      } while (after);
      onBulkDone();
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBulkBusy(false);
    }
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + VIEWPORT) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);
  const byGroup = new Map<string, CategoryDto[]>();
  for (const c of categories) {
    const group = c.group ?? t(`account.type_plural.${c.type}`);
    byGroup.set(group, [...(byGroup.get(group) ?? []), c]);
  }

  return (
    <div className="card space-y-3 p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <div role="group" aria-label={t('imports.filter.label')} className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              aria-pressed={filter === f.status}
              onClick={() => setFilter(f.status)}
              className={`rounded-md border px-2 py-1 text-sm ${filter === f.status ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface hover:bg-brand-50'}`}
            >
              {t(f.label)} <span className="num">({batch.counts[f.count]})</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {batch.counts.probableDuplicate > 0 && (
            <button
              type="button"
              className="btn-secondary"
              disabled={bulkBusy}
              onClick={skipProbableDuplicates}
            >
              {t('imports.preview.skip_probable')}
            </button>
          )}
          {onEditMapping && (
            <button type="button" className="btn-secondary" onClick={onEditMapping}>
              {t('imports.preview.edit_mapping')}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="px-4 text-sm text-bad">
          {error}
        </p>
      )}

      <div
        role="table"
        aria-label={t('imports.preview.title')}
        aria-rowcount={rows.length + 1}
        className="text-sm"
      >
        <div role="rowgroup">
          <div
            role="row"
            className="grid grid-cols-[6rem_minmax(0,1fr)_7rem_9rem_12rem_6rem] gap-2 border-y border-line px-4 py-2 text-xs uppercase tracking-wide text-muted"
          >
            <span role="columnheader">{t('fields.date')}</span>
            <span role="columnheader">{t('fields.description')}</span>
            <span role="columnheader" className="text-right">
              {t('fields.amount')}
            </span>
            <span role="columnheader">{t('imports.preview.status')}</span>
            <span role="columnheader">{t('fields.category')}</span>
            <span role="columnheader">
              <span className="sr-only">{t('imports.preview.decision')}</span>
            </span>
          </div>
        </div>
        <div
          role="rowgroup"
          className="relative overflow-y-auto"
          style={{ height: Math.min(VIEWPORT, Math.max(rows.length, 1) * ROW_HEIGHT) }}
          onScroll={(e) => {
            const el = e.currentTarget;
            setScrollTop(el.scrollTop);
            if (cursor && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - ROW_HEIGHT * 10)
              void fetchPage(filter, cursor);
          }}
        >
          <div style={{ height: rows.length * ROW_HEIGHT }} />
          {visible.map((row, i) => {
            const d = rowDisplay(row);
            const index = first + i;
            const categoryValue = row.categoryId ?? row.suggestion?.categoryId ?? '';
            return (
              <div
                key={row.id}
                role="row"
                aria-rowindex={index + 2}
                data-testid="preview-row"
                data-effective={row.effective}
                className={`absolute inset-x-0 grid grid-cols-[6rem_minmax(0,1fr)_7rem_9rem_12rem_6rem] items-center gap-2 border-b border-line px-4 ${row.effective === 'skip' ? 'text-muted' : ''}`}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
              >
                <span role="cell" className="whitespace-nowrap">
                  {row.date ? <DateText date={row.date} /> : '—'}
                </span>
                <span role="cell" className="min-w-0">
                  <span className="block truncate">{row.payee || row.description || '—'}</span>
                  {d.errorKey && <span className="block text-xs text-bad">{t(d.errorKey)}</span>}
                  {!d.errorKey && row.payee && row.description && (
                    <span className="block truncate text-xs text-muted">{row.description}</span>
                  )}
                </span>
                <span role="cell" className="text-right">
                  {row.amount ? (
                    <Money amount={row.amount.amount} currency={row.amount.currency} signed />
                  ) : (
                    '—'
                  )}
                </span>
                <span role="cell" className="space-y-0.5">
                  <span className={`chip chip-${d.statusTone}`}>{t(d.statusKey)}</span>
                  <span className="block text-xs text-muted" data-testid="row-effective">
                    {t(d.effectiveKey)}
                    {d.linkedTransactionId && (
                      <>
                        {' · '}
                        <Link className="underline" href={`${base}/transactions/${d.linkedTransactionId}`}>
                          {t('imports.preview.view_existing')}
                        </Link>
                      </>
                    )}
                  </span>
                </span>
                <span role="cell" className="min-w-0">
                  {row.effective === 'import' && (
                    <>
                      <select
                        aria-label={t('imports.preview.category_for', { row: row.rowNo })}
                        className="input py-1"
                        value={categoryValue}
                        onChange={(e) => void patch(row, { categoryId: e.target.value || null })}
                      >
                        <option value="">{t('imports.preview.uncategorized')}</option>
                        {[...byGroup].map(([group, list]) => (
                          <optgroup key={group} label={group}>
                            {list.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      {row.suggestion && !row.categoryId && row.suggestion.categoryId && (
                        <span
                          className="block truncate text-xs text-muted"
                          title={row.suggestion.explanation}
                        >
                          {row.suggestion.explanation}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <span role="cell" className="text-right">
                  {d.toggle && (
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1"
                      aria-label={`${t(d.toggle.labelKey)} ${t('imports.preview.row_n', { row: row.rowNo })}`}
                      onClick={() => void patch(row, { decision: d.toggle!.decision })}
                    >
                      {t(d.toggle.labelKey)}
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          {rows.length === 0 && !loading && (
            <p className="absolute inset-x-0 top-0 px-4 py-4 text-muted">{t('imports.preview.empty')}</p>
          )}
        </div>
      </div>
      {loading && (
        <p role="status" className="px-4 pb-3 text-xs text-muted">
          {t('common.loading')}
        </p>
      )}
    </div>
  );
}
