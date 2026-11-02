# Montra: project status and hand-off

_Last updated 2026-11-02, after the first Phase 5 session (contracts and receipt arithmetic on `claude/phase5-receipts-fx`). Keep this file current: update it at the
end of every work session and every phase._

This is the hand-off for the next session, human or Claude. It covers what is done, what is left, the
workarounds already in place (so nobody undoes them) and what to pick up next. Read it after
[`CLAUDE.md`](../CLAUDE.md).

---

## 1. Snapshot

| | |
| --- | --- |
| **Integration branch** | `develop`: Phases 0–4 merged. Last merge was PR #4 (Phase 4) at `bee2b04` |
| **Release branch** | `main`: no release yet. R1 `v1.0.0` lands at the end of Phase 11 |
| **Tags** | `v0.1.0-dev.1` Phase 0 · `v0.2.0-dev.1` Phase 1 · `v0.3.0-dev.1` Phase 2 · `v0.4.0-dev.1` Phase 3 · `v0.5.0-dev.1` Phase 4 |
| **Pull requests** | #1 Phase 1, #2 Phase 2, #3 Phase 3, #4 Phase 4, all merged into `develop` with green CI |
| **Requirements** | 252 IDs in total: **79 done, 29 partial**, the rest not started. The source is `docs/design/status.json`, rendered in `docs/design/traceability.md` |
| **In progress** | **Phase 5: receipts and multi-currency** on `claude/phase5-receipts-fx` (not pushed yet). Steps 1–2 of §7 done; see §7 "Progress" |

### Test suite (Phase 4 hand-off plus this branch; green locally)

| Suite | Tests |
| --- | --- |
| `@montra/api` (integration, real Postgres) | 83 |
| `@montra/categorize` | 70 (69, plus the perf budget run alone) |
| `@montra/web` unit | 70 |
| `@montra/doc-worker` (pytest, real Tesseract) | 71 |
| `@montra/domain` | 71 |
| `@montra/importers` (incl. a 22-file golden corpus) | 55 |
| `@montra/ai-gateway` (offline; fake and mocked providers) | 41 |
| `@montra/mobile` (pure modules; MemoryStore and SqliteStore contract tests) | 31 |
| `@montra/db` (ledger triggers, RLS, receipts) | 26 |
| `@montra/sync` (against a fake server) | 17 |
| `@montra/api-client` · `@montra/i18n` | 10 · 5 |
| Playwright e2e (API + worker + web, `AI_PROVIDER=fake`) | 9 specs |
| Mobile bundles | `expo export` for iOS and Android: about 5.2 MB Hermes bundles each |

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

| Phase | Title | State | Notes |
| --- | --- | --- | --- |
| 0 | Foundations and walking skeleton | ✅ done | Monorepo, CI, design docs (01–11), ADR-0001…0011, money/date domain |
| 1 | Core ledger and manual capture | ✅ done | Double-entry ledger, RLS, Kratos adapter, web app, recurring, sharing |
| 2 | Import pipeline | ✅ done | CSV/XLSX/XLS/PDF import, dedupe/matching, undo, reconciliation, Postgres job queue |
| 3 | AI gateway and categorization | ✅ done | Gateway, rules, six-step pipeline, review queue, learning, insights, OCR scans |
| 4 | Mobile foundation and offline sync | ✅ done (device checks pending) | Expo app, encrypted store, outbox sync with field-group LWW |
| **5** | **Receipts and multi-currency** | 🚧 **in progress** | Contracts and domain arithmetic done; see §7 |
| 6 | Budgeting, money flow and recommendations | not started | Budgets, dashboard, forecast, Sankey, net worth, recommendations |
| 7 | Family members and payslips | not started | Payslip capture and posting, per-member reports |
| 8 | Small business | not started | Invoices, bills, mileage, Schedule C, quarterly estimates, accountant export |
| 9 | Rental properties | not started | Units, leases, rent roll, Schedule E, depreciation, metrics |
| 10 | Reports, search, notifications, data ownership | not started | Report catalogue, search, notification engine, export, backup/restore |
| 11 | Hardening and launch | not started | Terraform, observability, billing, WCAG, pen test → `v1.0.0` on `main` |

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
  - AIA-09, AI-11: the real-provider accuracy benchmark (target ≥ 85%) and the 1,000-row timing. Both
    need `ANTHROPIC_API_KEY`. Run:
    ```bash
    pnpm --filter @montra/ai-gateway eval -- --provider anthropic --split test
    ```
- **Finished by a later phase, as planned:**
  - AIA-01: summaries and Q&A, in Phases 6 and 10.
  - AIA-12 and NFR-14: tax outputs, in Phase 8.
  - AI-02: property and unit, in Phase 9.
  - FAM-05: receipt items, in **Phase 5**.
  - PLT-03 and UP-07: mobile screens arrive with each feature phase.
  - UP-06: the privacy center, in Phase 10.
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

