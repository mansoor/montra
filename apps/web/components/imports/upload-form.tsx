'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type DragEvent } from 'react';
import type { AccountDto, UploadDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { ACCEPTED_EXTENSIONS, errorCode, fileProblem, IMPORT_ERROR_KEYS } from '@/lib/imports';
import { useI18n } from '../i18n';

type Item = {
  key: string;
  file: File;
  accountId: string;
  problem: string | null;
  state: 'ready' | 'uploading' | 'duplicate' | 'started' | 'error';
  upload?: UploadDto;
  batchId?: string;
  error?: string;
};

const ACCEPT = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(',');

/**
 * Statement upload (IMP-01): drop or pick one or more files, choose the account each belongs to, and start
 * parsing. A file uploaded before (same content) asks before importing it again.
 */
export function UploadForm({
  workspaceId,
  accounts,
  defaultAccountId,
}: {
  workspaceId: string;
  accounts: AccountDto[];
  defaultAccountId: string;
}) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const update = (key: string, patch: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  function add(files: FileList | File[]) {
    const added = [...files].map((file, n) => {
      const problem = fileProblem(file);
      return {
        key: `${Date.now()}-${n}-${file.name}`,
        file,
        accountId: defaultAccountId,
        problem,
        state: 'ready' as const,
      };
    });
    setItems((list) => [...list, ...added]);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) add(e.dataTransfer.files);
  }

  const failure = (err: unknown) => {
    const code = (err as { code?: string }).code ?? errorCode(String((err as Error).message ?? ''));
    const key = code ? IMPORT_ERROR_KEYS[code] : undefined;
    return key ? t(key) : friendlyMessage(err, t);
  };

  async function start(item: Item, upload: UploadDto): Promise<string | null> {
    try {
      const batch = await browserApi.createImport(workspaceId, {
        fileId: upload.fileId,
        accountId: item.accountId,
      });
      update(item.key, { state: 'started', upload, batchId: batch.id });
      return batch.id;
    } catch (err) {
      update(item.key, { state: 'error', error: failure(err) });
      return null;
    }
  }

  async function uploadAll() {
    setBusy(true);
    const started: string[] = [];
    let waiting = false;
    for (const item of items) {
      if (item.state !== 'ready' || item.problem) continue;
      update(item.key, { state: 'uploading', error: undefined });
      try {
        const upload = await browserApi.uploadFile(workspaceId, item.file, item.file.name);
        if (upload.duplicateOf) {
          update(item.key, { state: 'duplicate', upload });
          waiting = true;
          continue;
        }
        const id = await start(item, upload);
        if (id) started.push(id);
      } catch (err) {
        update(item.key, { state: 'error', error: failure(err) });
        waiting = true;
      }
    }
    setBusy(false);
    // One file and nothing to decide: go straight to its preview.
    if (started.length === 1 && !waiting && items.length === 1)
      router.push(`/w/${workspaceId}/imports/${started[0]}`);
  }

  const pending = items.some((i) => i.state === 'ready' && !i.problem);
  const uploadedOn = (u: UploadDto) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(u.duplicateOf!.uploadedAt));

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="drop-zone"
        className={`card flex flex-col items-center gap-2 border-2 border-dashed py-10 text-center ${dragging ? 'border-brand-600 bg-brand-50' : ''}`}
      >
        <p className="font-medium">{t('imports.upload.drop')}</p>
        <p className="text-sm text-muted">{t('imports.upload.types')}</p>
        <label className="btn-secondary cursor-pointer">
          {t('imports.upload.choose')}
          <input
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            aria-label={t('imports.upload.choose_files')}
            onChange={(e) => {
              if (e.target.files) add(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {items.length > 0 && (
        <ul className="space-y-3" aria-label={t('imports.upload.files')}>
          {items.map((item) => (
            <li key={item.key} className="card space-y-2" data-testid="upload-item">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.file.name}</p>
                  <p className="text-xs text-muted">
                    {t('imports.upload.size', { size: Math.max(1, Math.ceil(item.file.size / 1024)) })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor={`acct-${item.key}`} className="text-sm text-muted">
                    {t('fields.account')}
                  </label>
                  <select
                    id={`acct-${item.key}`}
                    className="input w-auto"
                    value={item.accountId}
                    disabled={item.state !== 'ready'}
                    onChange={(e) => update(item.key, { accountId: e.target.value })}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  {(item.state === 'ready' || item.state === 'error') && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                    >
                      {t('imports.upload.remove')}
                    </button>
                  )}
                </div>
              </div>
              {item.problem && (
                <p role="alert" className="text-sm text-bad">
                  {t(item.problem)}
                </p>
              )}
              {item.state === 'uploading' && (
                <p role="status" className="text-sm text-muted">
                  {t('imports.upload.uploading')}
                </p>
              )}
              {item.state === 'error' && (
                <p role="alert" className="text-sm text-bad">
                  {item.error}
                </p>
              )}
              {item.state === 'duplicate' && item.upload && (
                <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-warn">
                  <span>{t('imports.upload.duplicate', { date: uploadedOn(item.upload) })}</span>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={async () => {
                      const id = await start(item, item.upload!);
                      if (id && items.length === 1) router.push(`/w/${workspaceId}/imports/${id}`);
                    }}
                  >
                    {t('imports.upload.import_anyway')}
                  </button>
                  {item.upload.duplicateOf?.importBatchId && (
                    <Link
                      className="underline"
                      href={`/w/${workspaceId}/imports/${item.upload.duplicateOf.importBatchId}`}
                    >
                      {t('imports.upload.view_earlier')}
                    </Link>
                  )}
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                  >
                    {t('imports.upload.remove')}
                  </button>
                </div>
              )}
              {item.state === 'started' && item.batchId && (
                <p className="text-sm text-good">
                  {t('imports.upload.started')}{' '}
                  <Link className="font-medium underline" href={`/w/${workspaceId}/imports/${item.batchId}`}>
                    {t('imports.upload.review')}
                  </Link>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="btn-primary" disabled={!pending || busy} onClick={uploadAll}>
        {busy ? t('imports.upload.uploading') : t('imports.upload.submit')}
      </button>
    </div>
  );
}
