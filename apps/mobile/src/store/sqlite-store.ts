/**
 * `SyncStore` over SQLite (PLT-05, BAK-10). On devices the driver is expo-sqlite with SQLCipher (see
 * expo-driver.ts); in tests it is node:sqlite. Rows are stored as JSON with a few indexed columns for lists.
 */
import type {
  ConflictNotice,
  LocalTransaction,
  OutboxItem,
  ReferenceRows,
  ReferenceTable,
  SyncStore,
  TransactionQuery,
} from '@montra/sync';
import {
  MIGRATIONS,
  UPSERT_TXN,
  listQuery,
  placeholders,
  txnParams,
  type SqlDriver,
  type TxnRow,
} from './sql';

const TABLES: readonly ReferenceTable[] = ['accounts', 'categories', 'members', 'entities'];

export class SqliteStore implements SyncStore {
  private depth = 0;

  private constructor(
    private readonly db: SqlDriver,
    private readonly onWipe?: () => Promise<void>,
  ) {}

  /** Opens (and migrates) a store. `onWipe` runs after the file is deleted, e.g. to delete the key. */
  static async open(db: SqlDriver, onWipe?: () => Promise<void>): Promise<SqliteStore> {
    const [row] = await db.all<{ user_version: number }>('pragma user_version');
    const version = row?.user_version ?? 0;
    for (let v = version; v < MIGRATIONS.length; v++) {
      await db.exec(MIGRATIONS[v]!);
      await db.exec(`pragma user_version = ${v + 1}`);
    }
    return new SqliteStore(db, onWipe);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn();
    this.depth++;
    await this.db.exec('begin');
    try {
      const out = await fn();
      await this.db.exec('commit');
      return out;
    } catch (e) {
      await this.db.exec('rollback');
      throw e;
    } finally {
      this.depth--;
    }
  }

  async getMeta(key: string): Promise<string | null> {
    const [row] = await this.db.all<{ value: string }>('select value from meta where key = ?', [key]);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) await this.db.run('delete from meta where key = ?', [key]);
    else await this.db.run('insert or replace into meta (key, value) values (?, ?)', [key, value]);
  }

  async putTransactions(rows: LocalTransaction[]): Promise<void> {
    if (rows.length === 0) return;
    await this.transaction(async () => {
      for (const r of rows) await this.db.run(UPSERT_TXN, txnParams(r));
    });
  }

  async removeTransactions(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await this.db.run(`delete from txn where id in (${placeholders(chunk.length)})`, chunk);
    }
  }

  async getTransaction(id: string): Promise<LocalTransaction | null> {
    const [row] = await this.db.all<TxnRow>('select data from txn where id = ?', [id]);
    return row ? (JSON.parse(row.data) as LocalTransaction) : null;
  }

  async listTransactions(q: TransactionQuery): Promise<LocalTransaction[]> {
    const { sql, params } = listQuery(q);
    return (await this.db.all<TxnRow>(sql, params)).map((r) => JSON.parse(r.data) as LocalTransaction);
  }

  async replaceReference(rows: ReferenceRows): Promise<void> {
    await this.transaction(async () => {
      await this.db.run('delete from reference');
      for (const tbl of TABLES)
        for (const [i, r] of (rows[tbl] as Array<{ id: string }>).entries())
          await this.db.run('insert into reference (tbl, id, ord, data) values (?, ?, ?, ?)', [
            tbl,
            r.id,
            i,
            JSON.stringify(r),
          ]);
    });
  }

  /** Upsert by id; existing rows keep their position, new rows are appended (MemoryStore semantics). */
  async mergeReference(rows: Partial<ReferenceRows>): Promise<void> {
    await this.transaction(async () => {
      for (const tbl of Object.keys(rows) as ReferenceTable[]) {
        for (const r of (rows[tbl] ?? []) as Array<{ id: string }>) {
          const [existing] = await this.db.all<{ ord: number }>(
            'select ord from reference where tbl = ? and id = ?',
            [tbl, r.id],
          );
          if (existing) {
            await this.db.run('update reference set data = ? where tbl = ? and id = ?', [
              JSON.stringify(r),
              tbl,
              r.id,
            ]);
          } else {
            const [max] = await this.db.all<{ m: number | null }>(
              'select max(ord) as m from reference where tbl = ?',
              [tbl],
            );
            await this.db.run('insert into reference (tbl, id, ord, data) values (?, ?, ?, ?)', [
              tbl,
              r.id,
              (max?.m ?? -1) + 1,
              JSON.stringify(r),
            ]);
          }
        }
      }
    });
  }

  async getReference<T extends ReferenceTable>(table: T): Promise<ReferenceRows[T]> {
    const rows = await this.db.all<{ data: string }>(
      'select data from reference where tbl = ? order by ord',
      [table],
    );
    return rows.map((r) => JSON.parse(r.data)) as ReferenceRows[T];
  }

  async enqueue(item: OutboxItem): Promise<void> {
    await this.db.run('insert into outbox (op_id, data) values (?, ?)', [item.op.opId, JSON.stringify(item)]);
  }

  async outbox(): Promise<OutboxItem[]> {
    return (await this.db.all<{ data: string }>('select data from outbox order by seq')).map(
      (r) => JSON.parse(r.data) as OutboxItem,
    );
  }

  async updateOutbox(opId: string, patch: Partial<OutboxItem>): Promise<void> {
    const [row] = await this.db.all<{ data: string }>('select data from outbox where op_id = ?', [opId]);
    if (!row) return;
    const next = { ...(JSON.parse(row.data) as OutboxItem), ...patch };
    next.op = { ...next.op, opId } as OutboxItem['op'];
    await this.db.run('update outbox set data = ? where op_id = ?', [JSON.stringify(next), opId]);
  }

  async removeOutbox(opIds: string[]): Promise<void> {
    if (opIds.length === 0) return;
    await this.db.run(`delete from outbox where op_id in (${placeholders(opIds.length)})`, opIds);
  }

  async addConflict(n: ConflictNotice): Promise<void> {
    await this.db.run('insert into conflict (op_id, data) values (?, ?)', [n.opId, JSON.stringify(n)]);
  }

  async conflicts(): Promise<ConflictNotice[]> {
    return (await this.db.all<{ data: string }>('select data from conflict order by seq')).map(
      (r) => JSON.parse(r.data) as ConflictNotice,
    );
  }

  async clearConflicts(ids?: string[]): Promise<void> {
    if (!ids) await this.db.run('delete from conflict');
    else if (ids.length)
      await this.db.run(`delete from conflict where op_id in (${placeholders(ids.length)})`, ids);
  }

  async wipe(): Promise<void> {
    await this.db.destroy();
    await this.onWipe?.();
  }
}
