-- Phase 5: receipts and multi-currency (TXN-08/09, IMP-11, RCP-01..12, ACC-04, CUR-03..09, TZ-03, UP-09).
-- See ADR-0010 (FX accounting) and ADR-0014 (receipt pipeline and FX rates service); design 03 §6, 04 §2.2 and §7.

-- ---------------------------------------------------------------------------------------------
-- Reference data (OPS-05): currencies and daily FX rates. Rates are stored as published by the source
-- (ECB quotes everything against EUR); the rates service derives cross rates. Written only by the rates
-- loader job through app.upsert_fx_rates.
-- ---------------------------------------------------------------------------------------------
create table ref.currency (
  code         char(3) primary key check (code ~ '^[A-Z]{3}$'),
  minor_units  smallint not null check (minor_units between 0 and 4),
  name         text not null,
  symbol       text,
  version      integer not null default 1,
  updated_at   timestamptz not null default now()
);

create table ref.fx_rate (
  rate_date   date not null,
  base        char(3) not null check (base ~ '^[A-Z]{3}$'),
  quote       char(3) not null check (quote ~ '^[A-Z]{3}$'),
  rate        numeric(20, 10) not null check (rate > 0),   -- 1 base = rate quote
  source      text not null check (source in ('ecb', 'oxr')),
  fetched_at  timestamptz not null default now(),
  primary key (rate_date, base, quote, source),
  check (base <> quote)
);
create index fx_rate_pair on ref.fx_rate (base, quote, rate_date desc);

grant select on ref.currency, ref.fx_rate to montra_app;

-- rows: [{ "date": "2026-10-30", "base": "EUR", "quote": "USD", "rate": "1.0912" }, ...]
create function app.upsert_fx_rates(p_source text, p_rows jsonb) returns integer
  language plpgsql security definer set search_path = app, pg_temp as $$
declare n integer;
begin
  if p_source not in ('ecb', 'oxr') then raise exception 'unknown fx source %', p_source; end if;
  insert into ref.fx_rate (rate_date, base, quote, rate, source)
  select (r ->> 'date')::date, upper(r ->> 'base'), upper(r ->> 'quote'), (r ->> 'rate')::numeric, p_source
    from jsonb_array_elements(p_rows) r
  on conflict (rate_date, base, quote, source) do update set rate = excluded.rate, fetched_at = now()
    where ref.fx_rate.rate is distinct from excluded.rate;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function app.upsert_fx_rates(text, jsonb) to montra_app;

-- ---------------------------------------------------------------------------------------------
-- Trips (CUR-09): transactions in the window are tagged with the trip; AI expects the trip currency.
-- ---------------------------------------------------------------------------------------------
create table app.trip (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  name          text not null check (length(name) between 1 and 200),
  start_date    date not null,
  end_date      date not null,
  currency      char(3) not null check (currency ~ '^[A-Z]{3}$'),
  time_zone     text,                                   -- IANA zone for receipt local times (TZ-03)
  created_by    uuid references app.app_user (id),
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (workspace_id, id),
  check (end_date >= start_date)
);
create index trip_window on app.trip (workspace_id, start_date, end_date) where deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- Transaction and posting additions
--   trip_id         CUR-09
--   local_time      TZ-03: the receipt's wall-clock time; txn_date stays the statement date
--   fx_rate_source  CUR-05: where transaction.fx_rate came from
-- ---------------------------------------------------------------------------------------------
alter table app.transaction add column trip_id uuid;
alter table app.transaction add column local_time time;
alter table app.transaction add column fx_rate_source text check (fx_rate_source in ('implied', 'reference', 'user'));
alter table app.transaction add constraint transaction_trip_fk
  foreign key (workspace_id, trip_id) references app.trip (workspace_id, id);
alter table app.transaction add constraint transaction_fx_pair
  check ((original_amount_minor is null) = (original_currency is null));
