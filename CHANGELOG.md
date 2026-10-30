# Changelog

## v0.4.0-dev.1 — Phase 3: AI gateway and categorization (on feature branch)

- **`@montra/ai-gateway`** (ADR-0007, ADR-0012):
  - Task functions: categorize, map columns, normalize payees, natural-language quick add, statement table
    extraction and category proposals.
  - Adapters: Anthropic (structured outputs, effort, prompt caching, refusal handling), OpenAI-compatible
    (Ollama, LM Studio, vLLM), Null, and a deterministic Fake provider for tests.
  - Per-task routing, a minimizer (masking and pseudonyms), a per-item cache, calibration, a monthly budget
    with downgrade, and provider failover.
  - Evaluation harness and benchmark v1 (5,280 labelled transactions).
- **`@montra/categorize`:** rules engine (RE2-safe regex), amount bands, payee history, transfer detection,
  the six-step pipeline, rule proposals from corrections, recurring detection, anomaly flags and a
  heuristic quick-add parser.
- **API:**
  - The pipeline runs on every import row and manual entry. Confident results are auto-applied; the rest
    go to the review queue with their suggestion and a one-line explanation.
  - Learning from your choices: payee history, corrections, and a rule offered after two identical
    corrections, which can be applied to existing transactions.
  - Endpoints: rules with live preview and apply-to-existing, review queue (accept, accept all ≥ X%,
    resolve), editor suggestions, quick add, category proposals from an import, insights (recurring,
    unusual amounts, duplicate charges, new subscriptions, price increases).
  - AI settings: built-in, your own key (stored encrypted, never returned), local endpoint or off, with a
    privacy disclosure per mode, threshold, budget and usage. The AI audit log can be viewed and deleted.
  - AI column mapping when the heuristics aren't sure, and scanned PDFs read from OCR text.
- **Doc worker:** Tesseract OCR for scanned PDF statements, with account numbers, names, addresses,
  emails and phone numbers redacted before anything leaves the worker.
- **Web:** AI settings and activity log, rules, keyboard-first review queue, natural-language quick add,
  insights, and suggested categories in the import wizard.

## v0.3.0-dev.1 — Phase 2: statement import and reconciliation (on feature branch)

- **`@montra/importers`:**
  - Reading files: encoding sniffing, CSV/TSV/XLSX grids, header and column inference with
    running-balance verification, and sign and date-format detection (statement periods settle
    ambiguous dates).
  - Formats: app templates (YNAB, Mint, Monarch, Quicken, Stessa), saved profiles by fingerprint, and a
    golden corpus of 21 real layouts.
  - Cleaning and dedupe: payee normalization with 87 reference merchants, and conservative dedupe and
    matching.
- **Python doc worker:** XLS (`xlrd`) and digital PDF statements (`pdfplumber`) with opening and closing
  balances and the statement period.
- **Postgres job queue** (ADR-0011) and a Node worker that shares the API code.
- **Import API:**
  - upload, parse, preview, mapping, row decisions (single and bulk), atomic commit, and 30-day undo
    with partial-undo reporting;
  - storage on the local filesystem or S3;
  - reconciliation that locks the entries it covers.
- **Web:** upload wizard, mapping editor with a live preview, preview grid, summary and undo, import
  history, and the reconciliation checklist.
- **Performance:**
  - migrations 0008 and 0009: one balance check per entry, a change-feed counter updated once per
    transaction, and cached RLS helpers;
  - a per-transaction ledger cache.

  Import commits are 5× faster.

- **Sync:** `/sync/changes` pages end on transaction boundaries.

## v0.2.0-dev.1 — Phase 1: core ledger and manual capture (released to develop 2026-10-30)

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

- Next.js app with a backend-for-frontend:
  - **Sign-in:** dev mode, plus Ory Kratos browser flows covering sign-in with AAL2 step-up and re-auth, sign-up, recovery, verification and security settings (TOTP, passkeys, recovery codes, devices). Kratos responses are rendered through a hardened text-only node renderer.
  - **Accounts:** onboarding, home, accounts with their register, and a journal list.
  - **Transactions:** quick add, the split editor, transfers, the detail and edit view with journal entries, bulk edit, a needs-review filter, and trash with restore.
  - **Upcoming and recurring:** upcoming bills with confirmation, and recurring templates.
  - **Settings:** profile, entities with period close, family members, accounts, and sharing with invite links. Manual journals.
  - **Live updates:** over WebSocket, with a polling fallback.
  - **Translation:** every string comes from `@montra/i18n`, and dates and money follow the user's locale and format.
- Typed `@montra/api-client`.
- Playwright end-to-end tests run in CI:
  - onboarding and quick add;
  - edit, bulk review, recurring and invites;
  - trash;
  - live updates between two browsers.

### Security and email

- Invite emails; new-device sign-in alerts (AUTH-08).
- Email change confirmed from both addresses (AUTH-11).
- Lost-second-factor reset with a 72-hour hold and alerts (AUTH-06).

## v0.1.0-dev.1 — Phase 0: foundations (released to develop 2026-10-30)

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
