/**
 * A statement rendered as a PDF (VLT-13, ADR-0057 §2, §3). Pure: data in, bytes out.
 *
 * - Drawn from the import's parsed rows, never from the file: one renderer for every format the import reads.
 * - One cover page (the document summary, as much as the detail switch allows), then a table of date, description,
 *   money out, money in and running balance, with a page header (account name, period, page n of m) and the totals at
 *   the end.
 * - More rows than `maxRows` are split into parts, each its own PDF titled "part n of m".
 * - The original file can be attached inside the PDF (a PDF attachment, related as its source). With parts, it goes in
 *   the first part only, and the others' covers say so.
 * - Text prints in embedded Noto fonts, script by script, as invoices do (ADR-0032), so descriptions in any script print
 *   as written.
 * - The same input gives the same bytes: the documents' dates are passed in, and nothing else varies.
 */
import { AFRelationship, PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import { asCurrencyCode, formatMoney, minorUnits, money, toDecimalString } from '@montra/domain';
import { drawRuns, FontSet, type ShapedRun } from '../business/pdf-fonts.js';
import type { StatementLine, StatementSummary } from './document-summary.js';

export interface StatementPdfInput {
  summary: StatementSummary;
  /** The rows to draw, in order with their running balances; null when the file couldn't be read into rows. */
  lines: StatementLine[] | null;
  /** The "Describe documents in more detail" switch: off, the cover shows no amounts and no account number. */
  detail: boolean;
  /** The original file, attached inside the PDF when given. */
  original: { bytes: Uint8Array; mime: string } | null;
  /** STATEMENT_PDF_MAX_ROWS: the most rows in one PDF. */
  maxRows: number;
  /** The documents' creation date (and the attachment's), so that rendering again gives the same bytes. */
  at: Date;
}

export interface StatementPdfPart {
  part: number;
  parts: number;
  title: string;
  bytes: Uint8Array;
  pages: number;
  rows: number;
  /** Whether the original file is attached inside this part. */
  attached: boolean;
}

/** What was drawn where: a test's view of the page, since the embedded fonts' text isn't plain in the file. */
export interface DrawnText {
  part: number;
  /** 1-based, within the part. */
  page: number;
  text: string;
  /** Where the text is anchored: its left edge, or its right edge when right-aligned (the amount columns). */
  x: number;
  align: 'left' | 'right';
  y: number;
  size: number;
}
export type DrawTrace = (t: DrawnText) => void;

export interface CoverLine {
  label: string;
  value: string;
}

const WIDTH = 612; // US Letter
const HEIGHT = 792;
const MARGIN = 40;
const INK = rgb(0.1, 0.12, 0.14);
const MUTED = rgb(0.42, 0.45, 0.48);
const LINE = rgb(0.75, 0.77, 0.8);
const SHADE = rgb(0.95, 0.95, 0.96);
const ROW = 13;
const SIZE = 8.5;
const ELLIPSIS = '…';

// The table's columns: dates and descriptions from the left, amounts to the right edge of their column.
export const COL = {
  date: MARGIN,
  description: MARGIN + 62,
  out: WIDTH - MARGIN - 170,
  in: WIDTH - MARGIN - 85,
  balance: WIDTH - MARGIN,
};
const DESCRIPTION_WIDTH = COL.out - 80 - COL.description;

/** The note every rendered statement carries (ADR-0057 Consequences): it is Montra's rendering, not the bank's. */
export const RENDERED_NOTE =
  "Rendered by Montra from the imported rows. This is Montra's rendering, not the bank's own statement.";
/** A cover with no rows under it says only what it is. */
export const COVER_ONLY_NOTE =
  "Made by Montra as a cover for the original file. It is not the bank's own statement.";
export const UNREADABLE_NOTE =
  "Montra couldn't render this statement: it couldn't read the file into rows, so this PDF has only its cover.";

const CHECKS: Record<'ok' | 'mismatch' | 'n_a', string> = {
  ok: 'They check out: the opening balance and the rows add up to the closing balance',
  mismatch: "They don't check out: the opening balance and the rows don't add up to the closing balance",
  n_a: "Not checked: the file doesn't state both balances",
};

/** A whole-statement amount on the cover, with its currency ("$1,234.56"). */
const coverAmount = (minor: bigint, currency: string) =>
  formatMoney(money(minor, asCurrencyCode(currency)), { locale: 'en-US' });

/** An amount in the table, without the currency the page header names ("1,234.56", "-12.00"). */
export function tableAmount(minor: bigint, currency: string): string {
  const code = asCurrencyCode(currency);
  const exp = minorUnits(code);
  const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: exp, maximumFractionDigits: exp });
  // Intl.NumberFormat v3 formats a numeric string exactly; the cast is for older lib typings.
  return nf.format(toDecimalString(money(minor, code)) as unknown as number);
}

