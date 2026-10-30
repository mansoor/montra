-- 0004_session_devices: sign-in sessions seen per user, for new-device alerts and the device list (AUTH-07, AUTH-08).

create table app.session_device (
  user_id            uuid not null references app.app_user (id) on delete cascade,
  kratos_session_id  text not null,
  user_agent         text,
  ip_address         inet,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  primary key (user_id, kratos_session_id)
);

alter table app.session_device enable row level security;
alter table app.session_device force row level security;
create policy session_device_own on app.session_device for all
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

grant select, insert, update, delete on app.session_device to montra_app;
