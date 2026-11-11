# Montra: project status and hand-off

_Last updated 2026-11-09, with Phase 11 code complete (on `claude/phase11-contracts`, PR open). Launch steps remain. Keep this file current:
update it at the end of every work session and every phase._

This is the hand-off for the next session, human or Claude. It covers what is done, what is left, the
workarounds already in place (so nobody undoes them) and what to pick up next. Read it after
[`CLAUDE.md`](../CLAUDE.md).

---

## 1. Snapshot

|                        |                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integration branch** | `develop`: Phases 0–10 merged. Last merge was PR #17 at `4d5e62c`                                                                                                                                                                                                                                                                                   |
| **Release branch**     | `main`: no release yet. R1 `v1.0.0` lands at the end of Phase 11                                                                                                                                                                                                                                                                                    |
| **Tags**               | `v0.1.0-dev.1` Phase 0 · `v0.2.0-dev.1` Phase 1 · `v0.3.0-dev.1` Phase 2 · `v0.4.0-dev.1` Phase 3 · `v0.5.0-dev.1` Phase 4 · `v0.6.0-dev.1` Phase 5 · `v0.7.0-dev.1` Phase 6 · `v0.8.0-dev.1` Phase 7 · `v0.9.0-dev.1` Phase 8 · `v0.10.0-dev.1` Phase 9 · `v0.11.0-dev.1` Phase 10                                                                 |
| **Pull requests**      | #1–#4 Phases 1–4; Phase 5: #5 hand-off docs, #6 contracts and receipt arithmetic, #7 matching and FX posting, #8 rates service and foreign-currency accounts, #9 receipts API and web, #10 mobile capture and integration. All merged into `develop` with green CI. Open: #11 receipt-images setting; Phase 6 contracts and engine (stacked on #11) |
| **Requirements**       | 252 IDs in total: **182 done, 56 partial**, the rest not started. The source is `docs/design/status.json`, rendered in `docs/design/traceability.md`                                                                                                                                                                                                |
| **Next**               | Merge the Phase 11 PR, tag `v0.12.0-dev.1`, then the owner's decisions and `docs/runbooks/launch-checklist.md`. `v1.0.0` isn't ready                                                                                                                                                                                                                |

### Test suite at the end of Phase 11 (green locally)