create index transaction_trip on app.transaction (workspace_id, trip_id) where trip_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Attachment retention (RCP-10): receipt images and extracted data are kept 7 years by default.
-- ---------------------------------------------------------------------------------------------
alter table app.file add column retain_until date;
alter table app.file add column page_count integer check (page_count is null or page_count > 0);
create index file_retention on app.file (retain_until) where retain_until is not null and deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- Receipts (03 §6, 04 §7). attachment_ids is ordered: multi-shot pages and PDF invoices keep page order.
-- entity_id is the receipt's primary entity (RLS and the change feed); lines may go to other entities
-- (RCP-07). Amounts are minor units in the receipt currency. validation_gap_minor is
-- total − (Σ line_total − Σ line discounts − order discount + tax + fees + tip) (RCP-05).
-- ---------------------------------------------------------------------------------------------
create table app.receipt (
  workspace_id          uuid not null references app.workspace (id) on delete cascade,
  id                    uuid not null default gen_random_uuid(),
  entity_id             uuid not null,
  source                text not null default 'upload' check (source in ('camera', 'upload', 'order_import')),
  attachment_ids        uuid[] not null default '{}',
  status                text not null default 'processing'
                          check (status in ('processing', 'inbox', 'matched', 'needs_review', 'rejected')),
  merchant              text,
  merchant_raw          text,
  payee_id              uuid,
  receipt_date          date,
  local_time            time,
  currency              char(3) check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor        bigint,
  tax_minor             bigint not null default 0,
  discount_minor        bigint not null default 0 check (discount_minor >= 0),   -- order-level
  fees_minor            bigint not null default 0,
  tip_minor             bigint not null default 0 check (tip_minor >= 0),
  total_minor           bigint,
  card_last4            text check (card_last4 ~ '^[0-9]{4}$'),
  validation_gap_minor  bigint,
  extraction            jsonb,            -- { provider, model, confidence, warnings[], mode: builtin|byok|local }
  transaction_id        uuid,
  match_score           numeric(4, 3) check (match_score between 0 and 1),
  match_candidates      jsonb,            -- [{ transactionId, score, reasons[] }] below the auto-link threshold
  fx_rate               numeric(20, 10),  -- actual rate (home per receipt unit) once matched across currencies (CUR-04)
  trip_id               uuid,
  order_ref             text,             -- online orders (RCP-12)
  ocr_text              text,
  search                tsvector generated always as
                          (to_tsvector('simple', coalesce(merchant, '') || ' ' || coalesce(ocr_text, ''))) stored,
  retain_until          date not null default (current_date + interval '7 years')::date,
  created_by            uuid references app.app_user (id),
  version               bigint not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id),
  foreign key (workspace_id, payee_id) references app.payee (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete set null (transaction_id),
  foreign key (workspace_id, trip_id) references app.trip (workspace_id, id),
  check (status <> 'matched' or transaction_id is not null)
);
create index receipt_status on app.receipt (workspace_id, status, receipt_date desc) where deleted_at is null;
create index receipt_transaction on app.receipt (workspace_id, transaction_id) where transaction_id is not null;
create unique index receipt_order_ref on app.receipt (workspace_id, order_ref) where order_ref is not null and deleted_at is null;
create index receipt_search on app.receipt using gin (search);
create index receipt_merchant_trgm on app.receipt using gin (merchant gin_trgm_ops);

create table app.receipt_line (
  workspace_id      uuid not null,
  id                uuid not null default gen_random_uuid(),
  receipt_id        uuid not null,
  line_no           integer not null check (line_no > 0),
  raw_text          text not null,
  expanded_name     text,
  qty               numeric(12, 3),
  unit_price_minor  bigint,
  line_total_minor  bigint not null,                     -- negative for returns (RCP-08)
  discount_minor    bigint not null default 0 check (discount_minor >= 0),
  taxable           boolean not null default true,
  is_return         boolean not null default false,
  category_id       uuid,
  entity_id         uuid,
  member_id         uuid,                                -- null = Household (FAM-05)
  confidence        numeric(4, 3) check (confidence between 0 and 1),
  categorization    jsonb,                               -- { step, ruleId?, explanation } (AI-06)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, receipt_id, line_no),
  foreign key (workspace_id, receipt_id) references app.receipt (workspace_id, id) on delete cascade,
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id),
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id),
  check (is_return = (line_total_minor < 0))
);
create index receipt_line_category on app.receipt_line (workspace_id, category_id) where category_id is not null;

alter table app.posting add column receipt_line_id uuid;
alter table app.posting add constraint posting_receipt_line_fk
  foreign key (workspace_id, receipt_line_id) references app.receipt_line (workspace_id, id) on delete set null (receipt_line_id);
create index posting_receipt_line on app.posting (workspace_id, receipt_line_id) where receipt_line_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants
-- ---------------------------------------------------------------------------------------------
create trigger trip_touch before update on app.trip for each row execute function app.touch_versioned();
create trigger receipt_touch before update on app.receipt for each row execute function app.touch_versioned();
create trigger receipt_line_touch before update on app.receipt_line for each row execute function app.touch();
create trigger trip_change after insert or update or delete on app.trip for each row execute function app.record_change();
create trigger receipt_change after insert or update or delete on app.receipt for each row execute function app.record_change();
create trigger trip_audit after insert or update or delete on app.trip for each row execute function app.audit_row();
create trigger receipt_audit after insert or update or delete on app.receipt for each row execute function app.audit_row();

do $$
declare t text;
begin
  foreach t in array array['trip', 'receipt', 'receipt_line'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
end $$;

create policy trip_select on app.trip for select
  using (workspace_id = app.current_workspace_id() and app.is_member());
create policy trip_write on app.trip for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner'))
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner'));

create policy receipt_select on app.receipt for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy receipt_write on app.receipt for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

-- Lines follow their receipt; a line sent to another entity also needs access to that entity.
create policy receipt_line_select on app.receipt_line for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.receipt r where r.workspace_id = receipt_line.workspace_id and r.id = receipt_line.receipt_id)
         and (entity_id is null or app.can_read_entity(entity_id)));
create policy receipt_line_write on app.receipt_line for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.receipt r where r.workspace_id = receipt_line.workspace_id and r.id = receipt_line.receipt_id
                     and app.can_write_entity(r.entity_id))
         and (entity_id is null or app.can_write_entity(entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.receipt r where r.workspace_id = receipt_line.workspace_id and r.id = receipt_line.receipt_id
                     and app.can_write_entity(r.entity_id))
         and (entity_id is null or app.can_write_entity(entity_id)));

grant select, insert, update, delete on app.trip, app.receipt, app.receipt_line to montra_app;
