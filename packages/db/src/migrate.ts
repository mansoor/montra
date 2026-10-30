/**
 * Minimal SQL-first migration runner (ADR-0003). Applies migrations/NNNN_name.sql in order, each in its own
 * transaction, and records a checksum so an edited, already-applied migration is detected.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        version: Number(file.slice(0, 4)),
        name: file.slice(5, -4),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  connectionString: string,
  log: (msg: string) => void = () => {},
): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists public.schema_migrations (
      version integer primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`);
    // Serialize concurrent deploys.
    await client.query('select pg_advisory_lock(727465)');
    const { rows } = await client.query<{ version: number; checksum: string }>(
      'select version, checksum from public.schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    const result: MigrateResult = { applied: [], skipped: [] };
    for (const m of loadMigrations()) {
      const label = `${String(m.version).padStart(4, '0')}_${m.name}`;
      const existing = done.get(m.version);
      if (existing) {
        if (existing !== m.checksum) throw new Error(`Migration ${label} was modified after being applied`);
        result.skipped.push(label);
        continue;
      }
      log(`applying ${label}`);
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query(
          'insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${label} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(label);
    }
    return result;
  } finally {
    await client.query('select pg_advisory_unlock(727465)').catch(() => {});
    await client.end();
  }
}

/** Drops everything the migrations created. Test and local use only. */
export async function resetDatabase(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('drop schema if exists app cascade; drop table if exists public.schema_migrations;');
  } finally {
    await client.end();
  }
}
