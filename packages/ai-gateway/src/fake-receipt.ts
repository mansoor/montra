/**
 * Deterministic receipts for the fake provider (tests, e2e, the evaluation self-check). A "fake receipt
 * image" is a real 1×1 PNG whose `tEXt` chunk carries the receipt text, so uploads pass image sniffing and
 * the fake adapter can read it back. `parseReceiptText` is the fake model: plain line parsing, no guessing.
 */
import { crc32, deflateSync } from 'node:zlib';
import { isCurrencyCode } from '@montra/domain';
import type { ReceiptExtraction } from './types.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEYWORD = 'montra:receipt';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** A valid 1×1 grey PNG carrying `text` (UTF-8, base64 in a tEXt chunk). */
export function encodeFakeReceiptImage(text: string): Uint8Array {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  const text64 = Buffer.from(`${KEYWORD}\0${Buffer.from(text, 'utf8').toString('base64')}`, 'latin1');
  return new Uint8Array(
    Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('tEXt', text64),
      chunk('IDAT', deflateSync(Buffer.from([0, 0]))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** The text of a fake receipt image (base64 PNG), or null for any other image. */
export function decodeFakeReceiptImage(base64: string): string | null {
  const png = Buffer.from(base64, 'base64');
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let at = 8;
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'tEXt') {
      const [key, value] = data.toString('latin1').split('\0');
      if (key === KEYWORD && value) return Buffer.from(value, 'base64').toString('utf8');
    }
    at += 12 + len;
  }
  return null;
}

/** Retailer abbreviations the fake model "knows" (RCP-02); real models use product knowledge. */
const ABBREVIATIONS: Record<string, string> = {
  GV: 'Great Value',
  MLK: 'milk',
  GAL: '1 gal',
  ONN: 'onn.',
  CHRGR: 'charger',
  TS: '',
  MENS: "Men's",
  TEE: 'T-shirt',
  BNLS: 'boneless',
  CHKN: 'chicken',
  BRST: 'breast',
  ORG: 'organic',
  BNNA: 'bananas',
  PPR: 'paper',
  TWL: 'towels',
};

const SYMBOLS: Record<string, string> = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
const AMOUNT = /^(.*?)\s+(-?)([€£¥₹$]?)(-?\d{1,7}(?:[.,]\d{2})?)\s*([TNXF])?$/i;

const decimal = (s: string) => s.replace(',', '.');

function expand(raw: string): string | null {
  const words = raw.split(/\s+/);
  if (!words.some((w) => w.toUpperCase() in ABBREVIATIONS)) return null;
  return (
    words
      // Codes and acronyms (USB-C, UP&UP, 2%) stay as printed; plain words become sentence case.
      .map(
        (w) =>
          ABBREVIATIONS[w.toUpperCase()] ?? (/[\d&-]/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()),
      )
      .filter(Boolean)
      .join(' ')
  );
}

/**
 * Parses receipt text: the first line without an amount is the merchant; `YYYY-MM-DD` or `MM/DD/YYYY` and
 * `HH:MM` anywhere; `CURRENCY EUR` or a currency symbol; `SUBTOTAL`, `TAX`/`VAT`, `TOTAL`, `TIP`, `FEE`,
 * `DISCOUNT` lines (`TVA`/`MWST`/`IVA`/`VAT INCL` mean the prices include the tax); `COUPON` lines discount the item above; other lines ending in an amount are items, with
 * an optional T/N tax flag and `2 @ 1.50` quantities; `CARD **** 1234` gives the card.
 */
export function parseReceiptText(text: string): ReceiptExtraction {
  const out: ReceiptExtraction = {
    merchant: null,
    date: null,
    localTime: null,
    currency: null,
    lines: [],
    subtotal: null,
    tax: null,
    taxIncluded: null,
    discount: null,
    fees: null,
    tip: null,
    total: null,
    cardLast4: null,
    confidence: 0.6,
  };
  let fees = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(line);
    const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(line);
    if (!out.date && (iso || us)) {
      out.date = iso ? iso[0] : `${us![3]}-${us![1]!.padStart(2, '0')}-${us![2]!.padStart(2, '0')}`;
      const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(line);
      if (time) out.localTime = `${time[1]!.padStart(2, '0')}:${time[2]}`;
      continue;
    }
    const code = /^CURRENCY\s+([A-Z]{3})$/i.exec(line);
    if (code && isCurrencyCode(code[1]!.toUpperCase())) {
      out.currency = code[1]!.toUpperCase();
      continue;
    }
    const card = /\bCARD\b.*?(?:\*{2,}|X{2,})\s*(\d{4})\b/i.exec(line);
    if (card) {
      out.cardLast4 = card[1]!;
      continue;
    }
    const m = AMOUNT.exec(line);
    if (!m) {
      if (!out.merchant && out.lines.length === 0) out.merchant = line.replace(/\s*#\s*\d+.*$/, '');
      continue;
    }
    const [, label, minus, symbol, digits, flag] = m;
    if (symbol && SYMBOLS[symbol] && !out.currency) out.currency = SYMBOLS[symbol]!;
    const amount = (minus ? '-' : '') + decimal(digits!);
    const key = label!.toUpperCase();
    if (/^(SUB\s?TOTAL|SOUS-TOTAL|ZWISCHENSUMME)\b/.test(key)) out.subtotal = amount;
    else if (/^(TVA|MWST|IVA|VAT INCL)\b/.test(key)) {
      out.tax = amount;
      out.taxIncluded = true;
    } else if (/^(TAX|VAT|SALES TAX)\b/.test(key)) {
      out.tax = amount;
      out.taxIncluded = false;
    } else if (/^TOTAL\b/.test(key)) out.total = amount;
    else if (/^(TIP|GRATUITY)\b/.test(key)) out.tip = amount;
    else if (/\b(FEE|BAG|DELIVERY|SERVICE)\b/.test(key)) fees += Number(amount) * 100;
    else if (/^DISCOUNT\b/.test(key)) out.discount = amount.replace('-', '');
    else if (/^COUPON\b/.test(key) && out.lines.length > 0) {
      out.lines[out.lines.length - 1]!.discount = amount.replace('-', '');
    } else {
      const qty = /(\d+(?:\.\d+)?)\s*@\s*(\d+[.,]\d{2})/.exec(label!);
      const rawText = label!.replace(/\s*\d+(?:\.\d+)?\s*@\s*\d+[.,]\d{2}\s*/, ' ').trim();
      out.lines.push({
        rawText,
        expandedName: expand(rawText),
        qty: qty ? qty[1]! : null,
        unitPrice: qty ? decimal(qty[2]!) : null,
        lineTotal: amount,
        discount: null,
        taxable: flag ? /^T$/i.test(flag) : null,
      });
    }
  }
  if (fees) out.fees = (fees / 100).toFixed(2);
  if (out.total !== null && out.lines.length > 0) out.confidence = 0.9;
  return out;
}
