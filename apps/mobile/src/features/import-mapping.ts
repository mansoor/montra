/**
 * Guided column mapping on mobile (IMP-03, 08 §4 "simplified"): the server analyses the file and proposes a mapping;
 * when it isn't sure, the user picks the date, description and amount (or money out / money in) columns one step
 * at a time. The date format and decimal separator are detected from the sample here, or kept from the proposal.
 */
import type { ColumnMappingDto, ImportBatchDto } from '@montra/schemas';

export type DateFormat = ColumnMappingDto['dateFormat'];

export type MappingStep = 'date' | 'description' | 'amount' | 'review';

export interface GuidedChoices {
  date: number | null;
  description: number | null;
  /** One signed column … */
  amount: number | null;
  /** … or two columns: money out and money in. */
  debit: number | null;
  credit: number | null;
  /** Card exports often list purchases as positive numbers. */
  inverted: boolean;
}

export const emptyChoices = (): GuidedChoices => ({
  date: null,
  description: null,
  amount: null,
  debit: null,
  credit: null,
  inverted: false,
});

/** Seed the steps from the server's proposal so the user only corrects what's wrong. */
export function choicesFromProposal(m: ColumnMappingDto | null): GuidedChoices {
  if (!m) return emptyChoices();
  return {
    date: m.date,
    description: m.description[0] ?? null,
    amount: m.amount ?? null,
    debit: m.debit ?? null,
    credit: m.credit ?? null,
    inverted: m.sign === 'inverted',
  };
}

export function nextStep(c: GuidedChoices): MappingStep {
  if (c.date === null) return 'date';
  if (c.description === null) return 'description';
  if (c.amount === null && (c.debit === null || c.credit === null)) return 'amount';
  return 'review';
}

const NUMERIC: Array<[DateFormat, RegExp, 'ymd' | 'mdy' | 'dmy']> = [
  ['YYYY-MM-DD', /^(\d{4})-(\d{1,2})-(\d{1,2})$/, 'ymd'],
  ['YYYY/MM/DD', /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, 'ymd'],
  ['MM/DD/YYYY', /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, 'mdy'],
  ['DD/MM/YYYY', /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, 'dmy'],
  ['DD.MM.YYYY', /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, 'dmy'],
  ['MM-DD-YYYY', /^(\d{1,2})-(\d{1,2})-(\d{4})$/, 'mdy'],
  ['DD-MM-YYYY', /^(\d{1,2})-(\d{1,2})-(\d{4})$/, 'dmy'],
  ['MM/DD/YY', /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, 'mdy'],
  ['DD/MM/YY', /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, 'dmy'],
];

const valid = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** The numeric format that parses every sample value; day-first wins only when the data proves it (a day > 12). */
export function detectDateFormat(values: readonly string[], preferDayFirst = false): DateFormat | null {
  const sample = values.map((v) => v.trim().split(/[ T]/)[0]!).filter(Boolean);
  if (sample.length === 0) return null;
  const fits = NUMERIC.filter(([, re, order]) =>
    sample.every((v) => {
      const m = re.exec(v);
      if (!m) return false;
      const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return order === 'ymd' ? valid(b, c) : order === 'mdy' ? valid(a, b) : valid(b, a);
    }),
  );
  if (fits.length === 0) return null;
  const mdy = fits.find(([, , o]) => o === 'mdy');
  const dmy = fits.find(([, , o]) => o === 'dmy');
  if (mdy && dmy) return (preferDayFirst ? dmy : mdy)[0];
  return fits[0]![0];
}

/** ',' when values look like "1.234,56" or "12,50"; otherwise '.'. */
export function detectDecimal(values: readonly string[]): '.' | ',' {
  let comma = 0;
  let dot = 0;
  for (const raw of values) {
    const s = raw.replace(/[^\d.,]/g, '');
    if (/,\d{1,2}$/.test(s)) comma++;
    else if (/\.\d{1,2}$/.test(s)) dot++;
  }
  return comma > dot ? ',' : '.';
}

export function buildMapping(
  c: GuidedChoices,
  analysis: NonNullable<ImportBatchDto['analysis']>,
  proposal: ColumnMappingDto | null,
  preferDayFirst = false,
): ColumnMappingDto {
  if (c.date === null || c.description === null) throw new Error('Choose the date and description columns');
  if (c.amount === null && (c.debit === null || c.credit === null))
    throw new Error('Choose an amount column, or both money out and money in');
  const headerRow = proposal?.headerRow ?? (analysis.header ? 0 : null);
  const dataStart = proposal?.dataStart ?? (headerRow === null ? 0 : headerRow + 1);
  // `analysis.sample` is the raw top of the sheet, header included.
  const col = (i: number) =>
    analysis.sample
      .slice(dataStart)
      .map((r) => r[i] ?? '')
      .filter((v) => v.trim() !== '');
  const dateFormat =
    detectDateFormat(col(c.date), preferDayFirst) ?? proposal?.dateFormat ?? (preferDayFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY');
  const moneyCols = c.amount !== null ? [c.amount] : [c.debit!, c.credit!];
  return {
    headerRow,
    dataStart,
    date: c.date,
    dateFormat,
    description: [c.description],
    ...(c.amount !== null ? { amount: c.amount } : { debit: c.debit!, credit: c.credit! }),
    sign: c.inverted ? 'inverted' : 'normal',
    decimal: detectDecimal(moneyCols.flatMap(col)),
    ...(proposal?.sheet ? { sheet: proposal.sheet } : {}),
  };
}

/** File types the import flow accepts from the picker and the share sheet (IMP-01/02). */
export const IMPORT_MIME_TYPES = [
  'text/csv',
  'text/comma-separated-values',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
] as const;

export function fileTypeOf(name: string, mime?: string | null): 'csv' | 'xlsx' | 'xls' | 'pdf' | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'pdf') return ext;
  if (mime?.includes('pdf')) return 'pdf';
  if (mime?.includes('spreadsheetml')) return 'xlsx';
  if (mime?.includes('ms-excel')) return 'xls';
  if (mime?.includes('csv')) return 'csv';
  return null;
}
