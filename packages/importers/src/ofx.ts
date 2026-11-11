/**
 * OFX reader (IMP-13, ADR-0030): OFX 1.x (SGML: `OFXHEADER:100`, leaf tags left unclosed), OFX 2.x (XML) and QFX (OFX
 * plus Quicken's `INTU.*` tags, which are ignored). Each bank or card statement becomes one account:
 * - transactions are its `<STMTTRN>`s, with `FITID` kept for dedupe;
 * - the account is named from its type and the last 4 digits of `ACCTID`;
 * - `<LEDGERBAL><BALAMT>` is its closing balance.
 * Investment statements are skipped with a counted warning.
 */
import type { AccountKind } from '@montra/domain';
import { FIXED, FIXED_COLUMNS, fixedSheet } from './fixed-layout.js';
import type { Sheet, SheetAccount } from './grid.js';

/** True when the text looks like an OFX or QFX file. */
export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 2048);
  return /OFXHEADER\s*[:=]/i.test(head) || /<OFX>/i.test(head);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Every `<TAG>…</TAG>` block in the text (aggregates are closed in SGML OFX too). */
function blocks(text: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...text.matchAll(re)].map((m) => m[1]!);
}

/** A leaf element's value: SGML leaves run to the next tag, XML leaves to their closing tag. */
function leaf(text: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<]*)`, 'i').exec(text);
  return m ? decodeEntities(m[1]!).trim() : '';
}

/** OFX date-time (YYYYMMDD[HHMMSS[.XXX][[±H:TZ]]]) → YYYY-MM-DD, as the bank's local date. */
export function ofxDate(raw: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw.trim();
}

const BANK_TYPES: Record<string, { label: string; kind: AccountKind }> = {
  CHECKING: { label: 'Checking', kind: 'checking' },
  SAVINGS: { label: 'Savings', kind: 'savings' },
  MONEYMRKT: { label: 'Money market', kind: 'savings' },
  CREDITLINE: { label: 'Line of credit', kind: 'line_of_credit' },
  CD: { label: 'CD', kind: 'savings' },
};

/** Transaction types that take money out; used only when a bank writes every amount unsigned. */
const DEBIT_TYPES = new Set([
  'DEBIT',
  'PAYMENT',
  'CHECK',
  'ATM',
  'POS',
  'FEE',
  'SRVCHG',
  'DIRECTDEBIT',
  'CASH',
]);

export function readOfx(text: string, name = 'OFX'): Sheet {
  if (!looksLikeOfx(text) || !/<OFX>/i.test(text)) throw new Error('Not an OFX file: no <OFX> element');
  const org = leaf(blocks(text, 'FI')[0] ?? '', 'ORG');
  const rows: string[][] = [];
  const accounts: SheetAccount[] = [];
  const statements = [
    ...blocks(text, 'STMTRS').map((s) => ({ s, card: false })),
    ...blocks(text, 'CCSTMTRS').map((s) => ({ s, card: true })),
  ];
  for (const { s, card } of statements) {
    const from = blocks(s, card ? 'CCACCTFROM' : 'BANKACCTFROM')[0] ?? '';
    const id = leaf(from, 'ACCTID').replace(/\s+/g, '');
    const type = card ? null : (BANK_TYPES[leaf(from, 'ACCTTYPE').toUpperCase()] ?? null);
    const label = card ? 'Credit card' : (type?.label ?? 'Account');
    const account = [org, label, id ? `••${id.slice(-4)}` : ''].filter(Boolean).join(' ');
    const closing = leaf(blocks(s, 'LEDGERBAL')[0] ?? '', 'BALAMT') || null;
    accounts.push({ name: account, kind: card ? 'credit_card' : (type?.kind ?? null), closing });

    const list = blocks(s, 'BANKTRANLIST')[0] ?? s;
    const txns = blocks(list, 'STMTTRN').map((t) => ({
      type: leaf(t, 'TRNTYPE').toUpperCase(),
      date: ofxDate(leaf(t, 'DTPOSTED') || leaf(t, 'DTUSER')),
      amount: leaf(t, 'TRNAMT'),
      fitid: leaf(t, 'FITID'),
      name: leaf(t, 'NAME') || leaf(blocks(t, 'PAYEE')[0] ?? '', 'NAME'),
      memo: leaf(t, 'MEMO'),
      number: leaf(t, 'CHECKNUM') || leaf(t, 'REFNUM'),
    }));
    // Some banks write every amount unsigned and say the direction in TRNTYPE.
    const unsigned = txns.length > 0 && !txns.some((t) => t.amount.trim().startsWith('-'));
    const typed = txns.some((t) => DEBIT_TYPES.has(t.type));
    for (const t of txns) {
      const row: string[] = new Array<string>(FIXED_COLUMNS.length).fill('');
      row[FIXED.account] = account;
      row[FIXED.date] = t.date;
      row[FIXED.payee] = t.name;
      row[FIXED.memo] = t.memo && t.memo !== t.name ? t.memo : '';
      row[FIXED.transfer] =
        t.type === 'XFER' && !/transfer|xfer/i.test(`${t.name} ${t.memo}`) ? 'Transfer' : '';
      row[FIXED.amount] =
        unsigned && typed && DEBIT_TYPES.has(t.type) ? `-${t.amount.trim().replace(/^\+/, '')}` : t.amount;
      row[FIXED.number] = t.number;
      row[FIXED.id] = t.fitid;
      rows.push(row);
    }
  }
  const investment = blocks(text, 'INVSTMTRS').reduce((n, s) => n + (s.match(/<INVTRAN>/gi)?.length ?? 0), 0);
  return fixedSheet(name, rows, {
    accounts,
    warnings: investment ? [`investment_transactions_skipped:${investment}`] : [],
  });
}
