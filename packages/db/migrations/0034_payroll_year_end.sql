-- Payroll, stage 4: year-end forms (PRL-17..20; ADR-0034 §7b). W-2s, W-3, 1099-NECs and 1096 are worked out from the
-- year's approved paychecks and paid bills, like the stage 3 worksheets, so nothing about them is stored. What the forms
-- and SSA's EFW2 file need that Montra didn't have: the employer's address in parts (the business profile keeps it as
-- free text), and who at the business SSA should contact about the wage file.

alter table app.payroll_settings
  add column filing_line1   text check (length(filing_line1) <= 100),
  add column filing_line2   text check (length(filing_line2) <= 100),
  add column filing_city    text check (length(filing_city) <= 60),
  add column filing_state   text check (filing_state ~ '^[A-Z]{2}$'),
  add column filing_zip     text check (filing_zip ~ '^[0-9]{5}([0-9]{4})?$'),
  -- The SSA Business Services Online user ID that uploads the EFW2 file: 8 letters or digits.
  add column ssa_user_id    text check (ssa_user_id ~ '^[A-Za-z0-9]{8}$'),
  add column contact_name   text check (length(contact_name) <= 100),
  add column contact_phone  text check (length(contact_phone) <= 30),
  add column contact_email  text check (length(contact_email) <= 320);
