'use client';

import { useEffect, useState } from 'react';
import type { RevealInput } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { useI18n } from '../i18n';

/** How long a revealed value stays on screen. */
const SHOW_MS = 30_000;

/**
 * A masked value with a Show button (PRL-05). Showing asks the API, which needs a recent sign-in and logs it; the value
 * hides itself again after half a minute.
 */
export function Reveal({
  workspaceId,
  personId,
  masked,
  request,
  format,
}: {
  workspaceId: string;
  personId: string;
  masked: string | null;
  request: RevealInput;
  format?: (value: string) => string;
}) {
  return (
    <RevealValue
      masked={masked}
      load={() => browserApi.revealPayrollField(workspaceId, personId, request).then((r) => r.value)}
      format={format}
    />
  );
}

/** The same for any masked value: `load` fetches the full one (a business's EIN, ADR-0037 §5). */
export function RevealValue({
  masked,
  load,
  format = (v) => v,
  label,
}: {
  masked: string | null;
  load: () => Promise<string | null>;
  format?: (value: string) => string;
  /** Names what Show reveals, for screen readers. */
  label?: string;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => setValue(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [value]);

  if (!masked) return <span className="text-muted">{t('payroll.not_recorded')}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="num" data-testid="masked-value">
        {value !== null ? format(value) : masked}
      </span>
      {value === null ? (
        <button
          type="button"
          className="text-sm underline"
          disabled={busy}
          aria-label={label ? `${t('payroll.show')} ${label}` : undefined}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setValue((await load()) ?? '');
            } catch (err) {
              setError(friendlyMessage(err, t));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('payroll.show')}
        </button>
      ) : (
        <button type="button" className="text-sm underline" onClick={() => setValue(null)}>
          {t('payroll.hide')}
        </button>
      )}
      {error && (
        <span role="alert" className="text-sm text-bad">
          {error}
        </span>
      )}
    </span>
  );
}

/** "900123456" → "900-12-3456"; an EIN as "98-7654321". */
export const tinText = (type: 'ssn' | 'itin' | 'ein' | null) => (v: string) =>
  type === 'ein' ? `${v.slice(0, 2)}-${v.slice(2)}` : `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}`;