1. **Transfers.** Pipeline step 3 detects a likely transfer and explains it in review, but doesn't yet
   **convert** the pair into a transfer between the two accounts. Matching the other side is manual.
2. **Local-mode AI tasks.** Results the client posts to `POST /ai/tasks/:id/result` are stored but not
   yet applied to rows or review suggestions.
3. **More bring-your-own-key adapters:** OpenAI, Gemini and Azure. Only Anthropic and OpenAI-compatible
   endpoints exist.
4. **S3 storage** is only stub-tested; there is no MinIO run in CI.
5. **Undoing an import** doesn't take back payee history learned from categories picked during that
   import's preview.
6. **Mobile has no React Native Testing Library screen tests.** Pure modules have unit tests; screens rely
   on the export builds and on the Maestro flows, which haven't been run.
7. **Mobile Home** shows money spent and received this month, not "left to spend", until budgets arrive in
   Phase 6.
8. **Camera library:** the camera spike uses `expo-camera`. Moving to `react-native-vision-camera`
   (frame processors, ML Kit / VisionKit edge detection) is the Phase 5 option, decided by the spike. ADR-0009
   stays *proposed* until the spike runs on devices.
9. **Commit speed:** an import commit takes about 11 ms per row, so 5,000 rows take about a minute
   (with a progress bar). Bulk posting would speed it up later.
10. **Account-only transfer candidates:** transfer detection only pairs existing transactions, so a card
    payment whose bank side hasn't been imported yet gets no transfer suggestion.

---

## 5. Issues already solved, and their workarounds (don't undo these)

