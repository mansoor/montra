'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { Field, FormError } from './field';

const TEMPLATES = [
  { value: 'household', label: 'Household', hint: 'Personal and family spending' },
  { value: 'freelancer', label: 'Freelancer', hint: 'Personal + a small business (Schedule C)' },
  { value: 'landlord', label: 'Landlord', hint: 'Personal + rental properties (Schedule E)' },
  { value: 'hybrid', label: 'All three', hint: 'Personal, business and rentals' },
] as const;

const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'INR', 'JPY'];

export function WelcomeForm() {
  const router = useRouter();
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]['value']>('household');
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const defaultTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? '').trim() || undefined;
    setBusy(true);
    setErrors({ fields: {} });
    try {
      const ws = await browserApi.createWorkspace({
        name: str('name') ?? '',
        baseCurrency: str('baseCurrency') ?? 'USD',
        timeZone: str('timeZone') ?? 'UTC',
        template,
        businessName: template === 'freelancer' || template === 'hybrid' ? str('businessName') : undefined,
        rentalName: template === 'landlord' || template === 'hybrid' ? str('rentalName') : undefined,
      });
      router.push(`/w/${ws.id}`);
      router.refresh();
    } catch (err) {
      setErrors(toFormErrors(err));
      setBusy(false);
    }
  }

  const showBusiness = template === 'freelancer' || template === 'hybrid';
  const showRental = template === 'landlord' || template === 'hybrid';

  return (
    <form onSubmit={onSubmit} className="card space-y-5" noValidate>
      <FormError message={errors.form} />
      <Field id="name" label="Workspace name" error={errors.fields.name}>
        {(p) => (
          <input {...p} name="name" className="input" required maxLength={200} placeholder="Our household" />
        )}
      </Field>

      <fieldset>
        <legend className="field-label">What do you want to track?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <label
              key={t.value}
              className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${template === t.value ? 'border-brand-600 bg-brand-50' : 'border-line'}`}
            >
              <input
                type="radio"
                name="template"
                value={t.value}
                checked={template === t.value}
                onChange={() => setTemplate(t.value)}
              />
              <span>
                <span className="block font-medium">{t.label}</span>
                <span className="text-muted">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {showBusiness && (
        <Field id="businessName" label="Business name" error={errors.fields.businessName}>
          {(p) => (
            <input {...p} name="businessName" className="input" maxLength={200} placeholder="My Business" />
          )}
        </Field>
      )}
      {showRental && (
        <Field id="rentalName" label="Rental portfolio name" error={errors.fields.rentalName}>
          {(p) => (
            <input
              {...p}
              name="rentalName"
              className="input"
              maxLength={200}
              placeholder="Rental Portfolio"
            />
          )}
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="baseCurrency" label="Home currency" error={errors.fields.baseCurrency}>
          {(p) => (
            <select {...p} name="baseCurrency" className="input" defaultValue="USD">
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="timeZone"
          label="Time zone"
          error={errors.fields.timeZone}
          hint="Sets where each month starts and ends."
        >
          {(p) => <input {...p} name="timeZone" className="input" defaultValue={defaultTz} />}
        </Field>
      </div>

      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
}
