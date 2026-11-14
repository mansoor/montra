/**
 * The fake model for bills (tests, e2e): plain line parsing of the bill's text, no guessing. The first line is the
 * biller; `ACCOUNT … 1234`, `AMOUNT DUE 84.12`, `DUE DATE 2026-11-20` (or MM/DD/YYYY), `BILL DATE …`,
 * `SERVICE 2026-10-01 TO 2026-10-31`, `CUSTOMER MEMBER_2`, and `KIND water` give the rest.
 */
import type { BillExtraction } from './types.js';

const KINDS = new Set(['electricity_gas', 'water', 'trash', 'phone', 'internet_tv', 'insurance', 'other']);

function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[0];
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return us ? `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}` : null;
}

export function parseBillText(text: string): BillExtraction {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const find = (re: RegExp) => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m;
    }
    return null;
  };
  const amount = find(/^AMOUNT DUE\b[:\s]*\$?(-?[\d,]+\.\d{2})/i)?.[1]?.replace(/,/g, '') ?? null;
  const period = find(/^SERVICE\b[:\s]*(\S+)\s+(?:TO|-)\s+(\S+)/i);
  const kind = find(/^KIND\b[:\s]*(\w+)/i)?.[1]?.toLowerCase() ?? 'other';
  const out: BillExtraction = {
    biller: lines[0] ?? null,
    kind: (KINDS.has(kind) ? kind : 'other') as BillExtraction['kind'],
    accountLast4: find(/^ACCOUNT\b.*?(\d{4})\s*$/i)?.[1] ?? null,
    customer: find(/^CUSTOMER\b[:\s]*(MEMBER_\d+)\b/i)?.[1] ?? null,
    amountDue: amount,
    dueDate: isoDate(find(/^DUE DATE\b[:\s]*(.+)$/i)?.[1]),
    billDate: isoDate(find(/^BILL DATE\b[:\s]*(.+)$/i)?.[1]),
    periodStart: isoDate(period?.[1]),
    periodEnd: isoDate(period?.[2]),
    currency: null,
    confidence: 0.6,
  };
  if (out.amountDue && out.dueDate) out.confidence = 0.9;
  return out;
}
