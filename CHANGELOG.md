# Changelog

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
