/**
 * ISO 4217 active currency codes and their minor-unit exponents (CUR-02).
 * Most currencies have 2 decimals; the exceptions are listed explicitly.
 */

const ZERO_DECIMALS = [
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
] as const;

const THREE_DECIMALS = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'] as const;

const FOUR_DECIMALS = ['CLF', 'UYW'] as const;

const TWO_DECIMALS = [
  'AED',
  'AFN',
  'ALL',
  'AMD',
  'ANG',
  'AOA',
  'ARS',
  'AUD',
  'AWG',
  'AZN',
  'BAM',
  'BBD',
  'BDT',
  'BGN',
  'BMD',
  'BND',
  'BOB',
  'BRL',
  'BSD',
  'BTN',
  'BWP',
  'BYN',
  'BZD',
  'CAD',
  'CDF',
  'CHF',
  'CNY',
  'COP',
  'CRC',
  'CUP',
  'CVE',
  'CZK',
  'DKK',
  'DOP',
  'DZD',
  'EGP',
  'ERN',
  'ETB',
  'EUR',
  'FJD',
  'FKP',
  'GBP',
  'GEL',
  'GHS',
  'GIP',
  'GMD',
  'GTQ',
  'GYD',
  'HKD',
  'HNL',
  'HTG',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'IRR',
  'JMD',
  'KES',
  'KGS',
  'KHR',
  'KPW',
  'KYD',
  'KZT',
  'LAK',
  'LBP',
  'LKR',
  'LRD',
  'LSL',
  'MAD',
  'MDL',
  'MGA',
  'MKD',
  'MMK',
  'MNT',
  'MOP',
  'MRU',
  'MUR',
  'MVR',
  'MWK',
  'MXN',
  'MYR',
  'MZN',
  'NAD',
  'NGN',
  'NIO',
  'NOK',
  'NPR',
  'NZD',
  'PAB',
  'PEN',
  'PGK',
  'PHP',
  'PKR',
  'PLN',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'SAR',
  'SBD',
  'SCR',
  'SDG',
  'SEK',
  'SGD',
  'SHP',
  'SLE',
  'SOS',
  'SRD',
  'SSP',
  'STN',
  'SVC',
  'SYP',
  'SZL',
  'THB',
  'TJS',
  'TMT',
  'TOP',
  'TRY',
  'TTD',
  'TWD',
  'TZS',
  'UAH',
  'USD',
  'UYU',
  'UZS',
  'VES',
  'WST',
  'XCD',
  'YER',
  'ZAR',
  'ZMW',
  'ZWG',
] as const;

export type CurrencyCode =
  | (typeof ZERO_DECIMALS)[number]
  | (typeof TWO_DECIMALS)[number]
  | (typeof THREE_DECIMALS)[number]
  | (typeof FOUR_DECIMALS)[number];

const EXPONENTS: ReadonlyMap<string, number> = new Map<string, number>([
  ...ZERO_DECIMALS.map((c) => [c, 0] as const),
  ...TWO_DECIMALS.map((c) => [c, 2] as const),
  ...THREE_DECIMALS.map((c) => [c, 3] as const),
  ...FOUR_DECIMALS.map((c) => [c, 4] as const),
]);

export const CURRENCY_CODES: readonly CurrencyCode[] = [...EXPONENTS.keys()].sort() as CurrencyCode[];

export function isCurrencyCode(value: string): value is CurrencyCode {
  return EXPONENTS.has(value);
}

export function asCurrencyCode(value: string): CurrencyCode {
  const upper = value.toUpperCase();
  if (!isCurrencyCode(upper)) throw new RangeError(`Unknown ISO 4217 currency code: ${value}`);
  return upper;
}

/** Number of minor-unit digits, e.g. USD → 2, JPY → 0, KWD → 3. */
export function minorUnits(currency: CurrencyCode): number {
  const exp = EXPONENTS.get(currency);
  if (exp === undefined) throw new RangeError(`Unknown ISO 4217 currency code: ${currency}`);
  return exp;
}
