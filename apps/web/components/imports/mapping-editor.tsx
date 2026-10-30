'use client';

import { useState } from 'react';
import type { ImportBatchDto, UpdateMappingInput } from '@montra/api-client';
import {
  applyRole,
  COLUMN_ROLES,
  DATE_FORMATS,
  draftFromMapping,
  draftToMapping,
  mappingErrors,
  previewMapping,
  type MappingDraft,
} from '@/lib/imports';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';

const SAMPLE_ROWS_SHOWN = 12;

/**
 * Column mapping (IMP-03/04): a role per column over the file's first rows, date and number formats, the
 * sign convention, header and data rows, and (for multi-account exports) which account to import. A live
 * preview shows how the first five rows will read before the API re-parses the whole file.
 */
export function MappingEditor({
  batch,
  busy,
  onSave,
  onCancel,
}: {
  batch: ImportBatchDto;
  busy: boolean;
  onSave: (input: UpdateMappingInput) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const analysis = batch.analysis!;
  const sample = analysis.sample;
  const columns = Math.max(1, ...sample.map((r) => r.length));
  const [draft, setDraft] = useState<MappingDraft>(() => draftFromMapping(batch.mapping, columns));
  const [saveProfile, setSaveProfile] = useState(true);
  const accountColumn = analysis.accountColumn ?? batch.mapping?.filter?.column;
  const [account, setAccount] = useState(batch.mapping?.filter?.values[0] ?? '');

  const errors = mappingErrors(draft);
  const withFilter = (d: MappingDraft): MappingDraft => {
    if (analysis.accounts.length <= 1 || accountColumn === undefined) return d;
    const rest = { ...d.rest };
    if (account) rest.filter = { column: accountColumn, values: [account] };
    else delete rest.filter;
    return { ...d, rest };
  };
  const mapping = errors.length === 0 ? draftToMapping(withFilter(draft)) : null;
  // At most 25 sample rows: cheap enough to recompute on every render.
  const preview = mapping ? previewMapping(sample, mapping, batch.currency) : [];
  const header = (col: number) =>
    draft.headerRow !== null
      ? sample[draft.headerRow]?.[col] || t('imports.mapping.column', { n: col + 1 })
      : t('imports.mapping.column', { n: col + 1 });
  const rowOptions = sample.slice(0, SAMPLE_ROWS_SHOWN + 5).map((_, i) => i);

  return (
    <form
      className="card space-y-4"
      aria-labelledby="mapping-heading"
      onSubmit={(e) => {
        e.preventDefault();
        if (mapping) onSave({ mapping, saveProfile });
      }}
    >
      <div>
        <h2 id="mapping-heading" className="font-semibold">
          {t('imports.mapping.title')}
        </h2>
        <p className="text-sm text-muted">{t('imports.mapping.intro')}</p>
      </div>

      <div className="overflow-x-auto rounded-md border border-line">
        <table className="text-sm" data-testid="mapping-sample">
          <caption className="sr-only">{t('imports.mapping.sample')}</caption>
          <thead>
            <tr className="border-b border-line bg-canvas">
              <th scope="col" className="px-2 py-1 text-left text-xs text-muted">
                {t('imports.mapping.row')}
              </th>
              {Array.from({ length: columns }, (_, col) => (
                <th key={col} scope="col" className="px-2 py-1 text-left align-bottom">
                  <label htmlFor={`role-${col}`} className="block truncate text-xs font-medium">
                    {header(col)}
                  </label>
                  <select
                    id={`role-${col}`}
                    className="input mt-1 w-36 py-1"
                    value={draft.roles[col] ?? 'ignore'}
                    onChange={(e) =>
                      setDraft((d) => applyRole(d, col, e.target.value as MappingDraft['roles'][number]))
                    }
                  >
                    {COLUMN_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`imports.role.${r}`)}
                      </option>
                    ))}
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.slice(0, SAMPLE_ROWS_SHOWN).map((r, i) => (
              <tr
                key={i}
                className={`border-b border-line last:border-0 ${i === draft.headerRow ? 'font-semibold' : ''} ${i < draft.dataStart && i !== draft.headerRow ? 'text-muted' : ''}`}
              >
                <th scope="row" className="px-2 py-1 text-left text-xs text-muted">
                  {i + 1}
                </th>
                {Array.from({ length: columns }, (_, col) => (
                  <td key={col} className="max-w-48 truncate whitespace-nowrap px-2 py-1">
                    {r[col] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label htmlFor="header-row" className="field-label">
            {t('imports.mapping.header_row')}
          </label>
          <select
            id="header-row"
            className="input"
            value={draft.headerRow ?? ''}
            onChange={(e) => {
              const headerRow = e.target.value === '' ? null : Number(e.target.value);
              setDraft((d) => ({
                ...d,
                headerRow,
                dataStart: headerRow !== null && d.dataStart <= headerRow ? headerRow + 1 : d.dataStart,
              }));
            }}
          >
            <option value="">{t('imports.mapping.no_header')}</option>
            {rowOptions.map((i) => (
              <option key={i} value={i}>
                {t('imports.mapping.row_n', { n: i + 1 })}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="data-start" className="field-label">
            {t('imports.mapping.data_start')}
          </label>
          <select
            id="data-start"
            className="input"
            value={draft.dataStart}
            onChange={(e) => setDraft((d) => ({ ...d, dataStart: Number(e.target.value) }))}
          >
            {rowOptions.map((i) => (
              <option key={i} value={i}>
                {t('imports.mapping.row_n', { n: i + 1 })}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="date-format" className="field-label">
            {t('imports.mapping.date_format')}
          </label>
          <select
            id="date-format"
            className="input"
            value={draft.dateFormat}
            onChange={(e) =>
              setDraft((d) => ({ ...d, dateFormat: e.target.value as MappingDraft['dateFormat'] }))
            }
          >
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="decimal" className="field-label">
            {t('imports.mapping.decimal')}
          </label>
          <select
            id="decimal"
            className="input"
            value={draft.decimal}
            onChange={(e) => setDraft((d) => ({ ...d, decimal: e.target.value as '.' | ',' }))}
          >
            <option value=".">{t('imports.mapping.decimal_dot')}</option>
            <option value=",">{t('imports.mapping.decimal_comma')}</option>
          </select>
        </div>
        {analysis.accounts.length > 1 && (
          <div>
            <label htmlFor="account-filter" className="field-label">
              {t('imports.mapping.account_filter')}
            </label>
            <select
              id="account-filter"
              className="input"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">{t('imports.mapping.all_accounts')}</option>
              {analysis.accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={draft.sign === 'inverted'}
            onChange={(e) => setDraft((d) => ({ ...d, sign: e.target.checked ? 'inverted' : 'normal' }))}
          />
          {t('imports.mapping.inverted')}
        </label>
      </div>

      {errors.length > 0 ? (
        <ul role="alert" className="space-y-1 text-sm text-bad">
          {errors.map((e) => (
            <li key={e}>{t(e)}</li>
          ))}
        </ul>
      ) : (
        <div>
          <h3 className="mb-1 text-sm font-semibold">{t('imports.mapping.preview')}</h3>
          <table className="w-full text-sm" data-testid="mapping-preview">
            <caption className="sr-only">{t('imports.mapping.preview')}</caption>
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="py-1 pr-3">
                  {t('fields.date')}
                </th>
                <th scope="col" className="py-1 pr-3">
                  {t('fields.description')}
                </th>
                <th scope="col" className="py-1 text-right">
                  {t('fields.amount')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {preview.map((p) => (
                <tr key={p.rowNo}>
                  <td className="whitespace-nowrap py-1 pr-3">{p.date ? <DateText date={p.date} /> : '—'}</td>
                  <td className="py-1 pr-3">{p.description || '—'}</td>
                  <td className="py-1 text-right">
                    {p.error ? (
                      <span className="text-bad">{t(`imports.row_error.${p.error}`)}</span>
                    ) : (
                      <Money amount={p.amount!} currency={batch.currency} signed />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.length === 0 && <p className="text-sm text-muted">{t('imports.mapping.preview_empty')}</p>}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} />
        {t('imports.mapping.remember')}
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy || errors.length > 0}>
          {busy ? t('common.saving') : t('imports.mapping.apply')}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
