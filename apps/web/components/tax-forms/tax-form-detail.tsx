'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TaxFormDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { acceptable, checkChip } from '@/lib/tax-forms';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { TaxFormEditor, type AccountOption, type EmployerOption, type Option } from './tax-form-editor';
import { TaxFormResult } from './tax-year-view';

type Check = TaxFormDto['checks'][number];

/** One check's drill-down: the rule in words, the explanation, and what was summed (RPT-03). */
function HowWorkedOut({ workspaceId, check }: { workspaceId: string; check: Check }) {
  const { t } = useI18n();
  const base = `/w/${workspaceId}`;
  const s = check.sources;
  const count = s.payslipIds.length + s.transactionIds.length + s.journalEntryIds.length;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted">{t('tax_forms.how')}</summary>
      <div className="mt-2 space-y-1">
        <p>{check.rule}</p>
        {check.explanation && <p className="text-muted">{check.explanation}</p>}
        {check.acceptedNote && (
          <p className="text-muted">{t('tax_forms.accepted_note', { note: check.acceptedNote })}</p>
        )}
        {count > 0 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {s.payslipIds.map((id, i) => (
              <li key={id}>
                <Link href={`${base}/payslips/${id}`} className="underline">
                  {t('tax_forms.source_payslip', { n: i + 1 })}
                </Link>
              </li>
            ))}
            {s.transactionIds.map((id, i) => (
              <li key={id}>
                <Link href={`${base}/transactions/${id}`} className="underline">
                  {t('tax_forms.source_transaction', { n: i + 1 })}
                </Link>
              </li>
            ))}
            {s.journalEntryIds.length > 0 && (
              <li>
                <Link href={`${base}/journal`} className="underline">
                  {t('tax_forms.source_entries', { count: s.journalEntryIds.length })}
                </Link>
              </li>
            )}
          </ul>
        )}
        {count === 0 && check.books !== null && check.kind === 'check' && (
          <p className="text-xs text-muted">{t('tax_forms.no_drilldown')}</p>
        )}
      </div>
    </details>
  );
}

/**
 * One form (ADR-0052 §7.1): its result, the checks box by box with how each was worked out, and what can be done about a
 * difference (fix the books through the drill-down, fix the boxes, accept it with a note, change the match), plus
 * Record from the form for income a valued account never posted.
 */
