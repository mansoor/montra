# Montra — Design Documentation (R1)

Montra's technical design for Release 1. The source requirements are in
[`../requirements/R1-requirements.md`](../requirements/R1-requirements.md). This
design refers to them by ID (e.g. `DE-01`, `IMP-07`).

| # | Document | What it covers |
| --- | --- | --- |
| 01 | [Phased delivery plan](01-phased-plan.md) | Phases, scope per phase, exit criteria, release and branching process |
| 02 | [System architecture](02-architecture.md) | Context, containers, modules, tech stack, deployment, cross-cutting concerns |
| 03 | [Data model](03-data-model.md) | Tables, keys, constraints, ledger schema, RLS, sync change feed |
| 04 | [Domain logic](04-domain-logic.md) | Posting rules, FX, import, dedupe, categorization, receipts, budgets, forecasts, matching |
| 05 | [API design](05-api-design.md) | REST conventions, resources, async jobs, uploads, real-time sync |
| 06 | [AI gateway](06-ai-gateway.md) | Provider modes, task functions, routing, minimization, caching, evaluation |
| 07 | [Security, privacy and operations](07-security-privacy-ops.md) | Auth, RBAC, encryption, audit, backup/restore, observability, admin |
| 08 | [Web and mobile clients](08-clients.md) | App structure, navigation, offline, camera, accessibility, i18n |
| 09 | [Quality and delivery](09-quality-delivery.md) | Test strategy, CI/CD, environments, release mechanics |
| 10 | [Assumptions and open questions](10-assumptions.md) | Working answers to the open questions in requirements §14.3 |
| — | [Requirements traceability](traceability.md) | Every requirement ID mapped to a phase (generated) |
| — | [Architecture decision records](adr/) | One file per significant decision |

## Design principles

1. **The ledger is the source of truth.** Every money movement is a balanced
   double-entry journal entry, and the database rejects unbalanced entries. Reports,
   budgets and dashboards are read models over postings.
2. **Integer money, plain dates.** Amounts are `bigint` minor units with an ISO 4217
   currency. Transaction dates are calendar dates without a time zone. No floating point
   anywhere money is computed.
3. **Deterministic core, AI at the edges.** Code does every calculation. AI suggests,
   extracts and explains. Its output is schema-validated, carries a confidence score and
   can always be overridden. With AI off, the product still works.
4. **Expected vs actual.** Rent charges, invoices, bills, payslips and recurring items are
   *expected*. Imported or entered transactions are *actual*. One matching engine links
   them, and it will accept bank feeds unchanged in R2.
5. **Modular monolith first.** One API deployable plus one worker deployable, both with
   strict module boundaries. Services are split out only when scale or isolation needs it.
6. **Shared TypeScript domain.** Web, mobile, API and workers import the same money,
   ledger and validation code, so a number is computed the same way everywhere.
7. **Privacy by construction.** Tenant isolation through Postgres row-level security,
   field-level encryption for sensitive values, minimized AI prompts, and a full export
   at any time.
