'use client';

import { useState } from 'react';
import type { StorageDestinationDto, StorageItemDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  emptyConnection,
  hasSecret,
  storageSummary,
  storageWhere,
  toConnection,
  type ConnectionForm,
} from '@/lib/storage';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';

const KINDS = ['statement', 'receipt', 'payslip', 'invoice', 'lease', 'other'] as const;

/** ADR-0030: a copy of every document, and backups, in storage the owner controls. */
export function StorageSettings({
  workspace,
  destination,
  failed,
}: {
  workspace: WorkspaceDto;
  destination: StorageDestinationDto | null;
  failed: StorageItemDto[];
}) {
  if (workspace.role !== 'owner') return <OwnersOnly />;
  return destination ? (
    <Connected workspace={workspace} d={destination} failed={failed} />
  ) : (
    <Connect workspace={workspace} />
  );
}

function OwnersOnly() {
  const { t } = useAction();
  return (
    <section className="card">
      <p className="text-sm">{t('storage.owners_only')}</p>
    </section>
  );
}

/** The address and credentials, for connecting or for changing them. */
function ConnectionFields({
  form,
  set,
  saved,
}: {
  form: ConnectionForm;
  set: (f: ConnectionForm) => void;
  saved: boolean;
}) {
  const { t } = useAction();
  const field = <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) => set({ ...form, [k]: v });
  const keep = saved ? t('storage.keep_secret') : undefined;
  return (
    <div className="space-y-3">
      <fieldset className="space-y-1">
        <legend className="field-label">{t('storage.kind')}</legend>
        {(['s3', 'webdav'] as const).map((k) => (
          <label key={k} className="flex items-start gap-2 text-sm">
            <input type="radio" name="kind" checked={form.kind === k} onChange={() => field('kind', k)} />
            <span>
              <span className="font-medium">{t(`storage.kind_${k}`)}</span>
              <span className="block text-xs text-muted">{t(`storage.kind_${k}_examples`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {form.kind === 's3' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="field-label">{t('storage.endpoint')}</span>
            <input
              className="input w-full"
              type="url"
              placeholder="https://s3.us-west-004.backblazeb2.com"
              value={form.endpoint}
              onChange={(e) => field('endpoint', e.target.value)}
            />
            <span className="text-xs text-muted">{t('storage.endpoint_hint')}</span>
          </label>
          <label>
            <span className="field-label">{t('storage.bucket')}</span>
            <input
              className="input w-full"
              required
              value={form.bucket}
              onChange={(e) => field('bucket', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('storage.region')}</span>
            <input
              className="input w-full"
              value={form.region}
              onChange={(e) => field('region', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('storage.access_key')}</span>
            <input
              className="input w-full"
              autoComplete="off"
              placeholder={keep}
              value={form.accessKeyId}
              onChange={(e) => field('accessKeyId', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('storage.secret_key')}</span>
            <input
              className="input w-full"
              type="password"
              autoComplete="new-password"
              placeholder={keep}
              value={form.secretAccessKey}
              onChange={(e) => field('secretAccessKey', e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.pathStyle}
              onChange={(e) => field('pathStyle', e.target.checked)}
            />
            {t('storage.path_style')}
          </label>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="field-label">{t('storage.webdav_url')}</span>
            <input
              className="input w-full"
              type="url"
              required
              placeholder="https://cloud.example.com/remote.php/dav/files/sam/"
              value={form.url}
              onChange={(e) => field('url', e.target.value)}
            />
            <span className="text-xs text-muted">{t('storage.webdav_url_hint')}</span>
          </label>
          <label>
            <span className="field-label">{t('storage.username')}</span>
            <input
              className="input w-full"
              autoComplete="off"
              value={form.username}
              onChange={(e) => field('username', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('storage.password')}</span>
            <input
              className="input w-full"
              type="password"
              autoComplete="new-password"
              placeholder={keep}
              value={form.password}
              onChange={(e) => field('password', e.target.value)}
            />
            <span className="text-xs text-muted">{t('storage.password_hint')}</span>
          </label>
        </div>
      )}
      <p className="text-xs text-muted">{t('storage.secret_note')}</p>
    </div>
  );
}

function Connect({ workspace }: { workspace: WorkspaceDto }) {
  const { run, busy, message, setMessage, t } = useAction();
  const [form, setForm] = useState<ConnectionForm>(emptyConnection());
  const [label, setLabel] = useState('');
  const [folder, setFolder] = useState('');
  const [copyExisting, setCopyExisting] = useState(true);
  const connection = toConnection(form);
  const ready = connection !== null && hasSecret(form);
  return (
    <section className="card space-y-4" aria-labelledby="storage-connect-title">
      <div className="space-y-1">
        <h2 id="storage-connect-title" className="text-base font-semibold">
          {t('storage.title')}
        </h2>
        <p className="text-sm text-muted">{t('storage.intro')}</p>
        <p className="text-xs text-muted">{t('storage.later_providers')}</p>
      </div>
      <form
        className="space-y-4"
        aria-label={t('storage.connect')}
        onSubmit={(e) => {
          e.preventDefault();
          if (!connection || !ready) return setMessage({ tone: 'bad', text: t('storage.fill_in') });
          void run(
            () =>
              browserApi.connectStorageDestination(workspace.id, {
                label: label.trim() || t('storage.default_label'),
                connection,
                copyExisting,
                ...(folder.trim() ? { folder: folder.trim() } : {}),
              }),
            t('storage.connected'),
          );
        }}
      >
        <label className="block">
          <span className="field-label">{t('storage.label')}</span>
          <input
            className="input w-full"
            maxLength={80}
            placeholder={t('storage.default_label')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <ConnectionFields form={form} set={setForm} saved={false} />
        <label className="block">
          <span className="field-label">{t('storage.folder')}</span>
          <input
            className="input w-full"
            maxLength={200}
            placeholder={`Montra/${workspace.name}`}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
          <span className="text-xs text-muted">{t('storage.folder_hint')}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={copyExisting} onChange={(e) => setCopyExisting(e.target.checked)} />
          {t('storage.copy_existing')}
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !ready}
            onClick={async () => {
              const r = await run(() =>
                browserApi.testStorageDestination(workspace.id, connection!, folder.trim() || undefined),
              );
              if (!r) return;
              setMessage(
                r.ok
                  ? {
                      tone: 'good',
                      text: r.canDelete ? t('storage.test_ok') : t('storage.test_ok_no_delete'),
                    }
                  : { tone: 'bad', text: r.error ?? t('storage.test_failed') },
              );
            }}
          >
            {t('storage.test')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('storage.connect')}
          </button>
        </div>
        <StatusLine message={message} />
      </form>
    </section>
  );
}

function Connected({
  workspace,
  d,
  failed,
}: {
  workspace: WorkspaceDto;
  d: StorageDestinationDto;
  failed: StorageItemDto[];
}) {
  const { run, busy, message, t } = useAction();
  const [label, setLabel] = useState(d.label);
  const [folder, setFolder] = useState(d.folder);
  const [mirrorFiles, setMirrorFiles] = useState(d.mirrorFiles);
  const [kinds, setKinds] = useState<string[]>(d.fileKinds);
  const [deleteWithMontra, setDeleteWithMontra] = useState(d.deleteWithMontra);
  const [keepBackups, setKeepBackups] = useState(String(d.keepBackups));
  const [changing, setChanging] = useState(false);
  const [form, setForm] = useState<ConnectionForm>(emptyConnection(d));
  const summary = storageSummary(d);
  const tone = d.status === 'failing' ? 'text-bad' : d.status === 'paused' ? 'text-muted' : 'text-good';
  return (
    <div className="space-y-5">
      <section className="card space-y-3" aria-labelledby="storage-status-title">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="storage-status-title" className="text-base font-semibold">
              {d.label}
            </h2>
            <p className="text-sm text-muted" data-testid="storage-where">
              {t(`storage.kind_${d.kind}`)} · {storageWhere(d)}
            </p>
          </div>
          <span className={`chip ${tone}`} data-testid="storage-status">
            {t(`storage.status_${d.status}`)}
          </span>
        </div>
        <p className="text-sm" data-testid="storage-summary">
          {t(summary.key, summary.values)}
        </p>
        <dl className="grid gap-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">{t('storage.last_success')}</dt>
            <dd>{d.lastSuccessAt ? <DateText date={d.lastSuccessAt.slice(0, 10)} /> : t('storage.never')}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('storage.last_backup')}</dt>
            <dd>
              {d.lastBackup ? (
                <>
                  <DateText date={d.lastBackup.at.slice(0, 10)} /> ·{' '}
                  {t(`storage.copy_${d.lastBackup.status}`)}
                </>
              ) : (
                t('storage.never')
              )}
            </dd>
          </div>
        </dl>
        {d.lastError && (
          <p className="text-sm text-bad" role="note">
            {t('storage.last_error')} {d.lastError}
            {d.lastErrorAt && (
              <>
                {' '}
                (<DateText date={d.lastErrorAt.slice(0, 10)} />)
              </>
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  browserApi.updateStorageDestination(workspace.id, {
                    version: d.version,
                    paused: d.status !== 'paused',
                  }),
                d.status === 'paused' ? t('storage.resumed') : t('storage.paused'),
              )
            }
          >
            {d.status === 'paused' ? t('storage.resume') : t('storage.pause')}
          </button>
          {d.files.failed > 0 || d.lastBackup?.status === 'failed' ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                run(
                  () => browserApi.retryStorageDestination(workspace.id),
                  (r) => t('storage.retry_queued', { n: r.queued }),
                )
              }
            >
              {t('storage.retry')}
            </button>
          ) : null}
          {d.mirrorFiles && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                run(
                  () => browserApi.backfillStorageDestination(workspace.id),
                  (r) => t('storage.backfill_queued', { n: r.queued }),
                )
              }
            >
              {t('storage.backfill')}
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('storage.confirm_disconnect', { label: d.label }))) {
                void run(
                  () => browserApi.disconnectStorageDestination(workspace.id),
                  t('storage.disconnected'),
                );
              }
            }}
          >
            {t('storage.disconnect')}
          </button>
        </div>
        <StatusLine message={message} />
      </section>

      <section className="card space-y-3" aria-labelledby="storage-settings-title">
        <h2 id="storage-settings-title" className="text-base font-semibold">
          {t('storage.what_goes')}
        </h2>
        <form
          className="space-y-3"
          aria-label={t('storage.what_goes')}
          onSubmit={(e) => {
            e.preventDefault();
            const connection = changing ? toConnection(form) : null;
            void run(
              () =>
                browserApi.updateStorageDestination(workspace.id, {
                  version: d.version,
                  label: label.trim() || d.label,
                  folder: folder.trim() || d.folder,
                  mirrorFiles,
                  fileKinds: kinds as StorageDestinationDto['fileKinds'],
                  deleteWithMontra,
                  keepBackups: Math.max(0, Math.min(1000, Number.parseInt(keepBackups, 10) || 0)),
                  ...(connection ? { connection } : {}),
                }),
              t('storage.saved'),
            ).then((r) => {
              if (r) setChanging(false);
            });
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label>
              <span className="field-label">{t('storage.label')}</span>
              <input
                className="input w-full"
                maxLength={80}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('storage.folder')}</span>
              <input
                className="input w-full"
                maxLength={200}
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={mirrorFiles} onChange={(e) => setMirrorFiles(e.target.checked)} />
            {t('storage.mirror_files')}
          </label>
          {mirrorFiles && (
            <fieldset className="flex flex-wrap gap-3 pl-6">
              <legend className="sr-only">{t('storage.kinds')}</legend>
              {KINDS.map((k) => (
                <label key={k} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={kinds.includes(k)}
                    onChange={(e) =>
                      setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))
                    }
                  />
                  {t(`storage.file_kind_${k}`)}
                </label>
              ))}
            </fieldset>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={deleteWithMontra}
              disabled={!d.canDelete}
              onChange={(e) => setDeleteWithMontra(e.target.checked)}
            />
            <span>
              {t('storage.delete_with_montra')}
              <span className="block text-xs text-muted">
                {d.canDelete ? t('storage.delete_with_montra_hint') : t('storage.cannot_delete')}
              </span>
            </span>
          </label>
          <label className="block">
            <span className="field-label">{t('storage.keep_backups')}</span>
            <input
              className="input w-28"
              type="number"
              min={0}
              max={1000}
              value={keepBackups}
              onChange={(e) => setKeepBackups(e.target.value)}
            />
            <span className="block text-xs text-muted">{t('storage.keep_backups_hint')}</span>
          </label>
          <div>
            <button type="button" className="text-sm underline" onClick={() => setChanging(!changing)}>
              {changing ? t('storage.keep_connection') : t('storage.change_connection')}
            </button>
          </div>
          {changing && <ConnectionFields form={form} set={setForm} saved />}
          <button type="submit" className="btn-primary" disabled={busy || kinds.length === 0}>
            {t('storage.save')}
          </button>
        </form>
      </section>

      {failed.length > 0 && (
        <section className="card-flush overflow-x-auto" aria-label={t('storage.failed_files')}>
          <table className="tbl">
            <caption className="px-4 py-2 text-left text-sm font-semibold">
              {t('storage.failed_files')}
            </caption>
            <thead>
              <tr>
                <th className="px-4 py-2">{t('data.file')}</th>
                <th className="px-2 py-2">{t('storage.attempts')}</th>
                <th className="px-4 py-2">{t('storage.why')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {failed.map((f) => (
                <tr key={f.fileId} data-testid="storage-failed-row">
                  <td className="px-4 py-2 text-sm">{f.fileName ?? '—'}</td>
                  <td className="px-2 py-2 text-sm">{f.attempts}</td>
                  <td className="px-4 py-2 text-sm">{f.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
