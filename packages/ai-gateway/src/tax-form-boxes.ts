/**
 * `extract_tax_form`'s validator (ADR-0052 §6): the model's flat list of boxes becomes the stored boxes of
 * `@montra/domain` (money as strings of minor units), box by box. Anything that isn't a box of the kind, or isn't a
 * valid value for it, is dropped and counted, never guessed at.
 */
import { TaxFormBoxesJsonSchemas, W2_BOX12_CODES, type TaxFormKind, type W2Box12Code } from '@montra/domain';
import { BOX13_CODES, type WireBox } from './tasks/extract-tax-form/v1.js';

/** "85,120.34", "$85120.3", "412" → minor units as a string; null for anything else (negative included). */
export function decimalToMinor(value: string): string | null {
  const t = value.replace(/[\s,$]/g, '');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const cents = (m[2] ?? '').padEnd(2, '0');
  return String(BigInt(m[1]!) * 100n + BigInt(cents));
}

const STATE = /^[A-Z]{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const box = (b: string) =>
  b
    .trim()
    .toLowerCase()
    .replace(/^box\s*/, '');

const text = (s: string, max: number): string | null => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : null;
};

const isDate = (s: string) => {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Plain money boxes per kind: the box as printed → the stored field. */
const MONEY: Record<TaxFormKind, Record<string, string>> = {
  w2: Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8', '10', '11'].map((b) => [b, `box${b}`])),
  '1099_int': Object.fromEntries(
    ['1', '2', '3', '4', '5', '6', '8', '9', '10', '11', '12', '13'].map((b) => [b, `box${b}`]),
  ),
  '1099_div': Object.fromEntries(
    ['1a', '1b', '2a', '2b', '2c', '2d', '2e', '2f', '3', '4', '5', '6', '7', '9', '10', '12', '13'].map(
      (b) => [b, `box${b}`],
    ),
  ),
  '1098': Object.fromEntries(['1', '2', '4', '5', '6', '10'].map((b) => [b, `box${b}`])),
};

/** 1099 state rows: the box that names the state, its ID and its tax withheld. */
const STATE_ROWS_1099: Record<'1099_int' | '1099_div', { state: string; id: string; tax: string }> = {
  '1099_int': { state: '15', id: '16', tax: '17' },
  '1099_div': { state: '14', id: '15', tax: '16' },
};

const BOX13_FIELDS: Record<(typeof BOX13_CODES)[number], string> = {
  statutory_employee: 'statutoryEmployee',
  retirement_plan: 'retirementPlan',
  third_party_sick_pay: 'thirdPartySickPay',
};

/**
 * Converts one form's wire boxes. Returns the stored boxes (valid under the kind's schema) and how many wire boxes
 * were kept and dropped.
 */
export function taxFormBoxesFromWire(
  kind: TaxFormKind,
  items: readonly WireBox[],
): { boxes: Record<string, unknown>; kept: number; dropped: number } {
  const out: Record<string, unknown> = {};
  const box12: { code: W2Box12Code; amount: string }[] = [];
  const box14: { label: string; amount: string }[] = [];
  const box13: Record<string, boolean> = {};
  const states = new Map<string, Record<string, string>>();
  const stateRow = (code: string) => {
    const s = code.trim().toUpperCase();
    if (!STATE.test(s)) return null;
    if (!states.has(s)) states.set(s, { state: s });
    return states.get(s)!;
  };
  let kept = 0;
  let dropped = 0;
  const keep = (ok: boolean) => (ok ? kept++ : dropped++);

  for (const item of items) {
    const b = box(item.box);
    const value = item.value.trim();
    const field = MONEY[kind][b];
    if (field) {
      const minor = decimalToMinor(value);
      // A box read twice keeps the first reading.
      const ok = minor !== null && out[field] === undefined;
      if (ok) out[field] = minor;
      keep(ok);
      continue;
    }
    if (kind === 'w2') {
      if (b === '12' || /^12[a-d]$/.test(b)) {
        const code = item.code.trim().toUpperCase() as W2Box12Code;
        const amount = decimalToMinor(value);
        const ok = W2_BOX12_CODES.includes(code) && amount !== null && box12.length < 4;
        if (ok) box12.push({ code, amount: amount! });
        keep(ok);
      } else if (b === '13') {
        const field13 = BOX13_FIELDS[item.code.trim().toLowerCase() as keyof typeof BOX13_FIELDS];
        const ok = !!field13 && /^(x|yes|true|checked)$/i.test(value);
        if (ok) box13[field13] = true;
        keep(ok);
      } else if (b === '14') {
        const label = text(item.label, 40);
        const amount = decimalToMinor(value);
        const ok = !!label && amount !== null && box14.length < 8;
        if (ok) box14.push({ label: label!, amount: amount! });
        keep(ok);
      } else if (['15', '16', '17', '18', '19', '20'].includes(b)) {
        const row =
          states.size < 4 || states.has(item.code.trim().toUpperCase()) ? stateRow(item.code) : null;
        let ok = false;
        if (row && b === '15') {
          // A state named with no ID still opens its row.
          const id = text(value, 30);
          ok = id === null ? value === '' : !row.employerStateId;
          if (ok && id !== null) row.employerStateId = id;
        } else if (row && b === '20') {
          const locality = text(value, 40);
          ok = locality !== null && !row.box20;
          if (ok) row.box20 = locality!;
        } else if (row) {
          const amount = decimalToMinor(value);
          ok = amount !== null && !row[`box${b}`];
          if (ok) row[`box${b}`] = amount!;
        }
        keep(ok);
      } else keep(false);
      continue;
    }
    if (kind === '1099_int' || kind === '1099_div') {
      const rows = STATE_ROWS_1099[kind];
      const country = kind === '1099_int' ? '7' : '8';
      if (b === country) {
        const name = text(value, 60);
        const ok = name !== null && out[`box${b}`] === undefined;
        if (ok) out[`box${b}`] = name;
        keep(ok);
      } else if ([rows.state, rows.id, rows.tax].includes(b)) {
        const row =
          states.size < 4 || states.has(item.code.trim().toUpperCase()) ? stateRow(item.code) : null;
        let ok = false;
        if (row && b === rows.state) ok = true;
        else if (row && b === rows.id) {
          const id = text(value, 30);
          ok = id !== null && !row.stateId;
          if (ok) row.stateId = id!;
        } else if (row) {
          const amount = decimalToMinor(value);
          ok = amount !== null && !row.stateTaxWithheld;
          if (ok) row.stateTaxWithheld = amount!;
        }
        keep(ok);
      } else keep(false);
      continue;
    }
    // 1098
    if (b === '3' || b === '11') {
      const ok = isDate(value) && out[`box${b}`] === undefined;
      if (ok) out[`box${b}`] = value;
      keep(ok);
    } else if (b === '7') {
      const ok = /^(x|yes|true|checked)$/i.test(value);
      if (ok) out.box7 = true;
      keep(ok);
    } else if (b === '9') {
      const ok = /^\d{1,2}$/.test(value);
      if (ok) out.box9 = Number(value);
      keep(ok);
    } else keep(false);
  }
  // Box 10's description, when box 10 was read.
  if (kind === '1098' && out.box10 !== undefined) {
    const label = items.map((i) => (box(i.box) === '10' ? text(i.label, 60) : null)).find(Boolean);
    if (label) out.box10Label = label;
  }
  if (box12.length) out.box12 = box12;
  if (box14.length) out.box14 = box14;
  if (Object.keys(box13).length) out.box13 = box13;
  if (states.size) {
    out.states = [...states.values()].slice(0, 4);
  }
  // Belt and braces: what's built must pass the kind's schema; if it somehow doesn't, nothing is kept.
  const check = TaxFormBoxesJsonSchemas[kind].safeParse(out);
  if (!check.success) return { boxes: {}, kept: 0, dropped: items.length };
  return { boxes: out, kept, dropped };
}
