-- Roles and family logins (AUTH-14..17; ADR-0041).
--
-- Two new roles join owner, partner, viewer and accountant:
--   admin   does everything the owner does, except change or remove the owner, hand over ownership or restore a
--           backup over the workspace. The owner is still the one account that created (or was handed) the
--           workspace; app.is_admin() is true for both.
--   member  for children and staff: adds and edits transactions, receipts and trips in the books granted to them
--           (their personal books by default). The API keeps them out of setup (WorkspaceGuard); here they get
--           only the table rights that work needs.
-- An invite can name the family member it is for, and accepting it links that person to the new login, so the
-- Family list and Sharing show one person, and their own payslips become visible to them (PAY-09).

-- ---------------------------------------------------------------------------------------------
-- The role lists.
-- ---------------------------------------------------------------------------------------------
alter table app.workspace_member
  drop constraint workspace_member_role_check,
  add constraint workspace_member_role_check
    check (role in ('owner', 'admin', 'partner', 'member', 'viewer', 'accountant'));

alter table app.workspace_invite
  drop constraint workspace_invite_role_check,
  add constraint workspace_invite_role_check
    check (role in ('admin', 'partner', 'member', 'viewer', 'accountant'));

create function app.is_admin() returns boolean
  language sql stable as $$ select app.current_member_role() in ('owner', 'admin') $$;
revoke all on function app.is_admin() from public;
grant execute on function app.is_admin() to montra_app, montra_support;

-- ---------------------------------------------------------------------------------------------
-- Owner-only rights become admin rights.
-- ---------------------------------------------------------------------------------------------
alter policy ai_credential_write on app.ai_credential
  using (workspace_id = app.current_workspace_id() and app.is_admin())
  with check (workspace_id = app.current_workspace_id() and app.is_admin());
alter policy audit_log_select on app.audit_log
  using (workspace_id = app.current_workspace_id() and app.is_admin());
alter policy entity_write on app.entity
  using (workspace_id = app.current_workspace_id() and app.is_admin())
  with check (workspace_id = app.current_workspace_id() and app.is_admin());
alter policy grant_all on app.entity_grant
  using (workspace_id = app.current_workspace_id() and (app.is_admin() or user_id = app.current_user_id()))
  with check (workspace_id = app.current_workspace_id() and app.is_admin());
alter policy storage_destination_owner on app.storage_destination
  using (workspace_id = app.current_workspace_id() and app.is_admin())
  with check (workspace_id = app.current_workspace_id() and app.is_admin());
alter policy storage_mirror_item_owner on app.storage_mirror_item
  using (workspace_id = app.current_workspace_id() and app.is_admin())
  with check (workspace_id = app.current_workspace_id() and app.is_admin());
alter policy support_grant_owner on app.support_grant
  using (workspace_id = app.current_workspace_id() and app.is_admin())
  with check (workspace_id = app.current_workspace_id() and app.is_admin());
alter policy workspace_update on app.workspace
  using (id = app.current_workspace_id() and app.is_admin());
alter policy invite_owner on app.workspace_invite
  using (workspace_id = app.current_workspace_id() and app.is_admin())
  with check (workspace_id = app.current_workspace_id() and app.is_admin());

-- Admins manage members, but only the owner touches the owner's row or makes someone owner. Nobody deletes it.
alter policy member_insert on app.workspace_member
  with check (workspace_id = app.current_workspace_id()
              and ((app.is_admin() and role <> 'owner')
                   or (not app.workspace_has_members(workspace_id) and user_id = app.current_user_id()
                       and role = 'owner')));
alter policy member_update on app.workspace_member
  using (workspace_id = app.current_workspace_id() and app.is_admin()
         and (role <> 'owner' or app.current_member_role() = 'owner'))
  with check (workspace_id = app.current_workspace_id() and app.is_admin()
              and (role <> 'owner' or app.current_member_role() = 'owner'));
alter policy member_delete on app.workspace_member
  using (workspace_id = app.current_workspace_id() and app.is_admin() and role <> 'owner');

-- ---------------------------------------------------------------------------------------------
-- Role lists: admins everywhere partners are; members where adding transactions, receipts and trips needs it.
-- ---------------------------------------------------------------------------------------------
alter policy family_member_insert on app.family_member
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner'));
alter policy family_member_update on app.family_member
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'admin', 'partner'));
alter policy family_member_delete on app.family_member
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'admin', 'partner'));

alter policy file_all on app.file
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'accountant', 'member'));

alter policy idempotency_key_insert on app.idempotency_key
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'member'));
alter policy idempotency_key_update on app.idempotency_key
  using (workspace_id = app.current_workspace_id()
         and app.current_member_role() in ('owner', 'admin', 'partner', 'member'));
alter policy idempotency_key_delete on app.idempotency_key
  using (workspace_id = app.current_workspace_id()
         and app.current_member_role() in ('owner', 'admin', 'partner', 'member'));

alter policy import_migration_all on app.import_migration
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'accountant'));
alter policy import_profile_all on app.import_profile
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'accountant'));

alter policy payee_insert on app.payee
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'member'));
alter policy payee_update on app.payee
  using (workspace_id = app.current_workspace_id()
         and app.current_member_role() in ('owner', 'admin', 'partner', 'member'));
