-- Payments to different accounts are different payees (backlog item 11). The payee normalizer drops masked account
-- numbers, which is right for merchants, but it left "ONLINE PAYMENT TO CARD XXXX4321" and "… XXXX8765" both with the
-- key "TO": one payee, one history, one transfer memory for every card. New lines get the account's last four digits
-- in their payee key ("TO ••4321", `payeeKeyFor` in @montra/importers); this moves what is already stored the same way.
-- Duplicate detection doesn't use the payee key, so nothing here changes which lines count as already imported.
--
-- The patterns are `accountDigitsOf`'s: payment or transfer wording, or a key of only "TO"/"FROM", and a masked number
-- (XXXX4321, ****4321, ...4321, ••4321) or "ENDING IN 4321". Keys that already end in " ••dddd" are left, so a second
-- run changes nothing.

create temporary table payee_rekey on commit drop as
select t.workspace_id, t.id as transaction_id, t.payee_key as old_key, t.payee_key || ' ••' || d.digits as new_key,
       d.digits, x.s
  from app.transaction t
  cross join lateral (
    select upper(coalesce(t.payee_raw, '') || ' ' || coalesce(t.raw_description, t.description, '')) as s
  ) x
  cross join lateral (
    select right(coalesce(substring(x.s from '(?:X{2,}|\*{2,}|\.{2,}|•+)(\d{4,})\M'),
                          substring(x.s from '\mENDING(?: IN)? (\d{4,})\M')), 4) as digits
  ) d
 where t.payee_key is not null and t.payee_key <> ''
   and t.payee_key !~ ' ••\d{4}$'
   and (x.s ~ '\m(PAYMENT|PMT|PYMT|AUTOPAY|AUTO PAY|TRANSFER|XFER)\M' or t.payee_key ~ '^((TO|FROM)( |$))+$')
   and d.digits is not null;

-- Payee history: what each transaction counted (`categorization.learned`) moves to its new key.
with learned as (
  select r.workspace_id, r.old_key, r.new_key,
         (t.categorization -> 'learned' ->> 'band')::int as band,
         (t.categorization -> 'learned' ->> 'categoryId')::uuid as category_id,
         nullif(t.categorization -> 'learned' ->> 'memberId', '')::uuid as member_id
    from payee_rekey r
    join app.transaction t on t.workspace_id = r.workspace_id and t.id = r.transaction_id
   where jsonb_typeof(t.categorization -> 'learned') = 'object' and t.deleted_at is null
), moved as (
  select workspace_id, old_key, new_key, band, category_id, member_id, count(*)::int as n
    from learned group by 1, 2, 3, 4, 5, 6
), taken as (
  update app.payee_history h set count = greatest(h.count - m.n, 0)
    from (select workspace_id, old_key, band, category_id, member_id, sum(n)::int as n
            from moved group by 1, 2, 3, 4, 5) m
   where h.workspace_id = m.workspace_id and h.payee_key = m.old_key and h.amount_band = m.band
     and h.category_id = m.category_id
     and coalesce(h.member_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(m.member_id, '00000000-0000-0000-0000-000000000000'::uuid)
  returning 1
)
insert into app.payee_history (workspace_id, payee_key, amount_band, category_id, member_id, count)
select workspace_id, new_key, band, category_id, member_id, n from moved
    on conflict (workspace_id, payee_key, amount_band, category_id,
                 coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set count = app.payee_history.count + excluded.count;

-- Transfers made by hand: each transfer transaction moves one count to its new key, for the account it went to.
with moved as (
  select r.workspace_id, r.old_key, r.new_key, pt.account_id, count(*)::int as n
    from payee_rekey r
    join app.transaction t on t.workspace_id = r.workspace_id and t.id = r.transaction_id
    join app.payee_transfer pt on pt.workspace_id = r.workspace_id and pt.payee_key = r.old_key
                              and pt.account_id::text in (t.spec ->> 'fromAccountId', t.spec ->> 'toAccountId')
   where t.spec ->> 'type' = 'transfer' and t.deleted_at is null
   group by 1, 2, 3, 4
), taken as (
  update app.payee_transfer pt set count = greatest(pt.count - m.n, 0)
    from (select workspace_id, old_key, account_id, sum(n)::int as n from moved group by 1, 2, 3) m
   where pt.workspace_id = m.workspace_id and pt.payee_key = m.old_key and pt.account_id = m.account_id
  returning 1
)
insert into app.payee_transfer (workspace_id, payee_key, account_id, count)
select workspace_id, new_key, account_id, n from moved
    on conflict (workspace_id, payee_key, account_id) do update set count = app.payee_transfer.count + excluded.count;

-- Corrections follow their transaction, so rule suggestions count them per account.
update app.correction c set payee_key = r.new_key
  from payee_rekey r
 where c.workspace_id = r.workspace_id and c.transaction_id = r.transaction_id;

-- One payee per account, named like new lines' ("Payment to ••4321"); a transaction on the shared payee moves to it.
insert into app.payee (workspace_id, display_name, normalized_key)
select distinct on (workspace_id, new_key) workspace_id,
       case when s ~ '\m(TRANSFER|XFER)\M' then 'Transfer' else 'Payment' end || ' to ••' || digits, new_key
  from payee_rekey
 order by workspace_id, new_key
    on conflict (workspace_id, normalized_key) do nothing;

update app.transaction t set payee_id = np.id
  from payee_rekey r
  join app.payee np on np.workspace_id = r.workspace_id and np.normalized_key = r.new_key
 where t.workspace_id = r.workspace_id and t.id = r.transaction_id
   and exists (select 1 from app.payee op where op.workspace_id = t.workspace_id and op.id = t.payee_id
                 and op.normalized_key = r.old_key);

update app.transaction t set payee_key = r.new_key
  from payee_rekey r
 where t.workspace_id = r.workspace_id and t.id = r.transaction_id;
