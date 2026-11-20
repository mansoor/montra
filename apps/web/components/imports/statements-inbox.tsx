'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { AccountDto } from '@montra/api-client';
import type { BankFeedLinkDto } from '@montra/schemas';
import type { IntakeDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { isWorking, STATEMENT_ACCEPT } from '@/lib/intakes';
import { useI18n } from '../i18n';
import { IntakeCard } from '../intakes/intake-card';

type Item =
  | { key: string; name: string; state: 'uploading' }
  | { key: string; name: string; state: 'error'; error: string }
  | { key: string; name: string; state: 'intake'; intake: IntakeDto; undoing?: boolean };

const POLL_MS = 1500;
const POLL_LIMIT_MS = 120_000;

/**
 * The Statements screen's upload (ADR-0051): any statement file or a photo, with no account picked first. Each is read
 * and matched; the account found is shown to confirm or change, and a confirmed statement continues in the existing
 * import preview. Once learned, a clean statement is imported straight away, with Undo.
 */
export function StatementsInbox({
  workspaceId,
  role,
  accounts,
  pending = [],
  feedLinks = [],
}: {
  workspaceId: string;
  role: string | undefined;
  accounts: AccountDto[];
  /** Statements uploaded earlier that are still being read or waiting for an account (`pendingStatements`). */
  pending?: IntakeDto[];
  /** Accounts a bank feed imports into, and through when (ADR-0055 §6). */
  feedLinks?: BankFeedLinkDto[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [items, setItems] = useState<Item[]>(() =>
    pending.map((intake) => ({ key: intake.id, name: intake.fileName, state: 'intake' as const, intake })),
  );
  const [dragging, setDragging] = useState(false);
  const alive = useRef(true);
  const base = `/w/${workspaceId}`;
  const bankAccounts = accounts.filter((a) => a.type === 'asset' || a.type === 'liability');

  // Set on every mount, not only at first: React (strict mode in development) mounts, unmounts and mounts again, and a
  // flag left false by that first unmount stopped every upload's progress from updating.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const put = useCallback(
    (key: string, next: Item) => setItems((list) => list.map((i) => (i.key === key ? next : i))),
    [],
  );

  /** Polls an intake while it's being read or imported. */
  const follow = useCallback(
    async (key: string, name: string, first: IntakeDto) => {
      let intake = first;
      for (let waited = 0; isWorking(intake) && waited < POLL_LIMIT_MS && alive.current; waited += POLL_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        intake = await browserApi.getIntake(workspaceId, intake.id);
        put(key, { key, name, state: 'intake', intake });
      }
      router.refresh(); // the history below picks up the import
    },
    [workspaceId, put, router],
  );

  // Statements still being read when the screen opens are followed as if just uploaded.
  useEffect(() => {
    for (const intake of pending) if (isWorking(intake)) void follow(intake.id, intake.fileName, intake);
    // Only on opening: later uploads are followed by `add`.
  }, []);

  async function add(files: FileList | File[]) {
    const added = [...files].map((file, n) => ({ key: `${Date.now()}-${n}-${file.name}`, file }));
    setItems((list) => [
      ...added.map((a) => ({ key: a.key, name: a.file.name, state: 'uploading' as const })),
      ...list,
    ]);
    for (const { key, file } of added) {
      try {
        const intake = await browserApi.uploadStatement(workspaceId, file, file.name);
        put(key, { key, name: file.name, state: 'intake', intake });
        void follow(key, file.name, intake);
      } catch (err) {
        put(key, { key, name: file.name, state: 'error', error: friendlyMessage(err, t) });
      }
    }
  }

  async function undo(item: Extract<Item, { state: 'intake' }>) {
    if (!item.intake.importBatchId) return;
    put(item.key, { ...item, undoing: true });
    try {
      await browserApi.undoImport(workspaceId, item.intake.importBatchId);
      // The undo runs in the worker; the statement then comes back to pick its account.
      const back = await browserApi.getIntake(workspaceId, item.intake.id);
      put(item.key, { ...item, intake: back, undoing: false });
      router.refresh();
    } catch (err) {
      put(item.key, { key: item.key, name: item.name, state: 'error', error: friendlyMessage(err, t) });
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void add(e.dataTransfer.files);
  }

  const uploadedOn = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="statement-drop"
        className={`card flex flex-col items-center gap-2 border-2 border-dashed py-10 text-center ${dragging ? 'border-brand-600 bg-brand-50' : ''}`}
      >
        <p className="font-medium">{t('statements.drop')}</p>
        <p className="text-sm text-muted">{t('statements.types')}</p>
        <label className="btn-secondary cursor-pointer">
          {t('imports.upload.choose')}
          <input
            type="file"
            multiple
            accept={STATEMENT_ACCEPT}
            className="sr-only"
            aria-label={t('statements.choose_files')}
            onChange={(e) => {
              if (e.target.files) void add(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {items.length > 0 && (
        <ul className="space-y-3" aria-label={t('statements.uploaded')}>
          {items.map((item) => {
            if (item.state === 'uploading')
              return (
                <li key={item.key} className="card text-sm" data-testid="statement-item">
                  <p className="font-medium">{item.name}</p>
                  <p role="status" className="text-muted">
                    {t('imports.upload.uploading')}
                  </p>
                </li>
              );
            if (item.state === 'error')
              return (
                <li key={item.key} className="card text-sm" data-testid="statement-item">
                  <p className="font-medium">{item.name}</p>
                  <p role="alert" className="text-bad">
                    {item.error}
                  </p>
                </li>
              );
            const i = item.intake;
            if (i.status === 'suggested' || i.status === 'review')
              return (
                <IntakeCard
                  key={item.key}
                  workspaceId={workspaceId}
                  role={role}
                  intake={i}
                  accounts={bankAccounts}
                  billers={[]}
                  feedLinks={feedLinks}
                  onDone={(done) => {
                    put(item.key, { ...item, intake: done });
                    // Confirmed: the import continues in the existing preview, mapping and commit screens.
                    if (done.status === 'done' && done.importBatchId)
                      router.push(`${base}/imports/${done.importBatchId}`);
                  }}
                />
              );
            return (
              <li key={item.key} className="card space-y-1 text-sm" data-testid="statement-item">
                <p className="font-medium">{item.name}</p>
                {i.duplicateOf && (
                  <p className="text-xs text-warn">
                    {t('intakes.possible_duplicate', { date: uploadedOn(i.duplicateOf.uploadedAt) })}
                  </p>
                )}
                {i.status === 'reading' && (
                  <p role="status" className="text-muted">
                    {t('statements.reading')}
                  </p>
                )}
                {i.status === 'importing' && (
                  <p role="status" className="text-muted">
                    {t('statements.importing', { name: i.targetName ?? '' })}
                  </p>
                )}
                {i.status === 'done' && i.automatic && (
                  <p className="text-good" data-testid="auto-imported">
                    {t('statements.auto_imported', { name: i.targetName ?? '' })}{' '}
                    <button
                      type="button"
                      className="font-medium underline"
                      disabled={item.undoing}
                      onClick={() => void undo(item)}
                    >
                      {t('statements.undo')}
                    </button>
                  </p>
                )}
                {i.status === 'done' && i.importBatchId && (
                  <Link
                    className="font-medium text-brand-600 underline"
                    href={`${base}/imports/${i.importBatchId}`}
                  >
                    {t('statements.view_import')}
                  </Link>
                )}
                {i.status === 'dismissed' && <p className="text-muted">{t('intakes.dismissed')}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
