-- Interest rates to a ten-thousandth of a percent (ADR-0024 "Rate precision"; ACC-02, RNT-08, BUD-08).
--
-- Rates were whole basis points (0.01%), so a mortgage at 5.625% (an eighth) or an ARM at 6.4375% (a sixteenth) couldn't be
-- stored. Each interest-rate column gets a finer one next to it, in parts per million of the yearly rate:
--   1 ppm = 0.0001%, so 5.625% = 56250, 7.56% = 75600, 6.4375% = 64375.
--
-- Expand only (OPS-03). The bps columns stay, and new code keeps writing them, rounded half up to the nearest basis point,
-- so an older API task or an older phone build still reads a sensible rate. New code reads the ppm column, and bps × 100
-- where it's null.
--
-- An older API task writes only the bps column. The triggers below keep ppm in step: a row inserted without ppm takes
-- bps × 100, and an update that changes bps without touching ppm sets ppm to the new bps × 100. An update that writes ppm
-- (new code always writes both) keeps what it wrote.
--
-- Contract step, later, once no running API task or supported phone build reads or writes the bps columns: drop the
-- triggers and functions, then app.loan_schedule.rate_bps and app.bank_account.interest_rate_bps (each with
-- `-- contract:`), and make app.loan_schedule.rate_ppm not null. Tracked in docs/STATUS.md §7g.

alter table app.loan_schedule
  add column rate_ppm integer check (rate_ppm between 0 and 500000);

alter table app.bank_account
  add column interest_rate_ppm integer check (interest_rate_ppm between 0 and 1000000);

update app.loan_schedule set rate_ppm = rate_bps * 100 where rate_ppm is null;
update app.bank_account set interest_rate_ppm = interest_rate_bps * 100
  where interest_rate_ppm is null and interest_rate_bps is not null;

comment on column app.loan_schedule.rate_ppm is
  'The yearly rate in parts per million (1 = 0.0001%; 5.625% = 56250). Read this; rate_bps is kept, rounded, for older code.';
comment on column app.bank_account.interest_rate_ppm is
  'The yearly rate in parts per million (1 = 0.0001%). Read this; interest_rate_bps is kept, rounded, for older code.';

create function app.loan_schedule_rate_ppm() returns trigger
  language plpgsql set search_path = app, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.rate_ppm is null then
      new.rate_ppm := new.rate_bps * 100;
    end if;
  elsif new.rate_bps is distinct from old.rate_bps and new.rate_ppm is not distinct from old.rate_ppm then
    new.rate_ppm := new.rate_bps * 100;
  end if;
  return new;
end;
$$;

revoke all on function app.loan_schedule_rate_ppm() from public;

create trigger loan_schedule_rate_ppm before insert or update on app.loan_schedule
  for each row execute function app.loan_schedule_rate_ppm();

create function app.bank_account_rate_ppm() returns trigger
  language plpgsql set search_path = app, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.interest_rate_ppm is null then
      new.interest_rate_ppm := new.interest_rate_bps * 100;
    end if;
  elsif new.interest_rate_bps is distinct from old.interest_rate_bps
    and new.interest_rate_ppm is not distinct from old.interest_rate_ppm then
    new.interest_rate_ppm := new.interest_rate_bps * 100;
  end if;
  return new;
end;
$$;

revoke all on function app.bank_account_rate_ppm() from public;

create trigger bank_account_rate_ppm before insert or update on app.bank_account
  for each row execute function app.bank_account_rate_ppm();
