-- A workspace's own security rules (AUTH-04, AUTH-07, ADR-0044), set by its owner or admins.
--
-- - mfa_policy 'standard': two-step verification is required for owners, admins, partners and accountants, and for
--   anyone who can see business books (payroll lives there). 'everyone': required for every login, viewers included.
-- - idle_timeout_minutes: the web signs out after this long without use, 5–30 minutes. Never longer than the
--   service's own 30.

alter table app.workspace
  add column mfa_policy text not null default 'standard' check (mfa_policy in ('standard', 'everyone'));
alter table app.workspace
  add column idle_timeout_minutes smallint not null default 30 check (idle_timeout_minutes between 5 and 30);
