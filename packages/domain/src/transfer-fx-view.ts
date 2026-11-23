/**
 * What the web and the phone show of a transfer between currencies (CUR-08): the rate it got, the market rate, and
 * the FX cost or gain. The figures come from the server (`TransferFxDto`); this only shapes them for reading.
 */
import { decimalToString, parseDecimal, rescale } from './decimal.js';

/** The fields of `TransferFxDto` this reads. */
export interface TransferFxFigures {
  readonly sent: { readonly currency: string };
  readonly received: { readonly currency: string };
  readonly effectiveRate: string;
  readonly marketRate: string | null;
  readonly marketRateDate: string | null;
  readonly cost: { readonly amount: string; readonly currency: string } | null;
  readonly costBps: number | null;
}

/**
 * A rate to read at a glance: four decimals, more when it is below 1 so small rates keep four significant digits
 * ("0.006711"), trailing zeros dropped. Display only; the stored rate keeps its full precision.
 */
export function displayRate(rate: string): string {
  const d = parseDecimal(rate);
  const [whole = '0', fraction = ''] = rate.split('.');
  const leadingZeros = /^0*$/.test(whole) ? (/^0*/.exec(fraction)?.[0].length ?? 0) : 0;
  const scale = Math.min(10, 4 + leadingZeros);
  const s = decimalToString({ coefficient: rescale(d, scale, 'half_even'), scale });
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Basis points as a percent with two decimals: 182 → "1.82". The sign is dropped; the caller says cost or gain. */
export function bpsPercent(bps: number): string {
  const n = BigInt(bps < 0 ? -bps : bps);
  return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
}

export interface TransferFxView {
  /** "1 USD = 0.9091 EUR". */
  readonly effective: string;
  /** The market rate the same way, or null when none is stored for the date. */
  readonly market: string | null;
  readonly marketDate: string | null;
  /** Null without a market rate. `even` when the cost rounds to nothing. */
  readonly outcome: {
    readonly tone: 'cost' | 'gain' | 'even';
    /** Minor units, never negative. */
    readonly amount: bigint;
    readonly currency: string;
    readonly percent: string | null;
  } | null;
}

export function transferFxView(fx: TransferFxFigures): TransferFxView {
  const pair = (rate: string) => `1 ${fx.sent.currency} = ${displayRate(rate)} ${fx.received.currency}`;
  const cost = fx.cost ? BigInt(fx.cost.amount) : null;
  return {
    effective: pair(fx.effectiveRate),
    market: fx.marketRate ? pair(fx.marketRate) : null,
    marketDate: fx.marketRateDate,
    outcome:
      cost === null || !fx.cost
        ? null
        : {
            tone: cost > 0n ? 'cost' : cost < 0n ? 'gain' : 'even',
            amount: cost < 0n ? -cost : cost,
            currency: fx.cost.currency,
            percent: fx.costBps === null ? null : bpsPercent(fx.costBps),
          },
  };
}
