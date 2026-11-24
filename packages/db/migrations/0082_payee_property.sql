-- AI-02: the rental property and unit a payee's lines belong to, learned from what the person accepts or chooses. A
-- contractor who always works at 12 Elm St is suggested for 12 Elm St next time. Beside `payee_history`, which holds
-- categories: a line's property doesn't depend on its amount band, and a property's units are optional.
--
-- Each row counts how often the payee's lines went to that property (and unit, or none). When the person changes a
-- property they chose before, the old one loses its count, as payee history does.

create table app.payee_property (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  payee_key     text not null,
  property_id   uuid not null,
  unit_id       uuid,
  count         integer not null default 1 check (count >= 0),
  last_used_at  timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, property_id) references app.property (workspace_id, id) on delete cascade,
  foreign key (workspace_id, unit_id) references app.unit (workspace_id, id) on delete cascade
);
create unique index payee_property_key on app.payee_property
  (workspace_id, payee_key, property_id, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table app.payee_property enable row level security;
alter table app.payee_property force row level security;

-- It follows the property's books: no one learns from, or sees, books they can't read.
create policy payee_property_all on app.payee_property for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.property p where p.workspace_id = payee_property.workspace_id
                     and p.id = payee_property.property_id and app.can_read_entity(p.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.property p where p.workspace_id = payee_property.workspace_id
                     and p.id = payee_property.property_id and app.can_write_entity(p.entity_id)));

grant select, insert, update, delete on app.payee_property to montra_app;
