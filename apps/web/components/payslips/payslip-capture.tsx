'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type DragEvent } from 'react';
import type { EmployerDto, FamilyMemberDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { RECEIPT_ACCEPT, receiptFileProblem } from '@/lib/receipts';
import { useI18n } from '../i18n';

/**
 * Add a payslip (PAY-03): a PDF or photos for AI to read, or a start from the employer's last payslip, or by hand.
 * Every route ends on the review screen, because nothing posts until the user confirms.
 */
export function PayslipCapture({
  workspaceId,
  employers,
  members,
}: {
  workspaceId: string;
  employers: EmployerDto[];
  members: FamilyMemberDto[];
}) {
  const router = useRouter();
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [employerId, setEmployerId] = useState(employers[0]?.id ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const employer = employers.find((e) => e.id === employerId);
  const memberName = new Map(members.map((m) => [m.id, m.name]));

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

  async function start(route: 'files' | 'last' | 'hand') {
    setBusy(true);
    setError(null);
    try {
      const fileIds: string[] = [];
      if (route === 'files') {
        for (const f of files)
          fileIds.push((await browserApi.uploadPayslipFile(workspaceId, f, f.name)).fileId);
      }
      const payslip = await browserApi.createPayslip(workspaceId, {
        employerId,
        fileIds,
        fromLast: route === 'last',
      });
      setFiles([]);
      router.push(`/w/${workspaceId}/payslips/${payslip.id}`);
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3" aria-labelledby="payslip-add">
      <h2 id="payslip-add" className="font-medium">
        {t('payslips.add')}
      </h2>
      <label className="block max-w-md">
        <span className="field-label">{t('payslips.employer')}</span>
        <select className="input" value={employerId} onChange={(e) => setEmployerId(e.target.value)}>
          {employers.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} · {memberName.get(e.memberId) ?? ''}
            </option>
          ))}
        </select>
      </label>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-md border border-dashed p-4 text-sm ${dragging ? 'border-brand-600 bg-brand-50' : 'border-line'}`}
      >
        <p className="text-muted">{t('payslips.upload_hint')}</p>
        <button type="button" className="btn-secondary mt-2" onClick={() => input.current?.click()}>
          {t('payslips.pick_files')}
        </button>
        <input
          ref={input}
          type="file"
          accept={RECEIPT_ACCEPT}
          multiple
          className="sr-only"
          aria-label={t('payslips.pick_files')}
          data-testid="payslip-files"
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = '';
          }}
        />
        {files.length > 0 && (
          <ol className="mt-2 list-decimal pl-6" aria-label={t('receipts.pages')}>
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
      </div>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || files.length === 0 || !employerId}
          onClick={() => start('files')}
        >
          {busy ? t('receipts.uploading') : t('payslips.read')}
        </button>
        {employer?.lastPayDate && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => start('last')}>
            {t('payslips.from_last')}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || !employerId}
          onClick={() => start('hand')}
        >
          {t('payslips.by_hand')}
        </button>
      </div>
    </section>
  );
}
