'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { TaxFormUploadDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { photoForUpload } from '@/lib/photo-upload';
import { friendlyMessage } from '@/lib/errors';
import { UPLOAD_ACCEPT } from '@/lib/tax-forms';
import { useI18n } from '../i18n';

/**
 * The drop zone (ADR-0052 §7.1, TAX-01): several PDFs or photos at once, dropped or chosen. Each is stored and read in
 * the background; the same file again is refused with a link to the form made from it. Only masked text reaches the
 * AI, never the images.
 */
export function TaxFormDropZone({ workspaceId, year }: { workspaceId: string; year: number }) {
  const { t } = useI18n();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<TaxFormUploadDto['files']>([]);

  async function send(list: FileList | null) {
    const files = [...(list ?? [])];
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const photos = [];
      for (const f of files) photos.push(await photoForUpload(f));
      const res = await browserApi.uploadTaxFormFiles(
        workspaceId,
        photos.map((f) => ({ file: f, name: f.name })),
        { year, source: 'upload' },
      );
      setDone(res.files);
      router.refresh();
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <section aria-labelledby="tax-upload" className="space-y-3">
      <div>
        <h2 id="tax-upload" className="text-base font-semibold">
          {t('tax_forms.upload_title')}
        </h2>
        <p className="text-sm text-muted">{t('tax_forms.upload_intro')}</p>
      </div>
      <div
        className={`card flex flex-col items-center gap-2 border-2 border-dashed py-6 text-center ${
          over ? 'border-brand-600 bg-brand-50' : ''
        }`}
        data-testid="tax-drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files);
        }}
      >
        <p className="text-sm">{busy ? t('tax_forms.uploading') : t('tax_forms.drop_here')}</p>
        <label className="btn-secondary cursor-pointer">
          {t('tax_forms.choose_files')}
          <input
            ref={input}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            aria-label={t('tax_forms.choose_files')}
            disabled={busy}
            onChange={(e) => void send(e.target.files)}
          />
        </label>
        <p className="text-xs text-muted">{t('tax_forms.upload_privacy')}</p>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {done.length > 0 && (
        <ul className="space-y-1 text-sm" aria-live="polite" data-testid="tax-upload-results">
          {done.map((f, i) => (
            <li key={`${f.formId}-${i}`}>
              {f.status === 'reading' ? (
                t('tax_forms.upload_reading', { name: f.fileName })
              ) : (
                <>
                  {t('tax_forms.upload_duplicate', { name: f.fileName })}{' '}
                  <Link href={`/w/${workspaceId}/tax-forms/${f.formId}`} className="underline">
                    {t('tax_forms.open')}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Looks again every few seconds while a form is being read, so the screen moves on by itself. */
export function useRefreshWhile(reading: boolean, everyMs = 4000) {
  const router = useRouter();
  useEffect(() => {
    if (!reading) return;
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [reading, everyMs, router]);
}
