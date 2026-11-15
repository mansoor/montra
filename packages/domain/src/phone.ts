/**
 * Phone numbers for texts (ADR-0049 §6): E.164 only, and which country one is in, so texts go only to countries on
 * the allowed list. No library: calling codes are a short table, and within +1 the area code says whether a number
 * is Canada's or a Caribbean country's rather than the United States'.
 */

/** `+` and 7 to 15 digits, the first not 0. Spaces, dashes, dots and brackets are dropped first. */
export function normalizePhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return /^\+[1-9]\d{6,14}$/.test(withPlus) ? withPlus : null;
}

/** Canada's area codes in the North American Numbering Plan. */
const CA_AREA_CODES = new Set([
  '204',
  '226',
  '236',
  '249',
  '250',
  '257',
  '263',
  '289',
  '306',
  '343',
  '354',
  '365',
  '367',
  '368',
  '382',
  '403',
  '416',
  '418',
  '428',
  '431',
  '437',
  '438',
  '450',
  '468',
  '474',
  '506',
  '514',
  '519',
  '548',
  '579',
  '581',
  '584',
  '587',
  '600',
  '604',
  '613',
  '639',
  '647',
  '672',
  '683',
  '705',
  '709',
  '742',
  '753',
  '778',
  '780',
  '782',
  '807',
  '819',
  '825',
  '867',
  '873',
  '879',
  '902',
  '905',
]);

/** The other countries and territories that share +1, by area code. */
const NANP_OTHER: Readonly<Record<string, string>> = {
  '242': 'BS',
  '246': 'BB',
  '264': 'AI',
  '268': 'AG',
  '284': 'VG',
  '340': 'VI',
  '345': 'KY',
  '441': 'BM',
  '473': 'GD',
  '649': 'TC',
  '658': 'JM',
  '664': 'MS',
  '670': 'MP',
  '671': 'GU',
  '684': 'AS',
  '721': 'SX',
  '758': 'LC',
  '767': 'DM',
  '784': 'VC',
  '787': 'PR',
  '809': 'DO',
  '829': 'DO',
  '849': 'DO',
  '868': 'TT',
  '869': 'KN',
  '876': 'JM',
  '939': 'PR',
};

/** Calling codes outside +1, longest first when they share digits. */
const CALLING_CODES: readonly (readonly [string, string])[] = (
  [
    ['44', 'GB'],
    ['353', 'IE'],
    ['33', 'FR'],
    ['49', 'DE'],
    ['34', 'ES'],
    ['39', 'IT'],
    ['31', 'NL'],
    ['32', 'BE'],
    ['41', 'CH'],
    ['43', 'AT'],
    ['45', 'DK'],
    ['46', 'SE'],
    ['47', 'NO'],
    ['358', 'FI'],
    ['351', 'PT'],
    ['48', 'PL'],
    ['30', 'GR'],
    ['420', 'CZ'],
    ['36', 'HU'],
    ['40', 'RO'],
    ['352', 'LU'],
    ['354', 'IS'],
    ['61', 'AU'],
    ['64', 'NZ'],
    ['81', 'JP'],
    ['82', 'KR'],
    ['65', 'SG'],
    ['852', 'HK'],
    ['886', 'TW'],
    ['91', 'IN'],
    ['972', 'IL'],
    ['971', 'AE'],
    ['52', 'MX'],
    ['55', 'BR'],
    ['54', 'AR'],
    ['56', 'CL'],
    ['57', 'CO'],
    ['51', 'PE'],
    ['27', 'ZA'],
    ['234', 'NG'],
    ['254', 'KE'],
    ['63', 'PH'],
    ['60', 'MY'],
    ['66', 'TH'],
    ['62', 'ID'],
    ['84', 'VN'],
    ['86', 'CN'],
    ['7', 'RU'],
    ['90', 'TR'],
    ['20', 'EG'],
    ['966', 'SA'],
    ['92', 'PK'],
    ['880', 'BD'],
  ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

/** The ISO 3166 country of an E.164 number, or null if it isn't one this knows. */
export function phoneCountry(e164: string): string | null {
  const n = normalizePhone(e164);
  if (!n) return null;
  const digits = n.slice(1);
  if (digits.startsWith('1')) {
    if (digits.length !== 11) return null;
    const area = digits.slice(1, 4);
    if (CA_AREA_CODES.has(area)) return 'CA';
    return NANP_OTHER[area] ?? 'US';
  }
  for (const [code, country] of CALLING_CODES) if (digits.startsWith(code)) return country;
  return null;
}

/** Whether a text may go to a number: only to countries on the allowed list (ADR-0049 §6, against SMS pumping). */
export function textAllowedTo(e164: string, allowedCountries: readonly string[]): boolean {
  const country = phoneCountry(e164);
  return country !== null && allowedCountries.map((c) => c.toUpperCase()).includes(country);
}

/** Shown in the console and Settings: the country code and the last four digits. */
export function maskPhone(e164: string): string {
  const n = normalizePhone(e164);
  if (!n) return '';
  return `${n.slice(0, n.startsWith('+1') ? 2 : 3)} ••• ${n.slice(-4)}`;
}
