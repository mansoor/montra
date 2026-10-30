# Changelog

## v0.2.0-dev.1 — Phase 1: core ledger and manual capture (in progress)

### API

- Transactions keep their input spec. Edits re-run the posting builder and follow the
  DE-10 lock rules:
  - unprotected entries are rewritten in place;
  - reconciled entries in an open period get a reclassification adjustment on the original date;
  - entries in a closed period are reversed into the first open period.
- Void to trash and restore; bulk edit, including the one-tap entity move; `If-Match`/ETag
  concurrency.
- Recurring templates with scheduled occurrences, confirmation and auto-posting (TXN-05).
- Manual journals, period lock and unlock with history, audited entry unlock, audit log view.
- Entities, family members with default members per account, profile settings, and account
  update, archive and hide, plus audited balance adjustments.
- Sharing: invites with roles and per-entity grants, accepted through a reviewed definer
  function; member role changes and grants.
- Field-level AES-256-GCM encryption of memos with KMS-wrapped per-workspace keys (NFR-01).
- Ory Kratos adapter:
  - session token or cookie;
  - verified email required for writes;
  - AAL2 for owners and accountants;
  - 10-minute re-auth window for sensitive actions;
  - device list and remote sign-out;
  - webhook eviction after recovery.

  Kratos config and a docker compose `auth` profile are included.

- Real-time push over WebSocket using Postgres LISTEN/NOTIFY, plus the `/sync/changes` pull
  feed (PLT-06).
- `@montra/i18n`: message catalogs with plurals and time-zone-safe date formatting
  (TZ-06, PLT-11).

### Web

- Next.js app shell (dev sign-in BFF):
  - onboarding, home, accounts and the register;
  - transactions with quick add, the split editor and transfers.
- Typed `@montra/api-client`.

## v0.1.0-dev.1 — Phase 0: foundations (unreleased, on feature branch)

### Design

- R1 phased delivery plan (12 phases), detailed design (architecture, data model, domain logic, API,
  AI gateway, security/ops, clients, quality), ADR-0001…0010, assumptions for the open questions.
- Independent design review: 23 findings, all resolved (`docs/design/11-design-review.md`).
- Requirements traceability: all 252 requirement IDs mapped to phases; CI fails if any **M** item is unscheduled.

### Code

- Monorepo: pnpm + Turborepo, strict TypeScript, ESLint (bans `Math.round` for money), Prettier, Vitest, CI.
- `@montra/domain`: bigint `Money`, ISO 4217 exponents, exact decimal parsing (locale separators,
  accounting negatives), rounding modes, allocation (RCP-04 receipt tax rule; Hamilton), calendar dates
  without time zones, and the posting builder (expenses, income, splits, cross-entity splits through
  owner equity or due-to/due-from, transfers incl. FX cost, opening balances, reversals). Property tests.
- `@montra/db`: migration `0001_core` with a deferred balance trigger, period/reconciliation lock guards,
  change feed, audit trigger and entity-aware row-level security (tenant isolation, per-entity grants,
  restricted payslip entries). Integration tests on PostgreSQL 16.
- `@montra/api`: NestJS on Fastify with an RLS unit of work, dev auth adapter behind `AuthPort`,
  problem+json errors, idempotency keys, and endpoints for workspaces (onboarding templates with
  Schedule C/E charts), accounts with opening balances, categories, transactions, transfers and the
  account register.
