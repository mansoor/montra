# 02 — System Architecture

## 1. Context

```
                    ┌───────────────────────────────────────────────────────────┐
  Household user ──▶│                                                           │──▶ AI providers (built-in hosted,
  Partner ─────────▶│                         Montra                            │    BYO key, or local Ollama/LM Studio)
  Accountant ──────▶│  web app · iOS/Android app · API · workers · ledger DB    │──▶ OCR/document AI (Textract or local)
  Staff (admin) ───▶│                                                           │──▶ FX rates (ECB, Open Exchange Rates)
                    └───────────────────────────────────────────────────────────┘──▶ Email (SES/Postmark), push (Expo/APNs/FCM)
                                   ▲                                              ──▶ Billing (Stripe, App Store, Play)
                                   │ R2+: bank aggregators (Plaid, MX, GoCardless…)  ──▶ User cloud drives (backups, BAK-05)
```

R1 brings data in only through user files and manual entry. R2 bank feeds plug into the
same import pipeline as one more `source` (see §14.1 of the requirements).

## 2. Containers

```
┌──────────────┐   ┌──────────────┐
│ Web (Next.js)│   │ Mobile (Expo)│   both use packages/api-client + packages/domain
└──────┬───────┘   └──────┬───────┘
       │ HTTPS REST + WSS │
┌──────▼──────────────────▼─────────────────────────────────────────────┐
│ API (NestJS on Fastify) — modular monolith                             │
│  identity · workspace · ledger · accounts · transactions · import ·    │
│  categorize · receipts · budget · flow · business · rental · members · │
│  payroll · reports · search · notify · sync · files · admin            │
└──┬─────────────┬──────────────┬───────────────┬───────────────────────┘
   │ SQL (RLS)   │ enqueue      │ presign       │ pub/sub
┌──▼─────────┐ ┌─▼──────────┐ ┌─▼────────────┐ ┌▼──────┐
│ PostgreSQL │ │ Redis      │ │ Object store │ │ Redis │
│ 16 (ledger)│ │ (BullMQ)   │ │ (S3/R2/MinIO)│ │ pubsub│
└──▲─────────┘ └─┬──────────┘ └─▲────────────┘ └───────┘
   │             │ consume       │
┌──┴─────────────▼───────────────┴───────────────┐   ┌──────────────────────────┐
│ Worker (Node, same codebase, worker entrypoint) │──▶│ Doc worker (Python)      │
│ import parse · AI categorize · OCR · reports ·  │   │ pdfplumber table extract │
│ recurring · reminders · backups · FX sync       │   │ PaddleOCR/Tesseract local│
└─────────────────────────────────────────────────┘   └──────────────────────────┘
```

| Container | Tech | Responsibility | Scales by |
| --- | --- | --- | --- |
| Web | Next.js (App Router) + React + TS, Tailwind + shadcn/ui, TanStack Query, ECharts | Setup, import, bulk review, reports; server-rendered dashboard shell | CDN + stateless pods |
| Mobile | React Native (Expo, dev client), expo-sqlite, VisionCamera | Capture, review, budget check, offline | n/a |
| API | Node 22, NestJS 11 with Fastify adapter, Zod, OpenAPI 3.1 | Synchronous request handling, auth, RBAC, writes to ledger | Horizontal (stateless) |
| Worker | Node 22, BullMQ | Every slow or retryable task (imports, AI, OCR, reports, schedules) | Per-queue concurrency, horizontal |
| Doc worker | Python 3.12, pdfplumber, optional PaddleOCR | PDF table extraction, local OCR | Horizontal; separate queue |
| PostgreSQL | 16+, `pg_trgm`, `citext`, `pgcrypto` | Ledger, all relational state, full-text search | Vertical + read replica for reports |
| Redis | 7 (optional) | Rate limits and caches when needed; queues and fan-out run on Postgres (ADR-0008, ADR-0011) | Managed (ElastiCache) |
| Object storage | S3 (prod), MinIO (dev/self-host) | Receipts, statements, payslips, exports, backups | Managed |
| Identity | Ory Kratos (self-hosted or Ory Network) | Sign-up, password, passkeys, TOTP, recovery, social login | Managed / horizontal |

### Why a modular monolith

A small team gets the most from one deployable API with strict internal module boundaries:
cross-module calls go through each module's public service interface, never into another
module's tables. ESLint `no-restricted-imports` rules and a dependency-cruiser check in CI
enforce this. A module that later needs isolation (for example AI, or a bank-feed
connector in R2) can move into its own service without a rewrite, because it already
talks through an interface and a queue. See [ADR-0002](adr/0002-modular-monolith.md).

## 3. Monorepo layout

