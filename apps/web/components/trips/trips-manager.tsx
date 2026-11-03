'use client';

import { useState } from 'react';
import type { TripDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/** Travel mode (CUR-09): trip dates and currency; purchases in the window are tagged with the trip. */
export function TripsManager({ workspaceId, trips }: { workspaceId: string; trips: TripDto[] }) {
  const { run, busy, message, t } = useAction();
  const [form, setForm] = useState({ name: '', startDate: '', endDate: '', currency: '', timeZone: '' });
  const ready = form.name.trim() && form.startDate && form.endDate && /^[A-Za-z]{3}$/.test(form.currency);

  return (
    <div className="space-y-4">
      <form
        className="card grid gap-3 sm:grid-cols-5"
        onSubmit={async (e) => {
          e.preventDefault();
          const created = await run(
            () =>
              browserApi.createTrip(workspaceId, {
                name: form.name.trim(),
                startDate: form.startDate,
                endDate: form.endDate,
                currency: form.currency.toUpperCase(),
                timeZone: form.timeZone.trim() || null,
              }),
            (trip) => t('trips.created', { count: trip.transactionCount }),
          );
          if (created) setForm({ name: '', startDate: '', endDate: '', currency: '', timeZone: '' });
        }}
      >
        {(
          [
            ['name', 'trips.name', 'text'],
            ['startDate', 'trips.start', 'date'],
            ['endDate', 'trips.end', 'date'],
            ['currency', 'trips.currency', 'text'],
            ['timeZone', 'trips.time_zone', 'text'],
          ] as const
        ).map(([key, label, type]) => (
          <label key={key} className="text-sm">
            <span className="field-label">{t(label)}</span>
            <input
              className="input"
              type={type}
              value={form[key]}
              maxLength={key === 'currency' ? 3 : undefined}
              placeholder={key === 'currency' ? 'EUR' : key === 'timeZone' ? 'Europe/Paris' : undefined}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </label>
        ))}
        <div className="sm:col-span-5">
          <button type="submit" className="btn-primary" disabled={busy || !ready}>
            {t('trips.add')}
          </button>
        </div>
      </form>
      {trips.length === 0 ? (
        <p className="text-sm text-muted">{t('trips.empty')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {trips.map((trip) => (
            <li key={trip.id} className="flex flex-wrap items-center gap-3 py-2 text-sm" data-testid="trip">
              <span className="font-medium">{trip.name}</span>
              <span>
                <DateText date={trip.startDate} /> – <DateText date={trip.endDate} />
              </span>
              <span className="chip chip-muted">{trip.currency}</span>
              <span className="text-muted">{t('trips.transactions', { count: trip.transactionCount })}</span>
              <button
                type="button"
                className="btn-secondary ml-auto"
                disabled={busy}
                onClick={() => run(() => browserApi.deleteTrip(workspaceId, trip.id), t('trips.deleted'))}
              >
                {t('trips.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <StatusLine message={message} />
    </div>
  );
}
