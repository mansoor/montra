-- Phase 11: running the service (ADR-0020). Plans and billing (UP-12, OPS-08), the staff console (OPS-01), support
-- access (OPS-02), notices and the minimum app version (OPS-03, OPS-04), support requests (OPS-09), and the nightly
-- reconciliation and metrics (NFR-13, OPS-07).
--
-- Needs the roles montra_admin and montra_support: infra/db/bootstrap.sql locally and in CI, Terraform's runbook in
-- production. Staff never touch the financial tables. montra_admin reaches only what's granted here, and a test fails
-- if it can read anything else.

grant usage on schema app, ref to montra_admin, montra_support;

-- -----------------------------------------------------------------------------
-- UP-12, OPS-08: what a workspace is on. Written only through app.apply_subscription: a webhook has no user.
-- -----------------------------------------------------------------------------
create table app.subscription (
  workspace_id         uuid primary key references app.workspace (id) on delete cascade,
  plan                 text not null default 'free' check (plan in ('free', 'pro')),
  status               text not null default 'none'
                         check (status in ('none', 'trialing', 'active', 'past_due', 'canceled')),
  provider             text check (provider in ('stripe', 'apple', 'google', 'staff')),
  customer_ref         text,
  subscription_ref     text,
  billing_interval     text check (billing_interval in ('month', 'year')),
  trial_end            timestamptz,
  current_period_end   timestamptz,
  -- When a failed payment stops counting as paid. Data stays readable and exportable after that.
  grace_until          timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at           timestamptz not null default now()
);
create unique index subscription_ref_unique on app.subscription (provider, subscription_ref)
  where subscription_ref is not null;
create index subscription_customer on app.subscription (customer_ref) where customer_ref is not null;
create index subscription_grace on app.subscription (grace_until) where grace_until is not null;