const periodText = (s: StatementSummary) =>
  s.period ? `${s.period.start} to ${s.period.end}` : 'Period not known';

/**
 * What the cover lists (ADR-0057 §3). With the detail switch off: the account, its institution and type, the holders,
 * the currency and the period only; no amounts, no account number and nothing about the file. With it on: the account
 * number as chosen, the figures, and the original file's name, format, hash and import date too.
 */
export function coverLines(s: StatementSummary, detail: boolean): CoverLine[] {
  const out: CoverLine[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) out.push({ label, value });
  };
  add('Account', s.account?.name ?? 'Not known');
  add('Institution', s.account?.institution);
  add('Account type', s.account?.type);
  add(s.holders.length > 1 ? 'Account holders' : 'Account holder', s.holders.join(', '));
  if (detail) add('Account number', s.accountNumber);
  add('Currency', s.currency);
  add(
    'Period',
    s.period
      ? `${periodText(s)}${s.period.from === 'transactions' ? ' (first and last transactions)' : ''}`
      : null,
  );
  if (!detail) return out;
  const f = s.figures;
  if (f && s.currency) {
    add('Opening balance', f.opening === null ? 'Not stated' : coverAmount(f.opening, s.currency));
    add('Closing balance', f.closing === null ? 'Not stated' : coverAmount(f.closing, s.currency));
    add('Money in', coverAmount(f.moneyIn, s.currency));
    add('Money out', coverAmount(f.moneyOut, s.currency));
    add('Transactions', String(f.count));
    add('Balances', CHECKS[f.balanceCheck]);
  }
  add('Original file', s.original.fileName);
  add('Format', s.original.format);
  add('SHA-256', s.original.sha256);
  add('Imported', s.original.importedOn);
  return out;
}

/** The parts' titles: "Checking statement, 2026-10-01 to 2026-10-31, part 1 of 2". */
export function partTitle(s: StatementSummary, part: number, parts: number): string {
  const name = s.account ? `${s.account.name} statement` : 'Statement';
  const period = s.period ? `, ${periodText(s)}` : '';
  return `${name}${period}${parts > 1 ? `, part ${part} of ${parts}` : ''}`;
}

type Weight = 'regular' | 'bold';
const widthOf = (runs: readonly ShapedRun[], size: number) => runs.reduce((w, r) => w + r.width * size, 0);
const clean = (s: string) => s.replace(/[\r\n\t]+/g, ' ');

/**
 * Renders the statement: one PDF, or several parts when it has more rows than `maxRows`. A file that couldn't be read
 * (`lines` null) gives the cover alone, saying so.
 */
export async function renderStatementPdf(
  input: StatementPdfInput,
  trace?: DrawTrace,
): Promise<StatementPdfPart[]> {
  const lines = input.lines ?? [];
  const max = Math.max(1, input.maxRows);
  const parts = input.lines === null ? 1 : Math.max(1, Math.ceil(lines.length / max));
  const out: StatementPdfPart[] = [];
  for (let part = 1; part <= parts; part++) {
    const from = (part - 1) * max;
    const slice = input.lines === null ? null : lines.slice(from, from + max);
    out.push(await renderPart(input, part, parts, from, slice, trace));
  }
  return out;
}

