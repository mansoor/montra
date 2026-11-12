'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ExpenseDetailDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { attendeesText, parseAttendeeNames, spentByText } from '@/lib/assets';
import { StatusLine, useAction } from '../use-action';

interface Choice {
  id: string;
  name: string;
}

/**
 * Who spent, attendees and purpose on a business transaction (BIZ-18, ADR-0035 §7), with the meal and asset hints. Kept
 * beside the transaction: saving it doesn't re-post anything.
 */
export function ExpenseDetailPanel({
  workspaceId,
  transactionId,
  detail,
  people,
  parties,
  canEdit,
}: {
  workspaceId: string;
  transactionId: string;
  detail: ExpenseDetailDto;
  /** Payroll people of the business; empty when the viewer can't read payroll. */
  people: Choice[];
  /** Customers and vendors of the business. */
  parties: Choice[];
  canEdit: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const initialSpent =
    detail.spentBy === 'owner' ? 'owner' : detail.spentBy === 'person' ? (detail.spentByPersonId ?? '') : '';
  const [spentBy, setSpentBy] = useState(initialSpent);
  const [partyIds, setPartyIds] = useState<string[]>(
    detail.attendees.flatMap((a) => (a.partyId ? [a.partyId] : [])),
  );
  const [names, setNames] = useState(
    detail.attendees
      .filter((a) => !a.partyId)
      .map((a) => a.name)
      .join(', '),
  );
  const [purpose, setPurpose] = useState(detail.businessPurpose ?? '');
  const [pick, setPick] = useState('');
  const assets = `/w/${workspaceId}/business/${detail.entityId}/assets`;
  const who = spentByText(detail, t);

  return (
    <section aria-labelledby="expense-detail-heading" className="card space-y-3" data-testid="expense-detail">
      <h2 id="expense-detail-heading" className="font-medium">
        {t('expense.title')}
      </h2>
      {detail.assetId && (
        <p className="text-sm">
          <Link className="underline" href={`${assets}/${detail.assetId}`}>
            {t('expense.is_asset')}
          </Link>
        </p>
      )}
      {detail.assetCandidate && (
        <p className="text-sm text-warn" data-testid="asset-hint">
          {t('expense.asset_hint')}{' '}
          <Link className="font-medium underline" href={`${assets}?transactionId=${transactionId}`}>
            {t('expense.record_as_asset')}
          </Link>
        </p>
      )}
      {detail.needsMealDetail && (
        <p className="text-sm text-warn" data-testid="meal-hint">
          {t('expense.meal_hint')}
        </p>
      )}
      {!canEdit ? (
        <dl className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">{t('expense.spent_by')}</dt>
          <dd>{who ?? '—'}</dd>
          <dt className="text-muted">{t('expense.attendees')}</dt>
          <dd>{attendeesText(detail) || '—'}</dd>
          <dt className="text-muted">{t('expense.purpose')}</dt>
          <dd>{detail.businessPurpose ?? '—'}</dd>
        </dl>
      ) : (
        <form
          className="space-y-3"
          aria-label={t('expense.title')}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                browserApi.setExpenseDetail(workspaceId, transactionId, {
                  entityId: detail.entityId,
                  spentBy: !spentBy
                    ? null
                    : spentBy === 'owner'
                      ? { kind: 'owner' }
                      : { kind: 'person', personId: spentBy },
                  attendees: [
                    ...partyIds.map((partyId) => ({ partyId })),
                    ...parseAttendeeNames(names).map((name) => ({ name })),
                  ],
                  businessPurpose: purpose.trim() || null,
                  version: detail.version,
                }),
              t('expense.saved'),
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="field-label">{t('expense.spent_by')}</span>
              <select className="input" value={spentBy} onChange={(e) => setSpentBy(e.target.value)}>
                <option value="">{t('expense.spent_by_none')}</option>
                <option value="owner">{t('expense.spent_by_owner')}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {detail.spentBy === 'person' && !people.some((p) => p.id === detail.spentByPersonId) && (
                  <option value={detail.spentByPersonId ?? ''}>{detail.spentByName}</option>
                )}
              </select>
            </label>
            <label>
              <span className="field-label">{t('expense.purpose')}</span>
              <input
                className="input"
                maxLength={500}
                value={purpose}
                placeholder={t('expense.purpose_placeholder')}
                onChange={(e) => setPurpose(e.target.value)}
              />
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="field-label">{t('expense.attendees')}</legend>
            {partyIds.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {partyIds.map((id) => (
                  <li key={id} className="chip">
                    {parties.find((p) => p.id === id)?.name ??
                      detail.attendees.find((a) => a.partyId === id)?.name}
                    <button
                      type="button"
                      className="ml-1"
                      aria-label={t('expense.remove_attendee', {
                        name: parties.find((p) => p.id === id)?.name ?? '',
                      })}
                      onClick={() => setPartyIds(partyIds.filter((x) => x !== id))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {parties.length > 0 && (
              <div className="flex flex-wrap items-end gap-2">
                <label>
                  <span className="sr-only">{t('expense.add_party')}</span>
                  <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
                    <option value="">{t('expense.add_party')}</option>
                    {parties
                      .filter((p) => !partyIds.includes(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!pick}
                  onClick={() => {
                    setPartyIds([...partyIds, pick]);
                    setPick('');
                  }}
                >
                  {t('expense.add')}
                </button>
              </div>
            )}
            <label className="block">
              <span className="field-label">{t('expense.other_attendees')}</span>
              <input
                className="input"
                value={names}
                placeholder={t('expense.other_attendees_placeholder')}
                onChange={(e) => setNames(e.target.value)}
              />
            </label>
          </fieldset>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('expense.save')}
          </button>
          <StatusLine message={message} />
        </form>
      )}
    </section>
  );
}
