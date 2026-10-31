/**
 * The device store's SQL (PLT-05, BAK-10). Pure: no Expo imports, so the same statements run under node:sqlite in
 * tests and under expo-sqlite (SQLCipher) on devices. Semantics match `MemoryStore` in @montra/sync exactly:
 * lists sort by date desc then id desc, search is a case-insensitive substring match on payee or description.
 */
import type { LocalTransaction, TransactionQuery } from '@montra/sync';

export type SqlParam = string | number | null;

/** The minimal async SQL surface the store needs. */
export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;
  all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
  /** Close the connection and delete the database file (sign-out wipe). */
  destroy(): Promise<void>;
}

/** Schema versions, applied in order and recorded in `PRAGMA user_version`. */
export const MIGRATIONS: readonly string[] = [
  `
  create table if not exists meta (key text primary key, value text not null);
  create table if not exists txn (
    id text primary key,
    date text not null,
    account_id text,
    review_state text not null,
    search_payee text not null,
    search_desc text not null,
    data text not null
  );
  create index if not exists txn_order on txn (date desc, id desc);
  create index if not exists txn_account on txn (account_id, date desc, id desc);
  create index if not exists txn_review on txn (review_state, date desc, id desc);
  create table if not exists reference (
    tbl text not null,
    id text not null,
    ord integer not null,
    data text not null,
    primary key (tbl, id)
  );
  create table if not exists outbox (
    seq integer primary key autoincrement,
    op_id text not null unique,
    data text not null
  );
  create table if not exists conflict (
    seq integer primary key autoincrement,
    op_id text not null,
    data text not null
  );
  `,
];

export interface TxnRow {
  data: string;
}

/** Row values for `insert or replace into txn`. Search columns are lowered in JS for parity with MemoryStore. */
export function txnParams(t: LocalTransaction): SqlParam[] {
  return [
    t.id,
    t.date,
    t.accountId,
    t.reviewState,
    (t.payee ?? '').toLowerCase(),
    t.description.toLowerCase(),
    JSON.stringify(t),
  ];
}

export const UPSERT_TXN =
  'insert or replace into txn (id, date, account_id, review_state, search_payee, search_desc, data) values (?, ?, ?, ?, ?, ?, ?)';

/** SELECT for `listTransactions` with the same filters and order as MemoryStore. */
export function listQuery(q: TransactionQuery): { sql: string; params: SqlParam[] } {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (q.accountId) {
    where.push('account_id = ?');
    params.push(q.accountId);
  }
  if (q.reviewState) {
    where.push('review_state = ?');
    params.push(q.reviewState);
  }
  const search = q.search?.trim().toLowerCase();
  if (search) {
    where.push('(instr(search_payee, ?) > 0 or instr(search_desc, ?) > 0)');
    params.push(search, search);
  }
  if (q.before) {
    where.push('(date < ? or (date = ? and id < ?))');
    params.push(q.before.date, q.before.date, q.before.id);
  }
  let sql = 'select data from txn';
  if (where.length) sql += ` where ${where.join(' and ')}`;
  sql += ' order by date desc, id desc';
  if (q.limit !== undefined) {
    sql += ' limit ?';
    params.push(q.limit);
  }
  return { sql, params };
}

/** `?, ?, ?` for an IN list. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** SQLCipher raw-key pragma for a 64-hex-character key (no KDF: the key is already random, 256-bit). */
export function keyPragma(hexKey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hexKey)) throw new Error('Database key must be 64 hex characters');
  return `PRAGMA key = "x'${hexKey}'";`;
}
