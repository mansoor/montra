'use client';

import { useState, type FormEvent } from 'react';
import type { MeDto } from '@montra/api-client';
import { calendarDate, fromEpochDay, toEpochDay } from '@montra/domain';
import { formatCalendarDate, weekdayName } from '@montra/i18n';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { Field, FormError } from '../field';
import { StatusLine, useAction } from '../use-action';

const LOCALES = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN', 'fr-FR', 'de-DE', 'es-ES'];
const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY'] as const;
/** 2024-01-01 was a Monday; ISO weekdays 1..7 map to that week. */
const MONDAY = toEpochDay(calendarDate('2024-01-01'));
const SAMPLE_DATE = calendarDate('2026-10-31');

/** Profile and formats (TZ-01, TZ-05, CUR-10). */
export function ProfileSettings({ me }: { me: MeDto }) {
  const { busy, message, run, t } = useAction();
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    const dateFormat = get('dateFormat');
    setErrors({ fields: {} });
    await run(
      () =>
        browserApi
          .updateMe({
            displayName: get('displayName'),
            timeZone: get('timeZone'),
            locale: get('locale'),
            dateFormat: dateFormat ? (dateFormat as (typeof DATE_FORMATS)[number]) : null,
            weekStart: Number(get('weekStart')),
          })
          .catch((err: unknown) => {
            setErrors(toFormErrors(err, {}, t));
            throw err;
          }),
      t('profile.saved'),
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="card max-w-xl space-y-4"
      aria-label={t('settings.tab.profile')}
      noValidate
    >
      <FormError message={errors.form} action={errors.action} />
      <p className="flex flex-wrap justify-between gap-2 text-sm text-muted">
        <span>{t('security.signed_in_as', { email: me.email })}</span>
        <a href="/settings/security" className="font-medium text-brand-600 underline">
          {t('profile.security_link')}
        </a>
      </p>
      <Field id="pf-name" label={t('profile.display_name')} error={errors.fields.displayName}>
        {(p) => (
          <input {...p} name="displayName" className="input" defaultValue={me.displayName} maxLength={100} />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="pf-tz"
          label={t('profile.time_zone')}
          error={errors.fields.timeZone}
          hint={t('profile.time_zone_hint')}
        >
          {(p) => <input {...p} name="timeZone" className="input" defaultValue={me.timeZone} />}
        </Field>
        <Field id="pf-locale" label={t('profile.locale')} error={errors.fields.locale}>
          {(p) => (
            <select {...p} name="locale" className="input" defaultValue={me.locale}>
              {[...new Set([me.locale, ...LOCALES])].map((l) => (
                <option key={l} value={l}>
                  {l} ({new Intl.NumberFormat(l, { style: 'currency', currency: 'USD' }).format(1234.5)})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="pf-date" label={t('profile.date_format')} error={errors.fields.dateFormat}>
          {(p) => (
            <select {...p} name="dateFormat" className="input" defaultValue={me.dateFormat ?? ''}>
              <option value="">
                {t('profile.locale_default', {
                  example: formatCalendarDate(SAMPLE_DATE, { locale: me.locale }),
                })}
              </option>
              {DATE_FORMATS.map((d) => (
                <option key={d} value={d}>
                  {d} ({formatCalendarDate(SAMPLE_DATE, { format: d })})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="pf-week" label={t('profile.week_start')} error={errors.fields.weekStart}>
          {(p) => (
            <select {...p} name="weekStart" className="input" defaultValue={String(me.weekStart)}>
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <option key={d} value={d}>
                  {weekdayName(fromEpochDay(MONDAY + d - 1), me.locale, 'long')}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('profile.save')}
        </button>
        <StatusLine message={message} />
      </div>
    </form>
  );
}
