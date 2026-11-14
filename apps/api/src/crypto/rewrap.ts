import type pg from 'pg';
import type { KmsPort } from './crypto.service.js';

/**
 * `crypto:rewrap` (ADR-0050 §3): moves every wrapped key from the previous adapter to the current one. The data keys
 * themselves don't change, so nothing they encrypt is touched.
 *
 * It resumes by itself: a key the current adapter already unwraps is counted as done and skipped, so the stored keys
 * are the record of progress, and the command can be stopped and run again at any point. Each key is checked to
 * unwrap with the new adapter before it is written, and written only if it hasn't changed since it was read.
 *
 * It needs the owner connection (DATABASE_ADMIN_URL): the keys of every workspace, past row level security, and
 * `montra_app` can't update `app.workspace_key`.
 */

interface Place {
  /** Shown in the report. */
  name: string;
  table: string;
  keys: string[];
  /** The wrapped key as stored: bytea, or base64 text inside a job's payload. */
  value: string;
  encoding: 'bytea' | 'base64';
  where: string;
  /** The update, given the new value as `$1`. */
  set: string;
}

/** Every place a key wrapped by the KMS port is kept. */
const PLACES: Place[] = [
  {
    name: 'workspace keys',
    table: 'app.workspace_key',
    keys: ['workspace_id', 'key_version'],
    value: 'wrapped_key',
    encoding: 'bytea',
    where: 'true',
    set: 'wrapped_key = $1',
  },
  {
    name: 'backup schedules',
    table: 'app.backup_schedule',
    keys: ['workspace_id', 'user_id'],
    value: 'wrapped_key',
    encoding: 'bytea',
    where: 'wrapped_key is not null',
    set: 'wrapped_key = $1',
  },
  {
    name: 'restores',
    table: 'app.restore_job',
    keys: ['id'],
    value: 'wrapped_key',
    encoding: 'bytea',
    where: 'true',
    set: 'wrapped_key = $1',
  },
  {
    name: 'backup jobs',
    table: 'app.job',
    keys: ['id'],
    value: "payload->>'wrappedKey'",
    encoding: 'base64',
    where: "payload ? 'wrappedKey'",
    set: "payload = jsonb_set(payload, '{wrappedKey}', to_jsonb($1::text))",
  },
];

export interface RewrapCount {
  name: string;
  /** Already wrapped by the current adapter. */
  done: number;
  rewrapped: number;
  /** Neither adapter could unwrap it, or it changed while being moved. Run again, or look at the log. */
  failed: number;
}

export interface RewrapOptions {
  batchSize?: number;
  /** Count what would move, and write nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

type Queryable = Pick<pg.Pool, 'query'>;

function decode(place: Place, value: Buffer | string): Buffer {
  return place.encoding === 'bytea' ? (value as Buffer) : Buffer.from(value as string, 'base64');
}

function encode(place: Place, value: Buffer): Buffer | string {
  return place.encoding === 'bytea' ? value : value.toString('base64');
}

async function unwraps(kms: KmsPort, wrapped: Buffer): Promise<boolean> {
  try {
    await kms.unwrap(wrapped);
    return true;
  } catch {
    return false;
  }
}

async function rewrapPlace(
  db: Queryable,
  place: Place,
  current: KmsPort,
  previous: KmsPort,
  opts: Required<Omit<RewrapOptions, 'log'>> & Pick<RewrapOptions, 'log'>,
): Promise<RewrapCount> {
  const count: RewrapCount = { name: place.name, done: 0, rewrapped: 0, failed: 0 };
  const keyList = place.keys.join(', ');
  let after: unknown[] | undefined;
  for (;;) {
    const params: unknown[] = after ? [...after] : [];
    const afterClause = after
      ? `and (${keyList}) > (${place.keys.map((_, i) => `$${i + 1}`).join(', ')})`
      : '';
    const { rows } = await db.query<Record<string, unknown> & { wrapped: Buffer | string }>(
      `select ${keyList}, ${place.value} as wrapped from ${place.table}
        where ${place.where} ${afterClause}
        order by ${keyList} limit ${opts.batchSize}`,
      params,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const keyValues = place.keys.map((k) => row[k]);
      const label = `${place.table} (${keyValues.join(', ')})`;
      const old = decode(place, row.wrapped);
      if (await unwraps(current, old)) {
        count.done++;
        continue;
      }
      let plain: Buffer;
      try {
        plain = await previous.unwrap(old);
      } catch (e) {
        count.failed++;
        opts.log?.(`${label}: neither adapter unwraps it (${(e as Error).message})`);
        continue;
      }
      const fresh = await current.wrap(plain);
      if (!(await current.unwrap(fresh)).equals(plain)) {
        throw new Error(`${label}: the new adapter didn't give the key back. Nothing was written for it.`);
      }
      if (opts.dryRun) {
        count.rewrapped++;
        continue;
      }
      const n = place.keys.length;
      const { rowCount } = await db.query(
        `update ${place.table} set ${place.set}
          where (${keyList}) = (${place.keys.map((_, i) => `$${i + 2}`).join(', ')})
            and ${place.value} = $${n + 2}`,
        [encode(place, fresh), ...keyValues, encode(place, old)],
      );
      if (rowCount === 1) count.rewrapped++;
      else {
        count.failed++;
        opts.log?.(`${label}: changed while being moved; run again`);
      }
    }
    after = place.keys.map((k) => rows[rows.length - 1]![k]);
    opts.log?.(
      `${place.name}: ${count.done + count.rewrapped + count.failed} checked, ${count.rewrapped} ${
        opts.dryRun ? 'to move' : 'moved'
      }, ${count.failed} failed`,
    );
  }
  return count;
}

export async function rewrapKeys(
  db: Queryable,
  current: KmsPort,
  previous: KmsPort,
  options: RewrapOptions = {},
): Promise<RewrapCount[]> {
  const opts = { batchSize: options.batchSize ?? 200, dryRun: options.dryRun ?? false, log: options.log };
  const counts: RewrapCount[] = [];
  for (const place of PLACES) counts.push(await rewrapPlace(db, place, current, previous, opts));
  return counts;
}