| Area | Issue | Fix in place |
| --- | --- | --- |
| DB | `citext` not found inside `SECURITY DEFINER` functions (restricted `search_path`) | Use qualified names (`public.citext`) and `set search_path = app, pg_temp` |
| DB | Commit cost 59 ms per row; RLS helper functions dominated | Migration 0009 caches the helpers per transaction (GUCs plus `app.cache_gen`, bumped on membership or grant changes); 0008 runs one balance check per entry; the change log takes one seq per transaction; a ledger `UnitCache` per transaction. Now about 11 ms per row |
| DB | The audit trail recorded `field_clock` changes | `audit_row` excludes `field_clock` (redefined in 0011) |
| DB | The batch's `job_id` pointed at the doc job, so a failure in the chained parse job left the batch on "parsing" | `ImportsService.get` reads the latest job for the batch (`payload->>'batchId'`) |
| Tests | Vitest `globalSetup` ignores the custom export condition `@montra/source` | `vitest.shared.ts` `sourceAliases` maps every workspace package to its TS source. **Add new packages there** |
| Tests | API test data | `test/global-setup.ts` recreates `montra_test_api` and loads reference data. Tests need Postgres running |
| Tests | `@montra/categorize` perf budget (5,000 × 100 rules < 2 s) failed on 2-vCPU CI runners under parallel turbo load | Excluded from the default run; `test:perf` runs it alone (best of three) in CI and in `pnpm verify`. The budget is unchanged |
| Tests | Fake-provider AI auto-categorizes manual entries in e2e, which broke specs that assumed "uncategorized" | Specs set the review threshold to 99% (`setAi(page, { threshold: 99 })`) or pick categories the fake provider wouldn't choose |
| Lint | `no-restricted-properties` bans `Math.round` (money safety) | Non-money values use `Number(x.toFixed(n))` or `Math.trunc` |
| Kysely | `onConflict(...).doUpdateSet({ col: eb => eb.ref('excluded.col') })` doesn't type-check on JSON columns | Use `` sql`excluded.col` `` |
| Importers | `SP *` prefix stripping ate "SP" from SPOTIFY; Amazon/Apple variants | Prefix patterns require the `*`; Amazon and Apple use name synonyms instead of stripping |
| Importers | Chase's "Details" column was appended to descriptions | A second description column must contain real text (average length ≥ 10, ≥ 60% distinct values) |
| Importers | PDF statements with ambiguous dates and 2-row balance checks | The statement period disambiguates the date format; the running-balance fit returns NaN below 3 rows |
| Imports | Re-importing duplicated a manual entry that had been matched earlier | Transactions with a `transaction_source` count as imported candidates |
| Imports | The AI column mapping replaced the heuristic warnings even when not confident | The AI mapping is adopted only if its confidence × parse rate ≥ `MAPPING_OK` (0.75) |
| Sync | `hasMore` was wrong after the per-transaction seq change | It's computed with an existence query after the page's last seq; pages never end inside a seq group |
| Sync | A `duplicate` replay result carries no transaction, which left the local row pending forever | The engine drops `pending` when no other ops remain for that id; the next pull brings the server copy |
| Web | The editor treated the uncategorized system account as a chosen category, so it never asked for a suggestion | `toEditState` maps `uncategorized_*` postings to an empty category |
| Web | Fixtures broke whenever DTO fields were added | Update `apps/web/lib/*.test.ts` fixtures in the same change as the DTO |
| CI | Prettier failures (for example `infra/kratos/kratos.yml`) | `pnpm verify` runs `format:check` first. Run `pnpm format` before pushing |
| Mobile | `react-native-vision-camera` setup on SDK 58 | Used `expo-camera` for the spike. Swipe review uses `PanResponder`; transaction rows use `ReanimatedSwipeable` |
| Mobile | Metro with pnpm workspaces and the `@montra/source` condition | `apps/mobile/metro.config.js` sets watch folders and resolves workspace packages to their sources |
| Windows | With `core.autocrlf=true` every file was checked out CRLF: the Postgres init script failed in the container ("required file not found") and `format:check` failed | `.gitattributes` forces LF. In a clone made before it, run `git config core.autocrlf false` and re-check out (or strip CR from tracked files) |
| Windows | `LocalStorage` rejected every key (`path.normalize` turns `/` into `\`), failing 17 upload tests | Keys are checked with `posix.normalize`; containment with `path.relative`. `test/storage.test.ts` covers it |
| Local | Host ports 5432/1025/8025/9000 taken by other stacks | Compose ports read `MONTRA_PG_PORT` etc. (defaults unchanged; put them in the gitignored `infra/.env`). Point `DATABASE_URL`, `DATABASE_ADMIN_URL` (montra_test) and `API_DATABASE_URL`, `API_DATABASE_ADMIN_URL` (montra_test_api) at that port; turbo passes all four to tests |
| Local | `minio/minio` on Docker Hub is no longer pullable, which aborted `docker compose up` | Compose uses `quay.io/minio/minio` |
| Local | `perf-commit.test.ts` (300-row commit < 9 s) measured 9.4 s once under full parallel `pnpm verify` on a busy Windows machine; it passes run alone (about 7 s for the whole test) and in CI | Not changed. If it recurs, move it to a run-alone step like `test:perf` rather than raising the limit |
| Process (cloud) | The cloud sandbox couldn't push tags | Not an issue locally: tag from your machine |
| Process (cloud) | Container restarts killed Postgres and in-flight workers | Locally, run Postgres in Docker. Commit early and often in long tasks |

---

## 6. What is and isn't verified

| Verified (automated) | Not yet verified |
| --- | --- |
| Ledger invariants, RLS isolation, the DE-10 edit rules | A live Kratos server (sign-up, MFA, recovery emails) |
| Import corpus (22 layouts), dedupe, undo, reconciliation | S3/MinIO storage |
| AI pipeline with the fake provider, rules, learning, review, insights | **Real-provider accuracy (≥ 85%) and latency** |
| Scanned-PDF OCR with real Tesseract | Real scanned statements end to end through both workers *(the parts are tested separately)* |
| Offline sync: server, engine, and two simulated devices against the real API | **Mobile on devices**: SQLCipher, biometrics, camera, share sheet, push, gestures, Maestro |
| Mobile iOS/Android bundles build; store contract tests | The camera spike (ADR-0009 go/no-go) |
| Web e2e: 9 flows (happy path, import, reconcile, mapping, review, rules, AI off, quick add, Phase 1a) | Production infrastructure (Phase 11) |

---

## 7. Next: Phase 5, receipts and multi-currency

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
     *transaction* amount;
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

**Progress (branch `claude/phase5-receipts-fx`):**
- ✅ **Step 1, contracts:** migration `0012_receipts_fx.sql` (receipt, receipt_line, trip, `ref.currency`,
  `ref.fx_rate` with `app.upsert_fx_rates`, transaction `trip_id`/`local_time`/`fx_rate_source`,
  `posting.receipt_line_id`, file retention, OCR `tsvector`); Kysely types; `schemas/fx.ts` and
  `schemas/receipts.ts`; `TransactionDto.foreign/tripId/localTime`; currencies in reference data; ADR-0014
  (*proposed*); DB tests for RLS and constraints.
- 🟡 **Step 2, domain:** `packages/domain/src/receipt.ts` has validation, grouping and allocation, returns,
  fitting to the charged amount (tip tolerance), conversion at the implied rate and the ±3% deviation. Both
  exit criteria are unit tests there. **Still to do:** the IMP-11 matching score (date ±5 days, amount
  tolerance, merchant similarity → score ≥ 0.8 auto-links) and the ADR-0010 posting side (carrying rate on
  outflows, realized `fx_gain_loss`, `fx_rounding` lines).
- ⏭ **Next:** step 3 (FX rates service: ECB loader with recorded XML fixtures, `fx.daily` job) and step 4
  (`extract_receipt`) can run in parallel; then the API (step 5).

**Decisions and inputs to confirm with the product owner before or during Phase 5:**
- whether an Open Exchange Rates app ID will be provided (otherwise the app is ECB-only, which covers
  about 30 currencies);
- an `ANTHROPIC_API_KEY` for real receipt extraction tests, which aren't possible with the fake provider;
- results of the camera spike on real devices (`docs/design/spikes/phase4-camera.md`), to settle the camera
  library.

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
