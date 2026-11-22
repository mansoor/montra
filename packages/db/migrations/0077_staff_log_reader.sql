-- The staff log on screen (OPS-01). `montra_admin` already reads `app.admin_log`, but not `app.app_user`, so the
-- console can't say who each entry was. This returns the people who appear in the log, and only them, for admins
-- and owners. Support staff can't call it.

create function app.admin_log_staff(p_staff uuid)
  returns table (user_id uuid, email text, display_name text)
  language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_staff_role(p_staff, 'admin');
  return query
    select u.id, u.email::text, u.display_name
      from (select distinct l.staff_id from app.admin_log l) s
      join app.app_user u on u.id = s.staff_id
     order by u.email;
end $$;
revoke all on function app.admin_log_staff(uuid) from public;
grant execute on function app.admin_log_staff(uuid) to montra_admin;
