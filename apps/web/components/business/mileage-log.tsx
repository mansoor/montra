'use client';

import { useState } from 'react';
import type { MileageSummaryDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { canReimburse, driverText } from '@/lib/assets';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/**
 * Mileage (BIZ-07): each trip gets the IRS rate in force on its date. A deduction for Schedule C, not a transaction.
 * Only the owner's trips are the deduction; someone else's is reimbursed through payroll instead (BIZ-19).
 */
export function MileageLog({
  workspaceId,
  entityId,
  summary,
  today,
  people,
}: {
  workspaceId: string;
  entityId: string;
  summary: MileageSummaryDto;
  today: string;
  /** Payroll people who can be the driver; empty when the viewer can't read payroll. */
  people: { id: string; name: string }[];
}) {
  const { run, busy, message, t } = useAction();
  const [date, setDate] = useState(today);
  const [purpose, setPurpose] = useState('');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [miles, setMiles] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [driver, setDriver] = useState('');

  return (
    <div className="space-y-5">
      <form
        className="card space-y-3"
        aria-label={t('mileage.add')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              browserApi.createMileageTrip(workspaceId, {
                entityId,
                date,
                purpose,
                miles: miles.trim(),
                origin: origin.trim() || null,
                destination: destination.trim() || null,
                vehicle: vehicle.trim() || null,
                driverPersonId: driver || null,
              }),
            (trip) => t('mileage.added', { rate: trip.centsPerMile }),
          ).then((r) => {
            if (r) {
              setPurpose('');
              setOrigin('');
              setDestination('');
              setMiles('');
            }
          });
        }}
      >
        <h2 className="text-base font-semibold">{t('mileage.add')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label>
            <span className="field-label">{t('mileage.date')}</span>
            <input
              className="input"
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('mileage.miles')}</span>
            <input
              className="input"
              inputMode="decimal"
              required
              pattern="\d{1,6}(\.\d)?"
              title={t('mileage.miles_hint')}
              value={miles}
              onChange={(e) => setMiles(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('mileage.purpose')}</span>
            <input
              className="input"
              required
              maxLength={500}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('mileage.from')}</span>
            <input
              className="input"
              maxLength={200}
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('mileage.to')}</span>
            <input
              className="input"
              maxLength={200}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('mileage.driver')}</span>
            <select className="input" value={driver} onChange={(e) => setDriver(e.target.value)}>
              <option value="">{t('mileage.driver_owner')}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('mileage.vehicle')}</span>
            <input
              className="input"
              maxLength={100}
              value={vehicle}
              onChange={(e) => setVehicle(e.target.value)}
            />
          </label>
        </div>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('mileage.add')}
        </button>
        <StatusLine message={message} />
        <p className="text-xs text-muted">{t('mileage.deduction_note')}</p>
        {driver && <p className="text-xs text-muted">{t('mileage.driver_note')}</p>}
      </form>

      {summary.byDriver.length > 1 && (
        <section className="card-flush" aria-label={t('mileage.by_driver')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('mileage.driver')}</th>
                <th className="px-2 py-2 text-right">{t('mileage.trips')}</th>
                <th className="px-2 py-2 text-right">{t('mileage.miles')}</th>
                <th className="px-2 py-2 text-right">{t('mileage.at_rate')}</th>
                <th className="px-4 py-2 text-right">{t('mileage.reimbursed')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {summary.byDriver.map((d) => (
                <tr key={d.personId ?? d.name ?? 'owner'} data-testid="driver-row">
                  <td className="px-4 py-2">
                    {d.driver === 'owner' ? t('mileage.driver_owner') : d.name}
                    <span className="block text-xs text-muted">
                      {d.driver === 'owner' ? t('mileage.is_deduction') : t('mileage.not_deduction')}
                    </span>
                  </td>
                  <td className="num px-2 py-2 text-right">{d.trips}</td>
                  <td className="num px-2 py-2 text-right">{d.miles}</td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={d.amount} currency={summary.currency} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {d.driver === 'owner' ? '—' : <Money amount={d.reimbursed} currency={summary.currency} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {summary.trips.length > 0 && (
        <section className="card-flush" aria-label={t('mileage.list')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('mileage.date')}</th>
                <th className="px-2 py-2">{t('mileage.purpose')}</th>
                <th className="px-2 py-2">{t('mileage.driver')}</th>
                <th className="px-2 py-2 text-right">{t('mileage.miles')}</th>
                <th className="px-2 py-2 text-right">{t('mileage.rate')}</th>
                <th className="px-2 py-2 text-right">{t('mileage.deduction')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {summary.trips.map((r) => (
                <tr key={r.id} data-testid="trip-row">
                  <td className="px-4 py-2">
                    <DateText date={r.date} />
                  </td>
                  <td className="px-2 py-2">
                    {r.purpose}
                    {(r.origin || r.destination) && (
                      <span className="block text-xs text-muted">
                        {[r.origin, r.destination].filter(Boolean).join(' → ')}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {driverText(r, t)}
                    {r.reimbursementStatus && (
                      <span className="block text-xs text-muted">
                        {t(`mileage.reimbursement_${r.reimbursementStatus}`)}
                      </span>
                    )}
                  </td>
                  <td className="num px-2 py-2 text-right">{r.miles}</td>
                  <td className="num px-2 py-2 text-right">{t('mileage.cents', { rate: r.centsPerMile })}</td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={r.deduction} currency={summary.currency} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canReimburse(r) && (
                      <button
                        type="button"
                        className="mr-3 text-sm underline"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => browserApi.reimburseMileageTrip(workspaceId, r.id),
                            t('mileage.reimbursement_made'),
                          )
                        }
                      >
                        {t('mileage.reimburse')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-sm underline"
                      disabled={busy}
                      aria-label={t('mileage.delete_trip', { purpose: r.purpose })}
                      onClick={() =>
                        run(() => browserApi.deleteMileageTrip(workspaceId, r.id), t('mileage.deleted'))
                      }
                    >
                      {t('mileage.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
