import { formatMinor } from '@/lib/money';

/** Displays minor units with locale formatting; negatives in the "bad" color. */
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
  const value = typeof amount === 'string' ? BigInt(amount) : amount;
  const color = signed ? (value < 0n ? 'text-bad' : value > 0n ? 'text-good' : '') : '';
  return (
    <span className={`num whitespace-nowrap ${color} ${className}`}>
      {formatMinor(value, currency, { accounting })}
    </span>
  );
}
