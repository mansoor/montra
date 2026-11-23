/**
 * The filters the web lists share (Transactions, Review, Receipts): merchant words, an amount range without the sign,
 * and money in or out. Each returns SQL conditions to AND into the caller's query.
 */
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '@montra/db';
import { asCurrencyCode, CURRENCY_CODES, minorUnits } from '@montra/domain';
import type { ListFilterQuery, MoneyDirection } from '@montra/schemas';
import { tsQueryOf } from '../transactions/search-filter.js';

export interface TransactionListFilters extends ListFilterQuery {
  direction?: MoneyDirection;
}

/** The workspace currency's minor units, which the amount bounds are in. */
export async function baseCurrency(trx: Trx, workspaceId: string): Promise<{ code: string; exp: number }> {
  const ws = await trx
    .selectFrom('app.workspace')
    .select('base_currency')
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  return { code: ws.base_currency, exp: minorUnits(asCurrencyCode(ws.base_currency)) };
}

/**
 * The currencies whose minor units aren't 2 (JPY 0, BHD 3, …), as JSON for SQL: a lookup per row in `ref.currency` costs
 * a scan of it per row.
 */
const EXPONENTS = JSON.stringify(
  Object.fromEntries(CURRENCY_CODES.filter((c) => minorUnits(c) !== 2).map((c) => [c, minorUnits(c)])),
);

/**
 * An amount without its sign, in the workspace currency's minor units. An amount in another currency is compared by its
 * face value, as the search's `>20` is: 50.00 EUR counts as 50.00 in a USD workspace.
 */
function unsigned(
  amount: RawBuilder<unknown>,
  currency: RawBuilder<unknown>,
  base: { code: string; exp: number },
) {
  return sql`(case when ${currency} = ${base.code} then abs(${amount}::numeric)
    else abs(${amount}::numeric) * power(10::numeric, ${base.exp}::int
      - coalesce((${EXPONENTS}::jsonb ->> ${currency}::text)::int, 2)) end)`;
}

export function amountRange(
  f: Pick<ListFilterQuery, 'amountMin' | 'amountMax'>,
  amount: RawBuilder<unknown>,
  currency: RawBuilder<unknown>,
  base: { code: string; exp: number },
): RawBuilder<boolean>[] {
  const out: RawBuilder<boolean>[] = [];
  const value = unsigned(amount, currency, base);
  if (f.amountMin !== undefined) out.push(sql<boolean>`${value} >= ${f.amountMin}::numeric`);
  if (f.amountMax !== undefined) out.push(sql<boolean>`${value} <= ${f.amountMax}::numeric`);
  return out;
}

export const hasAmount = (f: Pick<ListFilterQuery, 'amountMin' | 'amountMax'>) =>
  f.amountMin !== undefined || f.amountMax !== undefined;

/**
 * Past this many candidates a filter isn't narrow enough to be worth looking up first: the list walks the date index and
 * stops at its page, so the access check runs on about a page of rows anyway.
 */
export const PREFILTER_MAX = 5000;

/**
 * Conditions on `app.transaction as t`. The merchant matches the start of words in the payee or description through the
 * search index (RPT-05), so "star" finds Starbucks. Money out is spending (a negative amount), money in is income or a
 * refund; transfers are neither, so a direction leaves them out. `from` and `to` only help find the candidates: the
 * caller applies its own dates.
 */
export async function transactionConditions(
  trx: Trx,
  workspaceId: string,
  f: TransactionListFilters & { from?: string; to?: string },
): Promise<RawBuilder<boolean>[]> {
  const out: RawBuilder<boolean>[] = [];
  const words = f.merchant ? tsQueryOf(f.merchant.split(/\s+/)) : null;
  const amount = hasAmount(f);
  if (!words && !amount && !f.direction) return out;
  if (words) out.push(sql<boolean>`t.search @@ to_tsquery('simple', ${words})`);
  const base = await baseCurrency(trx, workspaceId);
  if (amount) out.push(...amountRange(f, sql`(t.spec->>'amount')`, sql`(t.spec->>'currency')`, base));
  if (f.direction) {
    out.push(
      sql<boolean>`(t.spec->>'type' = 'standard' and (t.spec->>'amount')::numeric ${sql.raw(f.direction === 'out' ? '<' : '>')} 0)`,
    );
  }
  // Row-level security checks access on every row before conditions like these (migration 0087): find the few that
  // match first, so it checks only those. The conditions above still decide; this only narrows where they look.
  const { ids } = await sql<{ ids: string[] }>`select app.transaction_filter_ids(
      ${f.from ?? null}::date, ${f.to ?? null}::date,
      ${words ? sql`to_tsquery('simple', ${words})` : sql`null::tsquery`},
      ${f.amountMin ?? null}::numeric, ${f.amountMax ?? null}::numeric, ${f.direction ?? null}::text,
      ${base.code}::text, ${base.exp}::int, ${PREFILTER_MAX + 1}::int) as ids`
    .execute(trx)
    .then((r) => r.rows[0]!);
  if (ids.length <= PREFILTER_MAX) out.unshift(sql<boolean>`t.id = any(${ids}::uuid[])`);
  return out;
}
