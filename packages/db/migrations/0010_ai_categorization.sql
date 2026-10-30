-- Phase 3: AI gateway and categorization (AIA-01..12, AI-01..09, UP-02, FAM-05). See ADR-0012.

-- ---------------------------------------------------------------------------------------------
-- Categorization state on transactions (AI-03/06). `payee_key` is the normalized payee used by
-- history, rules and recurring detection; `categorization` records how the current category was
-- chosen: { step, confidence, explanation, ruleId?, suggested? }.
-- ---------------------------------------------------------------------------------------------
alter table app.transaction add column payee_key text;
alter table app.transaction add column categorization jsonb;
create index transaction_payee_key on app.transaction (workspace_id, payee_key) where payee_key is not null and deleted_at is null;

alter table app.import_row add column member_id uuid;
-- IMP-03: the AI column mapper is a mapping source of its own.
alter table app.import_batch drop constraint import_batch_mapping_source_check;
alter table app.import_batch add constraint import_batch_mapping_source_check
  check (mapping_source in ('profile', 'reference', 'heuristic', 'ai', 'user'));
alter table app.import_row add column entity_id uuid;

-- Merchant enrichment (AI-07): reference merchants carry an optional logo and website.
alter table ref.merchant add column domain text;
alter table ref.merchant add column logo_url text;

-- ---------------------------------------------------------------------------------------------
-- Rules (UP-02, 04 §6)
-- ---------------------------------------------------------------------------------------------
create table app.rule (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid,
  name          text not null check (length(name) between 1 and 200),
  scope         text not null default 'transaction' check (scope in ('transaction', 'receipt_line')),
  priority      integer not null default 100,
  conditions    jsonb not null,
  actions       jsonb not null,
  origin        text not null default 'user' check (origin in ('user', 'ai_suggested', 'correction')),
  enabled       boolean not null default true,
  hit_count     integer not null default 0,
  last_hit_at   timestamptz,
  created_by    uuid references app.app_user (id),
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);
create index rule_order on app.rule (workspace_id, priority, created_at) where enabled;

-- ---------------------------------------------------------------------------------------------
-- Learning (AI-05, AIA-06): payee history and corrections. Explainable, editable, deletable.
-- category_id implies the entity (categories are per-entity ledger accounts).
-- ---------------------------------------------------------------------------------------------
create table app.payee_history (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  payee_key     text not null,
  amount_band   smallint not null,
  category_id   uuid not null,
  member_id     uuid,
  count         integer not null default 1 check (count >= 0),
  last_used_at  timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, category_id) references app.ledger_account (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id) on delete cascade
);
create unique index payee_history_key on app.payee_history
  (workspace_id, payee_key, amount_band, category_id, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table app.correction (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  id              uuid not null default gen_random_uuid(),
  transaction_id  uuid not null,
  payee_key       text not null,
  field           text not null check (field in ('category', 'member', 'entity')),
  from_value      uuid,
  to_value        uuid,
  from_step       text,
  created_by      uuid references app.app_user (id),
  created_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete cascade
);
create index correction_payee on app.correction (workspace_id, payee_key, field, to_value);

create table app.rule_suggestion (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  id              uuid not null default gen_random_uuid(),
  payee_key       text not null,
  name            text not null,
  conditions      jsonb not null,
  actions         jsonb not null,
  evidence        integer not null,
  status          text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  rule_id         uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, id)
);
create unique index rule_suggestion_open on app.rule_suggestion (workspace_id, payee_key, (actions::text)) where status <> 'accepted';

-- ---------------------------------------------------------------------------------------------
-- AI gateway (06 §5, §8): cache, audit log, usage counter, BYOK credentials, local-mode tasks
-- ---------------------------------------------------------------------------------------------
create table app.ai_cache (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  task            text not null,
  key_hash        text not null,
  output          jsonb not null,
  model           text not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  primary key (workspace_id, task, key_hash)
);

create table app.ai_event (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  id              uuid not null default gen_random_uuid(),
  task            text not null,
  provider        text not null,
  model           text not null,
  prompt_version  text not null,
  input_hash      text not null,
  outcome         text not null check (outcome in ('ok', 'cached', 'off', 'budget', 'invalid_output', 'provider_error', 'refused')),
  output          jsonb,
  confidence      numeric(4, 3),
  items           integer not null default 1,
  latency_ms      integer,
  tokens_in       integer,
  tokens_out      integer,
  cost_micro_usd  bigint not null default 0,
  user_action     text check (user_action in ('pending', 'accepted', 'edited', 'rejected')),
  subject_type    text,
  subject_id      uuid,
  created_at      timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index ai_event_recent on app.ai_event (workspace_id, created_at desc, id desc);

-- Spend is counted separately so deleting audit entries (AIA-10) never resets the budget (AIA-08).
create table app.ai_usage (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  month           date not null,
  calls           integer not null default 0,
  cost_micro_usd  bigint not null default 0,
  primary key (workspace_id, month)
);

create table app.ai_credential (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  provider      text not null check (provider in ('anthropic', 'openai_compatible')),
  key_enc       bytea not null,
  last4         text not null,
  created_by    uuid references app.app_user (id),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, provider)
);

