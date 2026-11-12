'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { BusinessAssetDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

interface Choice {
  id: string;
  name: string;
}

/** One asset (BIZ-16, BIZ-17): its schedule, who holds it, and disposal. Figures are estimates, not tax advice. */
export function AssetDetail({
  workspaceId,
  asset: a,
  today,
  people,
  accounts,
}: {
  workspaceId: string;
  asset: BusinessAssetDto;
  today: string;
  people: Choice[];
  accounts: Choice[];
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const router = useRouter();
  const ccy = a.currency;
  const [personId, setPersonId] = useState(people[0]?.id ?? '');
  const [assignedOn, setAssignedOn] = useState(today);
  const [note, setNote] = useState('');
  const [returnedOn, setReturnedOn] = useState(today);
  const [disposedOn, setDisposedOn] = useState(today);
  const [proceeds, setProceeds] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [disposalNote, setDisposalNote] = useState('');
  const lastPosted = [...a.schedule].reverse().find((s) => s.posted);
  const held = a.assignedTo;

  return (
    <div className="space-y-4">
      <section className="card space-y-2" aria-labelledby="asset-title">
        <h2 id="asset-title" className="text-lg font-semibold">
          {a.name}
        </h2>
        <dl className="grid gap-1 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted">{t('assets.category')}</dt>
          <dd>{t(`assets.category_${a.category}`)}</dd>
          {a.serial && (
            <>
              <dt className="text-muted">{t('assets.serial')}</dt>
              <dd>{a.serial}</dd>
            </>
          )}
          <dt className="text-muted">{t('assets.cost')}</dt>
          <dd>
            <Money amount={a.cost} currency={ccy} />
            {a.transactionId && (
              <>
                {' · '}
                <Link className="underline" href={`/w/${workspaceId}/transactions/${a.transactionId}`}>
                  {t('assets.purchase')}
                </Link>
              </>
            )}
          </dd>
          <dt className="text-muted">{t('assets.in_service')}</dt>
          <dd>
            <DateText date={a.inServiceDate} />
          </dd>
          <dt className="text-muted">{t('assets.method')}</dt>
          <dd>
            {t(`assets.method_${a.method}`)}
            {a.method !== 'expense_now' && ` · ${t('assets.years', { n: a.lifeYears })}`}
          </dd>
          {BigInt(a.section179) > 0n && (
            <>
              <dt className="text-muted">{t('assets.section_179')}</dt>
              <dd>
                <Money amount={a.section179} currency={ccy} />
              </dd>
            </>
          )}
          <dt className="text-muted">{t('assets.accumulated')}</dt>
          <dd data-testid="asset-accumulated">
            <Money amount={a.accumulated} currency={ccy} />
          </dd>
          <dt className="text-muted">{t('assets.book_value')}</dt>
          <dd data-testid="asset-book-value">
            <Money amount={a.bookValue} currency={ccy} />
          </dd>
        </dl>
      </section>

      {a.schedule.length > 0 && (
        <section className="card-flush" aria-label={t('assets.schedule')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('assets.year')}</th>
                <th className="px-2 py-2 text-right">{t('assets.deduction')}</th>
                <th className="px-4 py-2">{t('assets.in_books')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {a.schedule.map((s) => (
                <tr key={s.year} data-testid="schedule-row">
                  <td className="num px-4 py-1.5">{s.year}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Money amount={s.amount} currency={ccy} />
                  </td>
                  <td className="px-4 py-1.5">
                    {s.posted ? t('assets.posted_yes') : t('assets.posted_no')}
                    {s.posted && s.year === lastPosted?.year && !a.disposal && (
                      <button
                        type="button"
                        className="ml-3 text-sm underline"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => browserApi.unpostDepreciation(workspaceId, a.id, s.year),
                            t('assets.unposted'),
                          )
                        }
                      >
                        {t('assets.unpost')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card space-y-3" aria-labelledby="holder-title">
        <h2 id="holder-title" className="text-base font-semibold">
          {t('assets.holder')}
        </h2>
        {held ? (
          <form
            className="flex flex-wrap items-end gap-3"
            aria-label={t('assets.mark_returned')}
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () => browserApi.returnAsset(workspaceId, held.id, { returnedOn, version: held.version }),
                t('assets.returned'),
              );
            }}
          >
            <p className="w-full text-sm" data-testid="asset-holder">
              {t('assets.held_by', { name: held.personName })} · <DateText date={held.assignedOn} />
            </p>
            <label>
              <span className="field-label">{t('assets.returned_on')}</span>
              <input
                className="input"
                type="date"
                required
                value={returnedOn}
                onChange={(e) => setReturnedOn(e.target.value)}
              />
            </label>
            <button type="submit" className="btn-secondary" disabled={busy}>
              {t('assets.mark_returned')}
            </button>
          </form>
        ) : a.disposal ? (
          <p className="text-sm text-muted">{t('assets.nobody')}</p>
        ) : people.length === 0 ? (
          <p className="text-sm text-muted">{t('assets.no_people')}</p>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            aria-label={t('assets.assign')}
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  browserApi.assignAsset(workspaceId, a.id, {
                    personId,
                    assignedOn,
                    note: note.trim() || null,
                  }),
                t('assets.assigned'),
              );
            }}
          >
            <label>
              <span className="field-label">{t('assets.person')}</span>
              <select className="input" value={personId} onChange={(e) => setPersonId(e.target.value)}>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('assets.assigned_on')}</span>
              <input
                className="input"
                type="date"
                required
                value={assignedOn}
                onChange={(e) => setAssignedOn(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('assets.note')}</span>
              <input
                className="input"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('assets.assign')}
            </button>
          </form>
        )}
        {a.assignments.length > 0 && (
          <ul className="divide-y divide-line text-sm" aria-label={t('assets.history')}>
            {a.assignments.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap justify-between gap-2 py-1.5"
                data-testid="assignment-row"
              >
                <span>
                  {h.personName}
                  {h.note ? ` · ${h.note}` : ''}
                </span>
                <span className="text-muted">
                  <DateText date={h.assignedOn} /> –{' '}
                  {h.returnedOn ? <DateText date={h.returnedOn} /> : t('assets.now')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-3" aria-labelledby="disposal-title">
        <h2 id="disposal-title" className="text-base font-semibold">
          {t('assets.disposal')}
        </h2>
        {a.disposal ? (
          <>
            <p className="text-sm" data-testid="asset-disposal">
              {t('assets.disposed_on')} <DateText date={a.disposal.date} /> · {t('assets.proceeds')}{' '}
              <Money amount={a.disposal.proceeds} currency={ccy} /> ·{' '}
              {BigInt(a.disposal.gain) >= 0n ? t('assets.gain') : t('assets.loss')}{' '}
              <Money amount={a.disposal.gain.replace('-', '')} currency={ccy} />
            </p>
            <p className="text-xs text-muted">{t('assets.form_4797')}</p>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                run(() => browserApi.undoAssetDisposal(workspaceId, a.id), t('assets.disposal_undone'))
              }
            >
              {t('assets.undo_disposal')}
            </button>
          </>
        ) : (
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            aria-label={t('assets.dispose')}
            onSubmit={(e) => {
              e.preventDefault();
              let minor = 0n;
              if (proceeds.trim()) {
                const p = parseAmountInput(proceeds, ccy, locale, t);
                if (!p.ok) return setMessage({ tone: 'bad', text: p.error });
                minor = p.minor;
              }
              void run(
                () =>
                  browserApi.disposeAsset(workspaceId, a.id, {
                    date: disposedOn,
                    proceeds: String(minor),
                    note: disposalNote.trim() || null,
                    payment: minor > 0n && accountId ? { accountId } : null,
                    version: a.version,
                  }),
                t('assets.disposed'),
              );
            }}
          >
            <label>
              <span className="field-label">{t('assets.disposed_on')}</span>
              <input
                className="input"
                type="date"
                required
                value={disposedOn}
                onChange={(e) => setDisposedOn(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('assets.proceeds')}</span>
              <input
                className="input"
                inputMode="decimal"
                value={proceeds}
                placeholder="0"
                onChange={(e) => setProceeds(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('assets.proceeds_account')}</span>
              <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('assets.note')}</span>
              <input
                className="input"
                maxLength={500}
                value={disposalNote}
                onChange={(e) => setDisposalNote(e.target.value)}
              />
            </label>
            <div className="sm:col-span-2 lg:col-span-4">
              <button type="submit" className="btn-secondary" disabled={busy}>
                {t('assets.dispose')}
              </button>
            </div>
          </form>
        )}
      </section>

      <StatusLine message={message} />
      {!a.disposal && (
        <button
          type="button"
          className="text-sm text-bad underline"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(t('assets.delete_confirm'))) return;
            void run(async () => {
              await browserApi.deleteAsset(workspaceId, a.id);
              return true;
            }, t('assets.deleted')).then((ok) => {
              if (ok) router.push(`/w/${workspaceId}/business/${a.entityId}/assets`);
            });
          }}
        >
          {t('assets.delete')}
        </button>
      )}
    </div>
  );
}
