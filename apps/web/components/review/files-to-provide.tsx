'use client';

import { useEffect, useId, useState } from 'react';
import type { MissingFileDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { MISSING_FILE_ACCEPT, missingFileUses, providedAgainKey } from '@/lib/missing-files';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/**
 * Review's "Files to provide again" (ADR-0054 §5a): files Montra no longer keeps a copy of that the household's Family
 * Document Vault didn't give back. Each says what it was and what in Montra uses it, with an Upload action that stores
 * the paper again under the same file. Owners and admins see them all, anyone else the ones they uploaded.
 */
export function FilesToProvide({ workspaceId }: { workspaceId: string }) {
  const { run, busy, message, t } = useAction();
  const [files, setFiles] = useState<MissingFileDto[]>([]);
  const id = useId();

  useEffect(() => {
    let alive = true;
    browserApi.listMissingFiles(workspaceId).then(
      (list) => alive && setFiles(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  async function upload(f: MissingFileDto, picked: File) {
    const done = await run(
      () => browserApi.provideMissingFile(workspaceId, f.fileId, picked, picked.name),
      (r) => t(providedAgainKey(r), { name: f.fileName }),
    );
    if (done) setFiles((list) => list.filter((x) => x.fileId !== f.fileId));
  }

  if (files.length === 0) return message ? <StatusLine message={message} /> : null;
  return (
    <section
      id="files-to-provide"
      className="space-y-3"
      aria-labelledby={`${id}-title`}
      data-testid="files-to-provide"
    >
      <div>
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {t('missing_files.title')}
        </h2>
        <p className="text-sm text-muted">{t('missing_files.intro')}</p>
      </div>
      <ul className="card-flush divide-y divide-line">
        {files.map((f) => (
          <li
            key={f.fileId}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            data-testid="missing-file"
          >
            <div className="min-w-0">
              <p className="font-medium">{f.fileName}</p>
              <p className="text-xs text-muted">
                {missingFileUses(f)
                  .map((u) => (u.label ? `${t(u.key)}: ${u.label}` : t(u.key)))
                  .join(' · ')}
              </p>
              <p className="text-xs text-muted">
                {f.reason} {t('missing_files.since')} <DateText date={f.missingSince.slice(0, 10)} />
              </p>
            </div>
            <label className="btn-secondary cursor-pointer">
              {t('missing_files.upload')}
              <input
                type="file"
                className="sr-only"
                accept={MISSING_FILE_ACCEPT}
                disabled={busy}
                aria-label={t('missing_files.upload_named', { name: f.fileName })}
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  e.target.value = '';
                  if (picked) void upload(f, picked);
                }}
              />
            </label>
          </li>
        ))}
      </ul>
      <StatusLine message={message} />
    </section>
  );
}
