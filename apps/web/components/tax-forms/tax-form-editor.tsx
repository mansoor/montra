'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TaxFormDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import {
  BOX12_CODES,
  boxFields,
  boxesOf,
  KINDS,
  MONEY_BOXES,
  type BoxFields,
  type TaxFormKind,
} from '@/lib/tax-forms';
import { useI18n } from '../i18n';

export interface Option {
  id: string;
  name: string;
}
export interface AccountOption extends Option {
  kind: string;
}
export interface EmployerOption extends Option {
  memberId: string;
}

/**
 * Typing a form in, or changing one (ADR-0052 §7.1): the kind and year (when new), the issuer, the person, what it's
 * matched to, and the boxes. A W-2 is matched to an employer; a 1099 to one or more accounts (a bank's form often
 * covers them all); a 1098 to the mortgage. Picking the match teaches Montra for next year.
 */
export function TaxFormEditor({
  workspaceId,
  form,
  year,
  members,
  employers,
  accounts,
  canMatchEmployer,
  onCancel,
}: {
  workspaceId: string;
  /** The form to change; a new one is typed in when absent. */
  form?: TaxFormDto;
  year: number;
  members: readonly Option[];
  employers: readonly EmployerOption[];
  accounts: readonly AccountOption[];
  /** An accountant doesn't match a W-2 to an employer (employers are private to their person). */
  canMatchEmployer: boolean;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [kind, setKind] = useState<TaxFormKind>(form?.kind ?? 'w2');
  const [taxYear, setTaxYear] = useState(String(form?.taxYear ?? year));
  const [issuerName, setIssuerName] = useState(form?.issuerName ?? '');
  const [issuerEin, setIssuerEin] = useState(
    form?.issuerEin ? `${form.issuerEin.slice(0, 2)}-${form.issuerEin.slice(2)}` : '',
  );
  const [accountLast4, setAccountLast4] = useState(form?.accountLast4 ?? '');
  const [personTinLast4, setPersonTinLast4] = useState(form?.personTinLast4 ?? '');
  const [person, setPerson] = useState(form?.personMemberId ?? '');
  const [employerId, setEmployerId] = useState(form?.targets.find((x) => x.employerId)?.employerId ?? '');
  const [accountIds, setAccountIds] = useState<string[]>(
    form?.targets.flatMap((x) => (x.accountId ? [x.accountId] : [])) ?? [],
  );
  const [fields, setFields] = useState<BoxFields>(() => boxFields(form?.kind ?? 'w2', form?.boxes ?? {}));
  const [error, setError] = useState<{ field?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = form ? `tf-${form.id}` : 'tf-new';
  // A form from a file that isn't confirmed may have been misread, or not read at all: its kind and year can change.
  const kindEditable = !form || (form.source !== 'typed' && form.status !== 'confirmed');

  const setMoney = (k: string, v: string) => setFields((f) => ({ ...f, money: { ...f.money, [k]: v } }));
  const changeKind = (k: TaxFormKind) => {
    setKind(k);
    setFields(boxFields(k, {}));
    setEmployerId('');
    setAccountIds([]);
  };
  const pickable = accounts.filter((a) =>
    kind === '1098'
      ? a.kind === 'mortgage' || a.kind === 'loan'
      : !['credit_card', 'loan', 'mortgage', 'line_of_credit', 'liability'].includes(a.kind),
  );
  const toggleAccount = (a: string) =>
    setAccountIds((ids) =>
      kind === '1098' ? [a] : ids.includes(a) ? ids.filter((x) => x !== a) : [...ids, a],
    );

  async function save() {
    setError(null);
    const boxes = boxesOf(kind, fields, form && form.kind === kind ? form.boxes : {}, t);
    if (!boxes.ok) return setError({ field: boxes.field, text: boxes.error });
    const targets =
      kind === 'w2' ? (employerId ? [{ employerId }] : []) : accountIds.map((accountId) => ({ accountId }));
    const common = {
      issuerName: issuerName.trim() || null,
      issuerEin: issuerEin.trim() || null,
      accountLast4: accountLast4.trim() || null,
      personTinLast4: personTinLast4.trim() || null,
      personMemberId: person || null,
      targets,
    };
    setBusy(true);
    try {
      if (form) {
        // An unchanged match isn't sent: picking a match is what teaches Montra, and an accountant can't re-send a W-2's.
        const before = form.targets.map((x) => x.employerId ?? x.accountId).join(',');
        const after = targets.map((x) => ('employerId' in x ? x.employerId : x.accountId)).join(',');
        const saved = await browserApi.updateTaxForm(workspaceId, form.id, {
          ...common,
          ...(kindEditable && (kind !== form.kind || form.reading?.kindKnown === false) ? { kind } : {}),
          ...(kindEditable && Number(taxYear) !== form.taxYear ? { taxYear: Number(taxYear) } : {}),
          targets: before === after ? undefined : targets,
          // A W-2 matched to an employer is for its person; don't send a different one.
          ...(kind === 'w2' && employerId ? { personMemberId: before === after ? undefined : null } : {}),
          boxes: boxes.boxes,
          version: form.version,
        });
        router.refresh();
        onCancel?.();
        return saved;
      }
      const made = await browserApi.createTaxForm(workspaceId, {
        ...common,
        ...(kind === 'w2' && employerId ? { personMemberId: null } : {}),
        kind,
        taxYear: Number(taxYear),
        boxes: boxes.boxes,
      } as Parameters<typeof browserApi.createTaxForm>[1]);
      router.push(`/w/${workspaceId}/tax-forms/${made.id}`);
    } catch (err) {
      setError({ text: friendlyMessage(err, t) });
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (f: string) => (error?.field === f ? error.text : undefined);
  const moneyInput = (key: string, label: string, value: string, onChange: (v: string) => void) => (
    <div key={key}>
      <label htmlFor={`${id}-${key}`} className="field-label">
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        className="input"
        inputMode="decimal"
        value={value}
        aria-invalid={fieldError(key) ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {fieldError(key) && (
        <p className="field-error" role="alert">
          {fieldError(key)}
        </p>
      )}
    </div>
  );

  return (
    <form
      className="card space-y-4"
      aria-label={form ? t('tax_forms.edit') : t('tax_forms.type_in')}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {kindEditable && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-kind`} className="field-label">
              {t('tax_forms.kind_label')}
            </label>
            <select
              id={`${id}-kind`}
              className="input"
              value={kind}
              onChange={(e) => changeKind(e.target.value as TaxFormKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`tax_forms.kind.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-year`} className="field-label">
              {t('tax_forms.tax_year')}
            </label>
            <input
              id={`${id}-year`}
              className="input"
              inputMode="numeric"
              value={taxYear}
              onChange={(e) => setTaxYear(e.target.value)}
            />
          </div>
        </div>
      )}

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">{t('tax_forms.issuer_section')}</legend>
        <div>
          <label htmlFor={`${id}-issuer`} className="field-label">
            {t(
              kind === 'w2'
                ? 'tax_forms.employer_name'
                : kind === '1098'
                  ? 'tax_forms.lender_name'
                  : 'tax_forms.payer_name',
            )}
          </label>
          <input
            id={`${id}-issuer`}
            className="input"
            value={issuerName}
            onChange={(e) => setIssuerName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${id}-ein`} className="field-label">
            {t('tax_forms.ein')}
          </label>
          <input
            id={`${id}-ein`}
            className="input"
            placeholder="12-3456789"
            value={issuerEin}
            onChange={(e) => setIssuerEin(e.target.value)}
          />
        </div>
        {kind !== 'w2' && (
          <div>
            <label htmlFor={`${id}-acct4`} className="field-label">
              {t('tax_forms.account_last4')}
            </label>
            <input
              id={`${id}-acct4`}
              className="input"
              inputMode="numeric"
              maxLength={4}
              value={accountLast4}
              onChange={(e) => setAccountLast4(e.target.value)}
            />
          </div>
        )}
        <div>
          <label htmlFor={`${id}-tin4`} className="field-label">
            {t('tax_forms.person_tin_last4')}
          </label>
          <input
            id={`${id}-tin4`}
            className="input"
            inputMode="numeric"
            maxLength={4}
            value={personTinLast4}
            onChange={(e) => setPersonTinLast4(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">{t('tax_forms.person_tin_hint')}</p>
        </div>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">{t('tax_forms.match_section')}</legend>
        {kind === 'w2' ? (
          <div>
            <label htmlFor={`${id}-employer`} className="field-label">
              {t('tax_forms.employer')}
            </label>
            {canMatchEmployer ? (
              <select
                id={`${id}-employer`}
                className="input"
                value={employerId}
                onChange={(e) => setEmployerId(e.target.value)}
              >
                <option value="">{t('tax_forms.not_matched')}</option>
                {employers.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            ) : (
              <p id={`${id}-employer`} className="text-sm text-muted">
                {t('tax_forms.employer_not_yours')}
              </p>
            )}
          </div>
        ) : (
          <div role="group" aria-label={t(kind === '1098' ? 'tax_forms.mortgage' : 'tax_forms.accounts')}>
            <p className="field-label">{t(kind === '1098' ? 'tax_forms.mortgage' : 'tax_forms.accounts')}</p>
            {pickable.length === 0 && <p className="text-sm text-muted">{t('tax_forms.no_accounts')}</p>}
            <ul className="space-y-1">
              {pickable.map((a) => (
                <li key={a.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type={kind === '1098' ? 'radio' : 'checkbox'}
                      name={`${id}-accounts`}
                      checked={accountIds.includes(a.id)}
                      onChange={() => toggleAccount(a.id)}
                    />
                    {a.name}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!(kind === 'w2' && employerId) && (
          <div>
            <label htmlFor={`${id}-person`} className="field-label">
              {t('tax_forms.person')}
            </label>
            <select
              id={`${id}-person`}
              className="input"
              value={person}
              onChange={(e) => setPerson(e.target.value)}
            >
              <option value="">{t('tax_forms.person_unknown')}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">{t('tax_forms.boxes_section')}</legend>
        {MONEY_BOXES[kind].map((k) =>
          moneyInput(
            k,
            t('tax_forms.box_label', { box: k.slice(3), name: t(`tax_forms.box_name.${kind}.${k}`) }),
            fields.money[k] ?? '',
            (v) => setMoney(k, v),
          ),
        )}
        {kind === 'w2' && (
          <>
            {fields.box12.map((e, i) => (
              <div key={`b12-${i}`} className="flex items-end gap-2">
                <div>
                  <label htmlFor={`${id}-b12c-${i}`} className="field-label">
                    {t('tax_forms.box12_code', { n: i + 1 })}
                  </label>
                  <select
                    id={`${id}-b12c-${i}`}
                    className="input"
                    value={e.code}
                    onChange={(ev) =>
                      setFields((f) => ({
                        ...f,
                        box12: f.box12.map((x, j) => (j === i ? { ...x, code: ev.target.value } : x)),
                      }))
                    }
                  >
                    {[...new Set([e.code, ...BOX12_CODES])].filter(Boolean).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                {moneyInput(`box12.${i}`, t('tax_forms.box12_amount', { n: i + 1 }), e.amount, (v) =>
                  setFields((f) => ({
                    ...f,
                    box12: f.box12.map((x, j) => (j === i ? { ...x, amount: v } : x)),
                  })),
                )}
              </div>
            ))}
            {fields.box12.length < 4 && (
              <div className="flex items-end">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setFields((f) => ({ ...f, box12: [...f.box12, { code: 'D', amount: '' }] }))}
                >
                  {t('tax_forms.box12_add')}
                </button>
              </div>
            )}
            <div>
              <label htmlFor={`${id}-state`} className="field-label">
                {t('tax_forms.box15_state')}
              </label>
              <input
                id={`${id}-state`}
                className="input"
                maxLength={2}
                value={fields.state.state}
                onChange={(e) => setFields((f) => ({ ...f, state: { ...f.state, state: e.target.value } }))}
              />
            </div>
            {(['box16', 'box17'] as const).map((b) =>
              moneyInput(`state.${b}`, t(`tax_forms.w2_${b}`), fields.state[b], (v) =>
                setFields((f) => ({ ...f, state: { ...f.state, [b]: v } })),
              ),
            )}
          </>
        )}
        {kind === '1098' && (
          <>
            <div>
              <label htmlFor={`${id}-box3`} className="field-label">
                {t('tax_forms.box_1098_box3')}
              </label>
              <input
                id={`${id}-box3`}
                type="date"
                className="input"
                value={fields.box3}
                onChange={(e) => setFields((f) => ({ ...f, box3: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor={`${id}-box10label`} className="field-label">
                {t('tax_forms.box_1098_box10_label')}
              </label>
              <input
                id={`${id}-box10label`}
                className="input"
                value={fields.box10Label}
                onChange={(e) => setFields((f) => ({ ...f, box10Label: e.target.value }))}
              />
            </div>
          </>
        )}
      </fieldset>

      {error && !error.field && (
        <p role="alert" className="text-sm text-bad">
          {error.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {form ? t('tax_forms.save') : t('tax_forms.add')}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
