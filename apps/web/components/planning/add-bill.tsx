'use client';

import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { BillerDto, ScanBillDetectedDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import {
  autoFiledName,
  blankDraft,
  checkBillDraft,
  draftFromReading,
  matchNote,
  providerChoices,
  waitForScan,
  type BillDraft,
  type BillField,
} from '@/lib/household-bills';
import { anyDuplicate } from '@/lib/missing-files';
import { RECEIPT_ACCEPT, receiptFileProblem } from '@/lib/receipts';
import { Field, FormError } from '../field';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

type Way = 'upload' | 'type';

interface Reading {
  /** Set only when the scan was read, so the bill is filed from the same reading (and keeps its pages). */
  scanId?: string;
  found: ScanBillDetectedDto | null;
}

/**
 * "Add a bill" on the budget's Bills tab (ADR-0048 §4), the web's version of the phone's bill scan
 * (apps/mobile/app/bills/capture.tsx). Upload: the pages go to `household-bills/files`, become a `bill` scan that the
 * worker reads once (the provider found by the account number's last four digits, else by name), and the person
 * checks or corrects what was read before filing it from the same reading. Or the bill is typed in. A provider that
 * isn't on the budget yet is added on the category chosen. A provider on a business's books files a vendor bill.
 */
export function AddBill({
  workspaceId,
  entityId,
  currency,
  categories,
  billers,
  entities,
}: {
  workspaceId: string;
  /** The budget's books: their first provider is the one offered when typing a bill in. */
  entityId: string;
  /** The budget's currency: a new provider's bills are in it. */
  currency: string;
  /** The budget's spending categories, by group; a new provider goes on one of them. */
  categories: { id: string; name: string; group: string }[];
  /** Every provider in the workspace, so a reading can match one on other books. */
  billers: BillerDto[];
  entities: { id: string; name: string; type: string; functionalCurrency: string }[];
}) {
  const { t, locale } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const ids = useId();
  // Bumped when the dialog closes or starts over, so a reading still in flight is dropped.
  const attempt = useRef(0);
  // A provider added by a filing that then failed, so a retry doesn't add it twice.
  const added = useRef<{ name: string; categoryId: string; id: string } | null>(null);
  const utilities = categories.find((c) => c.name === 'Utilities') ?? categories[0];
  const blank: BillDraft = {
    ...blankDraft(utilities?.id ?? ''),
    billerId: billers.find((b) => b.entityId === entityId && !b.archived)?.id ?? '',
  };

  const [open, setOpen] = useState(false);
  const [way, setWay] = useState<Way>('upload');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState<Reading | null>(null);
  const [readState, setReadState] = useState<'idle' | 'uploading' | 'reading'>('idle');
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BillDraft>(blank);
  const [errors, setErrors] = useState<Partial<Record<BillField, string>>>({});

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const startOver = (next: Way) => {
    attempt.current += 1;
    setWay(next);
    setFiles([]);
    setReading(null);
    setReadState('idle');
    setReadError(null);
    setDraft(blank);
    setErrors({});
  };
  const openDialog = () => {
    startOver('upload');
    setMessage(null);
    setOpen(true);
  };
  const close = () => {
    attempt.current += 1;
    setOpen(false);
  };

  const addFiles = (list: FileList | File[]) => {
    setReadError(null);
    const picked = [...list];
    const problem = picked.map((f) => receiptFileProblem(f, t)).find(Boolean);
    if (problem) setReadError(problem);
    else setFiles((prev) => [...prev, ...picked]);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  // The phone's sequence: upload each page, make a bill scan of them, wait for it to be read.
  const read = async () => {
    const mine = ++attempt.current;
    setReadError(null);
    setReadState('uploading');
    try {
      const uploads = [];
      for (const f of files) uploads.push(await browserApi.uploadHouseholdBillFile(workspaceId, f, f.name));
      // The same file is already in Montra, or kept in the vault (ADR-0054): the person decides.
      if (anyDuplicate(uploads) && !window.confirm(t('files.duplicate_confirm'))) {
        setReadState('idle');
        return;
      }
      const fileIds = uploads.map((u) => u.fileId);
      // Filed straight away when its provider is learned (ADR-0051); otherwise checked here, and kept in Review.
      const scan = await browserApi.createScan(workspaceId, { kind: 'bill', fileIds, autoFile: true });
      if (mine !== attempt.current) return;
      setReadState('reading');
      const done = await waitForScan(() => browserApi.getScan(workspaceId, scan.id));
      if (mine !== attempt.current) return;
      const filedFor = autoFiledName(done);
      const auto = done?.bill?.filed;
      if (filedFor !== null && auto) {
        const books = entity(auto.entityId);
        setMessage(
          auto.kind === 'business'
            ? {
                tone: 'good',
                text: t('billers.bill_filed_auto_business', { name: filedFor, business: books?.name ?? '' }),
                action: {
                  href: `/w/${workspaceId}/business/${auto.entityId}/bills`,
                  label: t('billers.bill_open_business'),
                },
              }
            : { tone: 'good', text: t('billers.bill_filed_auto', { name: filedFor }) },
        );
        router.refresh();
        close();
        return;
      }
      const ready = done?.status === 'ready';
      const found = ready ? done.bill : null;
      setReading({ scanId: ready ? scan.id : undefined, found });
      setDraft(draftFromReading(found, blank));
      if (!done) setReadError(t('billers.bill_read_slow'));
      else if (!ready || !found) setReadError(t('billers.bill_read_failed'));
    } catch (err) {
      if (mine === attempt.current) setReadError(friendlyMessage(err, t));
    } finally {
      if (mine === attempt.current) setReadState('idle');
    }
  };

  const found = reading?.found ?? null;
  const choices = providerChoices(billers, found);
  const choice = choices.find((c) => c.id === draft.billerId);
  const entity = (id: string | null | undefined) => entities.find((e) => e.id === id);
  // A bill is in its provider's books' currency; a new provider is on this budget.
  const billCurrency = draft.billerId
    ? (entity(choice?.entityId)?.functionalCurrency ?? found?.currency ?? currency)
    : currency;
  const note = matchNote(found, t);
  const set = (k: keyof BillDraft) => (e: { target: { value: string } }) => {
    setDraft({ ...draft, [k]: e.target.value });
    setErrors({ ...errors, [k]: undefined });
  };

  const file = async () => {
    const check = checkBillDraft(draft, billCurrency, locale, t);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    const name = draft.billerId ? (choice?.name ?? '') : draft.newName.trim();
    const filed = await run(async () => {
      let billerId = draft.billerId;
      if (!billerId) {
        const same = added.current;
        billerId =
          same && same.name === name && same.categoryId === draft.categoryId
            ? same.id
            : (
                await browserApi.createBiller(workspaceId, {
                  name,
                  categoryId: draft.categoryId,
                  dueDay: null,
                  accountLast4: found?.accountLast4 ?? null,
                })
              ).id;
        added.current = { name, categoryId: draft.categoryId, id: billerId };
      }
      return browserApi.createHouseholdBill(workspaceId, {
        billerId,
        ...(reading?.scanId ? { scanId: reading.scanId } : {}),
        amount: check.amount,
        dueDate: check.dueDate,
        billDate: check.billDate,
        periodStart: found?.periodStart ?? null,
        periodEnd: found?.periodEnd ?? null,
      });
    });
    if (!filed) return;
    added.current = null;
    // The server says what it made: a household bill (listed below) or a business's vendor bill.
    const books = entity(filed.entityId);
    setMessage(
      filed.kind === 'business'
        ? {
            tone: 'good',
            text: t('billers.bill_filed_business', { name, business: books?.name ?? '' }),
            action: {
              href: `/w/${workspaceId}/business/${filed.entityId}/bills`,
              label: t('billers.bill_open_business'),
            },
          }
        : { tone: 'good', text: t('billers.bill_filed', { name }) },
    );
    close();
  };

  const showForm = way === 'type' || reading !== null;
  const reads = readState !== 'idle';
  const groups = entities
    .map((e) => ({ entity: e, items: choices.filter((c) => c.entityId === e.id) }))
    .filter((g) => g.items.length > 0);
  const unplaced = choices.filter((c) => !entity(c.entityId));

  return (
    <div className="space-y-2">
      <button type="button" className="btn-primary" onClick={openDialog}>
        {t('billers.add_bill')}
      </button>
      {!open && <StatusLine message={message} />}

      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={close}
        className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40"
        data-testid="add-bill"
      >
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={titleId} className="text-lg font-semibold">
              {t('billers.add_bill')}
            </h2>
            <div role="radiogroup" aria-label={t('billers.bill_way')} className="segmented segmented-md">
              {(['upload', 'type'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  role="radio"
                  aria-checked={way === w}
                  disabled={busy}
                  onClick={() => way !== w && startOver(w)}
                >
                  {t(w === 'upload' ? 'billers.bill_way_upload' : 'billers.bill_way_type')}
                </button>
              ))}
            </div>
          </div>

          {way === 'upload' && reading === null && (
            <div className="space-y-3">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={`rounded-md border border-dashed p-4 text-sm ${dragging ? 'border-brand-600 bg-brand-50' : 'border-line'}`}
              >
                <p className="text-muted">{t('billers.bill_upload_hint')}</p>
                <button
                  type="button"
                  className="btn-secondary mt-2"
                  disabled={reads}
                  onClick={() => fileInput.current?.click()}
                >
                  {t('billers.bill_pick_files')}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={RECEIPT_ACCEPT}
                  multiple
                  className="sr-only"
                  aria-label={t('billers.bill_pick_files')}
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
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
                          disabled={reads}
                          onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}
                        >
                          {t('receipts.remove_page')}
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <p role="status" className="text-sm text-muted">
                {readState === 'uploading'
                  ? t('billers.bill_uploading')
                  : readState === 'reading'
                    ? t('billers.bill_reading')
                    : ''}
              </p>
              <FormError message={readError ?? undefined} />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={reads || files.length === 0}
                  onClick={() => void read()}
                >
                  {t('billers.bill_read')}
                </button>
                <button type="button" className="btn-secondary" onClick={close}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {showForm && (
            <form
              className="space-y-3"
              aria-label={t('billers.bill_details')}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void file();
              }}
            >
              {found && (
                <section
                  className="rounded-md border border-line bg-canvas p-3 text-sm"
                  aria-label={t('billers.bill_read_title')}
                  data-testid="bill-reading"
                >
                  <h3 className="mb-2 font-semibold">{t('billers.bill_read_title')}</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted">{t('billers.name')}</dt>
                    <dd>{found.billerName ?? '—'}</dd>
                    <dt className="text-muted">{t('billers.bill_amount_due')}</dt>
                    <dd>
                      {found.amount && found.currency ? (
                        <Money amount={found.amount} currency={found.currency} />
                      ) : (
                        '—'
                      )}
                    </dd>
                    <dt className="text-muted">{t('billers.bill_due_date')}</dt>
                    <dd>{found.dueDate ? <DateText date={found.dueDate} /> : '—'}</dd>
                    <dt className="text-muted">{t('billers.bill_statement_date')}</dt>
                    <dd>{found.billDate ? <DateText date={found.billDate} /> : '—'}</dd>
                    <dt className="text-muted">{t('billers.bill_account')}</dt>
                    <dd>
                      {found.accountLast4 ? t('billers.account_ending', { last4: found.accountLast4 }) : '—'}
                    </dd>
                  </dl>
                </section>
              )}
              {reading && readError && <FormError message={readError} />}
              {reading && <p className="text-sm text-muted">{t('billers.bill_check_hint')}</p>}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id={`${ids}-provider`}
                  label={t('billers.name')}
                  error={errors.billerId}
                  hint={note?.text}
                  className="sm:col-span-2"
                >
                  {(p) => (
                    <select {...p} className="input" value={draft.billerId} onChange={set('billerId')}>
                      {groups.map((g) => (
                        <optgroup key={g.entity.id} label={g.entity.name}>
                          {g.items.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      {unplaced.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      <option value="">{t('billers.bill_new_provider')}</option>
                    </select>
                  )}
                </Field>
                {!draft.billerId && (
                  <>
                    <Field id={`${ids}-name`} label={t('billers.bill_new_name')} error={errors.newName}>
                      {(p) => (
                        <input
                          {...p}
                          className="input"
                          maxLength={200}
                          placeholder={t('billers.name_hint')}
                          value={draft.newName}
                          onChange={set('newName')}
                        />
                      )}
                    </Field>
                    <Field id={`${ids}-category`} label={t('billers.category')} error={errors.categoryId}>
                      {(p) => (
                        <select
                          {...p}
                          className="input"
                          value={draft.categoryId}
                          onChange={set('categoryId')}
                        >
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.group} · {c.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  </>
                )}
                <Field
                  id={`${ids}-amount`}
                  label={t('billers.bill_amount_in', { currency: billCurrency })}
                  error={errors.amount}
                >
                  {(p) => (
                    <input
                      {...p}
                      className="input num"
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft.amount}
                      onChange={set('amount')}
                    />
                  )}
                </Field>
                <Field id={`${ids}-due`} label={t('billers.bill_due_date')} error={errors.dueDate}>
                  {(p) => (
                    <input
                      {...p}
                      className="input"
                      type="date"
                      value={draft.dueDate}
                      onChange={set('dueDate')}
                    />
                  )}
                </Field>
                <Field id={`${ids}-billdate`} label={t('billers.bill_date')} error={errors.billDate}>
                  {(p) => (
                    <input
                      {...p}
                      className="input"
                      type="date"
                      value={draft.billDate}
                      onChange={set('billDate')}
                    />
                  )}
                </Field>
              </div>
              {open && message?.tone === 'bad' && <StatusLine message={message} />}
              <div className="flex flex-wrap gap-2">
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy ? t('common.saving') : t('billers.bill_file')}
                </button>
                {reading && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => startOver('upload')}
                  >
                    {t('billers.bill_start_over')}
                  </button>
                )}
                <button type="button" className="btn-secondary" onClick={close}>
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </div>
  );
}
