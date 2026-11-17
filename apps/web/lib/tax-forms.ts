/**
 * The Tax forms screen's pure helpers (ADR-0052 §7.1): which year to open, the boxes each kind of form has and how
 * typed boxes become the API's minor units, the result's colour, and the expected forms grouped by person. No float
 * math: amounts go through @montra/domain.
 */
import type { TaxFormDto, TaxFormExpectedDto, TaxFormResultDto } from '@montra/api-client';
import { minorToInput, parseAmountInput } from './money';

export type TaxFormKind = TaxFormDto['kind'];
export const KINDS: readonly TaxFormKind[] = ['w2', '1099_int', '1099_div', '1098'];

/** Last year from January to April, while its forms arrive and are checked; this year otherwise. */
export function defaultTaxYear(today: string): number {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month <= 4 ? year - 1 : year;
}

/** The years the picker offers: the last four, newest first, and the one shown if it's older. */
export function yearChoices(today: string, shown: number): number[] {
  const year = Number(today.slice(0, 4));
  const years = [year, year - 1, year - 2, year - 3];
  return years.includes(shown) ? years : [...years, shown].sort((a, b) => b - a);
}

/** The money boxes each kind is typed in by, in the order printed on the form. */
export const MONEY_BOXES: Record<TaxFormKind, readonly string[]> = {
  w2: ['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box8', 'box10', 'box11'],
  '1099_int': [
    'box1',
    'box2',
    'box3',
    'box4',
    'box5',
    'box6',
    'box8',
    'box9',
    'box10',
    'box11',
    'box12',
    'box13',
  ],
  '1099_div': [
    'box1a',
    'box1b',
    'box2a',
    'box2b',
    'box2c',
    'box2d',
    'box2e',
    'box2f',
    'box3',
    'box4',
    'box5',
    'box6',
    'box7',
    'box9',
    'box10',
    'box12',
    'box13',
  ],
  '1098': ['box1', 'box2', 'box4', 'box5', 'box6', 'box10'],
};

/** W-2 box 12 codes offered in the editor; others stay as read. */
export const BOX12_CODES = ['D', 'AA', 'W', 'C', 'DD', 'E', 'G', 'P', 'V', 'Y'] as const;

type T = (key: string, values?: Record<string, string | number>) => string;

