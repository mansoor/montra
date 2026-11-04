-- Creates the production database roles. The production counterpart of bootstrap.sql, with real passwords and the two
-- extra roles the admin console and support access use. See docs/runbooks/first-time-setup.md.
-- Run once per cluster as the Aurora master user, connected to the `montra` database. Passwords come from the
-- environment, so they stay out of shell history and process lists:
--   export MONTRA_OWNER_PASSWORD=... MONTRA_APP_PASSWORD=... MONTRA_ADMIN_PASSWORD=... \
--          MONTRA_SUPPORT_PASSWORD=... MONTRA_KRATOS_PASSWORD=...
--   psql "$MASTER_URL" -f infra/db/production-roles.sql
-- Table grants for these roles come from the migrations, so run this before the first migration.
\set ON_ERROR_STOP on
\getenv owner_password MONTRA_OWNER_PASSWORD
\getenv app_password MONTRA_APP_PASSWORD
\getenv admin_password MONTRA_ADMIN_PASSWORD
\getenv support_password MONTRA_SUPPORT_PASSWORD
\getenv kratos_password MONTRA_KRATOS_PASSWORD

-- Owns the schema and runs migrations.
select format('create role montra_owner login password %L bypassrls', :'owner_password')
 where not exists (select from pg_roles where rolname = 'montra_owner') \gexec
-- The API, worker and doc worker. RLS applies to it.
select format('create role montra_app login password %L nobypassrls noinherit', :'app_password')
 where not exists (select from pg_roles where rolname = 'montra_app') \gexec
-- The admin console: no access to financial tables (OPS-01).
select format('create role montra_admin login password %L nobypassrls noinherit', :'admin_password')
 where not exists (select from pg_roles where rolname = 'montra_admin') \gexec
-- Support sessions granted by a user: read-only, RLS applies (OPS-02).
select format('create role montra_support login password %L nobypassrls noinherit', :'support_password')
 where not exists (select from pg_roles where rolname = 'montra_support') \gexec
-- Kratos, in its own database (ADR-0006).
select format('create role montra_kratos login password %L nobypassrls noinherit', :'kratos_password')
 where not exists (select from pg_roles where rolname = 'montra_kratos') \gexec

-- From PostgreSQL 16, the master user must hold a role before it can make that role an owner.
grant montra_owner to current_user;
grant montra_kratos to current_user;

alter database montra owner to montra_owner;
select 'create database kratos owner montra_kratos'
 where not exists (select from pg_database where datname = 'kratos') \gexec
alter database kratos owner to montra_kratos;

create extension if not exists citext;
create extension if not exists pg_trgm;
revoke all on schema public from public;
grant usage, create on schema public to montra_owner;
