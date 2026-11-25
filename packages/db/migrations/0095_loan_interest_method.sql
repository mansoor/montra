-- How a loan charges interest, and its grace period and late fee (ADR-0024 §13, §14; RNT-08, DE-04).
--
-- interest_method:
--   'monthly': the balance times the rate over 12 each payment, as mortgages do. Every loan tracked before this is monthly.
--   'daily':   simple interest for each day from the previous payment (or the start date, `start_date`) to the day the
--              payment is made, actual/365, as auto and personal loans do. A daily loan needs a start date; the API
--              refuses one without.
--
-- grace_days, late_fee_minor, late_fee_bps: a payment made more than grace_days after its due date is late, and the
-- lender may charge a fee: a fixed amount, a percent of the scheduled payment, or the greater of the two when both are
-- set. Null fee columns: no fee of that kind. A bank line is matched to a payment up to max(5, grace_days) days after it
-- was due.
--
-- app.loan_payment already keeps each payment's parts (0023); the lender's own split, when entered, is stored there
-- too. late_fee_minor is the fee paid with it, posted to the books' Bank fees account.
--
-- Additive: old API tasks never write these columns, and the defaults keep what they create monthly, with no grace
-- and no fee.

alter table app.loan_schedule
  add column interest_method text not null default 'monthly'
    check (interest_method in ('monthly', 'daily')),
  add column grace_days      integer not null default 0 check (grace_days between 0 and 60),
  add column late_fee_minor  bigint check (late_fee_minor >= 0),
  add column late_fee_bps    integer check (late_fee_bps between 0 and 10000);

alter table app.loan_payment
  add column late_fee_minor bigint check (late_fee_minor >= 0);

comment on column app.loan_schedule.interest_method is
  'monthly: balance × rate ÷ 12 per payment. daily: balance × rate × days ÷ 365 since the previous payment or start_date.';
comment on column app.loan_schedule.grace_days is
  'Days after the due date before a payment is late; also widens bank-line matching to max(5, grace_days) days after.';
comment on column app.loan_schedule.late_fee_minor is 'A fixed late fee; with late_fee_bps, the greater of the two.';
comment on column app.loan_schedule.late_fee_bps is
  'A late fee as a percent of the scheduled payment, in basis points; with late_fee_minor, the greater of the two.';
comment on column app.loan_payment.late_fee_minor is 'The late fee paid with this payment, if any.';
