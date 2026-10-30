'use client';

import { useI18n } from './i18n';

/** Displays minor units in the user's locale (CUR-10); negatives in the "bad" color when `signed`. */
export function Money({
  amount,
  currency,
  accounting,
  signed,
  className = '',
}: {
  amount: bigint | string;
  currency: string;
  accounting?: boolean;
  /** Color positive green / negative red. */
  signed?: boolean;
  className?: string;
}) {
  const { money } = useI18n();
  const value = typeof amount === 'string' ? BigInt(amount) : amount;
  const color = signed ? (value < 0n ? 'text-bad' : value > 0n ? 'text-good' : '') : '';
  return (
    <span className={`num whitespace-nowrap ${color} ${className}`}>
      {money(value, currency, { accounting })}
    </span>
  );
}
