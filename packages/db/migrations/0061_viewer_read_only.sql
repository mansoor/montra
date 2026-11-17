-- A viewer is read-only, always (ADR-0053 Q2, docs/design/07 §2).
--
-- A grant used to win over the role, so a viewer given `write` on a book could write to it, while the web and the phone
-- hid every write from them. The API now refuses such grants and turns write into read when someone becomes a viewer;
-- this is the backstop: whatever a viewer's grant says, they get at most read. 0059 and 0060 are kept for tax forms.

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
  if role = 'viewer' and access = 'write' then access := 'read'; end if;
  perform set_config(k, tag || access, true);
  return access;
end $$;

-- Existing write grants of viewers, and those waiting in open invites to viewers, become read.
update app.entity_grant g set access = 'read'
 where g.access = 'write'
   and exists (select 1 from app.workspace_member m
                where m.workspace_id = g.workspace_id and m.user_id = g.user_id and m.role = 'viewer');

update app.workspace_invite i
   set entity_grants = (select coalesce(jsonb_agg(case when e ->> 'access' = 'write'
                                                       then jsonb_set(e, '{access}', '"read"') else e end
                                                  order by n), '[]'::jsonb)
                          from jsonb_array_elements(i.entity_grants) with ordinality as x (e, n))
 where i.role = 'viewer' and i.accepted_at is null and i.revoked_at is null
   and i.entity_grants @> '[{"access": "write"}]';
