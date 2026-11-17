/**
 * Deterministic tax form reading for the fake provider (tests, e2e and the eval corpus): `parseTaxFormText` reads the
 * masked text the doc-worker hands on, with plain line rules and no guessing. It answers in `extract_tax_form`'s wire
 * format, as a real model would.
 *
 * What it reads:
 * - a form starts at its title ("Form W-2", "W-2c", "1099-INT", "1099-DIV", "Form 1098"; other 1099 sections are
 *   kind "other", with no boxes); the year is the one printed with the title; CORRECTED on a line of its own, or
 *   marked ("X CORRECTED"), or a W-2c, makes it corrected;
 * - the issuer is the line after "Employer's name", "PAYER'S name" or "LENDER'S name" (or after a colon on that line);
 *   the person is the first `MEMBER_n` token. Both are looked for in the text before the first title too (a
 *   consolidated 1099's header);
 * - boxes either inline, one per line ("1 Wages, tips, other compensation 85,120.34"), or as a row of labels with a row
 *   of values under it, cells split by tabs ("1  Wages…\t2  Federal…" then "$85,120.34\t…");
 * - "X Retirement plan" marks a box 13 checkbox, "7 X …" a 1098's box 7.
 */
import type { Output, WireBox, WireForm } from './tasks/extract-tax-form/v1.js';

type Kind = WireForm['kind'];

const TITLES: readonly [RegExp, Kind, boolean][] = [
  [/\bW-2c\b/i, 'w2', true],
  [/\bForm\s+W-2\b|\bW-2\s+Wage and Tax Statement\b/i, 'w2', false],
  [/\b1099-INT\b/i, '1099_int', false],
  [/\b1099-DIV\b/i, '1099_div', false],
  [/\b1099-(?:B|MISC|NEC|R|K|OID|G)\b/i, 'other', false],
  [/\bForm\s+1098(?![-\w])/i, '1098', false],
];

