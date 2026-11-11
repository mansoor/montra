/**
 * What's in a workspace, read from the database itself (ADR-0019 §7, §9), so a new table can't be forgotten: every `app.*` table is
 * exported or is named here with a reason, and a test fails otherwise. Foreign keys decide the order rows go back in.
 */
import { sql } from 'kysely';
import type { Trx } from '@montra/db';

/** Not in an archive at all, and why. */
export const NOT_EXPORTED: Readonly<Record<string, string>> = {
  app_user: 'People: whoever restores takes their place',
  workspace: 'In the manifest, because it is made new on restore',
  workspace_member: 'Who has access is not part of the books, and access must not come back with a file',
  entity_grant: 'As for workspace_member',
  workspace_invite: 'Holds tokens for other people',
  account_visibility: 'Per member, as for workspace_member',
  subscription:
    'Belongs to the payment provider and the original workspace, and a file must not bring a plan with it',
  feature_flag_override: 'How the service is run, not part of the books',
  support_grant: 'Access, as for workspace_member',
  support_request: 'A conversation with support, belonging to the person',
  workspace_key: 'A secret, and useless under another workspace',
  ai_credential: 'A secret: an API key is not copied into a file',
  ai_cache: 'A cache',
  ai_usage: 'A meter for the billing month',
  ai_task: 'Work in progress for a local AI client',
  change_log: 'A feed: restoring writes its own',
  sync_op: 'Device sync state',
  idempotency_key: 'Request replay protection',
  job: 'The queue',
  session_device: 'Sign-in sessions',
  push_device: 'Device tokens',
  email_change_request: 'Holds confirmation codes',
  mfa_reset_request: 'Holds confirmation codes',
  category_activity_monthly: 'A read model, rebuilt by triggers as postings go in',
  account_balance_daily: 'A read model, rebuilt by triggers as postings go in',
  export_job: 'About archives, not the books',
  backup_schedule: 'About archives, not the books',
  restore_job: 'About archives, not the books',
  storage_destination: 'A secret, and a connection the owner makes again (ADR-0031)',
  storage_mirror_item: 'What was copied to a connection a restore can’t bring back (ADR-0031)',
  notification_pref: 'Follows the person',
  security_event: 'Follows the person',
};

/** Yours to read in the archive, but they describe what happened in the original, so they don't come back on restore. */
export const EXPORT_ONLY: ReadonlySet<string> = new Set(['audit_log', 'ai_event', 'notification']);

/** Encrypted columns: decrypted into the archive, because a backup under a key the user doesn't hold is no use to them. */
export const ENCRYPTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  transaction: { memo_enc: 'transaction.memo' },
  bank_account: { account_number_enc: 'bank_account.account_number' },
};

export const plainName = (column: string) => column.replace(/_enc$/, '');