async function renderPart(
  input: StatementPdfInput,
  part: number,
  parts: number,
  from: number,
  rows: StatementLine[] | null,
  trace: DrawTrace | undefined,
): Promise<StatementPdfPart> {
  const s = input.summary;
  const currency = s.currency ?? 'USD';
  const title = partTitle(s, part, parts);
  const attach = input.original !== null && part === 1;

  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(title);
  pdf.setSubject(rows === null ? COVER_ONLY_NOTE : RENDERED_NOTE);
  pdf.setCreator('Montra');
  pdf.setProducer('Montra');
  pdf.setLanguage('en');
  pdf.setCreationDate(input.at);
  pdf.setModificationDate(input.at);

  const cover = coverLines(s, input.detail);
  const rowTexts = (rows ?? []).flatMap((r) => [
    r.date,
    r.description,
    tableAmount(r.amount < 0n ? -r.amount : r.amount, currency),
    r.balance === null ? '' : tableAmount(r.balance, currency),
  ]);
  const fonts = new FontSet(pdf, { ligatures: false });
  fonts.prepare([
    title,
    s.account?.name ?? '',
    periodText(s),
    ...cover.flatMap((l) => [l.label, l.value]),
    ...rowTexts,
    RENDERED_NOTE,
    COVER_ONLY_NOTE,
    UNREADABLE_NOTE,
    'Statement Page of Part Date Description Money out Money in Balance Totals for this part statement Amounts in',
    'The original file is attached to this PDF. part rows This holds Continued in',
    `0123456789,.-–·${ELLIPSIS}•()`,
  ]);
  const shapes = new Map<string, Promise<ShapedRun[]>>();
  const shape = (text: string, weight: Weight = 'regular') => {
    const key = `${weight}:${text}`;
    let hit = shapes.get(key);
    if (!hit) {
      hit = fonts.shape(clean(text), weight);
      shapes.set(key, hit);
    }
    return hit;
  };

  let page: PDFPage = pdf.addPage([WIDTH, HEIGHT]);
  let pageNo = 1;
  let y = HEIGHT - MARGIN;
  const draw = async (
    text: string,
    x: number,
    size: number,
    weight: Weight,
    color = INK,
    align: 'left' | 'right' = 'left',
  ) => {
    if (!text) return;
    const runs = await shape(text, weight);
    const at = align === 'right' ? x - widthOf(runs, size) : x;
    drawRuns(page, runs, at, y, size, color);
    trace?.({ part, page: pageNo, text, x, align, y, size });
  };
  /** Text cut to `width`, ending in an ellipsis; the longest start that fits, found by halving. */
  const fit = async (text: string, size: number, width: number, weight: Weight = 'regular') => {
    const t = clean(text);
    if (widthOf(await shape(t, weight), size) <= width) return t;
    const chars = [...t];
    let lo = 0;
    let hi = chars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (widthOf(await shape(chars.slice(0, mid).join('') + ELLIPSIS, weight), size) <= width) lo = mid;
      else hi = mid - 1;
    }
    return chars.slice(0, lo).join('').trimEnd() + ELLIPSIS;
  };
  /** Words to lines no wider than `width`. */
  const wrap = async (text: string, size: number, width: number, weight: Weight = 'regular') => {
    const out: string[] = [];
    let line = '';
    for (const word of clean(text).split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (!line || widthOf(await shape(next, weight), size) <= width) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
    // One at a time, so fonts are embedded in the same order every time (the same bytes).
    const fitted: string[] = [];
    for (const l of out) fitted.push(await fit(l, size, width, weight));
    return fitted;
  };

  // ----- The cover ------------------------------------------------------------------------------------------------
  await draw('Statement', MARGIN, 9, 'bold', MUTED);
  y -= 24;
  await draw(await fit(s.account?.name ?? 'Statement', 20, WIDTH - 2 * MARGIN, 'bold'), MARGIN, 20, 'bold');
  y -= 18;
  await draw(
    `${periodText(s)}${parts > 1 ? `, part ${part} of ${parts}` : ''}`,
    MARGIN,
    10.5,
    'regular',
    MUTED,
  );
  y -= 28;
  if (rows === null) {
    const notice = await wrap(
      `${UNREADABLE_NOTE}${attach ? ' The original file is attached to this PDF.' : ''}`,
      10,
      WIDTH - 2 * MARGIN - 20,
    );
    const h = notice.length * 14 + 12;
    page.drawRectangle({ x: MARGIN, y: y - h + 16, width: WIDTH - 2 * MARGIN, height: h, color: SHADE });
    for (const l of notice) {
      await draw(l, MARGIN + 10, 10, 'regular');
      y -= 14;
    }
    y -= 20;
  }
  const LABEL_W = 130;
  for (const l of cover) {
    const values = await wrap(l.value, 10, WIDTH - 2 * MARGIN - LABEL_W);
    await draw(l.label, MARGIN, 9, 'regular', MUTED);
    for (const v of values) {
      await draw(v, MARGIN + LABEL_W, 10, l.label === 'Account' ? 'bold' : 'regular');
      y -= 15;
    }
    y -= 3;
  }
  if (rows !== null && parts > 1) {
    y -= 8;
    await draw(
      `This part holds rows ${from + 1}–${from + rows.length} of ${input.lines?.length ?? 0}.`,
      MARGIN,
      9.5,
      'regular',
    );
    y -= 14;
  }
  y = MARGIN + 34;
  const notes = [
    rows === null ? COVER_ONLY_NOTE : RENDERED_NOTE,
    attach
      ? 'The original file is attached to this PDF.'
      : input.original !== null
        ? 'The original file is attached to part 1.'
        : '',
  ].filter(Boolean);
  for (const n of await wrap(notes.join(' '), 8, WIDTH - 2 * MARGIN)) {
    await draw(n, MARGIN, 8, 'regular', MUTED);
    y -= 11;
  }

  // ----- The table ------------------------------------------------------------------------------------------------
  const bodyPages: { page: PDFPage; no: number }[] = [];
  const TOP = HEIGHT - MARGIN - 34;
  const newPage = async () => {
    page = pdf.addPage([WIDTH, HEIGHT]);
    pageNo++;
    bodyPages.push({ page, no: pageNo });
    y = TOP;
    await draw('Date', COL.date, 8, 'bold', MUTED);
    await draw('Description', COL.description, 8, 'bold', MUTED);
    await draw('Money out', COL.out, 8, 'bold', MUTED, 'right');
    await draw('Money in', COL.in, 8, 'bold', MUTED, 'right');
    await draw('Balance', COL.balance, 8, 'bold', MUTED, 'right');
    y -= 5;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: WIDTH - MARGIN, y }, thickness: 0.5, color: LINE });
    y -= 12;
  };
  const room = (n: number) => y - n >= MARGIN + 10;
  const totalsRow = async (label: string, out: bigint, inn: bigint, balance: bigint | null) => {
    await draw(label, COL.description, SIZE, 'bold');
    await draw(tableAmount(out, currency), COL.out, SIZE, 'bold', INK, 'right');
    await draw(tableAmount(inn, currency), COL.in, SIZE, 'bold', INK, 'right');
    if (balance !== null) await draw(tableAmount(balance, currency), COL.balance, SIZE, 'bold', INK, 'right');
    y -= ROW;
  };

  if (rows !== null) {
    await newPage();
    for (const r of rows) {
      if (!room(ROW)) await newPage();
      await draw(r.date, COL.date, SIZE, 'regular');
      await draw(await fit(r.description, SIZE, DESCRIPTION_WIDTH), COL.description, SIZE, 'regular');
      if (r.amount < 0n) await draw(tableAmount(-r.amount, currency), COL.out, SIZE, 'regular', INK, 'right');
      else await draw(tableAmount(r.amount, currency), COL.in, SIZE, 'regular', INK, 'right');
      if (r.balance !== null)
        await draw(tableAmount(r.balance, currency), COL.balance, SIZE, 'regular', INK, 'right');
      y -= ROW;
    }
    const sums = (list: readonly StatementLine[]) =>
      list.reduce(
        (t, r) => (r.amount < 0n ? { ...t, out: t.out - r.amount } : { ...t, in: t.in + r.amount }),
        { out: 0n, in: 0n },
      );
    const last = rows.length ? rows[rows.length - 1]!.balance : null;
    if (!room(ROW * 3 + 6)) await newPage();
    y -= 2;
    page.drawLine({
      start: { x: MARGIN, y: y + 9 },
      end: { x: WIDTH - MARGIN, y: y + 9 },
      thickness: 0.5,
      color: LINE,
    });
    y -= 4;
    const mine = sums(rows);
    if (parts === 1) await totalsRow('Totals', mine.out, mine.in, last);
    else {
      await totalsRow(`Totals for part ${part}`, mine.out, mine.in, last);
      if (part === parts) {
        const all = sums(input.lines ?? []);
        await totalsRow('Statement totals', all.out, all.in, last);
      } else {
        await draw(`Continued in part ${part + 1} of ${parts}.`, COL.description, SIZE, 'regular', MUTED);
        y -= ROW;
      }
    }
  }

  // ----- Page headers and numbers, now the count is known ------------------------------------------------------------
  const total = pdf.getPageCount();
  const pages = pdf.getPages();
  page = pages[0]!;
  pageNo = 1;
  y = MARGIN - 16;
  await draw(`Page 1 of ${total}`, WIDTH - MARGIN, 8, 'regular', MUTED, 'right');
  for (const b of bodyPages) {
    page = b.page;
    pageNo = b.no;
    y = HEIGHT - MARGIN;
    await draw(await fit(s.account?.name ?? 'Statement', 10, 260, 'bold'), MARGIN, 10, 'bold');
    await draw(
      `${periodText(s)}${parts > 1 ? `, part ${part} of ${parts}` : ''}  ·  Page ${b.no} of ${total}`,
      WIDTH - MARGIN,
      8.5,
      'regular',
      MUTED,
      'right',
    );
    y -= 13;
    await draw(`Amounts in ${currency}`, MARGIN, 8, 'regular', MUTED);
  }

  if (attach && input.original) {
    await pdf.attach(input.original.bytes, s.original.fileName, {
      mimeType: input.original.mime,
      description: 'The original statement file this PDF was rendered from',
      creationDate: input.at,
      modificationDate: input.at,
      afRelationship: AFRelationship.Source,
    });
  }
  return {
    part,
    parts,
    title,
    bytes: await pdf.save(),
    pages: total,
    rows: rows?.length ?? 0,
    attached: attach,
  };
}
