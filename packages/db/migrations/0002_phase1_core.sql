-- 0002_phase1_core: sharing invites, recurring templates, field-encryption keys, account visibility,
-- and the transaction input spec used for edits and scheduled occurrences (Phase 1).

-- The user-level input that produced a transaction's journal entries (design 04 §2). Edits merge into it and
-- re-run the posting builder; scheduled occurrences hold a spec and no entries until confirmed (TXN-05).
alter table app.transaction add column spec jsonb;
alter table app.transaction add column posted_at timestamptz;
create unique index transaction_recurring_occurrence
  on app.transaction (workspace_id, recurring_item_id, txn_date) where recurring_item_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Invites (AUTH-10, UP-04): by email with a role and optional entity grants; 7-day expiry.
-- ---------------------------------------------------------------------------------------------
create table app.workspace_invite (
  workspace_id   uuid not null references app.workspace (id) on delete cascade,
  id             uuid not null default gen_random_uuid() primary key,
  email          citext not null,
  role           text not null check (role in ('partner', 'viewer', 'accountant')),
  entity_grants  jsonb not null default '[]',
  token_hash     text not null unique,
  invited_by     uuid references app.app_user (id),
  expires_at     timestamptz not null default now() + interval '7 days',
  accepted_at    timestamptz,
  accepted_by    uuid references app.app_user (id),
  revoked_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index workspace_invite_ws on app.workspace_invite (workspace_id);

-- Accepting runs before the user is a member, so it is a reviewed SECURITY DEFINER function.
create function app.accept_invite(p_token_hash text) returns uuid
  language plpgsql security definer set search_path = app, pg_temp as $$
declare inv app.workspace_invite; uid uuid := app.current_user_id(); user_email public.citext; g jsonb;
begin
  if uid is null then raise exception 'not signed in' using errcode = 'insufficient_privilege'; end if;
  select * into inv from app.workspace_invite where token_hash = p_token_hash for update;
  if not found or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at < now() then
    raise exception 'invite is invalid or expired' using errcode = 'check_violation', hint = 'invite.invalid';
  end if;
  select email into user_email from app.app_user where id = uid;
  if user_email is distinct from inv.email then
    raise exception 'invite was sent to a different email' using errcode = 'check_violation', hint = 'invite.email_mismatch';
  end if;
  perform set_config('app.workspace_id', inv.workspace_id::text, true);
  insert into app.workspace_member (workspace_id, user_id, role, invited_email)
  values (inv.workspace_id, uid, inv.role, inv.email)
  on conflict (workspace_id, user_id) do update set role = excluded.role, status = 'active';
  for g in select * from jsonb_array_elements(inv.entity_grants) loop
    insert into app.entity_grant (workspace_id, user_id, entity_id, access)
    values (inv.workspace_id, uid, (g ->> 'entityId')::uuid, g ->> 'access')
    on conflict (workspace_id, user_id, entity_id) do update set access = excluded.access;
  end loop;
  update app.workspace_invite set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.workspace_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Recurring templates (TXN-05, AI-08 later proposes them from history)
-- ---------------------------------------------------------------------------------------------
create table app.recurring_item (
  workspace_id       uuid not null references app.workspace (id) on delete cascade,
  id                 uuid not null default gen_random_uuid() primary key,
  primary_entity_id  uuid not null,
  name               text not null check (length(name) between 1 and 200),
  spec               jsonb not null,
  cadence            text not null check (cadence in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly')),
  start_date         date not null,
  end_date           date,
  next_date          date not null,
  auto_create        text not null default 'scheduled' check (auto_create in ('scheduled', 'posted')),
  status             text not null default 'active' check (status in ('active', 'paused', 'ended')),
  detected           boolean not null default false,
  version            bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, primary_entity_id) references app.entity (workspace_id, id)
);
alter table app.transaction
  add foreign key (workspace_id, recurring_item_id) references app.recurring_item (workspace_id, id);

-- ---------------------------------------------------------------------------------------------
-- Field-level encryption (NFR-01): one data key per workspace, wrapped by the KMS master key.
-- ---------------------------------------------------------------------------------------------
create table app.workspace_key (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  key_version   integer not null default 1,
  wrapped_key   bytea not null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, key_version)
);

-- Per-user account visibility preference (UP-04). Not a security boundary; RLS covers entities.
create table app.account_visibility (
  workspace_id       uuid not null,
  user_id            uuid not null,
  ledger_account_id  uuid not null,
  hidden             boolean not null default true,
  primary key (workspace_id, user_id, ledger_account_id),
  foreign key (workspace_id, user_id) references app.workspace_member (workspace_id, user_id) on delete cascade,
  foreign key (workspace_id, ledger_account_id) references app.ledger_account (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Triggers and RLS for the new tables
-- ---------------------------------------------------------------------------------------------
create trigger recurring_item_touch before update on app.recurring_item for each row execute function app.touch_versioned();
create trigger workspace_invite_touch before update on app.workspace_invite for each row execute function app.touch();
create trigger recurring_item_change after insert or update or delete on app.recurring_item
  for each row execute function app.record_change();
create trigger workspace_invite_audit after insert or update or delete on app.workspace_invite
  for each row execute function app.audit_row();
create trigger recurring_item_audit after insert or update or delete on app.recurring_item
  for each row execute function app.audit_row();

alter table app.workspace_invite enable row level security;
alter table app.workspace_invite force row level security;
alter table app.recurring_item enable row level security;
alter table app.recurring_item force row level security;
alter table app.workspace_key enable row level security;
alter table app.workspace_key force row level security;
alter table app.account_visibility enable row level security;
alter table app.account_visibility force row level security;

create policy invite_owner on app.workspace_invite for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');

create policy recurring_select on app.recurring_item for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(primary_entity_id));
create policy recurring_write on app.recurring_item for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(primary_entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(primary_entity_id));

-- Any member may read the wrapped key (useless without the KMS); creating it is part of normal writes.
create policy workspace_key_select on app.workspace_key for select
  using (workspace_id = app.current_workspace_id() and app.is_member());
create policy workspace_key_insert on app.workspace_key for insert
  with check (workspace_id = app.current_workspace_id() and app.is_member());

create policy account_visibility_own on app.account_visibility for all
  using (workspace_id = app.current_workspace_id() and user_id = app.current_user_id())
  with check (workspace_id = app.current_workspace_id() and user_id = app.current_user_id() and app.is_member());

grant select, insert, update, delete on app.workspace_invite, app.recurring_item, app.account_visibility to montra_app;
grant select, insert on app.workspace_key to montra_app;
grant execute on function app.accept_invite(text) to montra_app;
