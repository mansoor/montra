import pg from 'pg';
import { CURRENCY_CODES, minorUnits } from '@montra/domain';
import { MERCHANTS } from './merchants.js';

/**
 * Upserts reference data (OPS-05). Idempotent; rows whose content changed get their version bumped. Runs
 * after migrations and can run on its own to ship reference updates without an app release.
 */
export async function loadReferenceData(
  connectionString: string,
): Promise<{ merchants: number; currencies: number }> {
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
    // ISO 4217 codes and exponents come from @montra/domain (CUR-02); names and symbols from ICU.
    const names = new Intl.DisplayNames('en', { type: 'currency' });
    for (const code of CURRENCY_CODES) {
      const name = names.of(code) ?? code;
      const symbol = currencySymbol(code);
      await client.query(
        `insert into ref.currency (code, minor_units, name, symbol) values ($1, $2, $3, $4)
         on conflict (code) do update set minor_units = excluded.minor_units, name = excluded.name,
           symbol = excluded.symbol, version = ref.currency.version + 1, updated_at = now()
         where (ref.currency.minor_units, ref.currency.name, ref.currency.symbol)
               is distinct from (excluded.minor_units, excluded.name, excluded.symbol)`,
        [code, minorUnits(code), name, symbol],
      );
    }
    await client.query('commit');
    return { merchants: MERCHANTS.length, currencies: CURRENCY_CODES.length };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

function currencySymbol(code: string): string | null {
  const part = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'narrowSymbol',
  })
    .formatToParts(0)
    .find((p) => p.type === 'currency');
  return part && part.value !== code ? part.value : null;
}
