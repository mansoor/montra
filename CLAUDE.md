# CLAUDE.md — working on Montra

Montra is a money-tracking app: personal finance, optional rental properties and small business. It is a
TypeScript monorepo (pnpm + Turborepo) with a NestJS API, a Next.js web app, an Expo mobile app, a Python
document worker, and shared packages.

**Start every session by reading [`docs/STATUS.md`](docs/STATUS.md).** It says what is done, what is left,
the known workarounds and what to pick up next. Then read the design docs for the area you touch.

## Where things are

| Path                                                      | What                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `docs/requirements/R1-requirements.md`                    | The product requirements (IDs such as `IMP-05` and `RCP-04`)                                             |
| `docs/design/01-phased-plan.md`                           | The 12-phase plan: scope, deliverables and exit criteria per phase                                       |
| `docs/design/02`–`11`                                     | Architecture, data model, domain logic, API, AI gateway, security, clients, quality, assumptions, review |
| `docs/design/adr/`                                        | Decisions (ADR-0001…0014). Add one for every significant decision (copy `0000-template.md`)              |
| `docs/design/status.json`                                 | Implementation status per requirement ID (`done` / `partial`). `traceability.md` is generated from it    |
| `CHANGELOG.md`                                            | One entry per phase (`v0.N.0-dev.1`)                                                                     |
| `apps/api`                                                | NestJS 11 on Fastify, Kysely, Postgres RLS. Also the Node job worker (`src/worker-main.ts`)              |
| `apps/web`                                                | Next.js 15 App Router. Playwright e2e specs in `e2e/`                                                    |
| `apps/mobile`                                             | Expo SDK 58, expo-router, encrypted SQLite offline store                                                 |
| `apps/doc-worker`                                         | Python: XLS and PDF statement extraction, Tesseract OCR for scans                                        |
| `packages/domain`                                         | Money (bigint minor units), currency, dates, rounding, allocation, ledger builders                       |
| `packages/db`                                             | SQL migrations (`migrations/NNNN_*.sql`), Kysely types, RLS context, reference data                      |
| `packages/schemas`                                        | Zod DTOs: the API contract shared by every client                                                        |
| `packages/importers`                                      | CSV/XLSX parsing, column inference, dedupe, payee normalization                                          |
| `packages/ai-gateway`                                     | AI task functions, provider adapters, minimizer, cache, budget, eval harness                             |
| `packages/categorize`                                     | Rules engine, categorization pipeline, learning, recurring and anomaly detection                         |
| `packages/sync`                                           | Offline sync engine for clients (ADR-0013)                                                               |
| `packages/api-client`, `packages/i18n`, `packages/config` | Typed client, messages and formatters, shared lint/ts config                                             |

## Commands

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d   # Postgres (+ Redis, MinIO, Mailpit; Kratos with --profile auth)
pnpm db:migrate                                    # apply migrations to the dev database + load reference data
pnpm verify                                        # what CI runs: format, build, typecheck, lint, tests, perf budget, traceability
pnpm verify:py                                     # doc-worker lint, typecheck and tests (needs Python 3.12; Tesseract for OCR tests)
pnpm --filter @montra/web test:e2e                 # Playwright (needs a migrated dev DB; builds are run by verify)
pnpm --filter @montra/api dev | dev:worker         # API on :4000 | job worker
pnpm --filter @montra/web dev                      # web on :3000 (dev sign-in: any email)
pnpm --filter @montra/mobile start                 # Expo dev server
```

- API tests create their own database (`montra_test_api`) in a global setup, so they need Postgres running.
- `AI_PROVIDER=fake` gives deterministic keyword-based AI. Tests and e2e use it. Set `ANTHROPIC_API_KEY`
  for the real provider.

## How we work

1. **Branching:**
   - `main` holds released versions only.
   - `develop` is the integration branch.
   - Work happens on a feature branch off `develop` (`feature/<topic>` or `claude/<topic>`), and goes back
     into `develop` through a PR with green CI.
   - Never commit to `main` or `develop` directly.
   - At the end of each phase the owner tags `v0.N.0-dev.1` on `develop`.
2. **Contracts first.** For each phase or feature, pin these before the implementation:
   - the migration (`packages/db/migrations`),
   - the Kysely types (`packages/db/src/types.ts`),
   - the DTOs (`packages/schemas`),
   - any package interface (`types.ts`),
   - an ADR when a decision is involved.

   Then implement, in parallel where it helps.

3. **Run `pnpm verify` before every push**, plus `pnpm verify:py` when you touch `apps/doc-worker`. CI runs
   the same checks, plus e2e and the mobile bundle builds.
4. **Update the docs with the code.** That means `docs/design/status.json` (then run
   `node scripts/gen-traceability.mjs`), `CHANGELOG.md` at the end of a phase, the relevant design doc or
   ADR, and `docs/STATUS.md`.
5. **Commits:** imperative subject lines. Each commit is a coherent step that builds and passes its tests.
6. **Never skip, disable or weaken a test to get green.** Fix the cause. A performance budget that is noisy
   under parallel load runs on its own (`test:perf`), not with a raised limit.

## Rules the code depends on

- **Money:**
  - Money is `bigint` minor units everywhere.
  - Never use floats or `Math.round` for money. Lint bans `Math.round`; use `@montra/domain` rounding,
    `allocate` or `toFixed` for non-money values.
  - Dates are `CalendarDate` strings (`YYYY-MM-DD`), never JS `Date`, for transaction dates.
- **Ledger:**
  - The ledger is double-entry: debits are positive, and one journal entry per entity per transaction
    (ADR-0005).
  - A deferred trigger rejects unbalanced entries.
  - Locked and reconciled entries are changed only through the DE-10 rules in `transactions/poster.ts`.
- **RLS:**
  - Every query runs inside `db.run(ctx, trx => …)`, which sets the RLS context.
  - New tables need `enable` and `force row level security`, policies, and grants to `montra_app`
    (copy the pattern in the latest migration).
  - `SECURITY DEFINER` functions must use qualified names (`public.citext`, `app.*`) and
    `set search_path`.
- **Migrations** are append-only once merged to `develop`. Never edit a merged migration; add a new one.
- **New workspace packages** must be added to `vitest.shared.ts` `sourceAliases`, or Vitest won't resolve
  them to TS sources, and to the consumer's `package.json`.
- **When a DTO changes**, update the web test fixtures (`apps/web/lib/*.test.ts`) and the mobile types in the
  same change.
- **AI calls go through `@montra/ai-gateway` task functions**, never directly to a provider SDK.
  - Inputs are minimized.
  - Failures return `ok: false` and the feature degrades.
- **The mobile app keeps no ledger logic.** It shows the server's `TransactionDto` projection and writes
  through the `@montra/sync` outbox.