| Suite                                                                                                                                               | Tests                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@montra/api` (integration, real Postgres)                                                                                                          | 412, plus 4 perf budgets run alone                                  |
| `@montra/categorize`                                                                                                                                | 70 (69, plus the perf budget run alone)                             |
| `@montra/web` unit                                                                                                                                  | 123                                                                 |
| `@montra/doc-worker` (pytest, real Tesseract)                                                                                                       | 77                                                                  |
| `@montra/domain`                                                                                                                                    | 194                                                                 |
| `@montra/importers` (incl. a 22-file golden corpus, receipt matching)                                                                               | 72                                                                  |
| `@montra/ai-gateway` (offline; fake and mocked providers; receipt corpus)                                                                           | 73                                                                  |
| `@montra/mobile` (pure modules; MemoryStore and SqliteStore contract tests; receipt capture, payslips, business, rentals, your data, account types) | 73                                                                  |
| `@montra/db` (ledger triggers, RLS, staff roles, read models, receipts)                                                                             | 43                                                                  |
| `@montra/sync` (against a fake server; receipt upload queue)                                                                                        | 22                                                                  |
| `@montra/api-client` · `@montra/i18n`                                                                                                               | 10 · 5                                                              |
| Playwright e2e (API + worker + web, `AI_PROVIDER=fake`)                                                                                             | 29 tests in 15 spec files                                           |
| Mobile bundles                                                                                                                                      | `expo export` for iOS and Android: about 5.2 MB Hermes bundles each |

### CI (`.github/workflows/`)

- `ci.yml`:
  - **verify**: format, then turbo build/typecheck/lint/test, then the perf budget run alone, then the
    traceability check;
  - **e2e**: Playwright;
  - **doc-worker**: Python, with Tesseract installed.
- `mobile.yml`:
  - **bundle**: typecheck, lint, test and both `expo export` builds;
  - **eas-build**: manual (`workflow_dispatch`); it skips unless the `EXPO_TOKEN` secret is set.

---

## 2. Phase status

| Phase  | Title                                          | State                              | Notes                                                                                              |
| ------ | ---------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0      | Foundations and walking skeleton               | ✅ done                            | Monorepo, CI, design docs (01–11), ADR-0001…0011, money/date domain                                |
| 1      | Core ledger and manual capture                 | ✅ done                            | Double-entry ledger, RLS, Kratos adapter, web app, recurring, sharing                              |
| 2      | Import pipeline                                | ✅ done                            | CSV/XLSX/XLS/PDF import, dedupe/matching, undo, reconciliation, Postgres job queue                 |
| 3      | AI gateway and categorization                  | ✅ done                            | Gateway, rules, six-step pipeline, review queue, learning, insights, OCR scans                     |
| 4      | Mobile foundation and offline sync             | ✅ done (device checks pending)    | Expo app, encrypted store, outbox sync with field-group LWW                                        |
| 5      | Receipts and multi-currency                    | ✅ done (device checks pending)    | Receipts end to end, FX rates and foreign-currency accounts, web and mobile capture; see §7        |
| 6      | Budgeting, money flow and recommendations      | ✅ done (device checks pending)    | Budgets, goals, flow, recommendations, read models, web restyle, mobile; see §7a                   |
| 7      | Family members and payslips                    | ✅ done (device checks pending)    | Payslip capture and posting, deposit matching, reports by member, privacy; see §7b                 |
| 8      | Small business                                 | ✅ done (device checks pending)    | Invoices, bills, mileage, Schedule C, estimated tax, accountant export; see §7c                    |
| 9      | Rental properties                              | ✅ done (device checks pending)    | Leases, rent roll, deposits, mortgages, Schedule E, depreciation, metrics; see §7d                 |
| 10     | Reports, search, notifications, data ownership | ✅ done (device checks pending)    | Report catalogue, search, ask, notifications, backup and restore, trash, account deletion; see §7e |
| **11** | **Hardening and launch**                       | 🟡 **code complete, not launched** | Terraform, observability, billing, WCAG, pen test → `v1.0.0` on `main`                             |

Scope, deliverables and exit criteria for each phase are in `docs/design/01-phased-plan.md`.

---

## 3. What exists, by phase

### Phase 0–1: ledger, auth, web (`v0.2.0-dev.1`)

- **Ledger and transactions:**
  - `packages/domain`: bigint money, ISO 4217 exponents, decimal parsing, rounding modes, `allocate`
    (largest / largest-remainder), `CalendarDate`, recurrence, and the ledger builders (transaction,
    transfer, opening balance, reversal, adjustment).
  - Migrations 0001–0005:
    - core tables and RLS helpers;
    - a deferred balance trigger;
    - period locks;
    - audit log;
    - the change log;
    - invites;
    - recurring items;
    - workspace data keys;
    - session devices;
    - account recovery.
  - `transactions/poster.ts`: the DE-10 edit rules. An edit rewrites the entry in place, posts a
    reclassification adjustment, or reverses into the first open period.
  - Field encryption: AES-256-GCM with a KMS-wrapped key per workspace (`crypto/crypto.service.ts`; a
    local KMS in dev).
- **Auth:**
  - A Kratos adapter covering whoami, AAL2 for owners and accountants, re-auth within 10 minutes, the
    device list, webhook eviction, email change confirmed by both addresses, and an MFA reset with a
    72-hour hold.
  - A dev adapter that accepts `Bearer dev:<email>`.
- **Web:** onboarding, accounts and registers, the transaction editor with splits, quick add, bulk edit,
  journals, period lock, family members, settings, and sharing with entity-level grants.

### Phase 2: import (`v0.3.0-dev.1`)

- **`packages/importers`:** the pipeline is decode → grid → `findHeaderRow` → `inferMapping` →
  `applyMapping` → `checkBalance`. It also has:
  - templates for YNAB, Mint, Monarch, Quicken and Stessa;
  - saved profiles, matched by fingerprint;
  - payee normalization against 87 reference merchants;
  - `payeeDisplayName`, which names payment and transfer lines from their raw text ("Payment to Card ••4321");
  - `classifyRows` for dedupe and matching.
- **Database:** migrations 0006–0009 add files, the **Postgres job queue** (ADR-0011: SKIP LOCKED with
  NOTIFY), import batches and rows, transaction sources, reconciliation, and reference profiles and
  merchants. They also carry the performance work: one balance check per entry, cached RLS helpers and
  one change-log sequence number per transaction.
- **Python doc-worker** (`apps/doc-worker`): reads XLS (`xlrd`) and digital PDFs (`pdfplumber`). It is
  chained to the Node parse job through `then_job`.
- **API and web:** upload, parse, preview, mapping editor, single and bulk row decisions, atomic commit,
  30-day undo, and reconciliation that locks the lines it covers.

### Phase 3: AI and categorization (`v0.4.0-dev.1`)

- **`packages/ai-gateway`** (ADR-0007, ADR-0012):
  - Tasks: categorize, map columns, normalize payees, quick add, statement table extraction, category
    proposals, and ping.
  - Adapters:
    - Anthropic, through the SDK: structured outputs, effort, prompt caching and refusal handling.
      Models are `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5` by task group.
    - OpenAI-compatible, for Ollama, LM Studio and vLLM.
    - Null.
    - Fake.
  - Also: the minimizer, a per-item cache, calibration, a budget with downgrade, and failover.
  - Eval harness and benchmark v1 (5,280 rows) in `eval/`.
- **`packages/categorize`:**
  - the rules engine (`re2js`);
  - amount bands, payee history and transfer detection;
  - the pipeline;
  - rule proposals after two identical corrections;
  - recurring and anomaly detection;
  - a heuristic quick-add parser.
- **API (migration 0010):**
  - the pipeline on every import row and manual entry;
  - the review queue;
  - rules with preview and apply-to-existing (job `rules.apply`);
  - AI settings with disclosures and an encrypted bring-your-own key;
  - the AI audit log (`ai_event`), with spend kept separately in `ai_usage`;
  - category proposals and insights (job `insights.detect`);
  - quick add (`POST /transactions/parse`);
  - the AI column mapper fallback;
  - scanned PDFs: OCR text, then `extract_statement_table`.
- **Doc-worker:** Tesseract OCR with redaction.
- **Web:** AI settings and the activity log, rules, a keyboard-first review queue, natural-language quick
  add, insights, and suggested categories in the import wizard.

### Phase 4: mobile and offline (`v0.5.0-dev.1`)

- **API (migration 0011, ADR-0013):**
  - `GET /sync/pull` returns resolved DTOs: a bootstrap, then incremental pages.
  - `POST /sync/push` is an idempotent outbox. Every op is recorded in `sync_op`, and creates use the
    client-generated id.
  - Field-group last-write-wins through `transaction.field_clock`, maintained by a trigger.
  - Push-device registration.
- **`packages/sync`:** `SyncEngine`, `MemoryStore`, `FetchTransport` and the projection.
- **`apps/mobile`:**
  - **Sign-in:** dev mode and Kratos native login with TOTP.
  - **Security:** biometric app lock with a timeout and an app-switcher blur. The SQLCipher store is
    keyed from the Keychain/Keystore and wiped on sign-out.
  - **Screens:** home, transactions with swipe actions, a 3-tap quick add, a swipe review stack,
    accounts, import (picker, share sheet, camera pages turned into a PDF), sync activity and settings.
  - **Other:** push registration and the camera spike harness (`app/developer/camera.tsx`, protocol in
    `docs/design/spikes/phase4-camera.md`).
  - **Tooling:** EAS profiles and Maestro flows (`apps/mobile/.maestro/`).

---

## 4. Partial requirements and what is left

`status.json` holds the authoritative note for each ID. The partial ones, grouped by when they should be
finished:

- **Needs a real device or a live service (no code expected, verification only):**
  - PLT-02, PLT-04, PLT-07, IMP-02, BAK-10: mobile behaviour on iOS and Android devices, plus the
    Maestro flows.
  - AUTH-01, NFR-02: run against a live Kratos (`docker compose --profile auth`).
  - AIA-09, AI-11: **measured on 2026-11-03** with `claude-haiku-5-5` on the 1,056-row test split. Accuracy
    was 86.7% (target ≥ 85%), macro-F1 0.873, 26.4 s for the whole split, and $0.04. Calibration is off
    (ECE 0.111): refit the Anthropic curve on the train split. Rerun with:
    ```bash
    pnpm --filter @montra/ai-gateway eval -- --provider anthropic --split test
    ```
    The `--` is now handled; before that fix, the options were silently ignored.

- **Finished by a later phase, as planned:**
  - AIA-01: a monthly summary and a budget recommendation by AI.
  - AIA-12 and NFR-14: tax outputs, in Phase 8.
  - AI-02: AI doesn't suggest a property or unit. They're tagged by hand or by rent, mortgage and capital improvement links.
  - PLT-03 and UP-07: mobile screens arrive with each feature phase.
  - AI-07: logos, via reference data.
- **Phase 11 hardening:**
  - NFR-01: the AWS KMS adapter and TLS.
  - NFR-07: performance; the dashboard target is in Phase 6.
  - NFR-12: load testing.
  - AUTH-05: email templates.
  - AUTH-08: CAPTCHA at the edge.
  - OPS-05: the reference-data admin editor.
  - OPS-06: dependency updates beyond Renovate.
  - OPS-07: alerting.
  - PLT-01: a WCAG audit.

### Cross-phase backlog (known gaps not tied to one requirement)

1. ~~**Transfers.**~~ Done: accepting a suggested transfer in review (web or phone, one at a time or "accept all
   above") makes it a transfer and absorbs the other side (`POST /transactions/:id/make-transfer`). Import doesn't
   convert pairs on its own yet, even at 0.95: they wait in review.
2. **Local-mode AI tasks.** Results the client posts to `POST /ai/tasks/:id/result` are stored but not
   yet applied to rows or review suggestions.
3. **More bring-your-own-key adapters:** OpenAI, Gemini and Azure. Only Anthropic and OpenAI-compatible
   endpoints exist.
4. **S3 storage** is only stub-tested; there is no MinIO run in CI.
5. **Undoing an import** doesn't take back payee history learned from categories picked during that
   import's preview.
6. **Mobile has no React Native Testing Library screen tests.** Pure modules have unit tests; screens rely
   on the export builds and on the Maestro flows, which haven't been run.
7. ~~**Mobile Home**~~ now shows left to spend and left to assign, like the web.
8. **Camera library:** the camera spike uses `expo-camera`. Moving to `react-native-vision-camera`
   (frame processors, ML Kit / VisionKit edge detection) is the Phase 5 option, decided by the spike. ADR-0009
   stays _proposed_ until the spike runs on devices.
9. **Commit speed:** an import commit takes about 11 ms per row, so 5,000 rows take about a minute
   (with a progress bar). Bulk posting would speed it up later.
10. ~~**Account-only transfer candidates.**~~ Done: a payment whose text names another account's last 4 digits is
    suggested as a transfer (0.80) before that account's statement arrives, and that statement later matches it.
11. **Payment lines share a payee key.** The key for "ONLINE PAYMENT TO CARD XXXX4321" is just `TO`, whatever the card,
    so all such lines share one `app.payee` row and its name is the first one imported. Changing the key would need
    a migration of payee history and rules.
12. ~~**Patch schemas that fill defaults.**~~ Done: every `Update…` schema now leaves omitted fields out, and
    `packages/schemas/test/patches.test.ts` checks them all.

---

## 5. Issues already solved, and their workarounds (don't undo these)

| Area            | Issue                                                                                                                                                                                                                                    | Fix in place                                                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB              | `citext` not found inside `SECURITY DEFINER` functions (restricted `search_path`)                                                                                                                                                        | Use qualified names (`public.citext`) and `set search_path = app, pg_temp`                                                                                                                                                                                                                                                |
| DB              | Commit cost 59 ms per row; RLS helper functions dominated                                                                                                                                                                                | Migration 0009 caches the helpers per transaction (GUCs plus `app.cache_gen`, bumped on membership or grant changes); 0008 runs one balance check per entry; the change log takes one seq per transaction; a ledger `UnitCache` per transaction. Now about 11 ms per row                                                  |
| DB              | The audit trail recorded `field_clock` changes                                                                                                                                                                                           | `audit_row` excludes `field_clock` (redefined in 0011)                                                                                                                                                                                                                                                                    |
| DB              | The batch's `job_id` pointed at the doc job, so a failure in the chained parse job left the batch on "parsing"                                                                                                                           | `ImportsService.get` reads the latest job for the batch (`payload->>'batchId'`)                                                                                                                                                                                                                                           |
| Tests           | Vitest `globalSetup` ignores the custom export condition `@montra/source`                                                                                                                                                                | `vitest.shared.ts` `sourceAliases` maps every workspace package to its TS source. **Add new packages there**                                                                                                                                                                                                              |
| Tests           | API test data                                                                                                                                                                                                                            | `test/global-setup.ts` recreates `montra_test_api` and loads reference data. Tests need Postgres running                                                                                                                                                                                                                  |
| Tests           | `@montra/categorize` perf budget (5,000 × 100 rules < 2 s) failed on 2-vCPU CI runners under parallel turbo load                                                                                                                         | Excluded from the default run; `test:perf` runs it alone (best of three) in CI and in `pnpm verify`. The budget is unchanged                                                                                                                                                                                              |
| Tests           | Fake-provider AI auto-categorizes manual entries in e2e, which broke specs that assumed "uncategorized"                                                                                                                                  | Specs set the review threshold to 99% (`setAi(page, { threshold: 99 })`) or pick categories the fake provider wouldn't choose                                                                                                                                                                                             |
| Lint            | `no-restricted-properties` bans `Math.round` (money safety)                                                                                                                                                                              | Non-money values use `Number(x.toFixed(n))` or `Math.trunc`                                                                                                                                                                                                                                                               |
| Kysely          | `onConflict(...).doUpdateSet({ col: eb => eb.ref('excluded.col') })` doesn't type-check on JSON columns                                                                                                                                  | Use `` sql`excluded.col` ``                                                                                                                                                                                                                                                                                               |
| Importers       | `SP *` prefix stripping ate "SP" from SPOTIFY; Amazon/Apple variants                                                                                                                                                                     | Prefix patterns require the `*`; Amazon and Apple use name synonyms instead of stripping                                                                                                                                                                                                                                  |
| Importers       | Chase's "Details" column was appended to descriptions                                                                                                                                                                                    | A second description column must contain real text (average length ≥ 10, ≥ 60% distinct values)                                                                                                                                                                                                                           |
| Importers       | PDF statements with ambiguous dates and 2-row balance checks                                                                                                                                                                             | The statement period disambiguates the date format; the running-balance fit returns NaN below 3 rows                                                                                                                                                                                                                      |
| Imports         | Re-importing duplicated a manual entry that had been matched earlier                                                                                                                                                                     | Transactions with a `transaction_source` count as imported candidates                                                                                                                                                                                                                                                     |
| Imports         | The AI column mapping replaced the heuristic warnings even when not confident                                                                                                                                                            | The AI mapping is adopted only if its confidence × parse rate ≥ `MAPPING_OK` (0.75)                                                                                                                                                                                                                                       |
| Sync            | `hasMore` was wrong after the per-transaction seq change                                                                                                                                                                                 | It's computed with an existence query after the page's last seq; pages never end inside a seq group                                                                                                                                                                                                                       |
| Sync            | A `duplicate` replay result carries no transaction, which left the local row pending forever                                                                                                                                             | The engine drops `pending` when no other ops remain for that id; the next pull brings the server copy                                                                                                                                                                                                                     |
| Web             | The editor treated the uncategorized system account as a chosen category, so it never asked for a suggestion                                                                                                                             | `toEditState` maps `uncategorized_*` postings to an empty category                                                                                                                                                                                                                                                        |
| Web             | Fixtures broke whenever DTO fields were added                                                                                                                                                                                            | Update `apps/web/lib/*.test.ts` fixtures in the same change as the DTO                                                                                                                                                                                                                                                    |
| CI              | Prettier failures (for example `infra/kratos/kratos.yml`)                                                                                                                                                                                | `pnpm verify` runs `format:check` first. Run `pnpm format` before pushing                                                                                                                                                                                                                                                 |
| Mobile          | `react-native-vision-camera` setup on SDK 58                                                                                                                                                                                             | Used `expo-camera` for the spike. Swipe review uses `PanResponder`; transaction rows use `ReanimatedSwipeable`                                                                                                                                                                                                            |
| Mobile          | Hermes on Android has no `Intl.PluralRules`: the translator threw while the root layout loaded, so the release APK showed only a gray screen (no error screen can render that early)                                                     | `pluralRules()` in `@montra/i18n` falls back to one/other when it's missing. Don't call `new Intl.PluralRules` (or `RelativeTimeFormat`, `ListFormat`, `DisplayNames`, `Segmenter`) directly in code the phone loads                                                                                                      |
| Mobile          | Receipt photos sat at "Uploading…" on Android: the upload never reached the server, the queue took the failure for being offline (no error, no backoff), and the screen hid it                                                           | Receipt and payslip pages upload natively (`src/api/file-upload.ts`, expo-file-system, 120 s limit). A failure with a connection counts as a failed attempt, retried with backoff, and the receipts screen shows the error and when it retries (`queuedStatus`). Statements stay on FormData, which keeps their file name |
| AI              | Every receipt read with Claude failed with a 400: Anthropic compiles at most 16 union-typed (nullable) parameters per structured-output schema, and `extract_receipt.v1` had 17. Tests use the fake provider, which never sends a schema | `extract_receipt.v2` answers the two yes/no/unknown fields (`taxable`, `taxIncluded`) as words, mapped back to booleans in the gateway (15 unions). `test/schema-limits.test.ts` checks every task's schema against the limit                                                                                             |
| Mobile          | Metro with pnpm workspaces and the `@montra/source` condition                                                                                                                                                                            | `apps/mobile/metro.config.js` sets watch folders and resolves workspace packages to their sources                                                                                                                                                                                                                         |
| Windows         | With `core.autocrlf=true` every file was checked out CRLF: the Postgres init script failed in the container ("required file not found") and `format:check` failed                                                                        | `.gitattributes` forces LF. In a clone made before it, run `git config core.autocrlf false` and re-check out (or strip CR from tracked files)                                                                                                                                                                             |
| Windows         | `LocalStorage` rejected every key (`path.normalize` turns `/` into `\`), failing 17 upload tests                                                                                                                                         | Keys are checked with `posix.normalize`; containment with `path.relative`. `test/storage.test.ts` covers it                                                                                                                                                                                                               |
| Windows         | `PERF=1 vitest run` (categorize `test:perf`) fails in cmd.exe, pnpm's script shell on Windows                                                                                                                                            | `vitest run --mode perf`; the config selects the perf test by mode. Keep scripts free of `VAR=x` prefixes                                                                                                                                                                                                                 |
| Local           | Host ports 5432/1025/8025/9000 taken by other stacks                                                                                                                                                                                     | Compose ports read `MONTRA_PG_PORT` etc. (defaults unchanged; put them in the gitignored `infra/.env`). Point `DATABASE_URL`, `DATABASE_ADMIN_URL` (montra_test) and `API_DATABASE_URL`, `API_DATABASE_ADMIN_URL` (montra_test_api) at that port; turbo passes all four to tests                                          |
| Local           | `minio/minio` on Docker Hub is no longer pullable, which aborted `docker compose up`                                                                                                                                                     | Compose uses `quay.io/minio/minio`                                                                                                                                                                                                                                                                                        |
| Tests           | `perf-commit.test.ts` (300-row commit < 9 s) took 9.4–11.8 s under full parallel `pnpm verify` here, and about 5.7 s for the commit run alone (with or without the Phase 6 read-model triggers, which cost nothing measurable)           | Moved to `@montra/api` `test:perf` (`vitest run --mode perf`), run alone after `turbo test` in CI and `pnpm verify`. The budget is unchanged                                                                                                                                                                              |
| Process (cloud) | The cloud sandbox couldn't push tags                                                                                                                                                                                                     | Not an issue locally: tag from your machine                                                                                                                                                                                                                                                                               |
| Process (cloud) | Container restarts killed Postgres and in-flight workers                                                                                                                                                                                 | Locally, run Postgres in Docker. Commit early and often in long tasks                                                                                                                                                                                                                                                     |

---

## 6. What is and isn't verified

| Verified (automated)                                                                                  | Not yet verified                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Ledger invariants, RLS isolation, the DE-10 edit rules                                                | A live Kratos server (sign-up, MFA, recovery emails)                                        |
| Import corpus (22 layouts), dedupe, undo, reconciliation                                              | S3/MinIO storage                                                                            |
| AI pipeline with the fake provider, rules, learning, review, insights                                 | **Real-provider accuracy (≥ 85%) and latency**                                              |
| Scanned-PDF OCR with real Tesseract                                                                   | Real scanned statements end to end through both workers _(the parts are tested separately)_ |
| Offline sync: server, engine, and two simulated devices against the real API                          | **Mobile on devices**: SQLCipher, biometrics, camera, share sheet, push, gestures, Maestro  |
| Mobile iOS/Android bundles build; store contract tests                                                | The camera spike (ADR-0009 go/no-go)                                                        |
| Web e2e: 9 flows (happy path, import, reconcile, mapping, review, rules, AI off, quick add, Phase 1a) | Production infrastructure (Phase 11)                                                        |

---

## 7. Phase 5, receipts and multi-currency (done)

**Scope** (from `01-phased-plan.md`): TXN-08, TXN-09; IMP-11; RCP-01..08, RCP-10, RCP-11, RCP-12; ACC-04;
CUR-03..09; TZ-03; UP-09; and the receipt vault that BIZ-12 will use.

**Design references:**

- `04-domain-logic.md` §7 (the receipt pipeline, steps 1–8, including the worked Walmart example) and §1
  (money and FX);
- `03-data-model.md` (`receipt`, `receipt_line`, `ref.fx_rate`, and the posting `fx_rate` and
  `functional_amount_minor` fields, which already exist);
- **ADR-0010** (FX accounting: functional currency per entity, historical rates on inflows, average
  carrying cost on outflows, `fx_gain_loss` and `fx_rounding` accounts);
- `06-ai-gateway.md` (the `extract_receipt` task, routed to the vision model group; images go to an LLM
  only in builtin/BYOK mode);
- `08-clients.md` §3 (camera capture).

**Exit criteria:**

1. The requirements' Walmart example (§3.5) produces exactly **Groceries $5.10, Electronics $13.91,
   Clothing $9.70 = $28.71**. Taxable subtotal 21.86, tax 1.75, split 1.03 / 0.72 with
   `allocate(…, 'largest')`. Make it a unit test.
2. A foreign receipt matches its home-currency statement line within **±3%**, and the actual rate is
   stored.

**Suggested breakdown** (the pattern used for Phases 2–4: contracts first, then parallel work, then
integration):

1. **Contracts.**
   - Migration `0012_receipts_fx.sql`:
     - `receipt` and `receipt_line` (per 03);
     - `trip` (travel mode, CUR-09);
     - `ref.fx_rate` and `ref.currency` if they're missing;
     - attachment retention fields (7 years, RCP-10) and an OCR-text index (trigram or tsvector);
     - `rule.scope = 'receipt_line'` already exists.
   - Kysely types.
   - DTOs in `packages/schemas/src/receipts.ts` and `fx.ts`.
   - ADR-0014 (receipt pipeline and FX rates service).
2. **Domain** (`packages/domain` or a new `packages/receipts`):
   - validation within ±2 minor units (RCP-05);
   - grouping lines by (category, entity, member) (RCP-03, RCP-07);
   - tax, discount, fee and tip allocation (RCP-04);
   - returns as negative lines (RCP-08);
   - the matching score (IMP-11), with the restaurant tip tolerance;
   - the FX implied rate and conversion with `fx_rounding`.

   Use property tests (fast-check), as `allocate` does.

3. **FX rates service:**
   - an ECB daily and historical loader (free; no key);
   - Open Exchange Rates as an optional second source (`OXR_APP_ID`);
   - a daily job on the job queue;
   - a rate override per transaction (CUR-05);
   - foreign spend capture, with the four values plus the foreign transaction fee posted to `bank_fees`
     (CUR-03);
   - cross-currency transfers with FX cost (CUR-08);
   - the carrying-value rules from ADR-0010 (CUR-06/07).

   Test with recorded ECB XML fixtures.

4. **AI gateway:**
   - the `extract_receipt` task, with a vision prompt, a schema, a FakeAdapter branch and minimization
     (images only in builtin/BYOK mode);
   - RCP-02 name expansion;
   - line categorization through the pipeline with item rules;
   - a local path: Tesseract OCR in the doc-worker, then a local LLM for structure.

   Build a receipt fixture corpus (images plus expected JSON), as was done for the import corpus.

5. **API:**
   - receipt upload (images, multi-shot ordered pages, PDF invoices);
   - an extract job;
   - the receipt inbox;
   - matching on create and after every import, with automatic linking at a score ≥ 0.8;
   - apply: replace the transaction's splits with the receipt groups, which must sum to the
     _transaction_ amount;
   - the review endpoint;
   - item-rule learning from line corrections (RCP-06);
   - Amazon order-history import (RCP-12);
   - the "receipt recommended" flag (RCP-11);
   - retention and OCR-text search (RCP-10);
   - trips, which tag transactions in a date window (CUR-09);
   - local time on receipts (TZ-03).
6. **Web:** receipt upload, the inbox, the review screen with the image beside the lines (RCP-06),
   rate override and FX details on transactions, and the travel mode settings.
7. **Mobile:**
   - receipt capture (single and multi-shot, with blur and glare checks from `features/camera-metrics`);
   - an offline image queue (TXN-09: extend the outbox with upload ops, or a separate image queue in
     `@montra/sync`);
   - the inbox and review stack.

   Decide `expo-camera` versus `vision-camera` here, using the spike results if you have them.

8. **Integration:** e2e specs for upload, then match, then apply splits, and for a foreign receipt; the
   Walmart and FX exit tests; `status.json`, the changelog and this file; then a PR into `develop`.

**Progress (PR #6 merged; matcher on `claude/phase5-receipt-matching`):**

- ✅ **Step 1, contracts:** migration `0012_receipts_fx.sql` (receipt, receipt_line, trip, `ref.currency`,
  `ref.fx_rate` with `app.upsert_fx_rates`, transaction `trip_id`/`local_time`/`fx_rate_source`,
  `posting.receipt_line_id`, file retention, OCR `tsvector`); Kysely types; `schemas/fx.ts` and
  `schemas/receipts.ts`; `TransactionDto.foreign/tripId/localTime`; currencies in reference data; ADR-0014
  (_proposed_); DB tests for RLS and constraints.
- 🟡 **Step 2, domain and matching:** `packages/domain/src/receipt.ts` has validation, grouping and allocation, returns,
  fitting to the charged amount (tip tolerance), conversion at the implied rate and the ±3% deviation. Both
  exit criteria are unit tests there. The IMP-11 matcher is `packages/importers/src/receipt-match.ts`
  (`matchReceipts`: hard limits, a weighted score, one-to-one assignment, auto-link at ≥ 0.8 when
  unambiguous, the rate to store across currencies); rules in ADR-0014. The ADR-0010 posting rules are in
  `packages/domain/src/ledger/fx.ts` and the builders: carrying value on postings that shrink a foreign
  position, realized `fx_gain_loss`, same-currency carry-over, revaluation and transfer FX cost. Step 2
  is done.
- 🟡 **Step 3, FX rates service** (`apps/api/src/fx/`):
  - ECB and optional OXR loaders.
  - `ref.fx_rate` lookups: direct, inverse and cross, with a 7-day lookback for weekends; a preloaded
    `RateTable` for matching.
  - `GET /v1/workspaces/:id/fx/rates`.
  - The self-rescheduling `fx.daily` system job (migration 0013) and `fx:load`.
  - Fixtures in `apps/api/test/fixtures/fx` are hand-written in the published formats, not recorded
    downloads.
  - **Foreign-currency accounts are enabled in the API:**
    - opening balances at the opening date's rate, and balance adjustments (ACC-04);
    - spending at carrying value with realized `fx_gain_loss` (CUR-07);
    - `fxRate` overrides on create and update, and 422 `fx.no_rate` when there is no rate (CUR-05);
    - the four values plus the fee to `bank_fees` on a home-currency card (CUR-03);
    - transfers between currencies with `amountIn` (CUR-08).

    `test/foreign-currency.test.ts` covers them against the real database. Step 3 is done for the
    API. The web and mobile screens (rate field, FX cost display, travel mode) are step 6.

  - **Known limitations:** carrying balances count all same-day postings as earlier, and a back-dated
    transaction doesn't revalue later ones (ADR-0010 note). Imports into a foreign-currency account
    need a reference rate for every row's date. Cross-entity splits and transfers stay single-currency.
- ✅ **Step 4, `extract_receipt`** (branch `claude/phase5-receipts`, stacked on PR #8):
  - The gateway task, with images in builtin/BYOK and masked OCR text in local mode, plus
    `taxIncluded` for VAT receipts, in the extraction and in the domain math.
  - Anthropic and OpenAI-compatible image content.
  - The fake provider: PNG `tEXt` receipt images, `parseReceiptText`, and item keywords.
  - A 5-receipt corpus (`packages/ai-gateway/test/receipts`).
  - The doc-worker `receipt.ocr` job, plus a Windows venv fix in `scripts/py.mjs`.
  - **Not verified:** real-provider accuracy on real receipt photos (needs `ANTHROPIC_API_KEY` and
    photos), and real Tesseract on receipts locally (Tesseract isn't installed here; CI runs it).
- ✅ **Step 5, receipts API** (`apps/api/src/receipts`, `apps/api/src/trips`; migration 0014):
  - Uploads, sniffed by content.
  - The extract job: builtin/BYOK images, or doc-worker OCR then text in local mode; off goes to
    review.
  - Item categorization (rules → history → AI), validation with the gap, the inbox and search.
  - Matching on create and after each import, auto-apply, manual apply (including creating the
    transaction), review edits that re-split linked transactions, and learned item rules.
  - RCP-11 recommendations with dismissals, RCP-12 Amazon order history, trips (CUR-09), and local
    time (TZ-03).
  - `test/receipts.test.ts` (18) covers both exit criteria through the API.
- ✅ **Step 6, web:**
  - `/receipts`: upload of one receipt from several pages, the inbox, needs-review, matched and all tabs,
    search, receipt recommended (RCP-11) and Amazon order history (RCP-12).
  - `/receipts/[id]`: the review screen with the image beside editable lines, category and member
    pickers, the gap, a splits preview, match candidates, record from the receipt, look again and reject.
  - `/trips` (CUR-09).
  - The transaction page: an FX panel (the original amount, rate and source, a rate override on
    foreign-currency accounts, "Paid in another currency?" with a fee for CUR-03) and "Add a receipt".
  - The transfer form asks for the amount received across currencies (CUR-08).
  - `e2e/receipts.spec.ts` covers the Walmart receipt through the UI and the CUR-03 entry. The foreign
    _receipt_ match is covered by the API tests only: e2e runs against the dev database, which has no FX
    rates unless `fx:load` has fetched them.
- ✅ **Step 7, mobile** (`expo-camera`, decided by the product owner; ADR-0009 amendment):
  - Receipt capture: multi-shot, with a blur/glare verdict and retake after each shot, or a photo or
    PDF from Files. Entry points: the Capture tab, More → Receipts, and a transaction's "Add a
    receipt".
  - Offline upload queue: `ReceiptUploadQueue` in `@montra/sync` (TXN-09, ADR-0014), run on every sync.
  - The receipts list: waiting uploads with retry and discard, plus the server inbox.
  - Receipt review: the image (bearer-authenticated), line categories through the category picker,
    splits, candidates, record from the receipt, look again and reject.
  - **Not done or not verified:** live edge detection (needs vision-camera frame processors). Nothing
    has been run on a device yet: camera, file copies, offline upload, image loading. No Maestro flow
    for capture (it needs a camera on the simulator).
- ✅ **Step 8, integration:** `e2e/receipts.spec.ts` covers the Walmart receipt through the UI (exit
  criterion 1), the foreign receipt matched within ±3% with the actual rate (exit criterion 2; rates loaded
  through `app.upsert_fx_rates`) and the CUR-03 entry. An applied foreign receipt's rate is `implied` (from
  the charge). CHANGELOG `v0.6.0-dev.1`.

**Decisions and inputs:**

- **OXR app id** provided on 2026-11-03 and kept in the local `.env` (never committed). Live ECB and OXR
  loads were verified, and the two sources agree on cross rates.
- **Receipt images** go to the AI only with the new `allowReceiptImagesToLlm` setting (off by default);
  otherwise they are OCR'd first (ADR-0014 §7).
- **Camera library:** `expo-camera`, decided by the product owner on 2026-11-03 (ADR-0009 amendment).
  Edge detection would need `react-native-vision-camera`.
- **Still open:**
  - real receipt photos to measure extraction (RCP-01/02); the API key is set locally;
  - device runs of the mobile capture, the offline queue and the camera spike;
  - device runs (see above).
- **Phase 5 leftovers, not blocking:**
  - CUR-08: FX-cost display;
  - RCP-10: purge after retention;
  - UP-09: missing-receipt flags, with BIZ-12 in Phase 8.

---

## 7a. Phase 6, budgeting, money flow and recommendations (done)

Branch `claude/phase6-contracts` (PR #12), with the restyle in `claude/web-shell` (PR #13).

| Step                    | State                   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts            | ✅                      | Migration 0015 (budget, budget_period, budget_line, budget_move, goal, expected_income, recommendation; bank_account min payment and low-balance threshold; `posting.restricted_member_id`), Kysely types, DTOs (`budgets.ts`, `flow.ts`, `recommendations.ts`), ADR-0015                                                                                                                                                                                                                                                                                         |
| 2. Read models          | ✅                      | `category_activity_monthly` and `account_balance_daily`, maintained by statement-level posting triggers (transition tables) in the same transaction; restricted rows follow the payslip rule. `packages/db/test/read-models.test.ts` reconciles them with postings through random writes                                                                                                                                                                                                                                                                          |
| 3. Domain engine        | ✅                      | `packages/domain/src/budget/`: periods, carried-in / available / left to assign (money conserved), pace, sinking funds, goal projection, snowball/avalanche, draft/copy, 50/30/20, forecast, REC-01..08 rules. Property tests                                                                                                                                                                                                                                                                                                                                     |
| 4. API                  | ✅                      | `apps/api/src/planning/`: budgets (periods, assign, move, copy, income override, draft), goals (sinking-fund category, payoff), expected income, dashboard with drill filters, Sankey, forecast, calendar, net worth, recommendations (REC-01..08, `word_summary` AI wording, accept/dismiss, settings), nightly per-workspace run (TZ-04). `apps/api/test/planning.test.ts`                                                                                                                                                                                      |
| 5. Web                  | ✅                      | On the restyled shell (PR #13). Home is the dashboard (tiles drill to transactions, pace, next 14 days, net position trend, suggestions). A Plan group: Budget (plan, income, moves tabs; setup with history draft; assign, move, copy, rollover, 50/30/20, light mode), Goals (progress, payoff plans), Cash flow (Sankey, 30/60/90 forecast, net worth), Calendar, Suggestions. Settings gains Planning (priorities, high-interest threshold) and per-account planning fields. SVG charts are in `components/charts` (no chart library). `e2e/planning.spec.ts` |
| 6. Mobile               | ✅ (device run pending) | Budget tab (period view, assign, move, copy, pace; creates a monthly zero-based budget), Home planning cards, Goals, Cash flow (flow as a list, forecast, net worth), Calendar agenda, Suggestions. Palette matches the web app. Review moved from a tab to Home and More, as 08 §3 lays out; its count shows on the More tab. Planning data comes from the API and is cached in the encrypted store for offline reading (`useCached`); budget writes need a connection. `apps/mobile/test/planning.test.ts`; both bundles build                                  |
| 7. Perf and integration | ✅                      | `apps/api/test/perf-dashboard.test.ts` seeds 50k transactions (`perf-seed.ts`) and budgets the API work behind Home at 1.5 s (measured 0.69 s). In a browser against a production build: Home visible p95 1.0 s, median 0.81 s; Budget, Goals, Cash flow, Forecast, Calendar and Transactions all p95 under 0.65 s. Single user, on a development machine: k6 load testing stays in P11                                                                                                                                                                           |

Pace applies only to variable spending (`PACE_KINDS`: daily, fun) and only once a fifth of the period has
passed: fixed bills paid on the 1st, or one big shop on day 3, are not overspending.

Recommendation wording was checked against the real provider on 15 hand-read samples. The first round showed the
number check alone isn't enough: correct numbers were given the wrong meaning ("$15 per day" read as a limit, not a
reduction). Figure names now say what they mean, and the prompt forbids inventing actions. This is not a formal eval.

Phase 6 leftovers, not blocking:

- FAM-06/07: the API supports member budgets and goals; the screens have no member picker yet (fits Phase 7).
- FLOW-06: owner draws never count as spending, but the Sankey doesn't draw them as transfers yet.
- REC-06: unused subscriptions aren't detected. REC-04's wording can name at-risk bills awkwardly.
- Mobile: budgets are created only as monthly zero-based. No device run yet. (Goals can now be edited and archived on the phone; see §7g.)

Design notes that the API relies on:

- Only intent is stored. Carried-in, available and left to assign are computed by walking periods from
  the first one; a surplus or overspend a category doesn't carry goes back to left to assign, so
  left to assign + Σ available = Σ income − Σ activity.
- The budget's `version` is the concurrency token for its periods, lines and moves; only `budget` has a
  change-feed trigger.
- Read-model rows are never deleted (zeroed rows stay); filter on non-zero values.

---

## 7b. Phase 7, family members and payslips (done)

Branch `claude/phase7-contracts`. The design is ADR-0016.

| Step           | State                   | What                                                                                                                                                                        |
| -------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts   | ✅                      | Migration 0017 (employer, payslip, payslip_line, `posting.public_line`, `expected_income.employer_id`, posting read rule), DTOs, `packages/domain/src/payslip.ts`, ADR-0016 |
| 2. AI task     | ✅                      | `extract_payslip` with masked text (SSNs, account numbers, member pseudonyms); image only with `allowDocumentsToLlm`                                                        |
| 3. API         | ✅                      | `apps/api/src/payslips/`: employers, capture jobs, confirm and re-post, deposit matching, expected income, reports by member                                                |
| 4. Web         | ✅                      | Payslips (capture, employers, side-by-side review), By member, Home filter, member budgets and goals                                                                        |
| 5. Mobile      | ✅ (device run pending) | More → Payslips: camera or file, check, confirm, choose a deposit. Live reads only, nothing stored                                                                          |
| 6. Integration | ✅                      | `apps/api/test/payslips.test.ts`, public-line RLS test, `apps/web/e2e/payslips.spec.ts`                                                                                     |

Rules the code depends on (don't undo these):

- **Only the net-pay posting is public.** A restricted entry with a public line must keep its transaction `spec` to the
  bank fact: `transaction` has no restricted rule, and the DTO exposes the spec.
- **A payslip owns its transaction.** `updateInTrx` refuses ledger fields before `mergeSpec`, because the merged spec
  drops `payslipId`. Import undo keeps such a deposit. Anything new that posts from a spec must check `payslipId` too.
- **A taken-over deposit keeps its statement date** (DE-10), even when the payslip's pay date differs.
- **Budget income is take-home:** income categories minus payslip gross − net (`PlanningData.payslipWithheld`). Taxes are
  in a `system`-kind group, excluded from spending.

Phase 7 leftovers, not blocking:

- FAM-10 (could-have) isn't started: marking education expenses for credits or 529 withdrawals.
- **`extract_payslip` hasn't been run against the real provider or a real payslip.** Tests use the fake provider. Measure
  this before relying on the drafts; the user checks every draft against the file regardless.
- Mobile: no prefill from the last payslip and no amount edits (both on the web). No device run yet.
- Foreign-currency payslips are refused.
- After a payslip that took over an imported deposit is deleted, undoing that import no longer removes the deposit if the
  undo already ran. The user deletes it by hand.

---

## 7c. Phase 8, small business (done)

Branch `claude/phase8-contracts`. The design is ADR-0017.

| Step           | State                   | What                                                                                                                                                                                                 |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts   | ✅                      | Migration 0018 (business_profile, business_party, invoice, invoice_line, invoice_payment, bill, mileage_trip, `ref.tax_line`, `ref.mileage_rate`), DTOs, `packages/domain/src/business.ts`, ADR-0017 |
| 2. AI tasks    | ✅                      | `map_tax_lines` and `flag_separation`: answers limited to what was offered, and the user decides                                                                                                     |
| 3. API         | ✅                      | `apps/api/src/business/`: profiles, parties, invoices with PDF and email, bills, mileage, reports, export, nightly matching, flags and notes                                                         |
| 4. Web         | ✅                      | Business: overview, invoices, bills, customers and vendors, mileage, taxes, missing receipts, settings. Budget revenue target; tax hint on a transaction                                             |
| 5. Mobile      | ✅ (device run pending) | More → Business: profit, what's owed, tax to set aside, and logging a trip                                                                                                                           |
| 6. Integration | ✅                      | `apps/api/test/business.test.ts`, `business-files.test.ts`, RLS test, `apps/web/e2e/business.spec.ts`                                                                                                |

Rules the code depends on (don't undo these):

- **Cash basis.** Nothing posts at invoice or bill date; a payment is what becomes income or expense. An accrual method would
  be a separate decision (ADR-0017).
- **One owner check.** `ownerOf(spec)` in `transactions/poster.ts` covers payslips, invoices and bills. Edits, deletes and import
  undo all go through it. Anything new that changes a transaction must too.
- **Payments split cumulatively** (`allocatePayment`), so only the latest payment on an invoice can be removed.
- **Mileage is never in the ledger.** It's added on Schedule C and subtracted in the tax estimate, so those two agree. The P&L is
  book profit and doesn't include it.
- **A linked payment says whose it is.** Bank names often normalize to nothing ("ACH CREDIT"), so party totals read the link first
  and the payee key second.
- **Rates apply from a date** (`ref.mileage_rate`). IRS rates changed mid-year in 2022 and 2026. Rates were checked against the IRS
  page on 2026-11-03; update `packages/db/src/reference/tax.ts` when a new notice is published.
- **The calendar computes a tax estimate only when a due date is in view.** Home and the calendar both read it, and the estimate
  scans a year of postings. The 50k perf budget caught this at 2 s; it's 61 ms now.
- **Automatic links stay conservative.** Only in the business's own accounts, and only one exact pair or a quoted number. Offering is
  always safe; a wrong automatic link misstates income.

Known intermittent problem: **a click right after a background refresh can be lost.**

- What happens: the link does nothing and the page stays put. A second click works. It shows up in e2e as a failed navigation, in
  a different spec each time, about one full run in four on a loaded machine. Each spec passes alone (12 of 12 repeated).
- Why: `router.refresh()` from `components/realtime.tsx` (Phase 1) or `useAction` overlaps the navigation. In Next 15.5 a navigation
  that interrupts a pending action marks it discarded and never resolves its promise (`app-router-instance.js`), which looks like
  the cause. That isn't proven end to end.
- What's done: `realtime.tsx` now holds its refreshes until a click has had a second to land (`refreshWaitAfterAction`). This
  narrows the race but can't close it: a refresh already in flight when the click happens still overlaps. Failures seemed less
  frequent afterwards, but on too few runs to claim a fix.
- Whether it's new is unknown. The refresh code dates from Phase 1, but this has only been seen locally, on a machine about twice as
  slow as CI, and not in the last eight CI runs' logs. (CI retries a failed e2e test once, and a retried pass still logs as flaky.
  The flakes in Phase 6's CI were a different bug, a confirmation message lost with the last suggestion, fixed in Phase 8.)
- Next step: see whether a newer Next release resolves discarded actions, or make `useAction`'s refresh the only one for a user's
  own writes. Don't raise e2e timeouts or add retries to cover it.

Phase 8 leftovers, not blocking:

- **Not tried on the real thing:** IIF and Xero files against QuickBooks and Xero themselves; invoice email through a real mail
  server; `flag_separation` and `map_tax_lines` against the real provider.
- Invoice PDFs print Latin text only (the standard PDF fonts); other characters print as "?". Embedding a font would fix it.
- A deposit pays one invoice: one cheque for two invoices needs splitting by hand. Bills can't be part paid.
- Foreign-currency invoices and bills are refused.
- Estimated-tax periods assume a calendar tax year, even for a business with another fiscal year.
- The mileage rate editor is the admin screen in Phase 11; until then a new rate is a reference-data change.
- Reminders appear on the calendar and as suggestions, and since Phase 10 by push and email too.
- Mobile: invoices and bills are read-only, and there's no device run yet.
- BIZ-08, BIZ-14 and BIZ-15 (could-haves) aren't started.

## 7d. Phase 9, rental properties (done)

Branch `claude/phase9-contracts`. The design is ADR-0018.

| Step           | State                   | What                                                                                                                                                                                                                                                             |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts   | ✅                      | Migration 0019 (property, unit, tenant, lease, rent_charge, rent_payment, security_deposit_event, allocation_rule, loan_schedule, loan_payment, depreciation_schedule, rental_reminder, maintenance_log, property_budget), DTOs, `packages/domain/src/rental.ts` |
| 2. AI task     | ✅                      | `flag_capital`: payee, rounded amount and category only, and the owner decides                                                                                                                                                                                   |
| 3. API         | ✅                      | `apps/api/src/rentals/`: properties and leases, rent, mortgages, operations, reports, nightly jobs. Property and unit tags on splits. Rent and mortgages in the forecast and calendar; property values in net worth                                              |
| 4. Web         | ✅                      | Rentals: overview, properties, tenants, leases, rent roll, arrears, mortgages, maintenance, reminders, Schedule E, settings. Property on the transaction editor, split across properties, capital improvement in insights                                        |
| 5. Mobile      | ✅ (device run pending) | More → Rentals: the month's rent, arrears, and logging a payment                                                                                                                                                                                                 |
| 6. Integration | ✅                      | `apps/api/test/rentals.test.ts`, RLS test, `apps/web/e2e/rentals.spec.ts`                                                                                                                                                                                        |

Rules the code depends on (don't undo these):

- **What's paid is derived.** `applyRentPayments` applies a lease's payments to its charges oldest first each time it's read. There are
  no rows linking a payment to a charge, so removing one re-applies the rest.
- **Charges are written, and existing ones keep their amounts.** `ensureCharges` runs on lease create and edit, and nightly, through
  the end of next month. GET never writes. A charge someone edited stays edited, and a waived late fee isn't brought back.
- **One owner check, in two forms.** `ownerOf(spec)` and `NOT_OWNED` (SQL) in `transactions/poster.ts` cover payslips, invoices, bills,
  leases, deposits and loans. Anything new that matches lines or changes them in bulk must use them.
- **Matching stays in code and stays conservative.** No tenant names go to AI (ADR-0018 §3). A name shared by two leases proves nothing,
  and an exact amount needs nothing competing on either side. Offering is always safe; a wrong link misstates income.
- **Escrow is an operating expense when paid in.** NOI here includes Taxes and Insurance from escrow and excludes principal and interest.
  That can differ from the Form 1098 (ADR-0018 §6).
- **Depreciation is never in the ledger.** It's added on Schedule E and in the set-aside, so those two agree, and reports don't include it.
- **The category for rent, interest, taxes and insurance is found by tax line**, not name, because the owner may rename it.
- **A portfolio ratio needs every property's figure** (ADR-0018 §12). A dash is correct while one is missing.

Phase 9 leftovers, not blocking:

- **Not tried on the real thing:** `flag_capital` against the real provider, and the mobile screens on a device.
- The Schedule E export is CSV or Excel. The one-click tax package (UP-10) came in Phase 10.
- A lease and an entered expected-income item for the same rent both count in the forecast. The household budget's expected income
  still comes from entered items, so BUD-03 stays partial.
- Escrow goes straight to Taxes and Insurance rather than through an escrow account.
- Rent isn't prorated: a mid-month move-in gets a full charge, which the landlord edits.
- A detected recurring bill for the same payee as a mortgage can show twice on the calendar. Invoices and bills have the same limit.
- Foreign-currency leases aren't handled separately: a portfolio's rent is in its own currency.
- Reminders are on a list and the calendar, and since Phase 10 by push and email too.
- Mobile: only logging rent. Everything else is managed on the web.
- RNT-15 and RNT-16 (could-haves) aren't started.

---

## 7e. Phase 10, reports, search, notifications, data ownership (done)

Branch `claude/phase10-contracts`. The design is ADR-0019.

| Step                     | State | What                                                                                                                                                                                                                                                |
| ------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts             | ✅    | Migration 0020 (saved_report, notification, notification_pref, security_event, export_job, backup_schedule, restore_job, `transaction.search`, quota trigger, purge functions), DTOs, the search parser and notification timing in `@montra/domain` |
| 2. Reports and questions | ✅    | `apps/api/src/reports/`: one `ReportDto`, PDF, CSV and Excel from it, search, and `answer_question` returning a plan                                                                                                                                |
| 3. Notifications         | ✅    | `apps/api/src/notifications/`: written nightly, delivered every 5 minutes with quiet hours and the cap, through Expo push and mail                                                                                                                  |
| 4. Your data             | ✅    | `apps/api/src/data/`: archive from the DB catalog, restore with new ids, tax package, trash, storage, deletion and the hourly retention job                                                                                                         |
| 5. Screens               | ✅    | Web: reports, search, ask, inbox and bell, trash, four settings sections. Phone: inbox, channel switches, your data, settings to read                                                                                                               |
| 6. Tests                 | ✅    | `reports.test.ts`, `notifications.test.ts`, `data-ownership.test.ts`, RLS additions, `e2e/reports-data.spec.ts`                                                                                                                                     |

Rules this phase depends on:

- **A new table must be classified for backup.** `apps/api/src/data/catalog.ts` lists what isn't exported and why, and a test fails on
  anything unclassified. Restore works out insert order from `pg_constraint` and maps every id.
- **`search` is derived.** `app.audit_row` skips it, so it can't copy payees into audit diffs, and a new generated column needs the same.
- **The worker needs `BackupService`, `RestoreService` and `OwnershipService` registered**, and tests must call `register()` and drain
  the `report` queue.
- **A closing account gets 403 `account.deleting`** except on `/v1/me/deletion` and reading `/v1/me`. The page explaining it needs the
  person's language; without that it redirects to itself.
- **Quota lives in a trigger on `app.file`** (`storage.quota`). Exports don't count, so a full quota can't stop someone leaving.
- **Purge is due 2 hours before the 30 days**, so the hourly job finishes inside what NFR-06 promises.

Phase 10 leftovers, not blocking:

- **Not tried on the real thing:** `answer_question` against the real provider; push on a device and through real Expo; the phone's
  backup download and share sheet; new-device sign-ins on a live Kratos; a large restore (uploads are limited to 1 GB, in one
  transaction).
- **BAK-05** is the emailed link only. Drive, OneDrive, Dropbox and iCloud need OAuth apps.
- **OPS-13**: profile, family, entities, currency, time zone, AI mode and quiet hours are read-only on the phone.
- **AUTH-12**: password changes and session revocations aren't logged (the first happens in Kratos, the second in `sessions.controller.ts`);
  support access waits for the Phase 11 tool.
- **OPS-10**: SPF, DKIM and DMARC with Phase 11's domains. **BAK-09**: ageing out of backups with Phase 11's infrastructure.
- **BAK-08**: one 5 GB quota until plans exist. Web receipt uploads aren't compressed, and there's no choice to keep an original.
- **CUR-06**: net worth revalues at the period-end rate, but no report shows unrealized gain or loss yet.
- Personal books can't be restored into an existing workspace, which already has its one personal entity. Use a new workspace.
- Restoring to an existing workspace only counts likely duplicates; it doesn't drop them.
- Search reads the latest 5,000 notes, and leaves receipts out when the query has an amount or a tag.
- Line chart points reach their transactions through the table beneath, not by clicking the line.
- A notification on the phone doesn't deep-link to what it's about, and tapping a push opens the app rather than the item.

---

## 7f. Phase 11, hardening and launch (code complete, not launched)

Branch `claude/phase11-contracts`. The design is ADR-0020. **Nothing has been deployed**, and `validate` is as far as the Terraform has been.

| Step              | State             | What                                                                                                                           |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Contracts      | ✅                | Migration 0021, DTOs, entitlements and version checks in `@montra/domain`                                                      |
| 2. API            | ✅                | `apps/api/src/ops/`: billing, staff console, support access, notices, metrics, reconciliation                                  |
| 3. Web            | ✅                | Plan and support access in Settings, notices, `/status`, `/help`, `/legal/*`, `/admin`, a tour, error reporting                |
| 4. Mobile         | ✅                | Update screen on 426, notices on Home, plan and help links in Settings                                                         |
| 5. Infrastructure | ✅ written        | `infra/terraform`, images, `security.yml`, `terraform.yml`, `deploy.yml`, `infra/observability`, `infra/load`, `docs/runbooks` |
| 6. Audit          | ✅ automated only | `e2e/accessibility.spec.ts`                                                                                                    |
| 7. Launch         | ❌                | See below                                                                                                                      |

Rules this phase depends on:

- **Staff roles.** `packages/db/test/rls.test.ts` pins what `montra_admin` and `montra_support` can reach. Don't widen it to make something pass.
- **Clocks.** Compare a time written from JS with `now()` in SQL carefully: the database clock and this machine's differ. Write `now()` from SQL if SQL reads it.
- **The web CSP lives in `apps/web/lib/csp.mjs`, and is fixed at build time.** Each environment's web image needs its own `NEXT_PUBLIC_KRATOS_URL`. Browsers apply `form-action` to redirects too, so **a new OIDC provider has to be added to its list**, or sign-in with it is blocked.
- **`BILLING_MODE=off` is the default**, and is what e2e runs on. Paying is covered in `apps/api/test/operations.test.ts`, with Stripe stubbed.
- **Public pages use `getPublicI18n`.** `getI18n` needs a session, and redirects to sign-in without one.
- **The tour never opens by itself**, so it can't sit over someone's work or over a test's click.

What only the owner can do, in `docs/runbooks/first-time-setup.md` and `launch-checklist.md`:

- Create the AWS accounts, Cloudflare, SES production access, Stripe products and prices, Sentry, and DB roles, then the first `terraform apply`.
- Decide pricing.
- Have a lawyer read the legal pages, and sign DPAs with each AI and OCR provider.
- Commission the pen test (NFR-04), and run the quarterly restore drill for real (BAK-07).
- Run the closed beta and measure the exit metrics (≥ 85% categorization accepted, a month imported and reviewed in < 10 min, NFR-07).
- Cut `release/1.0`, `v1.0.0-rc.N` on staging, and merge to `main`.

Questions for the owner, each blocking something:

1. **BAK-01 or BAK-09?** Monthly snapshots kept 12 months conflict with deleted data ageing out within 35 days, and Vault Lock makes the choice permanent 3 days after apply. Settle before the first production apply.
2. **Is a 5-minute RPO only within a region acceptable?** Cross-region copies are daily, so losing a region can lose up to 24 hours. Closing that needs Aurora Global Database, at a monthly cost.
3. **Is an emailed code acceptable for AUTH-05?** The requirement says a link.
4. **Can the Aurora master create a `BYPASSRLS` role?** Untested. The setup runbook checks first and stops.

Measured locally, on 2026-11-04:

- **Restore drill:** `pg_dump` and `pg_restore` of the dev database into a scratch one, then `infra/db/reconciliation-checks.sql` and
  `app.reconcile_books()`. 416 workspaces and 2,680 postings came back the same, in about 10 seconds, with no problems found. This shows
  the checks work. It says nothing about a real restore's size or time, or about RPO and RTO.
- **A flaky limit:** `lib/colour-guard.test.ts` hit Vitest's 5-second limit once during a parallel `pnpm verify`, and passes in 0.4 s alone.
  It reads files without waiting, so a slow disk could do it again. The limit hasn't been changed.

Phase 11 leftovers:

- **Passkeys** were tested on 2026-11-04 in Chromium with a virtual authenticator against local Kratos v26.2.0: sign-up and sign-in work, and with the previous CSP they didn't. Security keys as a second factor, other browsers and real devices haven't been tried.
- **OIDC:** the CSP lists Apple and Google, and a local stand-in showed Chromium blocks the redirect without them. No real provider has been tried.
- **Base images** are pinned by digest in all four Dockerfiles, and the RDS bundle by checksum where it is downloaded. A rebuild no longer picks up base image patches, so they depend on digests being raised: see the monthly round in `docs/runbooks/security-patching.md`.
- **Renovate and Dependabot don't appear to be running.** Renovate has never opened a PR or branch, and the vulnerability alerts endpoint returns 404. Installing the app and turning on alerts is for the owner, and it's on the launch checklist. Until then, only the weekly `security.yml` run catches new findings.

- **Not tried on the real thing:** Stripe, Sentry, AWS KMS, S3 with KMS, SES, Cloudflare, Grafana, the deploy workflow, and every mobile screen on a device.
- **`security.yml`:** Kratos no longer fails it (ADR-0021), and a `zod` finding in the Expo CLI is accepted until 2027-02-04.
  Reasons and expiry dates are in `docs/runbooks/security-patching.md`.
- **PLT-08** (widgets) moves to R1.x. **Store billing** isn't built, so the phone shows the plan and doesn't sell it.
- **NFR-10:** axe only. No screen reader or manual audit, and nothing on mobile.
- **PLT-01:** only Chromium runs in e2e.
- **The status page** runs on the same stack it reports on, so it goes down with it. It needs a separate host before launch.
- **Staff sign-in** is the ordinary one with a second factor, not SSO.
- **Reference data:** merchants and mileage rates are editable. Tax lines, import profiles and currencies need a migration.
- **A lapsed plan** stops new books and uploads over quota. Business and rental features on existing books stay on.
- **A password change or session revocation** isn't in the security log (AUTH-12), and profile, family and entities are read-only on the phone (OPS-13). A session card covers both.
- **The zero-downtime claim** rests on the migration check and blue/green config, neither exercised by a real deploy.
- Import parse p95 was 5.7 to 9.0 s locally for 5,000 rows, close to the 10 s limit, and worth watching.

---

## 7g. Since Phase 11

- **Your own storage for files and backups, web and phone** ([ADR-0030](design/adr/0030-your-own-storage.md); BAK-03, BAK-05): Settings → Your own storage lets an owner connect an S3-compatible bucket (AWS S3, Backblaze B2, Wasabi, Cloudflare R2, MinIO) or a WebDAV folder (Nextcloud, ownCloud, Synology).
  - **Mirror, not move.** Montra keeps its own copy, so OCR, previews, matching, retention and quota are unchanged. A copy goes to `<folder>/<kind>/<year>/<date> <name> (<id tail>).<ext>`, by default under `Montra/<workspace>`.
  - **How copying works.** A trigger on `app.file` queues a copy for every upload (receipts, payslips, statements, business files, restores). The system job `storage.mirror` (`apps/api/src/storage/storage-mirror.jobs.ts`) copies under an owner's RLS. It leases rows (`for update skip locked`) and backs off from 1 minute to daily; after 10 tries a row is `failed` until the owner presses "Try failed ones again". Five failures in a row turn the connection to `failing` and send `storage_failing` to each owner, once. Connecting can copy the files already there, and "Copy existing files" does it later.
  - **Credentials.** They're sealed with `FieldCrypto` (`storage_destination.secret`), never returned, and the connection is tested before saving: write a probe file, then delete it. A key that can't delete is accepted, and old backups are then never pruned.
  - **Where Montra may connect.** In production, private, loopback, link-local and metadata addresses and plain http are refused, checked at connect time (DNS rebinding included). `STORAGE_DESTINATIONS_PRIVATE=true` allows them for self-hosting; it's the default outside production.
  - **Deleting.** Trash never touches a copy. Montra's own deletion (trash after 30 days, retention dates) keeps the copy unless the owner turned on "Also delete my copy". Disconnecting forgets the secret and leaves the copies.
  - **Backups.** "Back up now" also saves there (owners; `saveToStorage`). A schedule can go to `storage` instead of an emailed link, and can now have a password: the scrypt key is KMS-wrapped in `backup_schedule.wrapped_key`, and the password is never kept. The newest `keepBackups` (default 12) archives Montra wrote are kept there. `ExportJobDto.storageCopy` says how saving went, and a schedule's owner is told.
  - **Phone.** Status only, on Your data: the connection, its state, and a line on what's copied; each backup row says whether it was saved there.
  - **API.** `/storage-destination` (`GET`, `POST`, `PATCH`, `DELETE`, `/test`, `/backfill`, `/retry`, `/items`). Migration 0029.
  - **Tests.** `apps/api/test/own-storage.test.ts` runs against in-process fake S3 (driven by the real AWS SDK) and WebDAV servers (`test/fakes/storage-servers.ts`), so CI needs no MinIO. The S3 adapter was also checked by hand against the local MinIO on 19000: probe, upload, 3 MB streamed upload, wrong secret, missing bucket.
  - **Not done.** Google Drive, OneDrive and Dropbox each need an OAuth app registered in the owner's name (ADR-0030 §2 lists what), so BAK-05 stays partial. A single PUT caps a copy at 5 GB. Not run on a device or against a real Nextcloud.
- **Patches that kept resetting fields** (BUD-03, BIZ-06, RNT-13): Zod 4's `.partial()` keeps `.default()`, so three patch schemas filled the fields a request left out. Pausing or resuming an expected income on the web cleared its account, payee and member (so deposits stopped matching it); any bill edit dropped its attached files; any maintenance edit, marking it done included, dropped its files and linked transactions. The defaulted fields are now redeclared without a default. `@montra/schemas` has tests now: `test/patches.test.ts` parses every exported `Update…` schema with an empty patch and fails if anything is filled in. A stale expected-income version now answers 409 `version.conflict`, like the rest of the API (it was 422).
- **Editing and archiving goals, web and phone** (BUD-07, BUD-08): each goal on the web has **Edit** (the add form, pre-filled, without kind and books, which can't change) and **Archive** (after a confirmation); archived goals sit in a collapsible list with **Restore**. On the phone, tap a goal for an edit panel with the same fields and Archive behind an `Alert`; archived goals can be restored from the bottom of the screen. Saves send the goal's `version`: a stale one is refused with 409 `version.conflict`, which the web now explains everywhere with a Reload link, and the phone reopens the panel on the latest copy. The patch contract was fixed on the way: Zod 4's `.partial()` keeps `.default()`, so every `PATCH /goals/:id` used to reset the fields it left out (archiving cleared the target, due date, category and linked accounts). The API now also checks a new funding category like create does, and a goal whose linked accounts are all removed gets its own budget category again. Pure phone parts in `src/features/goals.ts`; not run on a device.
- **Explore spending, web and phone** (FLOW-01): Plan → Explore spending on the web, More → Explore spending on the phone. Pick up to 8 categories and 3, 6, 12 or 24 months; see them month by month in a chart and a table (cells drill to transactions), a card per category (trend, average, share of spending, purchases and typical size, biggest month, the pace for 12 months, top places), and what-ifs (cut by a percent or cap a month: the saving, the share of income kept, and months to each goal). Nothing is saved, except through **Make this my budget**: a row with a change shows this month's budget for the category, and the button sets it to the what-if's monthly amount (the average less the cut, or the cap) after a confirmation naming the month, the new amount and what it replaces. It updates the entity's (or member's) budget, or creates one when there is none. `GET /spending/explore` (now with each category's `assigned` and the `budget`), `POST /budgets/set-category`; the arithmetic is `categoryStats`, `whatIf` and `whatIfTarget` in `@montra/domain`.
- **Home's numbers for another period, web and phone** (FLOW-01): the date range under the Home title is a dropdown (a down arrow beside it) that picks the period for the four tiles (income, spent, left to spend, left to assign): the budget's periods, else months, newest first, back to the earliest with any transaction for the entity and member, at most 12 months. Away from the current period it's hard to miss: the tiles sit in a warning-coloured box saying "You're looking at September 2026, not the current period", with **Back to today** and a note that everything else on Home is as of today. It's never remembered: on the web it lives only in the URL (`?period=`), and the phone resets it when you leave Home. The charts keep their own period. `GET /dashboard?period=` returns the list as `periods`.
- **Transfers made real, web and phone** (TXN-04, AI-01): a card payment or move between accounts that was detected as a transfer becomes one when you accept it in review (Make transfer). The other side, when it was recorded separately, is absorbed: both statement lines stay on the transfer and stay cleared, the other side goes to the trash, re-importing either statement finds nothing new, and undoing the import that created the transfer keeps it (reason `transfer`). It stops counting as spending and income. A payment that names another account's last 4 digits is suggested before that account's statement arrives, and that statement later matches the transfer on amount and date. Import dedupe now keys statement lines per account (from `transaction_source`), so a transfer is recognised on both accounts' statements. `POST /transactions/:id/make-transfer`, ADR-0028.
- **Month in review, web and phone** (FLOW-01, AIA-01): Plan → Month in review on the web (and a link on Home), More → Month in review on the phone (and on Home). Pick any of the last twelve months (default: last month). It shows money in and out against your usual (the average of up to three months before with data), what was left over and the share kept, the clearest changes from usual, where the money went, the biggest purchases, how the budget went, and next month's budget from your last three months (BUD-02's median), each line with Make this my budget. The figures are computed; the new `summarize_month` AI task words them in a headline and up to five points (any number it wasn't given fails the call), cached per workspace by its input. With AI off or unavailable, plain sentences from the same figures. `GET /summary/month`.
- **Switching from another app, web** (IMP-13, ADR-0029): Import → "Switching from another app?", the Home card in a workspace without transactions, or the welcome form's choice. Pick the app (YNAB, Monarch, Mint, Lunch Money, Actual, Tiller, Empower, Copilot, Rocket Money, PocketSmith, Simplifi, Goodbudget, Quicken for Mac or anything else) for its export steps, upload the export, then confirm a plan: each account found becomes a new account (opening balance from today's balance or the export's), goes into one you have, or is left out; each category is mapped, created with its group, or left uncategorized (transfers by default). Each account then imports as its own batch (preview, dedupe, undo as usual), and transfers between them are paired with one button. A "spending shows as positive" switch per file covers apps whose sign convention isn't documented. Only for a fresh start: a workspace with its own transactions gets a new workspace instead. Not yet: QIF, OFX/QFX, Actual's database backup; the phone points to the web. `POST /migrations/analyze`, `POST /migrations`.
- **Receipts worth keeping** (UP-09, RCP-11): `/receipts/recommended` now also lists deductible business spending (above the business's threshold) and, when set, everyday spending above the planning settings' reminder amount, cards and imports included. Bills, debt and savings never. Each row has a `reason`. `GET /receipts/habit` gives the week's receipts kept and missing and a streak (`receiptHabit` in `@montra/domain`: the week in progress never breaks it). The phone's Home shows a small card only when something is waiting (three at most, Add or Not needed), or one quiet line when all are kept. The Receipts screen lists them all, and Settings (phone) and Planning settings (web) set the reminder amount. No push notifications.
- **Phone: quick add fits one screen, and asks for the receipt**: the three ways in (scan, type, say) are one row at the top, Expense/Income is a switch, the keypad is slimmer, and the account row shows the three most recently used (the chosen one always among them) with … for the rest (`recentAccountIds`), so nothing needs scrolling. After saving spending, a "Got the receipt?" card opens the camera for that transaction; the photo uploads linked to it (`offersReceipt` in `src/features/quick-add.ts`).
- **Phone: voice entry** (TXN-07): quick add has **Say it** and a microphone beside the sentence box. The phone's speech service (`expo-speech-recognition`) fills the sentence as you speak, and the same parser as typing reads it. No audio is kept. Pure parts in `src/features/voice.ts`.
- **Home charts, web and phone** (FLOW-01): `GET /dashboard/charts` feeds a money-over-time card (3, 6, 12 or 24 months: in, out and left over, plus net worth, with a summary sentence), the budget so far (ahead or behind its pace), where the money went this month, and last month's biggest changes from usual. The phone's Home has the same tiles and cards and a settings button. Shared arithmetic is `summarizeMonths`, `barShares` and `sharePercent` in `@montra/domain`. The web's "on pace to overspend" card and the small net-worth line are replaced by these.
- **Receipts nothing is reading, and AI that can't run** (2026-11-09): two failures that used to be silent now say why and what fixes it.
  - A receipt whose images may not go to the AI (or in local mode) waits for the doc-worker's `receipt.ocr`. With no doc-worker running it said "Reading" forever. `ReceiptDto.stalled` is now set when a `processing` receipt's latest job has waited in its queue past `JOB_STALL_MS` (3 minutes, `apps/api/src/jobs/queue.ts`) or failed, naming the worker it needs (`documents` or `jobs`). The web lists receipts being read above the tabs, with the reason and a link to Settings → AI; the receipt page and the phone say the same ("Not being read").
  - `/v1/status` has `workers.documents` and `workers.jobs`, `delayed` when that worker's queues lag past the same limit (`app.metrics_queue()`). The workspace layout and `/status` show a line for each delayed worker.
  - "Your own API key" with no key used to turn every AI feature off without a word. Saving mode `byok` (Anthropic) without a key is now refused (`ai.key_required` on `apiKey`, checked on the web form too). Removing the key is still allowed, and `AiSettingsDto.problem` (`no_key`, `no_endpoint`, `not_configured`) puts a warning on the AI settings page. Features that degrade without AI (receipts, payslips, questions, scanned PDFs, the provider test) give that reason and fix instead of "AI is off".
- **Receipts read by Claude** (`extract_receipt.v2`): the schema now fits Anthropic's limit of 16 nullable parameters; a test covers every AI task.
- **Phone: receipt uploads**: pages upload natively with a time limit; a capture waiting to retry shows why and when, with Try now.
- **Phone: look and feel**: Lucide icons by meaning (`src/ui/icons.tsx`), tinted fills (`primarySoft`, `dangerSoft`, `warningSoft`, `surfaceAlt` in `src/ui/palette.ts`, with an AA contrast test for every text-on-fill pair), cards with soft depth, filled fields, banners with icons, rows with leading icons, a tab bar with icons and a raised Add button, More grouped into sections, haptics (`src/ui/haptics.ts`: tap, select, success) and a check animation when quick add saves (`SuccessBurst`).
- **Phone: transaction filters** (FAM-09): a filter button beside search opens a side panel with a date range (presets or custom, with the native date picker), accounts (a whole kind at once) and family members (the household too). The list updates as you choose; active choices show as removable chips. The device store gained `txn.member_id` (local schema version 2, filled from each row's JSON on upgrade) and `accountIds`, `memberIds`, `from` and `to` on `TransactionQuery`.
- **Phone: a tighter layout, and leaving quick add**: screens, cards, rows, buttons and fields use less padding (`th.pad` 12, tappable items at least `th.tap` 44 pt), with slightly smaller title and amount text. Adding a transaction has Back and Cancel on every step after the amount, Android's back button goes back a step, and leaving the + tab discards an unsaved entry (`previousStep` in `src/features/quick-add.ts`).
- **Android startup** (#37 and this fix): the app lock's startup checks have a time limit, an app-wide error screen shows what failed, and the translator no longer needs `Intl.PluralRules`, which Hermes on Android lacks. That was the gray screen on the APK from `android-apk/**` builds ([runbook](runbooks/android-apk.md)).
- **Account types on the phone** (ADR-0024 to ADR-0027): an account's screen shows what its type needs above the register. A tracked loan shows its next payment, payoff date, the next few payments, and records a payment (online only). A card or line of credit shows what's due, the due date, the minimum and utilization; an investment or 401(k) its gain, return and money in, or the PAY-09 message when the server hides them; savings the interest this year; a home or car its equity against the linked loan; money owed its due date. Figures are read live from the existing endpoints and kept for offline viewing (`useCached`); setting each type up stays on the web. More → Accounts counts your share of rental properties from net worth, as the web does. `apps/mobile/test/accounts.test.ts`; not run on a device.
- **Accounts page** (`/w/{id}/accounts`, and More → Accounts on the phone): accounts by kind, with totals per kind and for everything, from `summarizeAccounts` in `@montra/domain`, so web and phone agree. "Add account" is a button there, not a menu item. Currencies are totalled apart, not converted, and the net excludes property values, so it can differ from net worth on Home. The phone version hasn't been run on a device.
- **Savings, homes and cars, cash, other money owed** ([ADR-0027](design/adr/0027-remaining-account-types.md)): savings shows interest earned this year; a home or car holds its purchase and the loan against it, and shows equity; cash is counted rather than imported; money owed outside a bank can have a due date, which reaches the calendar and reminders. The Accounts page now counts your share of rental properties, so its net matches Home. This finishes the account-type plan.
- **Card and line-of-credit statements** ([ADR-0026](design/adr/0026-card-statements.md)): a statement day and due day give the latest statement, what's still due, the minimum and utilization, worked out from the ledger. A payment rule (statement balance, minimum or a set amount, from a bank account) plans the payment for the forecast and calendar; it doesn't make it. The card's page pays it in one click, and Upcoming lists what's due. Lines of credit are now forecast like cards. Interest isn't calculated.
- **Retirement accounts and gains** ([ADR-0025](design/adr/0025-retirement-and-gains.md), ACC-07): an investment account has a plan type and can take an employer's payslips, the match optional. Values come from statements, typed or pasted, and post the difference as a change in value against Investment gains and losses, never income. The account page shows gain, money in and out, and return by period. Hidden from anyone who can't see all of the account's money. PDF statements aren't done.
- **Loan tracking** ([ADR-0024](design/adr/0024-loan-tracking.md)): adding a mortgage or loan offers tracking only the balance or payments too, and an existing account can start later. Payments are worked out from what's owed, split into principal and interest, and shown on the calendar, forecast, Recurring and Upcoming. They link to a statement line, take one click to record, or record themselves if asked. Rental loans use the same engine. A budget doesn't count principal as money going out.
- **Account types** ([ADR-0023](design/adr/0023-account-type-profiles.md)): one definition per type in `@montra/domain` that the form, the account page, Settings and the server read. The form asks only what a type has, and the page shows those facts and the balance over time. The per-type plan built on it is done (ADR-0024 to ADR-0027). The phone shows the type, balance word and each type's details, but no chart yet.
- **Splitting pay** ([ADR-0022](design/adr/0022-splitting-pay.md)): fixed amounts to other accounts, and the rest to the main one, as a plan on the employer. Each deposit is its own transaction and matches its own statement line. Editing is on the web; the phone shows the split and answers which-deposit questions. Forecasts expect each account's share on payday. The phone hasn't been run on a device.

---

## 8. Session checklist

1. `git checkout develop && git pull`, then `git checkout -b claude/<topic>` (or continue the open feature
   branch).
2. `docker compose -f infra/docker-compose.yml up -d && pnpm install && pnpm db:migrate`.
3. Read this file, then the design sections for the area.
4. Work contracts first. Commit in small coherent steps.
5. Run `pnpm verify` (and `pnpm verify:py` for doc-worker changes) and e2e when UI or API flows change.
6. Update `status.json` (then run `node scripts/gen-traceability.mjs`), `CHANGELOG.md` at phase end, and
   **this file**.
7. Push the feature branch and open a PR into `develop`. After the merge, tag `v0.N.0-dev.1` on `develop`.