-- Local mode on the hosted service: work parked for a client on the user's network (06 §2).
create table app.ai_task (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  task          text not null,
  input         jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'expired')),
  subject_type  text not null,
  subject_id    uuid not null,
  claimed_at    timestamptz,
  result        jsonb,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days',
  primary key (workspace_id, id)
);
create index ai_task_pending on app.ai_task (workspace_id, created_at) where status in ('pending', 'claimed');

-- ---------------------------------------------------------------------------------------------
-- Insights (AI-08, AI-09): recurring proposals and anomaly flags
-- ---------------------------------------------------------------------------------------------
create table app.insight (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  id              uuid not null default gen_random_uuid(),
  kind            text not null check (kind in ('recurring', 'unusual_amount', 'duplicate_charge', 'new_subscription', 'price_increase')),
  entity_id       uuid not null,
  transaction_id  uuid,
  payee_key       text,
  dedupe_key      text not null,
  data            jsonb not null,
  status          text not null default 'open' check (status in ('open', 'dismissed', 'accepted')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, dedupe_key),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete cascade
);
create index insight_open on app.insight (workspace_id, created_at desc) where status = 'open';

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants
-- ---------------------------------------------------------------------------------------------
create trigger rule_touch before update on app.rule for each row execute function app.touch_versioned();
create trigger rule_suggestion_touch before update on app.rule_suggestion for each row execute function app.touch();
create trigger insight_touch before update on app.insight for each row execute function app.touch();
create trigger rule_change after insert or update or delete on app.rule for each row execute function app.record_change();
create trigger insight_change after insert or update or delete on app.insight for each row execute function app.record_change();
create trigger rule_audit after insert or update or delete on app.rule for each row execute function app.audit_row();

do $$
declare t text;
begin
  foreach t in array array['rule', 'payee_history', 'correction', 'rule_suggestion', 'ai_cache', 'ai_event', 'ai_usage',
                           'ai_credential', 'ai_task', 'insight'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
end $$;

-- Rules apply across the workspace's entities; editing them is for members who can categorize.
create policy rule_select on app.rule for select
  using (workspace_id = app.current_workspace_id() and app.is_member() and (entity_id is null or app.can_read_entity(entity_id)));
create policy rule_write on app.rule for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner', 'accountant')
         and (entity_id is null or app.can_write_entity(entity_id)))
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner', 'accountant')
         and (entity_id is null or app.can_write_entity(entity_id)));

-- History follows the category's entity so a partner never learns from (or sees) a business they can't read.
create policy payee_history_all on app.payee_history for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account a where a.workspace_id = payee_history.workspace_id
                     and a.id = payee_history.category_id and app.can_read_entity(a.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account a where a.workspace_id = payee_history.workspace_id
                     and a.id = payee_history.category_id and app.can_write_entity(a.entity_id)));

create policy correction_all on app.correction for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = correction.workspace_id and t.id = correction.transaction_id))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = correction.workspace_id and t.id = correction.transaction_id));

create policy rule_suggestion_all on app.rule_suggestion for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner', 'accountant'))
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner', 'accountant'));

create policy ai_cache_all on app.ai_cache for all
  using (workspace_id = app.current_workspace_id() and app.is_member())
  with check (workspace_id = app.current_workspace_id() and app.is_member());

-- Any member may read and delete the audit log; writes come from the gateway in the member's context.
create policy ai_event_all on app.ai_event for all
  using (workspace_id = app.current_workspace_id() and app.is_member())
  with check (workspace_id = app.current_workspace_id() and app.is_member());

create policy ai_usage_all on app.ai_usage for all
  using (workspace_id = app.current_workspace_id() and app.is_member())
  with check (workspace_id = app.current_workspace_id() and app.is_member());

-- The key itself is only ever decrypted server-side; only owners manage it.
create policy ai_credential_select on app.ai_credential for select
  using (workspace_id = app.current_workspace_id() and app.is_member());
create policy ai_credential_write on app.ai_credential for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');

create policy ai_task_all on app.ai_task for all
  using (workspace_id = app.current_workspace_id() and app.is_member())
  with check (workspace_id = app.current_workspace_id() and app.is_member());

create policy insight_select on app.insight for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy insight_write on app.insight for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

grant select, insert, update, delete on app.rule, app.payee_history, app.correction, app.rule_suggestion, app.ai_cache,
  app.ai_event, app.ai_usage, app.ai_credential, app.ai_task, app.insight to montra_app;
