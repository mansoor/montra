/**
 * The Add wheel's pure part (ADR-0048): what it offers to whom, and where each choice sits on the arc above the +.
 */

export const WHEEL_CHOICES = ['transaction', 'receipt', 'statement', 'bill', 'payslip'] as const;
export type WheelChoice = (typeof WHEEL_CHOICES)[number];

export interface WheelAbilities {
  /** Records transactions and receipts (AUTH-18). */
  record: boolean;
  /** Imports statements. */
  importFiles: boolean;
  /** Sets things up: employers and payslips. */
  setUp: boolean;
}

/** The choices this login can use, in the wheel's order (left to right). */
export function wheelChoices(
  can: WheelAbilities,
  offered: readonly WheelChoice[] = WHEEL_CHOICES,
): WheelChoice[] {
  return offered.filter((c) =>
    c === 'statement' ? can.importFiles : c === 'payslip' ? can.setUp : can.record,
  );
}

/** Where the choice goes. */
export function wheelRoute(c: WheelChoice): string {
  switch (c) {
    case 'transaction':
      return '/capture';
    case 'receipt':
      return '/receipt-capture';
    case 'statement':
      return '/import?scan=1';
    case 'bill':
      return '/bills/capture';
    case 'payslip':
      return '/payslips';
  }
}

/**
 * Offsets from the + (x right, y up) for `n` choices on an arc of `radius`, spread from the left (165°) to the right
 * (15°), so the outer ones stay clear of the tab bar. One choice sits straight above.
 */
export function wheelLayout(n: number, radius: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: radius }];
  const from = 165;
  const to = 15;
  return Array.from({ length: n }, (_, i) => {
    const a = ((from - ((from - to) * i) / (n - 1)) * Math.PI) / 180;
    return { x: Number((radius * Math.cos(a)).toFixed(2)), y: Number((radius * Math.sin(a)).toFixed(2)) };
  });
}
