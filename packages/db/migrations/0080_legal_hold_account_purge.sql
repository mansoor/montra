-- A legal hold keeps a closing account and its workspaces (NFR-06, BAK-09, ADR-0049 §4). Migration 0079 made a legal
-- hold block purging receipts and files past their retention date, but the same hourly job (`data.retention`) still
-- purged a deleted account, and the workspaces that went with it, 30 days after it was closed, hold or not. Now:
--
--   1. A user under a legal hold, or a workspace with an active member under one, is not purged. Everything stays.
--   2. The job notes when it first held one back (`purge_held_at`) and logs it once; the staff console shows it beside
--      the hold. The note is cleared when the hold is lifted or the deletion cancelled.
--   3. Once the hold is lifted, the next run purges as before.
--
-- `retention_due()` keeps its shape, so old API tasks still running during a deploy skip held ones too, and
-- `purge_workspace` and `purge_user` refuse them, whoever calls.

alter table app.app_user add column purge_held_at timestamptz;
alter table app.workspace add column purge_held_at timestamptz;

-- Whether this person is under a legal hold.
create function app.user_on_legal_hold(p_user uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.account_suspension s where s.user_id = p_user and s.kind = 'legal_hold')
$$;
revoke all on function app.user_on_legal_hold(uuid) from public;

-- The job's first step for accounts: notes each user and workspace past its date that a legal hold keeps, and clears
-- the note on those no longer held (hold lifted, or deletion cancelled). Returns only what changed, so each is logged
-- once: `held` the first run it was kept, `released` the run its hold went.
create function app.retention_hold_purges()
  returns table (kind text, id uuid, change text)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
#variable_conflict use_column
begin
  return query
  with held_ws as (
    update app.workspace w set purge_held_at = now()
     where w.purge_after < now() and w.purge_held_at is null and app.workspace_on_legal_hold(w.id)
    returning w.id
  ), released_ws as (
    update app.workspace w set purge_held_at = null
     where w.purge_held_at is not null
       and (w.purge_after is null or not app.workspace_on_legal_hold(w.id))
    returning w.id
  ), held_users as (
    update app.app_user u set purge_held_at = now()
     where u.purge_after < now() and u.purge_held_at is null and app.user_on_legal_hold(u.id)
    returning u.id
  ), released_users as (
    update app.app_user u set purge_held_at = null
     where u.purge_held_at is not null
       and (u.purge_after is null or not app.user_on_legal_hold(u.id))
    returning u.id
  )
  select 'workspace'::text, x.id, 'held'::text from held_ws x
  union all select 'workspace', x.id, 'released' from released_ws x
  union all select 'user', x.id, 'held' from held_users x
  union all select 'user', x.id, 'released' from released_users x;
end $$;
revoke all on function app.retention_hold_purges() from public;
grant execute on function app.retention_hold_purges() to montra_app;

-- What else retention has to do, as in migration 0079, less what a legal hold keeps.
create or replace function app.retention_due()
  returns table (kind text, workspace_id uuid, id uuid, storage_key text)
  language sql stable security definer set search_path = app, pg_temp as $$
  select 'export', e.workspace_id, e.id, e.storage_key from app.export_job e
   where e.status = 'ready' and e.expires_at < now()
  union all
  select 'restore', null::uuid, r.id, r.storage_key from app.restore_job r where r.expires_at < now()
  union all
  select 'workspace', w.id, w.id, null from app.workspace w
   where w.purge_after < now() and not app.workspace_on_legal_hold(w.id)
  union all
  select 'user', null::uuid, u.id, null from app.app_user u
   where u.purge_after < now() and not app.user_on_legal_hold(u.id)
$$;

