'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type {
  BackupScheduleDto,
  DeletionStatusDto,
  ExportJobDto,
  RestoreJobDto,
  StorageUsageDto,
  WorkspaceDto,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { barPercent, formatBytes } from '@/lib/reports';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';

const saveBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
};

/** BAK-08: how much of the workspace's room is in use. */
export function StorageMeter({ usage }: { usage: StorageUsageDto }) {
  const { t } = useAction();
  const used = BigInt(usage.usedBytes);
  const quota = BigInt(usage.quotaBytes);
  const percent = barPercent(used, quota);
  return (
    <section className="card space-y-2" aria-labelledby="storage-title">
      <h2 id="storage-title" className="text-base font-semibold">
        {t('data.storage')}
      </h2>
      <p className="text-sm" data-testid="storage-used">
        {t('data.storage_used', { used: formatBytes(used), quota: formatBytes(quota) })}
      </p>
      <div
        className="h-2 rounded bg-sunken"
        role="progressbar"
        aria-label={t('data.storage')}
        aria-valuenow={Math.trunc(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-2 rounded ${percent > 90 ? 'bg-bad' : 'bg-brand-600'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-muted">{t('data.storage_note')}</p>
    </section>
  );
}

/** BAK-04, NFR-06: everything, as a file you keep. */
export function BackupPanel({
  workspace,
  jobs,
  schedule,
}: {
  workspace: WorkspaceDto;
  jobs: ExportJobDto[];
  schedule: BackupScheduleDto | null;
}) {
  const router = useRouter();
  const { run, busy, message, setMessage, t } = useAction();
  const isOwner = workspace.role === 'owner';
  const [entityId, setEntityId] = useState(isOwner ? '' : (workspace.entities[0]?.id ?? ''));
  const [password, setPassword] = useState('');
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>(schedule?.cadence ?? 'weekly');
  const [taxEntity, setTaxEntity] = useState(workspace.entities.find((e) => e.type !== 'personal')?.id ?? '');
  const year = new Date().getFullYear();
  const [taxYear, setTaxYear] = useState(String(year - 1));
  return (
    <div className="space-y-5">
      <section className="card space-y-3" aria-labelledby="backup-title">
        <h2 id="backup-title" className="text-base font-semibold">
          {t('data.backup')}
        </h2>
        <p className="text-sm text-muted">{t('data.backup_hint')}</p>
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t('data.backup_now')}
          onSubmit={(e) => {
            e.preventDefault();
            if (password && password.length < 10)
              return setMessage({ tone: 'bad', text: t('data.password_short') });
            void run(
              () =>
                browserApi.createBackup(workspace.id, {
                  ...(entityId ? { entityId } : {}),
                  ...(password ? { password } : {}),
                }),
              t('data.backup_started'),
            ).then((r) => {
              if (r) setPassword('');
            });
          }}
        >
          <label>
            <span className="field-label">{t('data.what')}</span>
            <select className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              {isOwner && <option value="">{t('data.whole_workspace')}</option>}
              {workspace.entities.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('data.password')}</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              maxLength={200}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('data.backup_now')}
          </button>
        </form>
        <p className="text-xs text-muted">{t('data.password_hint')}</p>
        <StatusLine message={message} />
      </section>

      {jobs.length > 0 && (
        <section className="card-flush overflow-x-auto" aria-label={t('data.files')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('data.file')}</th>
                <th className="px-2 py-2">{t('data.status')}</th>
                <th className="px-2 py-2 text-right">{t('data.size')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {jobs.map((j) => (
                <tr key={j.id} data-testid="export-row">
                  <td className="px-4 py-2 text-sm">
                    {j.fileName ?? t(`data.kind_${j.kind}`)}
                    {j.encrypted && <span className="chip ml-2">{t('data.protected')}</span>}
                  </td>
                  <td className="px-2 py-2 text-sm">{t(`data.status_${j.status}`)}</td>
                  <td className="px-2 py-2 text-right text-sm">{j.bytes ? formatBytes(j.bytes) : '—'}</td>
                  <td className="px-4 py-2 text-right">
                    {j.status === 'ready' && (
                      <button
                        type="button"
                        className="text-sm underline"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const { blob, fileName } = await browserApi.downloadBackup(workspace.id, j.id);
                            saveBlob(blob, fileName);
                            return fileName;
                          })
                        }
                      >
                        {t('data.download')}
                      </button>
                    )}
                    {(j.status === 'queued' || j.status === 'running') && (
                      <button type="button" className="text-sm underline" onClick={() => router.refresh()}>
                        {t('data.check_again')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {isOwner && (
        <section className="card space-y-3" aria-labelledby="schedule-title">
          <h2 id="schedule-title" className="text-base font-semibold">
            {t('data.schedule')}
          </h2>
          <p className="text-sm text-muted">{t('data.schedule_hint')}</p>
          {schedule && (
            <p className="text-sm" data-testid="schedule-next">
              {t('data.schedule_next')} <DateText date={schedule.nextRunOn} />
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label>
              <span className="field-label">{t('data.how_often')}</span>
              <select
                className="input"
                value={cadence}
                onChange={(e) => setCadence(e.target.value as 'weekly' | 'monthly')}
              >
                <option value="weekly">{t('data.weekly')}</option>
                <option value="monthly">{t('data.monthly')}</option>
              </select>
            </label>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                run(() => browserApi.saveBackupSchedule(workspace.id, { cadence }), t('data.schedule_saved'))
              }
            >
              {t('data.schedule_save')}
            </button>
            {schedule && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  run(() => browserApi.deleteBackupSchedule(workspace.id), t('data.schedule_removed'))
                }
              >
                {t('data.schedule_remove')}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card space-y-3" aria-labelledby="tax-title">
        <h2 id="tax-title" className="text-base font-semibold">
          {t('data.tax_package')}
        </h2>
        <p className="text-sm text-muted">{t('data.tax_package_hint')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label>
            <span className="field-label">{t('data.books')}</span>
            <select className="input" value={taxEntity} onChange={(e) => setTaxEntity(e.target.value)}>
              {workspace.entities.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('data.year')}</span>
            <select className="input" value={taxYear} onChange={(e) => setTaxYear(e.target.value)}>
              {[year, year - 1, year - 2, year - 3].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !taxEntity}
            onClick={() =>
              run(
                () =>
                  browserApi.createTaxPackage(workspace.id, { entityId: taxEntity, year: Number(taxYear) }),
                t('data.backup_started'),
              )
            }
          >
            {t('data.tax_package_make')}
          </button>
        </div>
      </section>
    </div>
  );
}

/** BAK-06: back from a file, with a look at what's in it first. */
export function RestorePanel({
  workspace,
  restores,
}: {
  workspace: WorkspaceDto;
  restores: RestoreJobDto[];
}) {
  const router = useRouter();
  const { run, busy, message, t } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const current = restores.find((r) => r.status === 'ready');
  const running = restores.find((r) => r.status === 'restoring');
  const last = restores[0];
  return (
    <section className="card space-y-3" aria-labelledby="restore-title">
      <h2 id="restore-title" className="text-base font-semibold">
        {t('data.restore')}
      </h2>
      <p className="text-sm text-muted">{t('data.restore_hint')}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('data.restore_upload')}
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) return;
          void run(
            () => browserApi.uploadRestore(file, file.name, password || undefined),
            t('data.restore_checked'),
          ).then((r) => {
            if (r) {
              setFile(null);
              setPassword('');
            }
          });
        }}
      >
        <label>
          <span className="field-label">{t('data.backup_file')}</span>
          <input
            className="input"
            type="file"
            accept=".zip,.montra"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          <span className="field-label">{t('data.password')}</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" className="btn-secondary" disabled={busy || !file}>
          {t('data.restore_upload')}
        </button>
      </form>

      {current?.preview && (
        <div className="space-y-2 border-t border-line pt-3" data-testid="restore-preview">
          <h3 className="text-sm font-semibold">{t('data.preview')}</h3>
          <p className="text-sm">
            {current.preview.workspaceName} · {current.preview.entities.map((e) => e.name).join(', ')}
          </p>
          <p className="text-sm text-muted">
            {t('data.preview_counts', {
              transactions: current.preview.counts.transaction ?? 0,
              files: current.preview.files,
            })}
            {current.preview.firstDate && current.preview.lastDate && (
              <>
                {' · '}
                <DateText date={current.preview.firstDate} /> – <DateText date={current.preview.lastDate} />
              </>
            )}
          </p>
          {current.preview.partial && <p className="text-sm text-warn">{t('data.preview_partial')}</p>}
          {current.preview.possibleDuplicates !== null && current.preview.possibleDuplicates > 0 && (
            <p className="text-sm text-warn">
              {t('data.preview_duplicates', { count: current.preview.possibleDuplicates })}
            </p>
          )}
          <fieldset className="space-y-1">
            <legend className="field-label">{t('data.restore_into')}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="restore-mode"
                checked={mode === 'new'}
                onChange={() => setMode('new')}
              />
              {t('data.restore_new')}
            </label>
            {workspace.role === 'owner' && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="restore-mode"
                  checked={mode === 'existing'}
                  onChange={() => setMode('existing')}
                />
                {t('data.restore_existing', { name: workspace.name })}
              </label>
            )}
          </fieldset>
          <p className="text-xs text-muted">{t('data.restore_note')}</p>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  browserApi.confirmRestore(
                    current.id,
                    mode === 'new' ? { mode: 'new' } : { mode: 'existing', workspaceId: workspace.id },
                  ),
                t('data.restore_started'),
              )
            }
          >
            {t('data.restore_confirm')}
          </button>
        </div>
      )}
      {running && (
        <p className="text-sm" role="status">
          {t('data.restore_running')}{' '}
          <button type="button" className="underline" onClick={() => router.refresh()}>
            {t('data.check_again')}
          </button>
        </p>
      )}
      {!current && !running && last?.status === 'done' && last.targetWorkspaceId && (
        <p className="text-sm text-good" role="status" data-testid="restore-done">
          {t('data.restore_done')}{' '}
          <a className="underline" href={`/w/${last.targetWorkspaceId}`}>
            {t('data.restore_open')}
          </a>
        </p>
      )}
      {!current && !running && last?.status === 'failed' && (
        <p className="text-sm text-bad" role="alert">
          {last.error}
        </p>
      )}
      <StatusLine message={message} />
    </section>
  );
}

/** NFR-06, BAK-09: leaving. It says what goes, and it can be undone for 30 days. */
export function DeleteAccountPanel({ status }: { status: DeletionStatusDto }) {
  const router = useRouter();
  const { run, busy, message, t } = useAction();
  const [typed, setTyped] = useState('');
  return (
    <section className="card space-y-3" aria-labelledby="delete-title">
      <h2 id="delete-title" className="text-base font-semibold">
        {t('data.delete_account')}
      </h2>
      <p className="text-sm text-muted">{t('data.delete_hint')}</p>
      {status.workspaces.length > 0 && (
        <ul className="list-inside list-disc text-sm" data-testid="delete-workspaces">
          {status.workspaces.map((w) => (
            <li key={w.id}>
              {w.name}
              {w.otherMembers > 0 && ` · ${t('data.delete_others', { count: w.otherMembers })}`}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('data.delete_account')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => browserApi.requestDeletion({ confirm: 'DELETE' })).then((r) => {
            if (r) router.push('/account-deleting');
          });
        }}
      >
        <label>
          <span className="field-label">{t('data.delete_type')}</span>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <button type="submit" className="btn-danger" disabled={busy || typed !== 'DELETE'}>
          {t('data.delete_confirm')}
        </button>
      </form>
      <StatusLine message={message} />
    </section>
  );
}
