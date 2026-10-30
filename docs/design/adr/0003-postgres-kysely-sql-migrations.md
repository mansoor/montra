# ADR-0003: PostgreSQL with SQL-first migrations and Kysely

- Status: accepted
- Date: 2026-10-30

## Context
The ledger needs database-enforced invariants (deferred constraint trigger for balance,
lock triggers), row-level security, partial indexes and full-text search. ORMs tend
to hide or fight these features.

## Decision
Plain, reviewed SQL migration files (`packages/db/migrations/NNNN_name.sql`) applied by a
small runner that records checksums. Queries use **Kysely** (typed SQL builder) with
`bigint` mapped to JS `bigint`. Raw SQL is allowed for reports.

## Consequences
Full control over DDL and RLS; types are kept in sync by `kysely-codegen` against the
migrated schema in CI. No automatic migrations from models.

## Alternatives considered
Prisma (weak RLS/trigger support, bigint ergonomics), Drizzle (good, but SQL-first is
clearer for triggers/RLS), TypeORM.