const ISSUER_LABEL = /(?:employer|payer|lender)[’']?s\s+name/i;
const BOX = /^(\d{1,2}[a-f]?)\s+/i;
const AMOUNT = /\$?\s?(\d[\d,]*\.\d{2})/;
const CHECKBOX_13: readonly [RegExp, string][] = [
  [/statutory employee/i, 'statutory_employee'],
  [/retirement plan/i, 'retirement_plan'],
  [/third-party sick pay/i, 'third_party_sick_pay'],
];
const US_STATES = new Set(
  (
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK ' +
    'OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI'
  ).split(' '),
);
/** The labels printed beside a state's ID, which aren't the ID. */
const STATE_ID_LABEL =
  /employer[’']?s\s+state\s+id(?:\s+(?:number|no\.?))?|state\s+identification\s+no\.?|state\s+id/i;

interface Segment {
  kind: Kind;
  taxYear: number | null;
  corrected: boolean;
  pages: Set<number>;
  lines: string[];
}

const titleOf = (line: string): { kind: Kind; corrected: boolean } | null => {
  for (const [re, kind, corrected] of TITLES) if (re.test(line)) return { kind, corrected };
  return null;
};

const cells = (line: string) =>
  line
    .split(/\t+/)
    .map((c) => c.trim())
    .filter(Boolean);

const plain = (amount: string) => amount.replace(/,/g, '');

const isoDate = (s: string): string | null => {
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1]!;
  const us = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return us ? `${us[3]}-${us[1]}-${us[2]}` : null;
};

/** The first US state named in a text, with where its name ends ("ID" before "number" is a label, not Idaho). */
function stateIn(s: string): { code: string; end: number } | null {
  for (const m of s.matchAll(/\b([A-Z]{2})\b/g)) {
    const after = s.slice(m.index + 2);
    if (US_STATES.has(m[1]!) && !(m[1] === 'ID' && /^\s*(?:number|no\b|#)/i.test(after)))
      return { code: m[1]!, end: m.index + 2 };
  }
  return null;
}

/** What's printed before an amount, without "Other" (W-2 box 14, 1098 box 10). */
const description = (value: string, label: string, at: number) =>
  (value.slice(0, at).trim() || label).replace(/^\s*other\b\s*/i, '').trim();

/** One box from its number, the label printed with it, and the value printed after or under it. */
function readBox(
  kind: Kind,
  b: string,
  label: string,
  value: string,
  state: { last: string },
): WireBox | null {
  const n = b.toLowerCase();
  const stateBoxes =
    kind === 'w2'
      ? ['15', '16', '17', '18', '19', '20']
      : kind === '1099_int'
        ? ['15', '16', '17']
        : kind === '1099_div'
          ? ['14', '15', '16']
          : [];
  if (stateBoxes.includes(n)) {
    const first = n === stateBoxes[0];
    const named = first ? stateIn(value) : stateIn(label.replace(/^\s*state\b/i, ''));
    const code = named?.code ?? state.last;
    if (!code) return null;
    state.last = code;
    if (first) {
      const id = (named ? value.slice(named.end) : value).replace(STATE_ID_LABEL, '').trim();
      const usable = id && !/•|redacted/i.test(id) ? id : '';
      return { box: n, value: kind === 'w2' ? usable : '', code, label: '' };
    }
    const rest = named ? value.slice(value.indexOf(code) + 2) : value;
    if (kind === 'w2' && n === '20') return { box: n, value: rest.trim(), code, label: '' };
    if (kind !== 'w2' && n === stateBoxes[1]) {
      const id = rest.replace(STATE_ID_LABEL, '').trim();
      return id && !/•|redacted/i.test(id) ? { box: n, value: id, code, label: '' } : null;
    }
    const amount = AMOUNT.exec(value);
    return amount ? { box: n, value: plain(amount[1]!), code, label: '' } : null;
  }
  const amount = AMOUNT.exec(value);
  if (kind === 'w2' && /^12[a-d]?$/.test(n)) {
    const code = /\bCode\s+([A-Z]{1,2})\b/.exec(label)?.[1] ?? /^([A-Z]{1,2})\b/.exec(value.trim())?.[1];
    return code && amount ? { box: '12', value: plain(amount[1]!), code, label: '' } : null;
  }
  if (kind === 'w2' && n === '14') {
    const what = amount ? description(value, label, amount.index) : '';
    return amount && what ? { box: '14', value: plain(amount[1]!), code: '', label: what } : null;
  }
  if (kind === '1098' && (n === '3' || n === '11')) {
    const date = isoDate(value);
    return date ? { box: n, value: date, code: '', label: '' } : null;
  }
  if (kind === '1098' && n === '9') {
    const count = /(\d{1,2})\s*$/.exec(value.trim());
    return count ? { box: '9', value: count[1]!, code: '', label: '' } : null;
  }
  if (kind === '1098' && n === '10') {
    return amount
      ? { box: '10', value: plain(amount[1]!), code: '', label: description(value, label, amount.index) }
      : null;
  }
  if ((kind === '1099_int' && n === '7') || (kind === '1099_div' && n === '8')) {
    const country = value.replace(/^.*possession\s*/i, '').trim();
    return country ? { box: n, value: country, code: '', label: '' } : null;
  }
  return amount ? { box: n, value: plain(amount[1]!), code: '', label: '' } : null;
}

/** The issuer's name from the line after its label (or after a colon on it); null when it's masked or a box. */
function issuerIn(lines: readonly string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (!ISSUER_LABEL.test(lines[i]!)) continue;
    const after = /:\s*(.+)$/.exec(lines[i]!)?.[1]?.trim();
    const candidate = after ?? lines.slice(i + 1).find((l) => l.trim()) ?? '';
    const name = candidate.split('\t')[0]!.trim();
    if (name && !/redacted|••••/.test(name) && !BOX.test(name) && !/MEMBER_\d/.test(name)) return name;
    return null;
  }
  return null;
}

function readSegment(s: Segment, preamble: readonly string[]): WireForm | null {
  const boxes: WireBox[] = [];
  const state = { last: '' };
  let corrected = s.corrected;
  for (let i = 0; i < s.lines.length; i++) {
    const line = s.lines[i]!;
    const trimmed = line.trim();
    if (/^(?:CORRECTED|(?:X|☒)\s+CORRECTED)\b/.test(trimmed) && !/if checked/i.test(trimmed))
      corrected = true;
    const check = /^(?:X|☒)\s+(.+)$/.exec(trimmed);
    if (check && s.kind === 'w2') {
      const which = CHECKBOX_13.find(([re]) => re.test(check[1]!));
      if (which) boxes.push({ box: '13', value: 'X', code: which[1], label: '' });
      continue;
    }
    if (s.kind === '1098' && /^7\s+(?:X|☒)\s/.test(trimmed)) {
      boxes.push({ box: '7', value: 'X', code: '', label: '' });
      continue;
    }
    // A row of labels with a row of values under it.
    const labelCells = cells(line);
    if (line.includes('\t') && labelCells.every((c) => BOX.test(c)) && i + 1 < s.lines.length) {
      const values = cells(s.lines[i + 1]!);
      const nextIsLabels = values.length > 0 && values.every((c) => BOX.test(c));
      if (!nextIsLabels && values.length === labelCells.length) {
        labelCells.forEach((c, k) => {
          const [, b, label] = /^(\d{1,2}[a-f]?)\s+(.*)$/i.exec(c)!;
          const read = readBox(s.kind, b!, label!, values[k]!, state);
          if (read) boxes.push(read);
        });
        i++;
        continue;
      }
    }
    // One box on its line: "1 Interest income 412.07".
    const inline = /^(\d{1,2}[a-f]?)\s+(.*)$/i.exec(trimmed);
    if (inline) {
      const rest = inline[2]!;
      const amount = AMOUNT.exec(rest);
      const read = readBox(s.kind, inline[1]!, amount ? rest.slice(0, amount.index) : rest, rest, state);
      if (read) boxes.push(read);
    }
  }
  if (s.kind !== 'other' && boxes.length === 0) return null;
  const person = /\bMEMBER_\d{1,3}\b/.exec([...s.lines, ...preamble].join('\n'))?.[0] ?? null;
  const issuerName = issuerIn(s.lines) ?? issuerIn(preamble);
  return {
    kind: s.kind,
    taxYear: s.taxYear,
    corrected,
    issuerName,
    person,
    pages: [...s.pages].sort((a, b) => a - b),
    // Sections Montra doesn't read yet are named, never read.
    boxes: s.kind === 'other' ? [] : boxes,
    confidence: issuerName ? 0.95 : 0.6,
  };
}

/** Reads the forms in pages of masked text. */
export function parseTaxFormText(pages: readonly { page: number; text: string }[]): Output {
  const segments: Segment[] = [];
  const preamble: string[] = [];
  let current: Segment | null = null;
  for (const p of pages) {
    for (const line of p.text.split('\n')) {
      const title = titleOf(line);
      const continues =
        current !== null && title?.kind === current.kind && current.lines.every((l) => !BOX.test(l.trim()));
      if (title && !continues) {
        current = {
          kind: title.kind,
          taxYear: Number(/\b(20\d{2})\b/.exec(line)?.[1]) || null,
          corrected: title.corrected,
          pages: new Set([p.page]),
          lines: [],
        };
        segments.push(current);
        continue;
      }
      if (!current) {
        preamble.push(line);
        continue;
      }
      if (title) current.corrected ||= title.corrected;
      current.pages.add(p.page);
      if (current.taxYear === null) {
        const year = /\b(20\d{2})\b/.exec(title ? line : '')?.[1];
        if (year) current.taxYear = Number(year);
      }
      current.lines.push(line);
    }
  }
  const forms: WireForm[] = [];
  for (const s of segments) {
    const f = readSegment(s, preamble);
    if (!f) continue;
    // A copy of a form already read (Copy B, Copy C): one form, on both pages.
    const same = forms.find(
      (o) => o.kind === f.kind && o.kind !== 'other' && JSON.stringify(o.boxes) === JSON.stringify(f.boxes),
    );
    if (same) same.pages = [...new Set([...same.pages, ...f.pages])].sort((a, b) => a - b);
    else forms.push(f);
  }
  return { forms };
}