-- As in migration 0020, refusing a workspace under a legal hold.
create or replace function app.purge_workspace(p_workspace uuid) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare t record; deleted integer; blocked boolean; total integer; passes integer := 0;
begin
  if not exists (select 1 from app.workspace w where w.id = p_workspace and w.purge_after < now()) then
    raise exception 'workspace % is not due for purging', p_workspace;
  end if;
  if app.workspace_on_legal_hold(p_workspace) then
    raise exception 'workspace % is held by a legal hold', p_workspace;
  end if;
  perform set_config('app.allow_locked_edit', 'on', true);
  loop
    passes := passes + 1;
    total := 0;
    blocked := false;
    for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
             where n.nspname = 'app' and c.relkind = 'r' and c.relname <> 'security_event'
             order by c.relname loop
      begin
        execute format('delete from app.%I where workspace_id = $1', t.relname) using p_workspace;
        get diagnostics deleted = row_count;
        total := total + deleted;
      exception when foreign_key_violation then
        blocked := true;
      end;
    end loop;
    exit when total = 0 and not blocked;
    if passes > 30 then raise exception 'could not purge workspace %', p_workspace; end if;
  end loop;
  delete from app.workspace where id = p_workspace;
  -- Removing the workspace can't write to the feeds, but anything written just before it can linger.
  delete from app.audit_log where workspace_id = p_workspace;
  delete from app.change_log where workspace_id = p_workspace;
end $$;

-- As in migration 0056, refusing a user under a legal hold (it would otherwise delete the hold with them).
create or replace function app.purge_user(p_user uuid) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if not exists (select 1 from app.app_user u where u.id = p_user and u.purge_after < now()) then
    raise exception 'user % is not due for purging', p_user;
  end if;
  if app.user_on_legal_hold(p_user) then
    raise exception 'user % is held by a legal hold', p_user;
  end if;
  update app.workspace_member set status = 'revoked', invited_email = null where user_id = p_user;
  delete from app.push_device where user_id = p_user;
  delete from app.session_device where user_id = p_user;
  delete from app.notification_pref where user_id = p_user;
  delete from app.security_event where user_id = p_user;
  delete from app.restore_job where user_id = p_user;
  delete from app.support_request where user_id = p_user;
  delete from app.staff_user where user_id = p_user;
  delete from app.account_suspension where user_id = p_user;
  delete from app.phone_verification where user_id = p_user;
  update app.app_user
     set email = 'deleted+' || id::text || '@invalid.example', display_name = '', identity_id = null,
         date_format = null, purge_after = null, phone_e164 = null, phone_verified = false, phone_opted_out_at = null,
         purge_held_at = null
   where id = p_user;
end $$;

-- -----------------------------------------------------------------------------
-- The staff console: since when a closing account, or a closing workspace on it, has been held back. Same names, same
-- grants; each gains the one column.
-- -----------------------------------------------------------------------------
drop function app.admin_account_states(uuid[]);
create function app.admin_account_states(p_users uuid[])
  returns table (user_id uuid, kind text, reason text, suspended_at timestamptz, purge_after timestamptz,
                 purge_held_at timestamptz)
  language sql stable security definer set search_path = app, pg_temp as $$
  select u.id, s.kind, s.reason, s.suspended_at, u.purge_after, u.purge_held_at
    from app.app_user u left join app.account_suspension s on s.user_id = u.id
   where u.id = any (p_users)
$$;
revoke all on function app.admin_account_states(uuid[]) from public;
grant execute on function app.admin_account_states(uuid[]) to montra_admin;

drop function app.admin_workspace_plans(uuid[]);
create function app.admin_workspace_plans(p_workspaces uuid[])
  returns table (workspace_id uuid, plan_name text, trial_end timestamptz, subscription_ref text,
                 purge_held_at timestamptz)
  language sql stable security definer set search_path = app, pg_temp as $$
  select w.id, coalesce(p.name, 'Free'), s.trial_end, s.subscription_ref, w.purge_held_at
    from app.workspace w
    left join app.subscription s on s.workspace_id = w.id
    left join app.plan p on p.key = s.plan
   where w.id = any (p_workspaces)
$$;
revoke all on function app.admin_workspace_plans(uuid[]) from public;
grant execute on function app.admin_workspace_plans(uuid[]) to montra_admin;
