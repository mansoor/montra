'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import type { IntakeDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import {
  billNeedsInput,
  canFile,
  detectedLines,
  initialTarget,
  targetOptions,
  waitingImport,
} from '@/lib/intakes';
import { parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';

export interface Pickable {
  id: string;
  name: string;
  archived?: boolean;
}

/**
 * One statement or bill to file (ADR-0051 §5): what the file says, why it waits, and a picker of the account or
 * biller with the candidates first. Finishing it teaches the match memory; a statement then opens in the existing
 * import preview.
 */
export function IntakeCard({
  workspaceId,
  role,
  intake,
  accounts,
  billers,
  note,
  onDone,
}: {
  workspaceId: string;
  role: string | undefined;
  intake: IntakeDto;
  accounts: readonly Pickable[];
  billers: readonly Pickable[];
  /** A line under the file name, e.g. that the file was uploaded before. */
  note?: ReactNode;
  /** The intake as it is after resolving or putting it aside. */
  onDone: (intake: IntakeDto) => void;
}) {
  const { t, locale } = useI18n();
  const statement = intake.kind === 'statement';
  const options = useMemo(
    () => targetOptions(intake, statement ? accounts : billers),
    [intake, statement, accounts, billers],
  );
  const [target, setTarget] = useState(initialTarget(intake));
  const needs = billNeedsInput(intake);
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState(intake.bill?.dueDate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const may = canFile(role, intake.kind);
  const preview = waitingImport(intake);
  const base = `/w/${workspaceId}`;

  async function finish() {
    if (!target) return;
    setError(null);
    let minor: string | undefined;
    if (needs.amount) {
      const parsed = parseAmountInput(amount, intake.bill?.currency ?? 'USD', locale, t);
      if (!parsed.ok) return setError(parsed.error);
      minor = parsed.minor.toString();
    }
    setBusy(true);
    try {
      const done = await browserApi.resolveIntake(workspaceId, intake.id, {
        targetId: target,
        ...(minor ? { amount: minor } : {}),
        ...(needs.dueDate && due ? { dueDate: due } : {}),
      });
      onDone(done);
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      onDone(await browserApi.dismissIntake(workspaceId, intake.id));
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const pickId = `intake-target-${intake.id}`;
  return (
    <li className="card space-y-3" data-testid="intake-item">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{intake.fileName}</p>
          <p className="text-xs text-muted">
            {t(statement ? 'intakes.kind.statement' : 'intakes.kind.bill')}
            {detectedLines(intake).map((d) => (
              <span key={d.key}> · {t(d.key, d.values)}</span>
            ))}
          </p>
          {note}
          {intake.duplicateOf && (
            // The same file was uploaded before: most likely a second copy, so putting it aside is offered first.
            <div role="alert" className="mt-2 space-y-1 text-sm text-warn" data-testid="intake-duplicate">
              <p>
                {t('intakes.possible_duplicate', {
                  date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                    new Date(intake.duplicateOf.uploadedAt),
                  ),
                })}
              </p>
              <button type="button" className="btn-secondary" disabled={busy} onClick={dismiss}>
                {t('intakes.discard_duplicate')}
              </button>
            </div>
          )}
        </div>
        {intake.bill?.amount && intake.bill.currency && (
          <p className="text-right text-sm">
            <Money amount={intake.bill.amount} currency={intake.bill.currency} />
            {intake.bill.dueDate && (
              <span className="block text-xs text-muted">
                {t('intakes.due')} <DateText date={intake.bill.dueDate} />
              </span>
            )}
          </p>
        )}
      </div>

      <p className="text-sm" data-testid="intake-why">
        {intake.status === 'suggested' && intake.targetName
          ? t('intakes.suggested', { name: intake.targetName })
          : intake.reason
            ? t(`intakes.reason.${intake.reason}`)
            : t('intakes.reason.no_match')}
      </p>
      {intake.learning && intake.learning.confirmations > 0 && (
        <p className="text-xs text-muted">
          {t('intakes.learning', { count: intake.learning.confirmations, needed: intake.learning.needed })}
        </p>
      )}

      {may ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <label htmlFor={pickId} className="field-label">
              {t(statement ? 'intakes.pick_account' : 'intakes.pick_biller')}
            </label>
            {options.length === 0 ? (
              <p className="text-sm text-muted">
                {t(statement ? 'imports.upload.no_accounts' : 'intakes.no_billers')}
              </p>
            ) : (
              <select
                id={pickId}
                className="input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {!target && <option value="">{t('intakes.choose')}</option>}
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.hint ? `${o.label} (${t(o.hint.key, o.hint.values)})` : o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          {needs.amount && (
            <div>
              <label htmlFor={`${pickId}-amount`} className="field-label">
                {t('intakes.amount')}
              </label>
              <input
                id={`${pickId}-amount`}
                className="input w-32"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          )}
          {needs.dueDate && (
            <div>
              <label htmlFor={`${pickId}-due`} className="field-label">
                {t('intakes.due_date')}
              </label>
              <input
                id={`${pickId}-due`}
                type="date"
                className="input"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </div>
          )}
          <button type="button" className="btn-primary" disabled={!target || busy} onClick={finish}>
            {t(statement ? 'intakes.import' : 'intakes.file_bill')}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={dismiss}>
            {t('intakes.dismiss')}
          </button>
        </div>
      ) : null}
      {preview && (
        <p className="text-sm">
          <Link className="font-medium text-brand-600 underline" href={`${base}/imports/${preview}`}>
            {t('intakes.open_import')}
          </Link>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </li>
  );
}