export interface ForeignKey {
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface TableInfo {
  name: string;
  columns: Map<string, { nullable: boolean; writable: boolean }>;
  fks: ForeignKey[];
  hasId: boolean;
}

export async function readCatalog(trx: Trx): Promise<Map<string, TableInfo>> {
  const { rows: cols } = await sql<{
    table_name: string;
    column_name: string;
    is_nullable: string;
    generated: string;
    identity: string;
  }>`
    select table_name, column_name, is_nullable, is_generated as generated, is_identity as identity
      from information_schema.columns
     where table_schema = 'app'
     order by table_name, ordinal_position`.execute(trx);
  const { rows: base } = await sql<{ table_name: string }>`
    select table_name from information_schema.tables where table_schema = 'app' and table_type = 'BASE TABLE'`.execute(
    trx,
  );
  const names = new Set(base.map((b) => b.table_name));
  const { rows: keys } = await sql<{
    table_name: string;
    ref_table: string;
    columns: string[];
    ref_columns: string[];
  }>`
    select c.conrelid::regclass::text as table_name, c.confrelid::regclass::text as ref_table,
           array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.ord) as columns,
           array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.ord) as ref_columns
      from pg_constraint c
     where c.contype = 'f' and c.connamespace = 'app'::regnamespace`.execute(trx);
  const out = new Map<string, TableInfo>();
  for (const name of names) out.set(name, { name, columns: new Map(), fks: [], hasId: false });
  for (const c of cols) {
    const t = out.get(c.table_name);
    if (!t) continue;
    t.columns.set(c.column_name, {
      nullable: c.is_nullable === 'YES',
      writable: c.generated !== 'ALWAYS' && c.identity !== 'YES',
    });
    if (c.column_name === 'id') t.hasId = true;
  }
  const strip = (n: string) => n.replace(/^app\./, '').replace(/"/g, '');
  for (const k of keys) {
    const t = out.get(strip(k.table_name));
    if (t) t.fks.push({ columns: k.columns, refTable: strip(k.ref_table), refColumns: k.ref_columns });
  }
  return out;
}

/** The tables holding a workspace's rows that an archive takes. */
export function exportedTables(catalog: Map<string, TableInfo>): string[] {
  return [...catalog.values()]
    .filter((t) => t.columns.has('workspace_id') && !(t.name in NOT_EXPORTED))
    .map((t) => t.name);
}

/** A foreign key's columns other than `workspace_id`, which every tenant key shares. */
const own = (fk: ForeignKey) => fk.columns.filter((c) => c !== 'workspace_id');

export interface InsertPlan {
  order: string[];
  /** Columns left null at first and set afterwards, because a parent comes later: self-references and cycles. */
  deferred: Map<string, string[]>;
}

/** Parents before children. A cycle is broken at a nullable column; one with no nullable way out is a schema problem to hear about. */
export function insertOrder(catalog: Map<string, TableInfo>, tables: readonly string[]): InsertPlan {
  const included = new Set(tables);
  const deferred = new Map<string, string[]>();
  const defer = (table: string, columns: string[]) =>
    deferred.set(table, [...new Set([...(deferred.get(table) ?? []), ...columns])]);
  const edges = new Map<string, Map<string, ForeignKey[]>>();
  for (const table of tables) {
    const parents = new Map<string, ForeignKey[]>();
    for (const fk of catalog.get(table)!.fks) {
      if (!included.has(fk.refTable)) continue;
      const columns = own(fk);
      if (fk.refTable === table) {
        defer(table, columns);
        continue;
      }
      parents.set(fk.refTable, [...(parents.get(fk.refTable) ?? []), fk]);
    }
    edges.set(table, parents);
  }
  const order: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size) {
    const ready = [...remaining]
      .filter((t) => [...edges.get(t)!.keys()].every((p) => !remaining.has(p)))
      .sort();
    if (ready.length) {
      for (const t of ready) {
        order.push(t);
        remaining.delete(t);
      }
      continue;
    }
    // Stuck in a cycle: wait on a nullable column somewhere in it.
    let broken = false;
    for (const t of [...remaining].sort()) {
      const info = catalog.get(t)!;
      for (const [parent, fks] of edges.get(t)!) {
        if (!remaining.has(parent)) continue;
        if (fks.every((fk) => own(fk).every((c) => info.columns.get(c)?.nullable))) {
          for (const fk of fks) defer(t, own(fk));
          edges.get(t)!.delete(parent);
          broken = true;
          break;
        }
      }
      if (broken) break;
    }
    if (!broken) throw new Error(`No insert order for: ${[...remaining].join(', ')}`);
  }
  return { order, deferred };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replaces every id anywhere in a value, JSON such as a transaction's spec included, keys too. */
export function remapIds(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return UUID.test(value) ? (map.get(value.toLowerCase()) ?? value) : value;
  if (Array.isArray(value)) return value.map((v) => remapIds(v, map));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[UUID.test(k) ? (map.get(k.toLowerCase()) ?? k) : k] = remapIds(v, map);
    }
    return out;
  }
  return value;
}

/**
 * Keeps a row only if what it needs is there: in an archive of one entity, or what RLS let through, a parent may be missing. A required
 * parent gone drops the row; an optional one is cleared. Returns the row, or null to drop it.
 */
export function withParents(
  info: TableInfo,
  row: Record<string, unknown>,
  kept: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, unknown> | null {
  let out = row;
  for (const fk of info.fks) {
    const columns = own(fk);
    const refColumns = fk.refColumns.filter((c) => c !== 'workspace_id');
    if (columns.length !== 1 || refColumns[0] !== 'id') continue;
    const parents = kept.get(fk.refTable);
    if (!parents) continue;
    const value = out[columns[0]!];
    if (value === null || value === undefined || parents.has(String(value))) continue;
    if (!info.columns.get(columns[0]!)?.nullable) return null;
    out = { ...out, [columns[0]!]: null };
  }
  return out;
}
