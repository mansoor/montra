-- The web lists' filters (Transactions, Review): merchant words, an amount range without the sign, money in or out.
--
-- Row-level security checks every row a query reads against `app.can_read_entity` before it applies any condition whose
-- operator isn't leakproof. The search index's `@@` and the casts out of `spec` aren't, so a filter that matches few
-- rows still paid the access check on every transaction in the window: about 3 s over 50,000 transactions.
--
-- This finds the candidates without that check: the ids of the current workspace's transactions that match, up to a
-- cap. The API then asks for those ids (uuid equality is leakproof, so the access check runs only on them) and applies
-- the same filters again under RLS, so what a person sees is exactly what they could see before. It returns ids only,
-- never data, and only for the workspace the request is in, to a member of it.
--
-- An amount counts without its sign. One in another currency counts by its face value in the workspace currency's
-- minor units, as the search's `>20` does. Money out is a negative standard transaction, money in a positive one;
-- transfers are neither.

create function app.transaction_filter_ids(
  p_from      date,
  p_to        date,
  p_words     tsquery,
  p_min       numeric,
  p_max       numeric,
  p_direction text,
  p_base      text,
  p_base_exp  integer,
  p_limit     integer
) returns uuid[]
  language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  ws  uuid := app.current_workspace_id();
  ids uuid[];
begin
  if ws is null or app.current_member_role() is null then
    return '{}';
  end if;
  -- Planned with the values each time, so the words use the search index and the dates the date index. The currency
  -- is joined, not looked up row by row.
  execute format($q$
    select coalesce(array_agg(x.id), '{}')
      from (select t.id
              from app.transaction t
              left join ref.currency c on c.code = (t.spec ->> 'currency')::char(3)
             where t.workspace_id = $1
               and t.txn_date between coalesce($2, '-infinity'::date) and coalesce($3, 'infinity'::date)
               %s %s %s
             limit $10) x$q$,
    case when p_words is null then '' else 'and t.search @@ $4' end,
    case when p_direction is null then ''
         else format('and t.spec ->> %L = %L and (t.spec ->> %L)::numeric %s 0', 'type', 'standard', 'amount',
                     case p_direction when 'out' then '<' else '>' end) end,
    case when p_min is null and p_max is null then ''
         else $a$and (case when t.spec ->> 'currency' = $8 then abs((t.spec ->> 'amount')::numeric)
                         else abs((t.spec ->> 'amount')::numeric)
                              * power(10::numeric, $9 - coalesce(c.minor_units, 2))
                    end) between coalesce($5, 0) and coalesce($6, 'Infinity'::numeric)$a$ end)
    into ids
    using ws, p_from, p_to, p_words, p_min, p_max, p_direction, p_base, p_base_exp, p_limit;
  return ids;
end
$$;
revoke all on function app.transaction_filter_ids(date, date, tsquery, numeric, numeric, text, text, integer, integer)
  from public;
grant execute on function app.transaction_filter_ids(date, date, tsquery, numeric, numeric, text, text, integer, integer)
  to montra_app;