```
montra/
├─ apps/
│  ├─ api/            NestJS API (HTTP + WebSocket gateway)
│  ├─ worker/         BullMQ workers (imports, AI, OCR, schedules)   ← Phase 2
│  ├─ web/            Next.js web app                                ← Phase 1
│  ├─ mobile/         Expo app                                       ← Phase 4
│  └─ doc-worker/     Python PDF/OCR worker                          ← Phase 2
├─ packages/
│  ├─ domain/         Pure TS: money, currency, dates, ledger, allocation, rules,
│  │                  dedupe, budget math, forecasts. No I/O. Heavily property-tested.
│  ├─ db/             SQL migrations, Kysely types, migration runner, seed data
│  ├─ schemas/        Zod schemas = API contract (requests, responses, events)
│  ├─ api-client/     Typed fetch client built on schemas (web + mobile)
│  ├─ ai-gateway/     Task-level AI functions + provider adapters        ← Phase 3
│  ├─ importers/      CSV/XLS(X) parsing, column detection, profiles      ← Phase 2
│  ├─ reference-data/ Tax line maps, currency table, MCC, merchant aliases, mileage rates
│  ├─ ui/             Shared design tokens (+ web components)
│  └─ config/         Shared tsconfig / eslint / vitest presets
├─ infra/             Terraform (AWS), docker-compose for local + self-host
├─ docs/              Requirements, design, ADRs, runbooks
└─ .github/workflows  CI/CD
```

Tooling: pnpm workspaces, Turborepo task graph and remote cache, TypeScript 5.9 strict
mode with `noUncheckedIndexedAccess`, ESLint and Prettier, Vitest, fast-check for property
tests, Playwright for web end-to-end tests, Maestro for mobile end-to-end tests. See
[ADR-0001](adr/0001-typescript-monorepo.md).

## 4. API module map

Each module owns its tables and exposes one service interface. Dependencies only point
downward in this list.

| Layer | Modules | Notes |
| --- | --- | --- |
| Platform | `config`, `db`, `auth`, `audit`, `files`, `queue`, `sync`, `notify`, `ai` | Infrastructure-facing. `db` provides the RLS-scoped unit of work. |
| Core | `workspace` (workspaces, members, roles, entities, settings), `ledger` (ledger accounts, journal entries, postings, locks, reconciliation), `fx`, `reference` | `ledger` is the only module that writes `journal_entries`/`postings`. |
| Capture | `accounts`, `transactions`, `import`, `receipts`, `payees`, `rules`, `categorize`, `recurring` | Build transactions, then ask `ledger` to post them. |
| Planning | `budget`, `goals`, `flow` (dashboard, Sankey, forecast), `recommend` | Read models plus budget writes. |
| Books | `members` (family), `payroll` (employers, payslips), `business` (customers, vendors, invoices, bills, mileage), `rental` (properties, units, tenants, leases, rent roll, deposits, maintenance) | Expected items. They post through `ledger` and match through `matching`. |
| Insight | `matching`, `reports`, `search`, `export`, `backup` | `matching` links expected items to actual transactions. |
| Ops | `admin`, `support-access`, `billing`, `flags` | Staff surface. Has no access to financial tables without a support grant. |

## 5. Request lifecycle

1. The client sends `Authorization: Bearer <session token>` (web uses an HttpOnly cookie
   through the Next.js backend-for-frontend; mobile uses a token held in the Keychain or
   Keystore).
2. `AuthGuard` validates the session with Kratos and caches the result in Redis for 60 s,
   then resolves the `user`. Revoking a session (sign-out, remote sign-out, password
   reset) deletes the cache entry right away, so AUTH-05/07 take effect immediately.
3. `WorkspaceGuard` reads `:workspaceId` from the route, loads the membership and role,
   and checks entity-level access when the route targets an entity.
4. `UnitOfWork` opens a database transaction and runs
   `SET LOCAL app.workspace_id = …, app.user_id = …`. Every query in the request runs
   inside it, so RLS applies even if a query forgets a `workspace_id` filter.
5. The handler validates input with Zod, calls domain services, writes audit rows and
   change-feed rows in the same transaction, and commits.
6. At commit, Postgres delivers a `montra_changes` notification (sent by the change-feed
   trigger). Every API instance listens and pushes it to subscribed WebSocket clients, which
   invalidate their caches or pull `/sync/changes` (target: under 5 s end to end, PLT-06;
   ADR-0008).

Writes accept an `Idempotency-Key` header, stored for 24 h, so mobile retries never double
post. Updates use optimistic concurrency: `If-Match: <version>`.

## 6. Asynchronous work

Jobs run on a Postgres queue (`app.job`, ADR-0011); the table below lists the queues.

| Queue | Producer → consumer | Examples | Retry |
| --- | --- | --- | --- |
| `import` | API → worker | parse file, detect columns, dedupe, stage rows | 3× exponential, then marked `failed` with reason |
| `doc` | worker → doc-worker | PDF table extraction, local OCR | 3× |
| `ai` | worker/API → worker | categorize batch, extract receipt or payslip, summarize month | provider failover, then review queue (OPS-07) |
| `schedule` | cron (BullMQ repeatable) | recurring instances, rent charges, reminders, FX sync, digests | idempotent by `(item, date)` |
| `report` | API → worker | PDF/XLSX export, tax package ZIP, full backup | 2× |
| `notify` | any → worker | push, email, in-app; quiet hours and caps applied here | 5× |

