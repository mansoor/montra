'use client';

import { useState, type FormEvent } from 'react';
import type { MeDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { Field, FormError } from '../field';
import { StatusLine, useAction } from '../use-action';

const LOCALES = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN', 'fr-FR', 'de-DE', 'es-ES'];
const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY'] as const;
const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Profile and formats (TZ-01, TZ-05, CUR-10). */
export function ProfileSettings({ me }: { me: MeDto }) {
  const { busy, message, run } = useAction();
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
            setErrors(toFormErrors(err));
            throw err;
          }),
      'Profile saved.',
    );
  }

  return (
    <form onSubmit={onSubmit} className="card max-w-xl space-y-4" aria-label="Profile" noValidate>
      <FormError message={errors.form} />
      <p className="text-sm text-muted">Signed in as {me.email}</p>
      <Field id="pf-name" label="Display name" error={errors.fields.displayName}>
        {(p) => (
          <input {...p} name="displayName" className="input" defaultValue={me.displayName} maxLength={100} />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="pf-tz"
          label="Time zone"
          error={errors.fields.timeZone}
          hint="IANA name, e.g. America/New_York"
        >
          {(p) => <input {...p} name="timeZone" className="input" defaultValue={me.timeZone} />}
        </Field>
        <Field id="pf-locale" label="Number and currency format" error={errors.fields.locale}>
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
        <Field id="pf-date" label="Date format" error={errors.fields.dateFormat}>
          {(p) => (
            <select {...p} name="dateFormat" className="input" defaultValue={me.dateFormat ?? ''}>
              <option value="">Locale default</option>
              {DATE_FORMATS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          )}
        </Field>
        <Field id="pf-week" label="Week starts on" error={errors.fields.weekStart}>
          {(p) => (
            <select {...p} name="weekStart" className="input" defaultValue={String(me.weekStart)}>
              {WEEK_DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>
          Save profile
        </button>
        <StatusLine message={message} />
      </div>
    </form>
  );
}
