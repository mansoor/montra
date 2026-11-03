-- NFR-07: expected income is matched to deposits on every budget, forecast and dashboard read. Deposits are a small
-- share of transactions, so this partial index turns a full scan (with an RLS check per row) into a short read.
create index transaction_deposits on app.transaction (workspace_id, primary_entity_id, txn_date)
  where status = 'posted' and deleted_at is null and spec->>'type' = 'standard' and (spec->>'amount')::bigint > 0;
