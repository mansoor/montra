-- Bank feeds, PR 3a: syncing into Review (ADR-0055 §5; FEED-03, FEED-04, FEED-05). A sync stages one import batch per
-- linked account; every batch waits in Review in this PR (clean ones commit themselves in PR 3b).

-- §5: the provider's transaction id on each staged row. A sync skips ids already brought into the account (waiting,
-- committed or discarded); an undone batch's ids come back. It is also the dedupe key's identity, as an OFX FITID is.
alter table app.import_row add column external_id text check (length(external_id) between 1 and 200);
create index import_row_external on app.import_row (workspace_id, external_id) where external_id is not null;

-- §5, D5: Sync now. Owners, admins and partners may press it, but only owners write the feed (RLS), so this marks it
-- due for them: at most once per `p_minutes` (SIMPLEFIN_SYNC_NOW_MINUTES), and only while it syncs.
create function app.bank_feed_sync_now(p_feed uuid, p_minutes integer)
  returns table (outcome text, after timestamptz)
  language plpgsql security definer set search_path = app, pg_temp as $$
declare
  f app.bank_feed;
begin
  if coalesce(app.current_member_role(), '') not in ('owner', 'admin', 'partner') then
    raise exception 'bank feed: not allowed' using errcode = '42501';
  end if;
  select * into f from app.bank_feed
   where workspace_id = app.current_workspace_id() and id = p_feed and status <> 'disconnected'
   for update;
  if not found then
    return query select 'not_found'::text, null::timestamptz;
    return;
  end if;
  if f.status not in ('active', 'failing') then
    return query select 'not_syncing'::text, null::timestamptz;
    return;
  end if;
  if f.last_manual_sync_at is not null and f.last_manual_sync_at > now() - make_interval(mins => p_minutes) then
    return query select 'too_soon'::text, f.last_manual_sync_at + make_interval(mins => p_minutes);
    return;
  end if;
  update app.bank_feed set last_manual_sync_at = now(), next_sync_at = now(), updated_at = now()
   where workspace_id = f.workspace_id and id = f.id;
  return query select 'ok'::text, null::timestamptz;
end
$$;
revoke all on function app.bank_feed_sync_now(uuid, integer) from public;
grant execute on function app.bank_feed_sync_now(uuid, integer) to montra_app;

-- §5: undoing a feed batch moves its account's cursor back before the batch's first date, so the next sync asks for
-- those days again and the undone rows come back. Whoever may undo an import may do this; it only ever moves the
-- cursor back. (A discarded batch's rows stay out: their ids are skipped.)
create function app.bank_feed_rewind(p_account uuid, p_before date) returns void
  language sql security definer set search_path = app, pg_temp as $$
  update app.bank_feed_account
     set synced_through = p_before - 1, updated_at = now()
   where workspace_id = app.current_workspace_id() and app.is_member()
     and id = p_account and synced_through is not null and synced_through >= p_before
$$;
revoke all on function app.bank_feed_rewind(uuid, date) from public;
grant execute on function app.bank_feed_rewind(uuid, date) to montra_app;
