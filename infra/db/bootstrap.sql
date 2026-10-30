-- Run once per cluster as a superuser (local dev, CI). Production roles are created by Terraform.
--   psql -v db=montra -f infra/db/bootstrap.sql
\set ON_ERROR_STOP on
select format('create role montra_owner login password %L bypassrls', 'montra_owner')
 where not exists (select from pg_roles where rolname = 'montra_owner') \gexec
select format('create role montra_app login password %L nobypassrls noinherit', 'montra_app')
 where not exists (select from pg_roles where rolname = 'montra_app') \gexec
select format('create database %I owner montra_owner', :'db')
 where not exists (select from pg_database where datname = :'db') \gexec
\connect :db
create extension if not exists citext;
create extension if not exists pg_trgm;
revoke all on schema public from public;
grant usage, create on schema public to montra_owner;
