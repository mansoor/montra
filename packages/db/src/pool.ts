import pg from 'pg';

const { Pool, types } = pg;

// Money is bigint minor units: never let int8 become a JS number (NFR-09).
types.setTypeParser(types.builtins.INT8, (v) => BigInt(v));
// Business dates are plain calendar dates (TZ-02): keep 'YYYY-MM-DD' instead of a local-time Date.
types.setTypeParser(types.builtins.DATE, (v) => v);
// Exchange rates and quantities stay exact decimal strings.
types.setTypeParser(types.builtins.NUMERIC, (v) => v);

export type PgPool = pg.Pool;

export function createPool(connectionString: string, options: pg.PoolConfig = {}): pg.Pool {
  return new Pool({ connectionString, max: 10, ...options });
}
