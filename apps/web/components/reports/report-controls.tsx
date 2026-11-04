'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type {
  AccountDto,
  CategoryDto,
  FamilyMemberDto,
  ReportDto,
  ReportExportFormat,
  WorkspaceDto,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { filtersFromParams, filtersToParams, type FilterValues } from '@/lib/reports';
import { StatusLine, useAction } from '../use-action';

const GROUPS: Record<string, string[]> = {
  spending: ['category', 'payee', 'tag'],
  items: ['item', 'store', 'category'],
};

/** RPT-02: the filters a report uses. They live in the URL, so a filtered report can be reloaded, bookmarked or saved. */
export function ReportFilterBar({
  workspace,
  report,
  values,
  accounts,
  categories,
  members,
  properties,
}: {
  workspace: WorkspaceDto;
  report: Pick<ReportDto, 'type' | 'uses'>;
  values: FilterValues;
  accounts: AccountDto[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
  properties: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { run, busy, message, t } = useAction();
  const [draft, setDraft] = useState<FilterValues>(values);
  const [saving, setSaving] = useState('');
  const uses = (k: string) => report.uses.includes(k);
  const set = (k: keyof FilterValues, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const here = `/w/${workspace.id}/reports/${report.type}`;
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const q = filtersToParams(draft).toString();
    router.push(q ? `${here}?${q}` : here);
  };
  return (
    <form className="card space-y-3" aria-label={t('reports.filters')} onSubmit={apply}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {uses('from') && (
          <label>
            <span className="field-label">{t('reports.from')}</span>
            <input
              className="input"
              type="date"
              value={draft.from ?? ''}
              onChange={(e) => set('from', e.target.value)}
            />
          </label>
        )}
        {uses('to') && (
          <label>
            <span className="field-label">{uses('from') ? t('reports.to') : t('reports.as_of')}</span>
            <input
              className="input"
              type="date"
              value={draft.to ?? ''}
              onChange={(e) => set('to', e.target.value)}
            />
          </label>
        )}
        {uses('entityId') && (
          <label>
            <span className="field-label">{t('reports.books')}</span>
            <select
              className="input"
              value={draft.entityId ?? ''}
              onChange={(e) => set('entityId', e.target.value)}
            >
              <option value="">{t('reports.all_books')}</option>
              {workspace.entities.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {uses('accountIds') && (
          <label>
            <span className="field-label">{t('reports.account')}</span>
            <select
              className="input"
              value={draft.accountIds ?? ''}
              onChange={(e) => set('accountIds', e.target.value)}
            >
              <option value="">{t('reports.all_accounts')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {uses('categoryIds') && (
          <label>
            <span className="field-label">{t('reports.category')}</span>
            <select
              className="input"
              value={draft.categoryIds ?? ''}
              onChange={(e) => set('categoryIds', e.target.value)}
            >
              <option value="">{t('reports.all_categories')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {uses('tags') && (
          <label>
            <span className="field-label">{t('reports.tags')}</span>
            <input className="input" value={draft.tags ?? ''} onChange={(e) => set('tags', e.target.value)} />
          </label>
        )}
        {uses('propertyId') && properties.length > 0 && (
          <label>
            <span className="field-label">{t('reports.property')}</span>
            <select
              className="input"
              value={draft.propertyId ?? ''}
              onChange={(e) => set('propertyId', e.target.value)}
            >
              <option value="">{t('reports.all_properties')}</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {uses('memberId') && (
          <label>
            <span className="field-label">{t('reports.member')}</span>
            <select
              className="input"
              value={draft.memberId ?? ''}
              onChange={(e) => set('memberId', e.target.value)}
            >
              <option value="">{t('reports.everyone')}</option>
              <option value="household">{t('members.household')}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {uses('groupBy') && GROUPS[report.type] && (
          <label>
            <span className="field-label">{t('reports.group_by')}</span>
            <select
              className="input"
              value={draft.groupBy ?? ''}
              onChange={(e) => set('groupBy', e.target.value)}
            >
              {GROUPS[report.type]!.map((g) => (
                <option key={g} value={g === GROUPS[report.type]![0] ? '' : g}>
                  {t(`reports.col.${g}`)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <button type="submit" className="btn-primary">
          {t('reports.apply')}
        </button>
        <label className="ml-auto">
          <span className="field-label">{t('reports.save_as')}</span>
          <input
            className="input w-48"
            maxLength={200}
            value={saving}
            onChange={(e) => setSaving(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || !saving.trim()}
          onClick={() =>
            run(
              () =>
                browserApi.createSavedReport(workspace.id, {
                  name: saving.trim(),
                  type: report.type,
                  filters: filtersFromParams({ ...draft }),
                }),
              t('reports.saved'),
            ).then((r) => {
              if (r) setSaving('');
            })
          }
        >
          {t('reports.save')}
        </button>
      </div>
      <StatusLine message={message} />
    </form>
  );
}

/** RPT-04: this report as a file. */
export function ReportExport({
  workspaceId,
  type,
  values,
}: {
  workspaceId: string;
  type: ReportDto['type'];
  values: FilterValues;
}) {
  const { run, busy, message, t } = useAction();
  const download = (format: ReportExportFormat) =>
    run(async () => {
      const { blob, fileName } = await browserApi.downloadReport(workspaceId, type, {
        ...filtersFromParams({ ...values }),
        format,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return fileName;
    });
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={t('reports.export')} role="group">
      {(['pdf', 'csv', 'xlsx'] as const).map((f) => (
        <button key={f} type="button" className="btn-secondary" disabled={busy} onClick={() => download(f)}>
          {t(`reports.export_${f}`)}
        </button>
      ))}
      <StatusLine message={message} />
    </div>
  );
}

/** Taking a saved report off the list. */
export function DeleteSavedReport({
  workspaceId,
  id,
  name,
}: {
  workspaceId: string;
  id: string;
  name: string;
}) {
  const { run, busy, t } = useAction();
  return (
    <button
      type="button"
      className="text-sm underline"
      disabled={busy}
      aria-label={t('reports.delete_saved', { name })}
      onClick={() => run(() => browserApi.deleteSavedReport(workspaceId, id))}
    >
      {t('reports.delete')}
    </button>
  );
}
