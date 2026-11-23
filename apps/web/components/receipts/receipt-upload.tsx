'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { photoSkipReason } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { anyDuplicate } from '@/lib/missing-files';
import { photoForUpload, photoSettings } from '@/lib/photo-upload';
import { RECEIPT_ACCEPT, receiptFileProblem } from '@/lib/receipts';
import { useI18n } from '../i18n';

/**
 * Receipt upload (TXN-08 on the web, RCP-01): one receipt from one or more photos (a long receipt in pages,
 * in order) or a PDF invoice. With `transactionId` the receipt is linked to that transaction once read.
 */
export function ReceiptUpload({
  workspaceId,
  transactionId,
  compact,
}: {
  workspaceId: string;
  transactionId?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // BAK-08: photos are compressed unless the person keeps originals; their profile setting is the default here.
  const [keepOriginal, setKeepOriginal] = useState(false);
  useEffect(() => {
    void photoSettings().then((s) => setKeepOriginal(s.keepOriginal));
  }, []);
  const anyPhoto = files.some((f) => photoSkipReason(f.type, { keepOriginal: false }) === null);

  function add(list: FileList | File[]) {
    setError(null);
    const picked = [...list];
    const problem = picked.map((f) => receiptFileProblem(f, t)).find(Boolean);
    if (problem) {
      setError(problem);
      return;
    }
    setFiles((prev) => [...prev, ...picked]);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) add(e.dataTransfer.files);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const uploads = [];
      for (const f of files) {
        const p = await photoForUpload(f, keepOriginal);
        uploads.push(await browserApi.uploadReceiptFile(workspaceId, p, p.name));
      }
      // The same picture is already in Montra, or kept in the vault (ADR-0054): the person decides.
      if (anyDuplicate(uploads) && !window.confirm(t('files.duplicate_confirm'))) return;
      const fileIds = uploads.map((u) => u.fileId);
      const receipt = await browserApi.createReceipt(workspaceId, {
        fileIds,
        ...(transactionId ? { transactionId } : {}),
      });
      setFiles([]);
      router.push(`/w/${workspaceId}/receipts/${receipt.id}`);
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? 'space-y-2' : 'card space-y-3'}>
      {!compact && <h2 className="font-medium">{t('receipts.upload_title')}</h2>}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-md border border-dashed p-4 text-sm ${dragging ? 'border-brand-600 bg-brand-50' : 'border-line'}`}
      >
        <p className="text-muted">{t('receipts.upload_hint')}</p>
        <button type="button" className="btn-secondary mt-2" onClick={() => input.current?.click()}>
          {t('receipts.pick_files')}
        </button>
        <input
          ref={input}
          type="file"
          accept={RECEIPT_ACCEPT}
          multiple
          className="sr-only"
          aria-label={t('receipts.pick_files')}
          data-testid="receipt-files"
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {files.length > 0 && (
        <ol className="list-decimal pl-6 text-sm" aria-label={t('receipts.pages')}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2">
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                className="text-xs text-muted underline"
                onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}
              >
                {t('receipts.remove_page')}
              </button>
            </li>
          ))}
        </ol>
      )}
      {files.length > 1 && (
        <p className="text-xs text-muted">{t('receipts.pages_hint', { count: files.length })}</p>
      )}
      {anyPhoto && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={keepOriginal}
            onChange={(e) => setKeepOriginal(e.target.checked)}
            data-testid="receipt-keep-original"
          />
          {t('photos.keep_original_once')}
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <button type="button" className="btn-primary" disabled={busy || files.length === 0} onClick={submit}>
        {busy ? t('receipts.uploading') : t('receipts.read_receipt')}
      </button>
    </div>
  );
}
