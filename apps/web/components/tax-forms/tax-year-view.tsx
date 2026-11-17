'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { TaxFormDto, TaxFormExpectedDto, TaxYearDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { anyReading, byPerson, resultChip } from '@/lib/tax-forms';
import { useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';
import { TaxFormDropZone, useRefreshWhile } from './tax-form-drop-zone';
import { TaxFormEditor, type AccountOption, type EmployerOption, type Option } from './tax-form-editor';

/** A form's result in words: Matches the books · Differs by $412.50 · Not tracked in the books · Needs a match … */
export function TaxFormResult({ form }: { form: TaxFormDto }) {
  const { t, money } = useI18n();
  const r = form.result;
  return (
    <span className={resultChip(r.state)} data-testid="tax-form-result">
      {r.state === 'differs' && r.difference
        ? t('tax_forms.result.differs_by', {
            amount: money(BigInt(r.difference) < 0n ? -BigInt(r.difference) : BigInt(r.difference), 'USD'),
          })
        : t(`tax_forms.result.${r.state}`)}
    </span>
  );
}

/** A form's title: its kind and issuer; a file not read yet by its name. */
export function formTitle(
  t: (k: string, v?: Record<string, string | number>) => string,
  form: TaxFormDto,
): string {
  if (form.reading && !form.reading.kindKnown)
    return form.reading.fileNames[0] ?? t('tax_forms.kind_unknown');
  return form.issuerName
    ? t('tax_forms.title_from', { kind: t(`tax_forms.kind.${form.kind}`), issuer: form.issuerName })
    : t(`tax_forms.kind.${form.kind}`);
}

/**
 * A year's tax forms (ADR-0052 §7.1): the forms expected, grouped by person, each Received (with its result), Not yet or
 * Won't come; the forms received that match nothing expected; and typing a form in.
 */
export function TaxYearView({
  workspaceId,
  data,
  members,
  employers,
  accounts,
  canWrite,
  canMatchEmployer,
}: {
  workspaceId: string;
  data: TaxYearDto;
  members: readonly Option[];
  employers: readonly EmployerOption[];
  accounts: readonly AccountOption[];
  canWrite: boolean;
  canMatchEmployer: boolean;
}) {
  const { t } = useI18n();
  const { busy, message, run } = useAction();
  const [typing, setTyping] = useState(false);
  const [waiving, setWaiving] = useState<string | null>(null);
  const [reason, setReason] = useState<'not_issued' | 'combined' | 'other'>('not_issued');
  const [note, setNote] = useState('');
  const names = new Map(members.map((m) => [m.id, m.name]));
  const forms = new Map(data.forms.map((f) => [f.id, f]));
  const base = `/w/${workspaceId}/tax-forms`;
  const keyOf = (e: TaxFormExpectedDto) => `${e.kind}:${e.employerId ?? e.accountId}`;
  const unexpected = data.unexpectedFormIds
    .map((id) => forms.get(id))
    .filter((f): f is TaxFormDto => !!f && f.status !== 'reading');
  const reading = data.forms.filter((f) => f.status === 'reading');
  useRefreshWhile(anyReading(data.forms));

  async function waive(e: TaxFormExpectedDto) {
    const done = await run(
      () =>
        browserApi.createTaxFormWaiver(workspaceId, {
          taxYear: data.year,
          kind: e.kind,
          ...(e.employerId
            ? { employerId: e.employerId }
            : { accountId: e.accountId!, personMemberId: e.personMemberId }),
          reason,
          note: note.trim() || null,
        }),
      t('tax_forms.waived'),
    );
    if (done) {
      setWaiving(null);
      setNote('');
    }
  }

  return (
    <div className="space-y-6">
      <StatusLine message={message} />
      {canWrite && <TaxFormDropZone workspaceId={workspaceId} year={data.year} />}
      {reading.length > 0 && (
        <section aria-labelledby="tax-being-read" className="space-y-3">
          <h2 id="tax-being-read" className="text-base font-semibold">
            {t('tax_forms.being_read')}
          </h2>
          <ul className="card-flush divide-y divide-line">
            {reading.map((f) => (
              <li
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                data-testid="tax-being-read"
              >
                <p className="min-w-0 font-medium">{formTitle(t, f)}</p>
                <div className="flex items-center gap-2">
                  <TaxFormResult form={f} />
                  <Link href={`${base}/${f.id}`} className="btn-secondary">
                    {t('tax_forms.open')}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="tax-expected" className="space-y-3">
        <div>
          <h2 id="tax-expected" className="text-base font-semibold">
            {t('tax_forms.expected_title')}
          </h2>
          <p className="text-sm text-muted">{t('tax_forms.expected_intro')}</p>
        </div>
        {data.expected.length === 0 ? (
          <p className="card text-sm text-muted">{t('tax_forms.expected_none')}</p>
        ) : (
          byPerson(data.expected, names).map((g) => (
            <div key={g.personMemberId ?? 'household'} className="card-flush">
              <h3 className="px-4 pt-3 text-sm font-semibold">{g.name ?? t('tax_forms.household')}</h3>
              <ul className="divide-y divide-line">
                {g.items.map((e) => {
                  const form = e.formId ? forms.get(e.formId) : undefined;
                  const k = keyOf(e);
                  return (
                    <li key={k} className="space-y-2 px-4 py-3" data-testid="tax-expected">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {t(`tax_forms.kind.${e.kind}`)} · {e.name}
                          </p>
                          <p className="text-xs text-muted">
                            {t(`tax_forms.expected_because.${e.kind}`)}{' '}
                            <Money amount={e.amount} currency="USD" />
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {e.state === 'received' && form ? (
                            <>
                              <span className="chip chip-good">{t('tax_forms.expected_state.received')}</span>
                              <TaxFormResult form={form} />
                              <Link href={`${base}/${form.id}`} className="btn-secondary">
                                {t('tax_forms.open')}
                              </Link>
                            </>
                          ) : e.state === 'waived' ? (
                            <>
                              <span className="chip chip-muted">
                                {t('tax_forms.expected_state.waived')}:{' '}
                                {t(
                                  `tax_forms.waiver_reason.${data.waivers.find((w) => w.id === e.waiverId)?.reason ?? 'other'}`,
                                )}
                              </span>
                              {canWrite && (
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    run(() => browserApi.deleteTaxFormWaiver(workspaceId, e.waiverId!))
                                  }
                                >
                                  {t('tax_forms.unwaive')}
                                </button>
                              )}
                            </>
                          ) : (
                            <>
                              <span className="chip chip-warn">{t('tax_forms.expected_state.missing')}</span>
                              {canWrite && waiving !== k && (
                                <button type="button" className="btn-secondary" onClick={() => setWaiving(k)}>
                                  {t('tax_forms.waive')}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {waiving === k && (
                        <div
                          className="flex flex-wrap items-end gap-2"
                          role="group"
                          aria-label={t('tax_forms.waive')}
                        >
                          <div>
                            <label htmlFor={`waive-${k}`} className="field-label">
                              {t('tax_forms.waiver_reason_label')}
                            </label>
                            <select
                              id={`waive-${k}`}
                              className="input"
                              value={reason}
                              onChange={(ev) => setReason(ev.target.value as typeof reason)}
                            >
                              {(['not_issued', 'combined', 'other'] as const).map((r) => (
                                <option key={r} value={r}>
                                  {t(`tax_forms.waiver_reason.${r}`)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="min-w-[12rem] flex-1">
                            <label htmlFor={`waive-note-${k}`} className="field-label">
                              {t('tax_forms.note')}
                            </label>
                            <input
                              id={`waive-note-${k}`}
                              className="input"
                              value={note}
                              onChange={(ev) => setNote(ev.target.value)}
                            />
                          </div>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy}
                            onClick={() => waive(e)}
                          >
                            {t('tax_forms.waive_save')}
                          </button>
                          <button type="button" className="btn-secondary" onClick={() => setWaiving(null)}>
                            {t('common.cancel')}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </section>

      <section aria-labelledby="tax-unexpected" className="space-y-3">
        <h2 id="tax-unexpected" className="text-base font-semibold">
          {t('tax_forms.unexpected_title')}
        </h2>
        {unexpected.length === 0 ? (
          <p className="text-sm text-muted">{t('tax_forms.unexpected_none')}</p>
        ) : (
          <ul className="card-flush divide-y divide-line">
            {unexpected.map((f) => (
              <li
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                data-testid="tax-received"
              >
                <div className="min-w-0">
                  <p className="font-medium">{formTitle(t, f)}</p>
                  {f.personMemberId && <p className="text-xs text-muted">{names.get(f.personMemberId)}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <TaxFormResult form={f} />
                  <Link href={`${base}/${f.id}`} className="btn-secondary">
                    {t('tax_forms.open')}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canWrite && (
        <section aria-labelledby="tax-type-in" className="space-y-3">
          <h2 id="tax-type-in" className="text-base font-semibold">
            {t('tax_forms.type_in')}
          </h2>
          {typing ? (
            <TaxFormEditor
              workspaceId={workspaceId}
              year={data.year}
              members={members}
              employers={employers}
              accounts={accounts}
              canMatchEmployer={canMatchEmployer}
              onCancel={() => setTyping(false)}
            />
          ) : (
            <>
              <p className="text-sm text-muted">{t('tax_forms.type_in_intro')}</p>
              <button type="button" className="btn-primary" onClick={() => setTyping(true)}>
                {t('tax_forms.type_in')}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
