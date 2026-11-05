'use client';

import { Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { depositChoices } from '@montra/domain';
import type { AccountDto, PayslipDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  buildUpdate,
  codeLabel,
  LINE_CODES,
  liveTotals,
  rowsOf,
  SECTIONS,
  STATUS_CHIP,
  type PayslipFields,
  type PayslipRow,
  depositRowsOf,
  depositsInput,
  type DepositRow,
} from '@/lib/payslips';
import { DateText, useI18n } from '../i18n';
import { DepositSplitEditor } from './deposit-split-editor';
import { Money } from '../money';
import { ReceiptViewer } from '../receipts/receipt-viewer';
import { StatusLine, useAction } from '../use-action';

/**
 * The payslip review screen (PAY-02, PAY-03): the payslip beside what was read from it. Nothing posts until the
 * user confirms, and it confirms only when the lines add up to the printed net pay. Several deposits that could
 * be this pay are offered to choose from (PAY-04).
 */
export function PayslipReview({
  workspaceId,
  payslip,
  mainAccountId,
  accounts,
}: {
  workspaceId: string;
  payslip: PayslipDto;
  mainAccountId: string;
  accounts: AccountDto[];
}) {
  const router = useRouter();
  const { run, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const initial = useMemo(() => rowsOf(payslip), [payslip]);
  const [fields, setFields] = useState<PayslipFields>(initial.fields);
  const [rows, setRows] = useState<PayslipRow[]>(initial.rows);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [nextKey, setNextKey] = useState(0);
  const [splitRows, setSplitRows] = useState<DepositRow[]>(() =>
    depositRowsOf(payslip.deposits, payslip.currency),
  );
  const [picks, setPicks] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setFields(initial.fields);
    setRows(initial.rows);
    setSplitRows(depositRowsOf(payslip.deposits, payslip.currency));
    setPicks({});
  }, [initial, payslip.deposits, payslip.currency]);

  // While the payslip is being read, check back every couple of seconds.
  useEffect(() => {
    if (payslip.status !== 'processing') return;
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [payslip.status, router]);

  const ccy = payslip.currency;
  const posted = payslip.status === 'posted';
  const totals = liveTotals(rows, fields.net, ccy);
  const setRow = (key: string, patch: Partial<PayslipRow>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const candidates = payslip.status === 'needs_review' ? payslip.matchCandidates : [];
  const askedAccounts = [...new Set(candidates.map((c) => c.accountId))];
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';
  /** Picks one account's deposit, and goes ahead once every account asked about has an answer. */
  function pick(accountId: string, transactionId: string | null) {
    const next = { ...picks, [accountId]: transactionId };
    setPicks(next);
    if (askedAccounts.every((a) => a in next)) void confirm(next);
  }

  function addRow(section: PayslipRow['section']) {
    const code = LINE_CODES[section][0]!;
    setRows((list) => [
      ...list,
      {
        key: `new-${nextKey}`,
        section,
        code,
        label: codeLabel(section, code, t),
        amount: '',
        ytd: '',
        accountId: null,
      },
    ]);
    setNextKey((n) => n + 1);
  }

  /** What's on screen as a request, or null after pointing at what needs fixing first. */
  function prepare() {
    const res = buildUpdate(payslip.version, fields, rows, ccy, undefined, t);
    if (!res.ok) {
      setErrors(res.errors);
      setMessage({ tone: 'bad', text: res.errors.lines ?? t('payslips.fix_fields') });
      return null;
    }
    // Where the pay went can't change once it's posted.
    if (posted) {
      setErrors({});
      return res.input;
    }
    const split = depositsInput(splitRows, ccy, locale, t);
    if (!split.ok) {
      setMessage({ tone: 'bad', text: split.error });
      return null;
    }
    setErrors({});
    return { ...res.input, deposits: split.deposits };
  }

  async function saveOnly() {
    const input = prepare();
    if (!input) return;
    await run(() => browserApi.updatePayslip(workspaceId, payslip.id, input), t('payslips.saved'));
  }

  async function confirm(chosen: Record<string, string | null> = {}) {
    const input = prepare();
    if (!input) return;
    await run(
      async () => {
        const saved = await browserApi.updatePayslip(workspaceId, payslip.id, input);
        return browserApi.confirmPayslip(workspaceId, payslip.id, {
          version: saved.version,
          ...depositChoices(
            payslip.deposits.map((d) => d.accountId),
            chosen,
          ),
        });
      },
      (r) =>
        r.status === 'posted'
          ? t(r.matchedDeposit ? 'payslips.posted_matched' : 'payslips.posted_new')
          : t('payslips.choose_deposit'),
    );
  }

  async function remove() {
    const done = await run(async () => {
      await browserApi.deletePayslip(workspaceId, payslip.id);
      return true;
    });
    if (done) router.push(`/w/${workspaceId}/payslips`);
  }

  const viewer = payslip.fileIds.length > 0 && (
    <aside aria-label={t('payslips.image')} className="lg:sticky lg:top-20 lg:h-[calc(100dvh-9rem)]">
      <ReceiptViewer
        pages={payslip.fileIds.map((fileId, i) => ({
          src: browserApi.payslipFilePath(workspaceId, payslip.id, fileId),
          alt: t('receipts.page_n', { n: i + 1 }),
        }))}
      />
    </aside>
  );
  const layout = viewer
    ? 'grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,42%)]'
    : 'space-y-4';

  if (payslip.status === 'processing') {
    return (
      <div className={layout}>
        <p role="status" className="card text-sm text-muted">
          {t('payslips.reading')}
        </p>
        {viewer}
      </div>
    );
  }

  return (
    <div className={layout}>
      <section className="space-y-4" aria-label={t('payslips.details')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={STATUS_CHIP[payslip.status]}>{t(`payslips.status.${payslip.status}`)}</span>
          {payslip.matchedDeposit && <span className="chip">{t('payslips.matched_chip')}</span>}
          {!posted &&
            payslip.extraction?.warnings.map((w) => (
              <span key={w} className="chip chip-warn">
                {w}
              </span>
            ))}
          {payslip.transactionId && (
            <Link
              href={`/w/${workspaceId}/transactions/${payslip.transactionId}`}
              className="text-sm underline"
            >
              {t('payslips.open_transaction')}
            </Link>
          )}
        </div>

        <div className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            label={t('payslips.pay_date')}
            type="date"
            value={fields.payDate}
            error={errors.payDate}
            onChange={(payDate) => setFields((f) => ({ ...f, payDate }))}
          />
          <TextField
            label={t('payslips.period_start')}
            type="date"
            value={fields.periodStart}
            onChange={(periodStart) => setFields((f) => ({ ...f, periodStart }))}
          />
          <TextField
            label={t('payslips.period_end')}
            type="date"
            value={fields.periodEnd}
            onChange={(periodEnd) => setFields((f) => ({ ...f, periodEnd }))}
          />
          <TextField
            label={t('payslips.net')}
            value={fields.net}
            inputMode="decimal"
            error={errors.net}
            onChange={(net) => setFields((f) => ({ ...f, net }))}
          />
        </div>

        {SECTIONS.map((section) => {
          const inSection = rows.filter((r) => r.section === section);
          return (
            <section key={section} className="card space-y-2" aria-label={t(`payslips.section.${section}`)}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{t(`payslips.section.${section}`)}</h2>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => addRow(section)}
                  aria-label={t('payslips.add_line_to', { section: t(`payslips.section.${section}`) })}
                >
                  <Plus aria-hidden size={14} /> {t('payslips.add_line')}
                </button>
              </div>
              {section === 'employer' && <p className="text-xs text-muted">{t('payslips.employer_hint')}</p>}
              {inSection.map((r) => (
                <LineEditor
                  key={r.key}
                  row={r}
                  errors={errors}
                  onChange={(patch) => setRow(r.key, patch)}
                  onRemove={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                />
              ))}
            </section>
          );
        })}

        <section className="card space-y-1 text-sm" aria-label={t('payslips.totals')}>
          <Total label={t('payslips.gross')} amount={totals.gross} currency={ccy} />
          <Total label={t('payslips.section.pre_tax')} amount={-totals.preTax} currency={ccy} />
          <Total label={t('payslips.section.tax')} amount={-totals.taxes} currency={ccy} />
          <Total label={t('payslips.section.post_tax')} amount={-totals.postTax} currency={ccy} />
          <div className="border-t border-line pt-1">
            <Total label={t('payslips.computed_net')} amount={totals.computedNet} currency={ccy} strong />
          </div>
          {totals.gap !== 0n ? (
            <p role="alert" className="text-warn">
              {t('payslips.gap')} <Money amount={totals.gap} currency={ccy} />
            </p>
          ) : (
            <p className="text-good">{t('payslips.adds_up')}</p>
          )}
        </section>

        <section className="card space-y-2" aria-labelledby="deposits-title" data-testid="payslip-deposits">
          <h2 id="deposits-title" className="text-sm font-semibold">
            {t('deposits.title')}
          </h2>
          {posted ? (
            <ul className="divide-y divide-line text-sm">
              <li className="flex justify-between gap-2 py-1.5" data-testid="payslip-deposit">
                <span>{accountName(mainAccountId)}</span>
                <Money amount={payslip.mainDeposit} currency={ccy} />
              </li>
              {payslip.deposits.map((d) => (
                <li
                  key={d.accountId}
                  className="flex justify-between gap-2 py-1.5"
                  data-testid="payslip-deposit"
                >
                  <span>
                    {accountName(d.accountId)}
                    {d.matchedDeposit && <span className="chip ml-2">{t('payslips.matched_chip')}</span>}
                  </span>
                  <Money amount={d.amount} currency={ccy} />
                </li>
              ))}
            </ul>
          ) : (
            <>
              <p className="text-sm text-muted">{t('deposits.hint')}</p>
              <DepositSplitEditor
                rows={splitRows}
                onChange={setSplitRows}
                accounts={accounts}
                mainAccountId={mainAccountId}
                currency={ccy}
                net={fields.net}
              />
            </>
          )}
        </section>

        {candidates.length > 0 && (
          <section className="card space-y-2" aria-label={t('payslips.choose_deposit')}>
            <h2 className="text-sm font-semibold">{t('payslips.choose_deposit')}</h2>
            <p className="text-sm text-muted">{t('payslips.choose_deposit_hint')}</p>
            {askedAccounts.map((accountId) => (
              <div key={accountId} className="space-y-1" data-testid="deposit-choice">
                {askedAccounts.length > 1 || payslip.deposits.length > 0 ? (
                  <h3 className="text-sm font-medium">{accountName(accountId)}</h3>
                ) : null}
                <ul className="divide-y divide-line">
                  {candidates
                    .filter((c) => c.accountId === accountId)
                    .map((c) => (
                      <li
                        key={c.transactionId}
                        className="flex flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <span className="text-sm">
                          <DateText date={c.date} /> · {c.payee ?? t('payslips.deposit')} ·{' '}
                          <Money amount={c.amount} currency={ccy} />
                        </span>
                        <button
                          type="button"
                          className={picks[accountId] === c.transactionId ? 'btn-primary' : 'btn-secondary'}
                          aria-pressed={picks[accountId] === c.transactionId}
                          disabled={busy}
                          onClick={() => pick(accountId, c.transactionId)}
                        >
                          {t('payslips.use_this_deposit')}
                        </button>
                      </li>
                    ))}
                </ul>
                <button
                  type="button"
                  className={picks[accountId] === null ? 'btn-primary' : 'btn-secondary'}
                  aria-pressed={picks[accountId] === null}
                  disabled={busy}
                  onClick={() => pick(accountId, null)}
                >
                  {t('payslips.none_of_these')}
                </button>
              </div>
            ))}
          </section>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!posted && candidates.length === 0 && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || totals.gap !== 0n}
              onClick={() => confirm()}
            >
              {t('payslips.confirm')}
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={busy} onClick={saveOnly}>
            {posted ? t('payslips.save_repost') : t('payslips.save')}
          </button>
          {confirmingDelete ? (
            <>
              <button type="button" className="btn-danger" disabled={busy} onClick={remove}>
                {t(payslip.matchedDeposit ? 'payslips.delete_keep_deposit' : 'payslips.delete_confirm')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirmingDelete(false)}>
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="btn-ghost ml-auto" onClick={() => setConfirmingDelete(true)}>
              {t('payslips.delete')}
            </button>
          )}
        </div>
        <StatusLine message={message} />
      </section>
      {viewer}
    </div>
  );
}

function LineEditor({
  row,
  errors,
  onChange,
  onRemove,
}: {
  row: PayslipRow;
  errors: Record<string, string>;
  onChange: (patch: Partial<PayslipRow>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const codes = LINE_CODES[row.section];
  const known = codes.includes(row.code);
  const name = row.label || t(`payslips.section.${row.section}`);
  return (
    <div
      className="grid items-start gap-2 sm:grid-cols-[11rem_minmax(0,1fr)_7rem_7rem_auto]"
      data-testid="payslip-line"
    >
      <select
        className="input"
        aria-label={t('payslips.line_kind', { name })}
        value={row.code}
        onChange={(e) => {
          const code = e.target.value;
          const wasDefault = known && row.label === codeLabel(row.section, row.code, t);
          onChange({ code, ...(wasDefault || !row.label ? { label: codeLabel(row.section, code, t) } : {}) });
        }}
      >
        {!known && <option value={row.code}>{row.label}</option>}
        {codes.map((c) => (
          <option key={c} value={c}>
            {c === 'other' ? t('payslips.code_other') : t(`payslips.code.${c}`)}
          </option>
        ))}
      </select>
      <TextField
        label={t('payslips.line_label')}
        hideLabel
        value={row.label}
        error={errors[`line.${row.key}.label`]}
        onChange={(label) => onChange({ label })}
      />
      <TextField
        label={t('payslips.line_amount', { name })}
        hideLabel
        placeholder={t('payslips.amount')}
        inputMode="decimal"
        value={row.amount}
        error={errors[`line.${row.key}.amount`]}
        onChange={(amount) => onChange({ amount })}
      />
      <TextField
        label={t('payslips.line_ytd', { name })}
        hideLabel
        placeholder={t('payslips.ytd')}
        inputMode="decimal"
        value={row.ytd}
        error={errors[`line.${row.key}.ytd`]}
        onChange={(ytd) => onChange({ ytd })}
      />
      <button
        type="button"
        className="icon-btn"
        onClick={onRemove}
        aria-label={t('payslips.remove_line', { name })}
      >
        <X aria-hidden size={15} />
      </button>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  error,
  type = 'text',
  inputMode,
  placeholder,
  hideLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  inputMode?: 'decimal';
  placeholder?: string;
  hideLabel?: boolean;
}) {
  return (
    <label className="block">
      <span className={hideLabel ? 'sr-only' : 'field-label'}>{label}</span>
      <input
        className="input"
        type={type}
        inputMode={inputMode}
        placeholder={placeholder}
        value={value}
        aria-invalid={error ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

function Total({
  label,
  amount,
  currency,
  strong,
}: {
  label: string;
  amount: bigint;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? 'font-semibold' : ''}`}>
      <span>{label}</span>
      <Money amount={amount} currency={currency} />
    </div>
  );
}
