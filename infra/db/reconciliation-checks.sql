-- Ledger reconciliation checks for a restored database (BAK-07). Each query must return no rows.
-- Read-only. Run as montra_owner, which bypasses RLS and so sees every workspace:
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/db/reconciliation-checks.sql
\echo 'Check 1: every journal entry balances (sum of postings = 0)'
select workspace_id, journal_entry_id, sum(functional_amount_minor) as unbalanced_by
  from app.posting
 group by workspace_id, journal_entry_id
having sum(functional_amount_minor) <> 0;

\echo 'Check 2: every journal entry has at least two postings'
select je.workspace_id, je.id as journal_entry_id, count(p.journal_entry_id) as postings
  from app.journal_entry je
  left join app.posting p on p.workspace_id = je.workspace_id and p.journal_entry_id = je.id
 group by je.workspace_id, je.id
having count(p.journal_entry_id) < 2;

\echo 'Check 3: daily balances equal the postings'
with from_postings as (
  select workspace_id, ledger_account_id, entry_date as date,
         sum(amount_minor) as amount, sum(functional_amount_minor) as functional
    from app.posting
   group by 1, 2, 3
), stored as (
  select workspace_id, ledger_account_id, date,
         sum(delta_minor) as amount, sum(functional_delta_minor) as functional
    from app.account_balance_daily
   group by 1, 2, 3
)
select coalesce(p.workspace_id, s.workspace_id) as workspace_id,
       coalesce(p.ledger_account_id, s.ledger_account_id) as ledger_account_id,
       coalesce(p.date, s.date) as date,
       p.amount as posted, s.amount as stored,
       p.functional as posted_functional, s.functional as stored_functional
  from from_postings p
  full join stored s using (workspace_id, ledger_account_id, date)
 where coalesce(p.amount, 0) <> coalesce(s.amount, 0)
    or coalesce(p.functional, 0) <> coalesce(s.functional, 0);

\echo 'Check 4: monthly category activity equals the postings'
with from_postings as (
  select workspace_id, ledger_account_id, date_trunc('month', entry_date)::date as month,
         sum(functional_amount_minor) as activity, count(*) as postings
    from app.posting
   group by 1, 2, 3
), stored as (
  select workspace_id, ledger_account_id, month,
         sum(activity_minor) as activity, sum(postings) as postings
    from app.category_activity_monthly
   group by 1, 2, 3
)
select coalesce(p.workspace_id, s.workspace_id) as workspace_id,
       coalesce(p.ledger_account_id, s.ledger_account_id) as ledger_account_id,
       coalesce(p.month, s.month) as month,
       p.activity as posted, s.activity as stored,
       p.postings as posted_count, s.postings as stored_count
  from from_postings p
  full join stored s using (workspace_id, ledger_account_id, month)
 where coalesce(p.activity, 0) <> coalesce(s.activity, 0)
    or coalesce(p.postings, 0) <> coalesce(s.postings, 0);
