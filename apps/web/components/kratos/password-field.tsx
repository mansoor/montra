'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PasswordCheck, PasswordPolicy } from '@montra/password';

export interface PasswordFieldLabels {
  strength: string;
  /** Very weak … very strong, by score 0–4. */
  levels: string[];
  needs: string;
  tooShort: string;
  tooWeak: string;
}

const BAR = ['bg-bad', 'bg-bad', 'bg-warn', 'bg-good', 'bg-good'];

/**
 * A new-password input with a strength meter (AUTH-02, ADR-0043). It scores as the person types, against the same
 * policy the auth gateway enforces, and won't let the form submit until the password meets it; the gateway checks
 * again whatever the browser does. The scorer and its word lists load only on pages with this field.
 */
export function PasswordField({
  id,
  name,
  label,
  autoComplete,
  required,
  describedBy,
  policy,
  words,
  labels,
}: {
  id: string;
  name: string;
  label: string;
  autoComplete?: string;
  required: boolean;
  describedBy?: string;
  policy: PasswordPolicy;
  /** The person's own email and name, when known; the email typed on the same form is added. */
  words: string[];
  labels: PasswordFieldLabels;
}) {
  const input = useRef<HTMLInputElement>(null);
  const scorer = useRef<typeof import('@montra/password') | null>(null);
  const [ready, setReady] = useState(false);
  const [value, setValue] = useState('');
  const [check, setCheck] = useState<PasswordCheck | null>(null);
  const meterId = `${id}-strength`;

  useEffect(() => {
    let alive = true;
    void import('@montra/password').then((m) => {
      if (!alive) return;
      scorer.current = m;
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const m = scorer.current;
    const el = input.current;
    if (!m || !el) return;
    const timer = setTimeout(() => {
      if (!value) {
        setCheck(null);
        el.setCustomValidity('');
        return;
      }
      const typed = (el.form?.elements.namedItem('traits.email') as HTMLInputElement | null)?.value;
      const all = [...words, ...m.personalWords({ email: typed })];
      const c = m.checkPassword(value, policy, all);
      setCheck(c);
      el.setCustomValidity(
        c.ok
          ? ''
          : [
              c.problems.includes('too_short') ? labels.tooShort : null,
              c.problems.includes('too_weak') ? labels.tooWeak : null,
            ]
              .filter(Boolean)
              .join(' '),
      );
    }, 120);
    return () => clearTimeout(timer);
  }, [value, ready, policy, words, labels]);

  const describe = useMemo(() => [describedBy, meterId].filter(Boolean).join(' '), [describedBy, meterId]);
  const score = check?.strength.score ?? 0;

  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        ref={input}
        id={id}
        name={name}
        type="password"
        required={required}
        autoComplete={autoComplete ?? 'new-password'}
        className="input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={check && !check.ok ? 'true' : undefined}
        aria-describedby={describe}
      />
      <div id={meterId} className="mt-2 space-y-1" aria-live="polite" data-testid="password-strength">
        <div className="flex gap-1" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full ${check && score > i ? BAR[score] : 'bg-line'}`}
            />
          ))}
        </div>
        {check ? (
          <p className="text-xs">
            <span className="text-muted">{labels.strength}: </span>
            <span className={check.ok ? 'text-good' : 'text-bad'}>{labels.levels[score]}</span>
            {check.strength.warning ? <span className="text-muted"> · {check.strength.warning}</span> : null}
          </p>
        ) : null}
        <p className="text-xs text-muted">{labels.needs}</p>
      </div>
    </div>
  );
}
