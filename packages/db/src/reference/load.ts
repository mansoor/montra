import pg from 'pg';
import { MERCHANTS } from './merchants.js';

/**
 * Upserts reference data (OPS-05). Idempotent; rows whose content changed get their version bumped. Runs
 * after migrations and can run on its own to ship reference updates without an app release.
 */
export async function loadReferenceData(connectionString: string): Promise<{ merchants: number }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    for (const r of MERCHANTS) {
      await client.query(
        `insert into ref.merchant (id, display_name, match_key, mcc, category_hint)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set display_name = excluded.display_name, match_key = excluded.match_key,
           mcc = excluded.mcc, category_hint = excluded.category_hint,
           version = ref.merchant.version + 1, updated_at = now()
         where (ref.merchant.display_name, ref.merchant.match_key, ref.merchant.mcc, ref.merchant.category_hint)
               is distinct from (excluded.display_name, excluded.match_key, excluded.mcc, excluded.category_hint)`,
        [r.id, r.name, r.key, r.mcc ?? null, r.hint],
      );
    }
    await client.query('commit');
    return { merchants: MERCHANTS.length };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}
