'use client';

import type { Trigger } from '@/lib/kratos-ui';

/**
 * WebAuthn / passkey button. Kratos' webauthn.js defines the trigger function on `window`; we only ever call
 * one of the allow-listed names (never an `onclick` string from the flow).
 */
export function TriggerButton({
  name,
  value,
  label,
  disabled,
  trigger,
}: {
  name: string;
  value: string;
  label: string;
  disabled: boolean;
  trigger: Trigger;
}) {
  return (
    <button
      type="button"
      name={name}
      value={value}
      disabled={disabled}
      className="btn-secondary w-full"
      onClick={(e) => {
        e.preventDefault();
        const fn = (window as unknown as Record<string, unknown>)[trigger];
        if (typeof fn === 'function') (fn as () => void)();
      }}
    >
      {label}
    </button>
  );
}