/** What the editor holds while a form is typed: every box as typed text. */
export interface BoxFields {
  money: Record<string, string>;
  box12: { code: string; amount: string }[];
  /** W-2's first state row (boxes 15–17). */
  state: { state: string; box16: string; box17: string };
  /** 1098 dates and box 10's label. */
  box3: string;
  box11: string;
  box10Label: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const money = (v: unknown) => (typeof v === 'string' && v !== '' ? minorToInput(BigInt(v), 'USD') : '');

/** A form's stored boxes as editor fields. */
export function boxFields(kind: TaxFormKind, boxes: Record<string, unknown>): BoxFields {
  const state = (Array.isArray(boxes.states) ? boxes.states[0] : undefined) as
    Record<string, unknown> | undefined;
  return {
    money: Object.fromEntries(MONEY_BOXES[kind].map((k) => [k, money(boxes[k])])),
    box12: Array.isArray(boxes.box12)
      ? (boxes.box12 as { code: string; amount: string }[]).map((e) => ({
          code: e.code,
          amount: money(e.amount),
        }))
      : [],
    state: { state: str(state?.state), box16: money(state?.box16), box17: money(state?.box17) },
    box3: str(boxes.box3),
    box11: str(boxes.box11),
    box10Label: str(boxes.box10Label),
  };
}

export type BoxesResult =
  { ok: true; boxes: Record<string, unknown> } | { ok: false; field: string; error: string };

/**
 * The editor's fields as the API's boxes, on top of what the form already holds (boxes the editor doesn't show, such as
 * box 14 or a second state, are kept). A blank box is left out.
 */
export function boxesOf(
  kind: TaxFormKind,
  fields: BoxFields,
  previous: Record<string, unknown> = {},
  t?: T,
): BoxesResult {
  const out: Record<string, unknown> = { ...previous };
  const amount = (field: string, text: string): { ok: true; value: string | undefined } | BoxesResult => {
    if (text.trim() === '') return { ok: true, value: undefined };
    const r = parseAmountInput(text, 'USD', 'en-US', t);
    if (!r.ok) return { ok: false, field, error: r.error };
    if (r.minor < 0n)
      return { ok: false, field, error: t ? t('tax_forms.negative') : 'Boxes are never negative' };
    return { ok: true, value: r.minor.toString() };
  };
  for (const k of MONEY_BOXES[kind]) {
    const r = amount(k, fields.money[k] ?? '');
    if (!r.ok) return r;
    if ('value' in r && r.value !== undefined) out[k] = r.value;
    else delete out[k];
  }
  if (kind === 'w2') {
    const rows: { code: string; amount: string }[] = [];
    for (const [i, e] of fields.box12.entries()) {
      const r = amount(`box12.${i}`, e.amount);
      if (!r.ok) return r;
      if ('value' in r && r.value !== undefined && e.code) rows.push({ code: e.code, amount: r.value });
    }
    if (rows.length) out.box12 = rows;
    else delete out.box12;
    const others = Array.isArray(previous.states) ? (previous.states as unknown[]).slice(1) : [];
    const code = fields.state.state.trim().toUpperCase();
    if (code) {
      const row: Record<string, unknown> = {
        ...((Array.isArray(previous.states) ? previous.states[0] : {}) as Record<string, unknown>),
        state: code,
      };
      for (const b of ['box16', 'box17'] as const) {
        const r = amount(`state.${b}`, fields.state[b]);
        if (!r.ok) return r;
        if ('value' in r && r.value !== undefined) row[b] = r.value;
        else delete row[b];
      }
      out.states = [row, ...others];
    } else if (others.length) out.states = others;
    else delete out.states;
  }
  if (kind === '1098') {
    for (const k of ['box3', 'box11', 'box10Label'] as const) {
      const v = fields[k].trim();
      if (v) out[k] = v;
      else delete out[k];
    }
  }
  return { ok: true, boxes: out };
}

/** The chip a result is shown in: green when it matches, amber when it needs a look, grey otherwise. */
export function resultChip(state: TaxFormResultDto['state']): string {
  if (state === 'matches' || state === 'accepted') return 'chip chip-good';
  if (state === 'not_tracked' || state === 'reading' || state === 'dismissed' || state === 'superseded')
    return 'chip chip-muted';
  return 'chip chip-warn';
}

/** The chip a check is shown in. */
export function checkChip(status: string): string {
  if (status === 'matches' || status === 'explained' || status === 'accepted') return 'chip chip-good';
  if (status === 'differs' || status === 'check_reading') return 'chip chip-warn';
  return 'chip chip-muted';
}

/** Expected forms grouped by the person they're for (household last), each group in the order given. */
export function byPerson(
  expected: readonly TaxFormExpectedDto[],
  names: ReadonlyMap<string, string>,
): { personMemberId: string | null; name: string | null; items: TaxFormExpectedDto[] }[] {
  const groups = new Map<string | null, TaxFormExpectedDto[]>();
  for (const e of expected) groups.set(e.personMemberId, [...(groups.get(e.personMemberId) ?? []), e]);
  return [...groups.entries()]
    .map(([id, items]) => ({ personMemberId: id, name: id ? (names.get(id) ?? null) : null, items }))
    .sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name)));
}

/** Whether a form's checks can be acted on: a `check` box that differs and isn't accepted yet. */
export const acceptable = (c: TaxFormDto['checks'][number]): boolean =>
  c.kind === 'check' && (c.status === 'differs' || c.status === 'check_reading');

// ----- Forms read from files (ADR-0052 PR 3) ----------------------------------------------------------------------

/** The files the drop zone takes: PDFs and photos, as the API sniffs them. */
export const UPLOAD_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp';

/**
 * Where a form from a file stands in its reading, for the screen's words: being read (or waiting for a worker),
 * couldn't be read (type it in), read and waiting for a person to confirm it, or confirmed (by a person or by the
 * books agreeing). Null for a form typed in.
 */
export const READING_STAGES = [
  'reading',
  'waiting',
  'unread',
  'to_confirm',
  'confirmed_by_books',
  'confirmed',
] as const;
export type ReadingStage = (typeof READING_STAGES)[number];

export function readingStage(form: TaxFormDto): ReadingStage | null {
  const r = form.reading;
  if (!r) return null;
  if (form.status === 'reading') {
    if (r.problem === 'failed') return 'unread';
    return r.problem === 'waiting' ? 'waiting' : 'reading';
  }
  if (form.status === 'confirmed') return r.confirmedBy === 'books' ? 'confirmed_by_books' : 'confirmed';
  if (!r.kindKnown || !r.boxesRead || form.reason === 'unread') return 'unread';
  return 'to_confirm';
}

/** Whether Confirm reading can be pressed: read, in Review, matched, and for a known person. */
export function canConfirmReading(form: TaxFormDto): boolean {
  return (
    form.reading !== null &&
    form.status === 'review' &&
    form.reason !== 'unread' &&
    form.reading.kindKnown &&
    Object.keys(form.boxes).length > 0 &&
    form.targets.length > 0 &&
    form.personMemberId !== null
  );
}

/** Whether the screen should look again soon: a form is still being read. */
export const anyReading = (forms: readonly TaxFormDto[]): boolean =>
  forms.some((f) => f.status === 'reading' && f.reading?.problem !== 'failed');