export function TaxFormDetail({
  workspaceId,
  form,
  members,
  employers,
  accounts,
  canWrite,
  canMatchEmployer,
}: {
  workspaceId: string;
  form: TaxFormDto;
  members: readonly Option[];
  employers: readonly EmployerOption[];
  accounts: readonly AccountOption[];
  canWrite: boolean;
  canMatchEmployer: boolean;
}) {
  const { t, money } = useI18n();
  const router = useRouter();
  const { busy, message, run } = useAction();
  const [accepting, setAccepting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmRecord, setConfirmRecord] = useState(false);
  const usd = (v: string) => money(BigInt(v), 'USD');
  const recordable = form.result.recordable;

  async function accept(box: string) {
    if (!note.trim()) return;
    const done = await run(
      () => browserApi.acceptTaxFormDifference(workspaceId, form.id, { box, note: note.trim() }),
      t('tax_forms.accepted'),
    );
    if (done) {
      setAccepting(null);
      setNote('');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <TaxFormResult form={form} />
        {form.corrected && <span className="chip">{t('tax_forms.corrected')}</span>}
      </div>
      <StatusLine message={message} />

      {form.checks.length === 0 ? (
        <p className="card text-sm text-muted">{t('tax_forms.no_checks')}</p>
      ) : (
        <section className="card-flush overflow-x-auto" aria-label={t('tax_forms.checks')}>
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t('tax_forms.col_box')}</th>
                <th scope="col" className="text-right">
                  {t('tax_forms.col_form')}
                </th>
                <th scope="col" className="text-right">
                  {t('tax_forms.col_books')}
                </th>
                <th scope="col" className="text-right">
                  {t('tax_forms.col_difference')}
                </th>
                <th scope="col">{t('tax_forms.col_result')}</th>
              </tr>
            </thead>
            <tbody>
              {form.checks.map((c) => (
                <tr key={c.box} data-testid="tax-check">
                  <th scope="row" className="align-top font-medium">
                    {t('tax_forms.box_short', { box: c.box })}
                  </th>
                  <td className="text-right align-top">
                    {c.form !== null ? <Money amount={c.form} currency="USD" /> : '—'}
                  </td>
                  <td className="text-right align-top">
                    {c.books !== null ? <Money amount={c.books} currency="USD" /> : '—'}
                  </td>
                  <td className="text-right align-top">
                    {c.difference !== null && c.kind === 'check' ? (
                      <Money amount={c.difference} currency="USD" />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="space-y-2 align-top">
                    <span className={checkChip(c.status)}>{t(`tax_forms.check_status.${c.status}`)}</span>
                    <HowWorkedOut workspaceId={workspaceId} check={c} />
                    {canWrite && acceptable(c) && accepting !== c.box && (
                      <button
                        type="button"
                        className="btn-secondary"
                        aria-label={t('tax_forms.accept_box', { box: c.box })}
                        onClick={() => {
                          setAccepting(c.box);
                          setNote('');
                        }}
                      >
                        {t('tax_forms.accept')}
                      </button>
                    )}
                    {accepting === c.box && (
                      <div className="flex flex-wrap items-end gap-2">
                        <div>
                          <label htmlFor={`accept-${c.box}`} className="field-label">
                            {t('tax_forms.accept_note')}
                          </label>
                          <input
                            id={`accept-${c.box}`}
                            className="input"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                          />
                        </div>
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busy || !note.trim()}
                          onClick={() => accept(c.box)}
                        >
                          {t('tax_forms.accept_save')}
                        </button>
                        <button type="button" className="btn-secondary" onClick={() => setAccepting(null)}>
                          {t('common.cancel')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {recordable && canWrite && (
        <section className="card space-y-2" aria-labelledby="tax-record">
          <h2 id="tax-record" className="text-base font-semibold">
            {t('tax_forms.record_title')}
          </h2>
          <p className="text-sm">
            {t('tax_forms.record_intro', {
              amount: usd(recordable.amount),
              category: recordable.categoryName,
              account: recordable.accountName,
              year: form.taxYear,
            })}
          </p>
          {confirmRecord ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  run(
                    () => browserApi.recordFromTaxForm(workspaceId, form.id, recordable.amount),
                    t('tax_forms.recorded'),
                  )
                }
              >
                {t('tax_forms.record_confirm', {
                  amount: usd(recordable.amount),
                  category: recordable.categoryName,
                })}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirmRecord(false)}>
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => setConfirmRecord(true)}>
              {t('tax_forms.record')}
            </button>
          )}
        </section>
      )}
      {form.result.recorded && (
        <section
          className="card flex flex-wrap items-center justify-between gap-2 text-sm"
          aria-label={t('tax_forms.record_title')}
        >
          <p>
            {t('tax_forms.recorded_on', { amount: usd(form.result.recorded.amount) })}{' '}
            <DateText date={form.result.recorded.date} />
          </p>
          {canWrite && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                run(
                  () => browserApi.undoRecordFromTaxForm(workspaceId, form.id),
                  t('tax_forms.record_undone'),
                )
              }
            >
              {t('tax_forms.record_undo')}
            </button>
          )}
        </section>
      )}

      {canWrite &&
        (editing ? (
          <TaxFormEditor
            workspaceId={workspaceId}
            form={form}
            year={form.taxYear}
            members={members}
            employers={employers}
            accounts={accounts}
            canMatchEmployer={canMatchEmployer}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
              {t('tax_forms.edit')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={async () => {
                const done = await run(() => browserApi.deleteTaxForm(workspaceId, form.id).then(() => true));
                if (done) router.push(`/w/${workspaceId}/tax-forms?year=${form.taxYear}`);
              }}
            >
              {t('tax_forms.delete')}
            </button>
          </div>
        ))}
    </div>
  );
}
