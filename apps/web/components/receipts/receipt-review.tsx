'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { AccountDto, CategoryDto, FamilyMemberDto, ReceiptDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  amountPlaceholder,
  buildUpdate,
  rowsOf,
  STATUS_CHIP,
  type HeaderFields,
  type LineRow,
} from '@/lib/receipts';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { ReceiptViewer } from './receipt-viewer';

/**
 * The receipt review screen (RCP-06): the receipt image beside its lines. Lines get a category (and entity,
 * RCP-07) and member each; the same category groups into one split (RCP-03). Changing a line's category
 * teaches an item rule. Applying links the receipt to a transaction and splits it (04 §7 step 7).
 */
export function ReceiptReview({
  workspace,
  receipt,
  categories,
  members,
  accounts,
}: {
  workspace: WorkspaceDto;
  receipt: ReceiptDto;
  categories: CategoryDto[];
  members: FamilyMemberDto[];
  accounts: AccountDto[];
}) {
  const router = useRouter();
  const { run, busy, message, setMessage, t } = useAction();
  const initial = useMemo(() => rowsOf(receipt), [receipt]);
  const [header, setHeader] = useState<HeaderFields>(initial.header);
  const [lines, setLines] = useState<LineRow[]>(initial.lines);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  useEffect(() => {
    setHeader(initial.header);
    setLines(initial.lines);
  }, [initial]);

  // While the receipt is being read, check back every couple of seconds.
  useEffect(() => {
    if (receipt.status !== 'processing') return;
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [receipt.status, router]);

  const ws = workspace.id;
  const entityName = new Map(workspace.entities.map((e) => [e.id, e.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const byEntity = workspace.entities.map((e) => ({
    entity: e,
    options: categories.filter((c) => c.entityId === e.id && c.type === 'expense'),
  }));
  const currency = header.currency || receipt.currency || 'USD';
  const open = receipt.status === 'inbox' || receipt.status === 'needs_review';
  const setLine = (i: number, patch: Partial<LineRow>) =>
    setLines((list) => list.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save() {
    const res = buildUpdate(receipt.version, header, lines, undefined, t);
    if (!res.ok) {
      setErrors(res.errors);
      setMessage({ tone: 'bad', text: t('receipts.fix_fields') });
      return;
    }
    setErrors({});
    await run(() => browserApi.updateReceipt(ws, receipt.id, res.input), t('receipts.saved'));
  }

  const viewer = (
    // The receipt itself, kept in view while the lines are checked (RCP-06).
    <aside aria-label={t('receipts.image')} className="lg:sticky lg:top-20 lg:h-[calc(100dvh-9rem)]">
      <ReceiptViewer
        pages={receipt.fileIds.map((fileId, i) => ({
          src: browserApi.receiptFilePath(ws, receipt.id, fileId),
          alt: t('receipts.page_n', { n: i + 1 }),
        }))}
      />
    </aside>
  );

  if (receipt.status === 'processing') {
    return (
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,42%)]">
        <p role="status" className="card text-sm text-muted">
          {t('receipts.reading')}
        </p>
        {viewer}
      </div>
    );
  }

  const gap = receipt.validationGap ? BigInt(receipt.validationGap) : null;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,42%)]">
      <section className="space-y-4" aria-label={t('receipts.details')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={STATUS_CHIP[receipt.status]}>{t(`receipts.status.${receipt.status}`)}</span>
          {receipt.extraction?.warnings.map((w) => (
            <span key={w} className="chip chip-warn">
              {w}
            </span>
          ))}
          {receipt.transactionId && (
            <Link href={`/w/${ws}/transactions/${receipt.transactionId}`} className="text-sm underline">
              {t('receipts.open_transaction')}
            </Link>
          )}
        </div>

        {gap !== null && gap !== 0n && (
          <p role="alert" className="text-sm text-warn">
            {t('receipts.gap')} <Money amount={gap} currency={currency} />
          </p>
        )}

        <div className="card grid gap-3 sm:grid-cols-3">
          {(
            [
              ['merchant', 'receipts.merchant', 'text'],
              ['receiptDate', 'receipts.date', 'date'],
              ['localTime', 'receipts.time', 'time'],
              ['currency', 'receipts.currency', 'text'],
              ['total', 'receipts.total', 'amount'],
              ['tax', 'receipts.tax', 'amount'],
              ['discount', 'receipts.discount', 'amount'],
              ['fees', 'receipts.fees', 'amount'],
              ['tip', 'receipts.tip', 'amount'],
            ] as const
          ).map(([key, label, kind]) => (
            <label key={key} className="text-sm">
              <span className="field-label">{t(label)}</span>
              <input
                className="input"
                type={kind === 'amount' ? 'text' : kind}
                inputMode={kind === 'amount' ? 'decimal' : undefined}
                placeholder={kind === 'amount' ? amountPlaceholder(currency) : undefined}
                aria-invalid={errors[key] ? 'true' : undefined}
                value={header[key]}
                onChange={(e) => setHeader({ ...header, [key]: e.target.value })}
              />
              {errors[key] && <span className="field-error">{errors[key]}</span>}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={header.taxIncluded}
              onChange={(e) => setHeader({ ...header, taxIncluded: e.target.checked })}
            />
            {t('receipts.tax_included')}
          </label>
        </div>

        <table className="w-full text-sm">
          <caption className="sr-only">{t('receipts.lines')}</caption>
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1">{t('receipts.item')}</th>
              <th className="py-1">{t('receipts.amount')}</th>
              <th className="py-1">{t('receipts.taxable')}</th>
              <th className="py-1">{t('receipts.category')}</th>
              <th className="py-1">{t('receipts.member')}</th>
              <th className="py-1">
                <span className="sr-only">{t('receipts.remove_line')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((l, i) => {
              const suggested = receipt.lines.find((x) => x.id === l.id)?.categorization?.suggested
                ?.categoryId;
              return (
                <tr key={l.id ?? `new-${i}`} data-testid="receipt-line">
                  <td className="py-1 pr-2">
                    <input
                      className="input"
                      aria-label={t('receipts.item')}
                      aria-invalid={errors[`rawText.${i}`] ? 'true' : undefined}
                      value={l.rawText}
                      onChange={(e) => setLine(i, { rawText: e.target.value })}
                    />
                    <input
                      className="input mt-1 text-xs"
                      aria-label={t('receipts.expanded_name')}
                      placeholder={t('receipts.expanded_name')}
                      value={l.expandedName}
                      onChange={(e) => setLine(i, { expandedName: e.target.value })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      className="input num w-24"
                      inputMode="decimal"
                      aria-label={t('receipts.amount')}
                      aria-invalid={errors[`lineTotal.${i}`] ? 'true' : undefined}
                      value={l.lineTotal}
                      onChange={(e) => setLine(i, { lineTotal: e.target.value })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="checkbox"
                      aria-label={t('receipts.taxable')}
                      checked={l.taxable}
                      onChange={(e) => setLine(i, { taxable: e.target.checked })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <select
                      className="input"
                      aria-label={t('receipts.category_for', { item: l.rawText })}
                      value={l.categoryId}
                      onChange={(e) => setLine(i, { categoryId: e.target.value })}
                    >
                      <option value="">{t('receipts.uncategorized')}</option>
                      {byEntity.map(({ entity, options }) =>
                        options.length ? (
                          <optgroup key={entity.id} label={entity.name}>
                            {options.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </optgroup>
                        ) : null,
                      )}
                    </select>
                    {!l.categoryId && suggested && (
                      <button
                        type="button"
                        className="mt-1 text-xs underline"
                        onClick={() => setLine(i, { categoryId: suggested })}
                      >
                        {t('receipts.use_suggestion', { name: categoryName.get(suggested) ?? '' })}
                      </button>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <select
                      className="input"
                      aria-label={t('receipts.member')}
                      value={l.memberId}
                      onChange={(e) => setLine(i, { memberId: e.target.value })}
                    >
                      <option value="">{t('receipts.household')}</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1">
                    <button
                      type="button"
                      className="text-xs text-muted underline"
                      onClick={() => setLines((list) => list.filter((_, j) => j !== i))}
                    >
                      {t('receipts.remove_line')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              setLines((list) => [
                ...list,
                {
                  rawText: '',
                  expandedName: '',
                  lineTotal: '',
                  discount: '',
                  taxable: true,
                  categoryId: '',
                  memberId: '',
                },
              ])
            }
          >
            {t('receipts.add_line')}
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={save}>
            {t('receipts.save')}
          </button>
        </div>

        {receipt.groups.length > 0 && (
          <div className="card space-y-1" aria-label={t('receipts.splits')}>
            <h2 className="font-medium">{t('receipts.splits')}</h2>
            <ul className="text-sm">
              {receipt.groups.map((g) => (
                <li key={g.lineIds.join()} className="flex justify-between gap-2" data-testid="receipt-split">
                  <span>
                    {g.categoryId ? categoryName.get(g.categoryId) : t('receipts.uncategorized')}
                    {workspace.entities.length > 1 && g.entityId ? ` · ${entityName.get(g.entityId)}` : ''}
                  </span>
                  <Money amount={g.total} currency={currency} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {open && (
          <div className="card space-y-2">
            <h2 className="font-medium">{t('receipts.match_title')}</h2>
            {receipt.candidates.length === 0 && (
              <p className="text-sm text-muted">{t('receipts.no_candidates')}</p>
            )}
            <ul className="divide-y divide-line text-sm">
              {receipt.candidates.map((c) => (
                <li key={c.transactionId} className="flex flex-wrap items-center gap-2 py-2">
                  <DateText date={c.date} />
                  <span>{c.payee}</span>
                  <Money amount={c.amount.amount} currency={c.amount.currency} />
                  <span className="chip chip-muted">
                    {t('receipts.score', { score: Math.trunc(c.score * 100) })}
                  </span>
                  <span className="text-xs text-muted">{c.reasons.join(' · ')}</span>
                  <button
                    type="button"
                    className="btn-secondary ml-auto"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          browserApi.applyReceipt(ws, receipt.id, {
                            transactionId: c.transactionId,
                            version: receipt.version,
                          }),
                        t('receipts.applied'),
                      )
                    }
                  >
                    {t('receipts.use_transaction')}
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="field-label">{t('receipts.paid_from')}</span>
                <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !accountId}
                onClick={() =>
                  run(
                    () =>
                      browserApi.applyReceipt(ws, receipt.id, {
                        createTransaction: { accountId },
                        version: receipt.version,
                      }),
                    t('receipts.applied'),
                  )
                }
              >
                {t('receipts.create_transaction')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  run(() => browserApi.matchReceipt(ws, receipt.id), t('receipts.matched_again'))
                }
              >
                {t('receipts.match_again')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => run(() => browserApi.rejectReceipt(ws, receipt.id), t('receipts.rejected'))}
              >
                {t('receipts.reject')}
              </button>
            </div>
          </div>
        )}
        <StatusLine message={message} />
      </section>

      {viewer}
    </div>
  );
}