Jobs carry `workspaceId` and run in the same RLS-scoped unit of work as API requests.
Long jobs report progress in a `jobs` table. The client polls `GET /jobs/{id}` or receives
`job.updated` over WebSocket.

## 7. Cross-cutting concerns

| Concern | Approach |
| --- | --- |
| Tenancy | Shared schema with `workspace_id` on every row and Postgres RLS (`FORCE ROW LEVEL SECURITY`). The app connects as a role without `BYPASSRLS`. Migrations run as the owner role. |
| Authorization | Role per workspace (`owner`, `partner`, `viewer`, `accountant`) plus per-entity grants (`none`, `read`, `write`) and per-account visibility (UP-04). Checked by guards and the policy service; tenant isolation is enforced by RLS. |
| Money | `packages/domain` `Money` type (bigint minor units + currency). JSON carries amounts as decimal strings of minor units (`"amount":"12345","currency":"USD"`). See [ADR-0004](adr/0004-money-representation.md). |
| Dates | `CalendarDate` (`YYYY-MM-DD`) for business dates, `timestamptz` (UTC) for system times. Period boundaries are computed in the workspace time zone (TZ-01/02). |
| i18n | ICU message format with all strings externalized (`packages/i18n` in Phase 1). Money and dates formatted with `Intl` for the user's locale, with an override (CUR-10, PLT-11). |
| Audit | Append-only `audit_log` rows written in the same transaction: actor, action, entity, before/after diff (sensitive fields redacted). |
| Observability | OpenTelemetry traces and metrics (HTTP, SQL, queue, AI calls), pino JSON logs with correlation ids, Sentry for errors. Dashboards for import failures by bank format and AI accuracy (NFR-13). |
| Config and flags | Zod-validated environment config. Feature flags through Unleash (or a DB-backed flags table in dev) for plan gating and staged rollouts. |
| Reference data | Versioned JSON in `packages/reference-data`, loaded into `ref.*` tables by migration and updatable at runtime from the admin console (OPS-05). |

## 8. Deployment (production)

| Concern | Choice |
| --- | --- |
| Compute | AWS ECS Fargate: `api` (≥ 2 tasks, multi-AZ), `worker` (autoscaled on queue depth), `doc-worker`. Web on Vercel or as a Fargate service behind CloudFront. |
| Database | Aurora PostgreSQL 16 (Multi-AZ), PITR 35 days, a reporting read replica, and snapshots copied to a second region and a separate backup account with S3 Object Lock (BAK-01/02). |
| Cache/queue | ElastiCache Redis (Multi-AZ). |
| Files | S3 with SSE-KMS, versioning, cross-region replication, a 30-day noncurrent-version lifecycle (BAK-03), and presigned PUT/GET only. |
| Edge | Cloudflare (DNS, WAF, rate limiting, CDN) in front of an ALB. |
| Secrets | AWS Secrets Manager + KMS. Per-environment KMS keys for field encryption (envelope encryption). |
| IaC | Terraform modules under `infra/terraform` with one state per environment. |
| Deploys | Blue/green ECS deployments, expand/contract migrations, minimum mobile version enforced (OPS-03/04). |
| Environments | `local` (docker compose), `dev` (auto-deploys `develop`), `staging` (release candidates), `prod` (tags on `main`). |

A **self-hosted edition** (later) reuses the same images with docker compose: api,
worker, doc-worker, Postgres, MinIO, Kratos and optional Ollama.

## 9. Scalability targets (NFR-07, NFR-12)

- 100k users × 50k transactions at the high end ≈ 5×10⁸ postings worst case; realistic
  median ≈ 3k transactions per user. Postings carry a denormalized `entry_date` and
  `entity_id` and are indexed on `(workspace_id, ledger_account_id, entry_date)` and
  `(workspace_id, entity_id, entry_date)`. Hash partitioning by `workspace_id` is planned once
  postings pass about 200M rows; the schema already allows it, because every key includes
  `workspace_id`.
- The dashboard reads from `account_balance_daily` and `category_activity_monthly`
  summary tables. Workers maintain them incrementally from the change feed, so
  dashboard p95 stays under 2 s at 50k transactions.
- Import parsing is streaming (Papa Parse for CSV, exceljs for XLSX, xlrd and pdfplumber in the Python doc worker). 5k rows parse in
  under 10 s before AI.
- AI categorization is batched (up to 100 rows per call), runs in parallel across
  calls, and skips rows already answered by rules, history or cache, so a 1,000-row
  import finishes in under 60 s (AI-11).
