'use client';

import { useState } from 'react';
import type { NotificationPrefsDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput } from '@/lib/money';
import { minutesToTime, timeToMinutes } from '@/lib/reports';
import { positiveMinor } from '@/lib/rentals';
import { StatusLine, useAction } from '../use-action';

const TYPES = [
  'bill_due',
  'low_balance',
  'overspend_pace',
  'large_transaction',
  'rent_overdue',
  'lease_expiring',
  'reminder',
  'tax_due',
  'import_reminder',
  'monthly_review',
  'suggestion',
  'weekly_digest',
] as const;
const CHANNELS = ['inApp', 'email', 'push'] as const;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** NOT-01..03: each type on each channel, quiet hours and a daily cap. They follow you across workspaces. */
export function NotificationSettings({
  initial,
  currency,
}: {
  initial: NotificationPrefsDto;
  currency: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [channels, setChannels] = useState(initial.channels);
  const [quiet, setQuiet] = useState(initial.quietStart !== null);
  const [start, setStart] = useState(minutesToTime(initial.quietStart ?? 1320));
  const [end, setEnd] = useState(minutesToTime(initial.quietEnd ?? 420));
  const [cap, setCap] = useState(String(initial.dailyCap));
  const [weekday, setWeekday] = useState(String(initial.digestWeekday));
  const [large, setLarge] = useState(minorToInput(BigInt(initial.largeTransaction), currency));
  const [lowDays, setLowDays] = useState(String(initial.lowBalanceDays));
  const [importDays, setImportDays] = useState(String(initial.importReminderDays));
  const [unsubscribed, setUnsubscribed] = useState(initial.emailUnsubscribed);

  return (
    <form
      className="space-y-5"
      aria-label={t('notify.settings')}
      onSubmit={(e) => {
        e.preventDefault();
        const threshold = positiveMinor(large, currency, t);
        if (!threshold.ok) return setMessage({ tone: 'bad', text: threshold.error });
        const quietStart = quiet ? timeToMinutes(start) : null;
        const quietEnd = quiet ? timeToMinutes(end) : null;
        if (quiet && (quietStart === null || quietEnd === null)) {
          return setMessage({ tone: 'bad', text: t('notify.quiet_invalid') });
        }
        void run(
          () =>
            browserApi.updateNotificationPrefs({
              channels,
              quietStart,
              quietEnd,
              dailyCap: Number(cap),
              digestWeekday: Number(weekday),
              largeTransaction: threshold.value,
              lowBalanceDays: Number(lowDays),
              importReminderDays: Number(importDays),
              emailUnsubscribed: unsubscribed,
            }),
          t('notify.saved'),
        );
      }}
    >
      <section className="card-flush overflow-x-auto" aria-labelledby="notify-types">
        <h2 id="notify-types" className="px-4 pt-3 text-base font-semibold">
          {t('notify.what_when')}
        </h2>
        <table className="tbl">
          <thead>
            <tr>
              <th className="px-4 py-2">{t('notify.type')}</th>
              {CHANNELS.map((c) => (
                <th key={c} className="px-2 py-2 text-center">
                  {t(`notify.channel_${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {TYPES.map((type) => (
              <tr key={type} data-testid="notify-row">
                <td className="px-4 py-2 text-sm">{t(`notify.type_${type}`)}</td>
                {CHANNELS.map((c) => (
                  <td key={c} className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label={t('notify.toggle', {
                        type: t(`notify.type_${type}`),
                        channel: t(`notify.channel_${c}`),
                      })}
                      checked={channels[type]![c]}
                      onChange={(e) =>
                        setChannels({ ...channels, [type]: { ...channels[type]!, [c]: e.target.checked } })
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card space-y-3" aria-labelledby="notify-timing">
        <h2 id="notify-timing" className="text-base font-semibold">
          {t('notify.timing')}
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
          {t('notify.quiet_on')}
        </label>
        {quiet && (
          <div className="flex flex-wrap gap-3">
            <label>
              <span className="field-label">{t('notify.quiet_start')}</span>
              <input
                className="input"
                type="time"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('notify.quiet_end')}</span>
              <input
                className="input"
                type="time"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label>
            <span className="field-label">{t('notify.daily_cap')}</span>
            <input
              className="input"
              type="number"
              min={0}
              max={50}
              required
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
            <span className="mt-1 block text-xs text-muted">{t('notify.daily_cap_hint')}</span>
          </label>
          <label>
            <span className="field-label">{t('notify.digest_day')}</span>
            <select className="input" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              {WEEKDAYS.map((d) => (
                <option key={d} value={d}>
                  {t(`calendar.weekday_${d - 1}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('notify.large_amount')}</span>
            <input
              className="input"
              inputMode="decimal"
              required
              value={large}
              onChange={(e) => setLarge(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('notify.low_days')}</span>
            <input
              className="input"
              type="number"
              min={1}
              max={90}
              required
              value={lowDays}
              onChange={(e) => setLowDays(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('notify.import_days')}</span>
            <input
              className="input"
              type="number"
              min={1}
              max={90}
              required
              value={importDays}
              onChange={(e) => setImportDays(e.target.value)}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={unsubscribed} onChange={(e) => setUnsubscribed(e.target.checked)} />
          {t('notify.unsubscribed')}
        </label>
        <p className="text-xs text-muted">{t('notify.privacy')}</p>
      </section>

      <button type="submit" className="btn-primary" disabled={busy}>
        {t('notify.save')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
