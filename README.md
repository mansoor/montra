# Montra

AI-assisted money tracking for personal finance, small business and rental properties. Every money
movement is a balanced double-entry journal entry. AI suggests and explains, and code does the math.

- Requirements: [`docs/requirements/R1-requirements.md`](docs/requirements/R1-requirements.md)
- Design (start here): [`docs/design/README.md`](docs/design/README.md)
- Phased plan: [`docs/design/01-phased-plan.md`](docs/design/01-phased-plan.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## Repository layout

| Path               | What                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `packages/domain`  | Pure TypeScript domain: money (bigint minor units), currencies, dates, allocation, ledger posting builder  |
| `packages/db`      | SQL-first migrations (ledger invariants, RLS), Kysely types, migration runner, chart-of-accounts templates |
| `packages/schemas` | Zod API contract shared by the API and clients                                                             |
| `apps/api`         | NestJS (Fastify) API                                                                                       |
| `infra/`           | Database bootstrap, local docker compose                                                                   |
| `docs/`            | Requirements, design documents, ADRs, traceability                                                         |

## Getting started

Prerequisites: Node 22.12+, pnpm 10, and PostgreSQL 16 (local or via docker compose).

```bash
pnpm install

# Dependencies: Postgres (+ Redis, MinIO, Mailpit for later phases)
docker compose -f infra/docker-compose.yml up -d
#   …or with a local Postgres, as a superuser:
#   for db in montra montra_test montra_test_api; do psql -v db=$db -f infra/db/bootstrap.sql; done

pnpm db:migrate                 # apply migrations to the dev database
pnpm --filter @montra/api dev   # API on http://localhost:4000

# Everything CI's verify job runs (format, build, typecheck, lint, tests, traceability)
pnpm verify
# Browser end-to-end tests (needs a migrated dev database)
pnpm --filter @montra/web test:e2e
```

In development, the API accepts `Authorization: Bearer dev:<email>` (production uses Ory Kratos, Phase 1):

```bash
curl -X POST localhost:4000/v1/workspaces -H 'authorization: Bearer dev:me@example.com' \
  -H 'content-type: application/json' -d '{"name":"Home","baseCurrency":"USD","template":"hybrid"}'
```

## Branching model

| Branch                  | Purpose                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `main`                  | Released versions only. Every commit on `main` is a tagged release (`vX.Y.Z`).              |
| `develop`               | Integration branch for development releases (`v0.N.0-dev.M` tags at the end of each phase). |
| `feature/*`, `claude/*` | Short-lived feature branches, merged into `develop` through a pull request with green CI.   |
| `release/*`, `hotfix/*` | Release stabilisation and urgent fixes; merged into `main` **and** `develop`.               |

Details: [`docs/design/09-quality-delivery.md`](docs/design/09-quality-delivery.md).