alter policy payee_delete on app.payee
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'admin', 'partner'));
alter policy payee_alias_all on app.payee_alias
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'admin', 'partner'));

alter policy rule_write on app.rule
  using (workspace_id = app.current_workspace_id()
         and app.current_member_role() in ('owner', 'admin', 'partner', 'accountant')
         and (entity_id is null or app.can_write_entity(entity_id)))
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'accountant')
              and (entity_id is null or app.can_write_entity(entity_id)));
alter policy rule_suggestion_all on app.rule_suggestion
  using (workspace_id = app.current_workspace_id()
         and app.current_member_role() in ('owner', 'admin', 'partner', 'accountant'))
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'accountant'));

alter policy tag_insert on app.tag
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'member'));
alter policy tag_update on app.tag
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'admin', 'partner'));
alter policy tag_delete on app.tag
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'admin', 'partner'));

alter policy trip_write on app.trip
  using (workspace_id = app.current_workspace_id()
         and app.current_member_role() in ('owner', 'admin', 'partner', 'member'))
  with check (workspace_id = app.current_workspace_id()
              and app.current_member_role() in ('owner', 'admin', 'partner', 'member'));

-- ---------------------------------------------------------------------------------------------
-- Books: admins write everything, as owners do. With no grant, members write the personal books as partners do;
-- business and rental books need a grant.
-- ---------------------------------------------------------------------------------------------
create or replace function app.entity_access(p_entity uuid) returns text
  language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  ws uuid := app.current_workspace_id(); uid uuid := app.current_user_id();
  role text := app.current_member_role();
  k text := 'app.cache_ea_' || replace(p_entity::text, '-', '');
  tag text; cached text; access text;
begin
  if role is null then return 'none'; end if;
  if role in ('owner', 'admin') then return 'write'; end if;
  tag := ws::text || '|' || uid::text || '|' || coalesce(nullif(current_setting('app.cache_gen', true), ''), '0') || '|';
  cached := current_setting(k, true);
  if cached like tag || '%' then return substr(cached, length(tag) + 1); end if;
  select g.access into access from app.entity_grant g where g.workspace_id = ws and g.user_id = uid and g.entity_id = p_entity;
  if access is null then
    select case when type = 'personal'
                then case role when 'partner' then 'write' when 'member' then 'write' when 'viewer' then 'read' else 'none' end
                else 'none' end
      into access from app.entity where id = p_entity;
  end if;
  access := coalesce(access, 'none');
  perform set_config(k, tag || access, true);
  return access;
end $$;

-- PAY-09: restricted (payslip) entries are visible to owners and admins, and to the login linked to the person.
create or replace function app.can_read_restricted(p_member uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select app.is_admin()
      or exists (select 1 from app.family_member
                  where workspace_id = app.current_workspace_id() and id = p_member
                    and linked_user_id = app.current_user_id())
$$;

-- ---------------------------------------------------------------------------------------------
-- AUTH-16: a login belongs to at most one person in a workspace, and only owners and admins choose which.
-- Accepting an invite (security definer, so not montra_app) links the person the invite was for.
-- ---------------------------------------------------------------------------------------------
update app.family_member f set linked_user_id = null
 where linked_user_id is not null
   and exists (select 1 from app.family_member o
                where o.workspace_id = f.workspace_id and o.linked_user_id = f.linked_user_id
                  and (o.created_at, o.id) < (f.created_at, f.id));
create unique index family_member_one_login on app.family_member (workspace_id, linked_user_id)
  where linked_user_id is not null;

create function app.guard_family_login() returns trigger
  language plpgsql set search_path = app, pg_temp as $$
begin
  if new.linked_user_id is distinct from (case when tg_op = 'UPDATE' then old.linked_user_id end)
     and current_user = 'montra_app' and not app.is_admin() then
    raise exception 'only an owner or admin can link a login to a family member'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function app.guard_family_login() from public;
create trigger family_member_login_guard before insert or update of linked_user_id on app.family_member
  for each row execute function app.guard_family_login();

alter table app.workspace_invite add column family_member_id uuid;
alter table app.workspace_invite
  add constraint workspace_invite_family_member_fkey foreign key (workspace_id, family_member_id)
    references app.family_member (workspace_id, id) on delete set null (family_member_id);

create or replace function app.accept_invite(p_token_hash text) returns uuid
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
  -- The owner keeps their role whatever an invite says.
  insert into app.workspace_member (workspace_id, user_id, role, invited_email)
  values (inv.workspace_id, uid, inv.role, inv.email)
  on conflict (workspace_id, user_id) do update
    set role = case when app.workspace_member.role = 'owner' then 'owner' else excluded.role end, status = 'active';
  for g in select * from jsonb_array_elements(inv.entity_grants) loop
    insert into app.entity_grant (workspace_id, user_id, entity_id, access)
    values (inv.workspace_id, uid, (g ->> 'entityId')::uuid, g ->> 'access')
    on conflict (workspace_id, user_id, entity_id) do update set access = excluded.access;
  end loop;
  if inv.family_member_id is not null then
    update app.family_member set linked_user_id = null
     where workspace_id = inv.workspace_id and linked_user_id = uid and id <> inv.family_member_id;
    update app.family_member set linked_user_id = uid
     where workspace_id = inv.workspace_id and id = inv.family_member_id;
  end if;
  update app.workspace_invite set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.workspace_id;
end $$;