-- A provider can resend an event, so each is handled once.
create table app.billing_event (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- OPS-01: who's staff, and what they did. Rows are added by hand with `pnpm staff:add`.
-- -----------------------------------------------------------------------------
create table app.staff_user (
  user_id    uuid primary key references app.app_user (id) on delete cascade,
  role       text not null check (role in ('support', 'admin')),
  created_at timestamptz not null default now()
);

create table app.admin_log (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null,
  action     text not null,
  subject    text,
  detail     jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index admin_log_at on app.admin_log (at desc);

create table app.feature_flag (
  key        text primary key check (key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  enabled    boolean not null default false,
  -- The share of workspaces it's on for when enabled, decided by a hash of the workspace id.
  rollout    integer not null default 100 check (rollout between 0 and 100),
  note       text not null default '',
  updated_at timestamptz not null default now()
);

create table app.feature_flag_override (
  key          text not null references app.feature_flag (key) on delete cascade,
  workspace_id uuid not null references app.workspace (id) on delete cascade,
  enabled      boolean not null,
  primary key (key, workspace_id)
);

-- -----------------------------------------------------------------------------
-- OPS-03, OPS-04: what's announced in the app and on the status page, and the oldest phone app still served.
-- -----------------------------------------------------------------------------
create table app.system_notice (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('maintenance', 'incident', 'info')),
  title      text not null check (length(title) between 1 and 200),
  body       text not null default '' check (length(body) <= 2000),
  -- When people start seeing it, and what it's about. Maintenance is announced 48 hours ahead (checked in the API).
  show_from  timestamptz not null default now(),
  starts_at  timestamptz,
  ends_at    timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index system_notice_ends on app.system_notice (ends_at);

create table app.system_setting (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
insert into app.system_setting (key, value) values ('min_app_version_ios', '0.0.0'), ('min_app_version_android', '0.0.0');

-- -----------------------------------------------------------------------------
-- OPS-02: a person lets support look at a workspace, for a limited time. It's always read-only.
-- -----------------------------------------------------------------------------
create table app.support_grant (
  workspace_id uuid not null references app.workspace (id) on delete cascade,
  id           uuid not null default gen_random_uuid(),
  granted_by   uuid not null references app.app_user (id),
  reason       text not null default '' check (length(reason) <= 500),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index support_grant_active on app.support_grant (expires_at) where revoked_at is null;

-- -----------------------------------------------------------------------------
-- OPS-09: questions and bug reports. A screenshot and logs are there only if the person chose to send them.
-- -----------------------------------------------------------------------------
create table app.support_request (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app.app_user (id) on delete cascade,
  workspace_id uuid references app.workspace (id) on delete set null,
  kind         text not null check (kind in ('question', 'bug')),
  subject      text not null check (length(subject) between 1 and 200),
  body         text not null check (length(body) between 1 and 5000),
  context      jsonb not null default '{}',
  screenshot   bytea check (octet_length(screenshot) <= 2097152),
  status       text not null default 'open' check (status in ('open', 'closed')),
  created_at   timestamptz not null default now()
);
create index support_request_status on app.support_request (status, created_at desc);

-- -----------------------------------------------------------------------------
-- Risk register: every night, across all workspaces, the books must balance and read models must equal postings.
-- -----------------------------------------------------------------------------
create table app.reconciliation_run (
  id                 uuid primary key default gen_random_uuid(),
  finished_at        timestamptz not null default now(),
  unbalanced_entries integer not null,
  read_model_gaps    integer not null,
  -- Only ids, so that a failure can be looked into without seeing anyone's money.
  sample             jsonb not null default '[]'
);
create index reconciliation_run_at on app.reconciliation_run (finished_at desc);

-- -----------------------------------------------------------------------------
-- Access. Nothing here has a workspace policy unless it belongs to one.
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['subscription', 'billing_event', 'staff_user', 'admin_log', 'feature_flag',
                           'feature_flag_override', 'system_notice', 'system_setting', 'support_grant',
                           'support_request', 'reconciliation_run'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
end $$;

create policy subscription_member on app.subscription for select
  using (workspace_id = app.current_workspace_id() and app.is_member());
grant select on app.subscription to montra_app;

create policy feature_flag_read on app.feature_flag for select to montra_app using (true);
create policy feature_flag_admin on app.feature_flag for all to montra_admin using (true) with check (true);
grant select on app.feature_flag to montra_app;
grant select, insert, update, delete on app.feature_flag to montra_admin;
create policy feature_flag_override_read on app.feature_flag_override for select to montra_app
  using (workspace_id = app.current_workspace_id());
create policy feature_flag_override_admin on app.feature_flag_override for all to montra_admin
  using (true) with check (true);
grant select on app.feature_flag_override to montra_app;
grant select, insert, update, delete on app.feature_flag_override to montra_admin;

create policy system_notice_read on app.system_notice for select to montra_app using (true);
create policy system_notice_admin on app.system_notice for all to montra_admin using (true) with check (true);
grant select on app.system_notice to montra_app;
grant select, insert, update, delete on app.system_notice to montra_admin;

create policy system_setting_read on app.system_setting for select to montra_app using (true);
create policy system_setting_admin on app.system_setting for all to montra_admin using (true) with check (true);
grant select on app.system_setting to montra_app;
grant select, insert, update on app.system_setting to montra_admin;

create policy admin_log_admin on app.admin_log for all to montra_admin using (true) with check (true);
grant select, insert on app.admin_log to montra_admin;

-- The owner gives and takes back access; members can see it's been given.
create policy support_grant_member on app.support_grant for select
  using (workspace_id = app.current_workspace_id() and app.is_member());
create policy support_grant_owner on app.support_grant for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');
grant select, insert, update on app.support_grant to montra_app;

create policy support_request_own on app.support_request for all
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert on app.support_request to montra_app;

-- ref.* can change without an app release (OPS-05).
grant select, insert, update, delete on ref.merchant, ref.mileage_rate, ref.tax_line, ref.import_profile to montra_admin;
grant select on ref.currency to montra_admin;

-- -----------------------------------------------------------------------------
-- Billing. A webhook has no user, so these are the one way in.
-- -----------------------------------------------------------------------------
create function app.record_billing_event(p_id text, p_type text) returns boolean
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  insert into app.billing_event (id, type) values (p_id, p_type) on conflict do nothing;
  return found;
end $$;
grant execute on function app.record_billing_event(text, text) to montra_app;

create function app.apply_subscription(
  p_workspace uuid, p_plan text, p_status text, p_provider text, p_customer text, p_subscription text,
  p_interval text, p_trial_end timestamptz, p_period_end timestamptz, p_grace_until timestamptz,
  p_cancel_at_period_end boolean, p_quota_bytes bigint
) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  insert into app.subscription as s (workspace_id, plan, status, provider, customer_ref, subscription_ref,
                                     billing_interval, trial_end, current_period_end, grace_until,
                                     cancel_at_period_end)
  values (p_workspace, p_plan, p_status, p_provider, p_customer, p_subscription, p_interval, p_trial_end,
          p_period_end, p_grace_until, p_cancel_at_period_end)
  on conflict (workspace_id) do update
    set plan = excluded.plan, status = excluded.status, provider = excluded.provider,
        customer_ref = coalesce(excluded.customer_ref, s.customer_ref),
        subscription_ref = coalesce(excluded.subscription_ref, s.subscription_ref),
        billing_interval = coalesce(excluded.billing_interval, s.billing_interval),
        trial_end = excluded.trial_end, current_period_end = excluded.current_period_end,
        -- A second failed payment doesn't start the grace again.
        grace_until = case when excluded.status = 'past_due' then coalesce(s.grace_until, excluded.grace_until)
                           else excluded.grace_until end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at = now();
  update app.workspace set storage_quota_bytes = p_quota_bytes where id = p_workspace;
end $$;
grant execute on function app.apply_subscription(uuid, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz, boolean, bigint)
  to montra_app, montra_admin;

create function app.subscription_by_ref(p_provider text, p_subscription text, p_customer text)
  returns table (workspace_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select s.workspace_id from app.subscription s
   where s.provider = p_provider and (s.subscription_ref = p_subscription or s.customer_ref = p_customer)
   limit 1
$$;
grant execute on function app.subscription_by_ref(text, text, text) to montra_app;

-- A failed payment that ran out of grace, and a trial that ended with no payment. Read by the hourly sweep.
create function app.subscriptions_lapsed() returns table (workspace_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select s.workspace_id from app.subscription s
   where s.plan <> 'free'
     and ((s.status = 'past_due' and s.grace_until < now())
       or (s.status = 'trialing' and s.trial_end < now()))
$$;
grant execute on function app.subscriptions_lapsed() to montra_app;

-- -----------------------------------------------------------------------------
-- Staff identity, read with the ordinary app connection before anything else is opened.
-- -----------------------------------------------------------------------------
create function app.staff_role(p_user uuid) returns text
  language sql stable security definer set search_path = app, pg_temp as $$
  select role from app.staff_user where user_id = p_user
$$;
grant execute on function app.staff_role(uuid) to montra_app;

-- The console's window on accounts: people and plans, never money. These run as their owner, so these
-- grants are what keeps them to staff.
create function app.admin_find_accounts(p_query text)
  returns table (id uuid, email text, display_name text, created_at timestamptz, deleted_at timestamptz, workspaces bigint)
  language sql stable security definer set search_path = app, pg_temp as $$
  select u.id, u.email::text, u.display_name, u.created_at, u.deleted_at,
         (select count(*) from app.workspace_member m where m.user_id = u.id and m.status = 'active')
    from app.app_user u
   where u.email ilike '%' || replace(replace(replace(p_query, '\', '\'), '%', '\%'), '_', '\_') || '%'
   order by u.email limit 50
$$;
revoke all on function app.admin_find_accounts(text) from public;
grant execute on function app.admin_find_accounts(text) to montra_admin;

create function app.admin_account_workspaces(p_user uuid)
  returns table (id uuid, name text, role text, plan text, status text, provider text, current_period_end timestamptz,
                 grace_until timestamptz, quota_bytes bigint, used_bytes bigint, members bigint, created_at timestamptz,
                 deleted_at timestamptz, support_until timestamptz)
  language sql stable security definer set search_path = app, pg_temp as $$
  select w.id, w.name, m.role, coalesce(s.plan, 'free'), coalesce(s.status, 'none'), s.provider, s.current_period_end,
         s.grace_until, w.storage_quota_bytes,
         coalesce((select sum(f.bytes) from app.file f where f.workspace_id = w.id and f.deleted_at is null), 0)::bigint,
         (select count(*) from app.workspace_member x where x.workspace_id = w.id and x.status = 'active'),
         w.created_at, w.deleted_at,
         (select max(g.expires_at) from app.support_grant g
           where g.workspace_id = w.id and g.revoked_at is null and g.expires_at > now())
    from app.workspace_member m
    join app.workspace w on w.id = m.workspace_id
    left join app.subscription s on s.workspace_id = w.id
   where m.user_id = p_user and m.status = 'active'
   order by w.created_at
$$;
revoke all on function app.admin_account_workspaces(uuid) from public;
grant execute on function app.admin_account_workspaces(uuid) to montra_admin;

create function app.admin_subscription(p_workspace uuid)
  returns table (status text, provider text, customer_ref text, subscription_ref text, billing_interval text)
  language sql stable security definer set search_path = app, pg_temp as $$
  select s.status, s.provider, s.customer_ref, s.subscription_ref, s.billing_interval
    from app.subscription s where s.workspace_id = p_workspace
$$;
revoke all on function app.admin_subscription(uuid) from public;
grant execute on function app.admin_subscription(uuid) to montra_admin;

-- OPS-01, NFR-13: by bank format, never by file or customer.
create function app.admin_import_failures(p_days integer)
  returns table (institution text, file_type text, batches bigint, failed bigint, needed_mapping bigint, rows_failed bigint)
  language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce(p.institution, 'Unknown'), b.file_type, count(*),
         count(*) filter (where b.status = 'failed'),
         count(*) filter (where b.mapping_source is distinct from 'profile'),
         coalesce(sum(b.rows_failed), 0)
    from app.import_batch b
    left join ref.import_profile p on p.fingerprint = b.fingerprint
   where b.created_at > now() - make_interval(days => p_days)
   group by 1, 2
   order by count(*) filter (where b.status = 'failed') desc, count(*) desc
   limit 200
$$;
revoke all on function app.admin_import_failures(integer) from public;
grant execute on function app.admin_import_failures(integer) to montra_admin;

create function app.admin_ai_accuracy(p_days integer)
  returns table (task text, provider text, model text, calls bigint, failures bigint, accepted bigint, edited bigint,
                 rejected bigint, cost_micro_usd bigint)
  language sql stable security definer set search_path = app, pg_temp as $$
  select e.task, e.provider, e.model, count(*),
         count(*) filter (where e.outcome not in ('ok', 'cached', 'off', 'budget')),
         count(*) filter (where e.user_action = 'accepted'),
         count(*) filter (where e.user_action = 'edited'),
         count(*) filter (where e.user_action = 'rejected'),
         coalesce(sum(e.cost_micro_usd), 0)::bigint
    from app.ai_event e
   where e.created_at > now() - make_interval(days => p_days)
   group by 1, 2, 3
   order by 4 desc
   limit 200
$$;
revoke all on function app.admin_ai_accuracy(integer) from public;
grant execute on function app.admin_ai_accuracy(integer) to montra_admin;

create function app.admin_support_requests(p_status text)
  returns table (id uuid, email text, kind text, subject text, body text, context jsonb, has_screenshot boolean,
                 status text, created_at timestamptz, workspace_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select r.id, u.email::text, r.kind, r.subject, r.body, r.context, r.screenshot is not null, r.status, r.created_at,
         r.workspace_id
    from app.support_request r join app.app_user u on u.id = r.user_id
   where r.status = p_status
   order by r.created_at desc limit 200
$$;
revoke all on function app.admin_support_requests(text) from public;
grant execute on function app.admin_support_requests(text) to montra_admin;

create function app.admin_support_screenshot(p_id uuid) returns bytea
  language sql stable security definer set search_path = app, pg_temp as $$
  select screenshot from app.support_request where id = p_id
$$;
revoke all on function app.admin_support_screenshot(uuid) from public;
grant execute on function app.admin_support_screenshot(uuid) to montra_admin;

create function app.admin_close_support_request(p_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  update app.support_request set status = 'closed' where id = p_id;
  return found;
end $$;
revoke all on function app.admin_close_support_request(uuid) from public;
grant execute on function app.admin_close_support_request(uuid) to montra_admin;

-- -----------------------------------------------------------------------------
-- OPS-02: a support session. The grant is checked here, and it reads as whoever granted it, on a role that can't write.
-- -----------------------------------------------------------------------------
create function app.admin_support_grant(p_workspace uuid)
  returns table (id uuid, granted_by uuid, expires_at timestamptz)
  language sql stable security definer set search_path = app, pg_temp as $$
  select g.id, g.granted_by, g.expires_at from app.support_grant g
    join app.workspace_member m on m.workspace_id = g.workspace_id and m.user_id = g.granted_by
                               and m.role = 'owner' and m.status = 'active'
   where g.workspace_id = p_workspace and g.revoked_at is null and g.expires_at > now()
   order by g.expires_at desc limit 1
$$;
revoke all on function app.admin_support_grant(uuid) from public;
grant execute on function app.admin_support_grant(uuid) to montra_admin;

-- The person sees it in their security log (AUTH-12), which is otherwise theirs alone to write.
create function app.log_support_access(p_workspace uuid, p_user uuid, p_staff uuid, p_what text) returns void
  language sql volatile security definer set search_path = app, pg_temp as $$
  insert into app.security_event (user_id, workspace_id, kind, detail)
  values (p_user, p_workspace, 'support_access', jsonb_build_object('what', p_what));
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'support.view', p_workspace::text, jsonb_build_object('what', p_what));
$$;
revoke all on function app.log_support_access(uuid, uuid, uuid, text) from public;
grant execute on function app.log_support_access(uuid, uuid, uuid, text) to montra_admin;

-- What a support session can read. Not the encrypted columns, payslips, tenants or anyone's documents.
grant select (workspace_id, id, type, name, functional_currency) on app.entity to montra_support;
grant select on app.workspace_member to montra_support;
grant select on app.entity_grant to montra_support;
grant select on app.account_balance_daily to montra_support;
grant select (id, name, deleted_at, base_currency) on app.workspace to montra_support;
grant select (workspace_id, id, entity_id, status, file_type, rows_read, rows_added, rows_matched, rows_skipped,
              rows_failed, mapping_source, created_at, min_date, max_date, currency) on app.import_batch to montra_support;
grant select (workspace_id, id, task, provider, model, outcome, confidence, user_action, created_at) on app.ai_event to montra_support;

-- -----------------------------------------------------------------------------
-- Risk register: the nightly reconciliation. Only counts and ids leave the function.
-- -----------------------------------------------------------------------------
create function app.reconcile_books() returns table (unbalanced_entries integer, read_model_gaps integer, sample jsonb)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_unbalanced integer;
  v_gaps integer;
  v_sample jsonb;
begin
  with bad as (
    select p.workspace_id, p.journal_entry_id
      from app.posting p
     group by 1, 2
    having sum(p.functional_amount_minor) <> 0
  ), gaps as (
    select coalesce(a.workspace_id, b.workspace_id) as workspace_id,
           coalesce(a.ledger_account_id, b.ledger_account_id) as ledger_account_id
      from (select p.workspace_id, p.ledger_account_id, sum(p.amount_minor) as total
              from app.posting p group by 1, 2) a
      full join (select d.workspace_id, d.ledger_account_id, sum(d.delta_minor) as total
                   from app.account_balance_daily d group by 1, 2) b
        on a.workspace_id = b.workspace_id and a.ledger_account_id = b.ledger_account_id
     where coalesce(a.total, 0) <> coalesce(b.total, 0)
  )
  select (select count(*) from bad), (select count(*) from gaps),
         coalesce((select jsonb_agg(x) from (
           select jsonb_build_object('kind', 'entry', 'workspace', workspace_id, 'id', journal_entry_id) as x from bad limit 20
         ) s1), '[]'::jsonb)
         || coalesce((select jsonb_agg(x) from (
           select jsonb_build_object('kind', 'account', 'workspace', workspace_id, 'id', ledger_account_id) as x from gaps limit 20
         ) s2), '[]'::jsonb)
    into v_unbalanced, v_gaps, v_sample;
  insert into app.reconciliation_run (unbalanced_entries, read_model_gaps, sample) values (v_unbalanced, v_gaps, v_sample);
  delete from app.reconciliation_run where finished_at < now() - interval '90 days';
  return query select v_unbalanced, v_gaps, v_sample;
end $$;
grant execute on function app.reconcile_books() to montra_app;

-- -----------------------------------------------------------------------------
-- NFR-13, OPS-07: what /internal/metrics reports, all of it counts.
-- -----------------------------------------------------------------------------
create function app.metrics_queue() returns table (queue text, lag_seconds double precision, failed bigint)
  language sql stable security definer set search_path = app, pg_temp as $$
  select j.queue,
         coalesce(extract(epoch from now() - min(j.run_after) filter (where j.status = 'queued' and j.run_after <= now())), 0)::double precision,
         count(*) filter (where j.status = 'failed')
    from app.job j
   group by 1
$$;
grant execute on function app.metrics_queue() to montra_app;

create function app.metrics_job_failures() returns table (queue text, type text, failed bigint)
  language sql stable security definer set search_path = app, pg_temp as $$
  select j.queue, j.type, count(*) from app.job j where j.status = 'failed' group by 1, 2
$$;
grant execute on function app.metrics_job_failures() to montra_app;

create function app.metrics_ai() returns table (provider text, task text, outcome text, calls bigint)
  language sql stable security definer set search_path = app, pg_temp as $$
  select e.provider, e.task, e.outcome, count(*) from app.ai_event e group by 1, 2, 3
$$;
grant execute on function app.metrics_ai() to montra_app;

create function app.metrics_ai_accepted() returns double precision
  language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce(
    (count(*) filter (where e.user_action = 'accepted'))::double precision
      / nullif(count(*) filter (where e.user_action in ('accepted', 'edited', 'rejected')), 0), 0)
    from app.ai_event e where e.created_at > now() - interval '30 days'
$$;
grant execute on function app.metrics_ai_accepted() to montra_app;

create function app.metrics_import_failures() returns table (institution text, file_type text, failed bigint)
  language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce(p.institution, 'Unknown'), b.file_type, count(*)
    from app.import_batch b left join ref.import_profile p on p.fingerprint = b.fingerprint
   where b.status = 'failed'
   group by 1, 2
$$;
grant execute on function app.metrics_import_failures() to montra_app;

create function app.metrics_ops() returns table (reconciliation_failures bigint, backup_failures bigint, last_reconciled timestamptz)
  language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce((select r.unbalanced_entries + r.read_model_gaps from app.reconciliation_run r
                    order by r.finished_at desc limit 1), 0)::bigint,
         (select count(*) from app.export_job e where e.status = 'failed'),
         (select max(r.finished_at) from app.reconciliation_run r)
$$;
grant execute on function app.metrics_ops() to montra_app;

-- Leaving takes support requests too (BAK-09). The row in app_user stays, with nothing to identify it.
create or replace function app.purge_user(p_user uuid) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if not exists (select 1 from app.app_user u where u.id = p_user and u.purge_after < now()) then
    raise exception 'user % is not due for purging', p_user;
  end if;
  update app.workspace_member set status = 'revoked', invited_email = null where user_id = p_user;
  delete from app.push_device where user_id = p_user;
  delete from app.session_device where user_id = p_user;
  delete from app.notification_pref where user_id = p_user;
  delete from app.security_event where user_id = p_user;
  delete from app.restore_job where user_id = p_user;
  delete from app.support_request where user_id = p_user;
  delete from app.staff_user where user_id = p_user;
  update app.app_user
     set email = 'deleted+' || id::text || '@invalid.example', display_name = '', identity_id = null,
         date_format = null, purge_after = null
   where id = p_user;
end $$;

-- -----------------------------------------------------------------------------
-- Functions were open to every role until now, which didn't matter with only one. From here on they belong to the app,
-- and staff and support get what's named for them. The admin_ functions above have already been kept from the app.
-- -----------------------------------------------------------------------------
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname not like 'admin\_%' and p.proname <> 'log_support_access'
  loop
    execute format('grant execute on function %s to montra_app', f);
    execute format('revoke execute on function %s from public', f);
  end loop;
end $$;
alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema app grant execute on functions to montra_app;

-- Row policies call these as whoever is querying.
grant execute on function app.current_workspace_id(), app.current_user_id(), app.current_member_role(), app.is_member(),
  app.entity_access(uuid), app.can_read_entity(uuid), app.can_write_entity(uuid) to montra_support;
