/**
 * Turns the search syntax into a filter on `app.transaction as t` (RPT-05, ADR-0019 §3). Notes are encrypted, so they can't be matched
 * in SQL: the most recent are decrypted here and the ones that match come back as ids. All under the caller's RLS.
 */
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '@montra/db';
import { parseSearchQuery, textMatchesTerms, type AmountFilter, type SearchQuery } from '@montra/domain';
import type { FieldCrypto } from '../crypto/crypto.service.js';

/** How many notes are decrypted for one search. Older notes than this aren't searched. */
export const NOTE_SEARCH_LIMIT = 5000;

/** Words of a term as a prefix query: letters and digits only, so nothing in it can be tsquery syntax. */
export function tsQueryOf(terms: readonly string[]): string | null {
  const parts = terms
    .map((t) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => `${w}:*`).join(' <-> '))
    .filter(Boolean);
  return parts.length ? parts.join(' & ') : null;
}

const AMOUNT_OPS: Record<AmountFilter['op'], RawBuilder<unknown>> = {
  '>': sql.raw('>'),
  '>=': sql.raw('>='),
  '<': sql.raw('<'),
  '<=': sql.raw('<='),
  '=': sql.raw('='),
};

export interface SearchFilter {
  query: SearchQuery;
  where: RawBuilder<boolean>;
  /** The note behind each match, decrypted, for showing why it matched. */
  notes: Map<string, string>;
}

export async function searchFilter(
  trx: Trx,
  ctx: { workspaceId: string },
  crypto: FieldCrypto,
  q: string,
): Promise<SearchFilter> {
  const query = parseSearchQuery(q);
  const conditions: RawBuilder<unknown>[] = [];
  const notes = new Map<string, string>();

  if (query.terms.length) {
    const sealed = await trx
      .selectFrom('app.transaction')
      .select(['id', 'memo_enc'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('memo_enc', 'is not', null)
      .where('deleted_at', 'is', null)
      .orderBy('txn_date', 'desc')
      .limit(NOTE_SEARCH_LIMIT)
      .execute();
    for (const row of sealed) {
      const memo = await crypto.decrypt(trx, ctx.workspaceId, 'transaction.memo', row.memo_enc);
      if (memo && textMatchesTerms(memo, query.terms)) notes.set(row.id, memo);
    }
    const ts = tsQueryOf(query.terms);
    const ids = [...notes.keys()];
    const inNotes = ids.length ? sql`t.id = any(${ids}::uuid[])` : sql`false`;
    conditions.push(ts ? sql`(t.search @@ to_tsquery('simple', ${ts}) or ${inNotes})` : inNotes);
  }
  // Compared as decimals against the amount in its own currency's units, so "> 500" reads the same in any currency.
  for (const a of query.amounts) {
    conditions.push(sql`abs((t.spec->>'amount')::numeric) / power(10::numeric,
      coalesce((select c.minor_units from ref.currency c where c.code = t.spec->>'currency'), 2))
      ${AMOUNT_OPS[a.op]} ${a.value}::numeric`);
  }
  for (const tag of query.tags) {
    conditions.push(sql`exists (select 1 from app.transaction_tag tt
      join app.tag g on g.workspace_id = tt.workspace_id and g.id = tt.tag_id
      where tt.workspace_id = t.workspace_id and tt.transaction_id = t.id and lower(g.name) = lower(${tag}))`);
  }
  return {
    query,
    notes,
    where: conditions.length ? sql<boolean>`(${sql.join(conditions, sql` and `)})` : sql<boolean>`true`,
  };
}
