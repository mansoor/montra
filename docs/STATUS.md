# Montra: project status and hand-off

_Last updated 2026-11-23. Phase 11 is code complete and merged; launch steps remain. Keep this file current:
update it at the end of every work session and every phase._

This is the hand-off for the next session, human or Claude. It covers what is done, what is left, the
workarounds already in place (so nobody undoes them) and what to pick up next. Read it after
[`CLAUDE.md`](../CLAUDE.md).

---

## 1. Snapshot

|                        |                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integration branch** | `develop`: Phases 0–11 merged, and the work since (§7g). Last merge was PR #193 at `99e8105` (2026-11-22)                                                                                                                                                                                                                                                                           |
| **Release branch**     | `main`: no release yet. R1 `v1.0.0` lands at the end of Phase 11                                                                                                                                                                                                                                                                                                                    |
| **Tags**               | `v0.1.0-dev.1` Phase 0 · `v0.2.0-dev.1` Phase 1 · `v0.3.0-dev.1` Phase 2 · `v0.4.0-dev.1` Phase 3 · `v0.5.0-dev.1` Phase 4 · `v0.6.0-dev.1` Phase 5 · `v0.7.0-dev.1` Phase 6 · `v0.8.0-dev.1` Phase 7 · `v0.9.0-dev.1` Phase 8 · `v0.10.0-dev.1` Phase 9 · `v0.11.0-dev.1` Phase 10 · `v0.12.0-dev.1` Phase 11, then one `v0.12.0-dev.N` per merge since (latest `v0.12.0-dev.140`) |
| **Pull requests**      | #1–#17 Phases 1–10, #18 Phase 11, then the work in §7g, up to #193. Each merged into `develop` with green CI                                                                                                                                                                                                                                                                        |
| **Requirements**       | 350 IDs in total: **283 done, 53 partial**, 14 not started. The source is `docs/design/status.json`, rendered in `docs/design/traceability.md`                                                                                                                                                                                                                                      |
| **Next**               | The owner's decisions and `docs/runbooks/launch-checklist.md`. `v1.0.0` isn't ready                                                                                                                                                                                                                                                                                                 |

**Built:** [ADR-0052](design/adr/0052-tax-forms-received.md), tax forms received (W-2, 1099-INT, 1099-DIV and 1098
read, matched and reconciled against the books, then added to the tax package), accepted by the owner on 2026-11-16.
All five PRs are done: storage, typing a form in and the owner's accountant setting (PR 1, migration 0059); the checks
against the books, expected forms, Review and the `/tax-forms` screen (PR 2); reading uploaded forms, masked text only,
and matching them automatically (PR 3); the phone (PR 4, not run on a device yet); and the tax package, retention and
the 16 February reminder (PR 5, migration 0060); see §7g. Role-based permissions (ADR-0053) are a separate proposal for
later; tax forms use an owner-only setting for accountants instead.

**Accepted 2026-11-24, built:** [ADR-0057](design/adr/0057-vault-statement-pdfs.md), statements the
vault doesn't keep (CSV, XLS, OFX, QIF, a bank's own layout) sent as PDFs drawn from the imported rows, with a cover
page and, by default, the original attached inside. Each sent group chooses: don't send, convert, or convert with the
original attached. Accounts gain holder names and a sealed full account number. All three PRs are built (accounts,
migration 0091; rendering, 0092; sending, 0093); see §7g. PDF/A and bank-feed statements are on the backlog.

**Proposed and deferred, no build scheduled:** [ADR-0053](design/adr/0053-lightweight-rbac.md), lightweight RBAC (the six roles
become default permission sets, with per-person switches in Settings → Sharing). Plan only; ADR-0052's owner-only
accountant setting is what it would replace.

**Built, the chain complete (2026-11-20):** [ADR-0055](design/adr/0055-bank-feeds-simplefin.md), bank feeds per workspace, with
SimpleFIN Bridge as the first provider behind a provider port, accepted by the owner on 2026-11-19. An owner (recent
sign-in) pastes a SimpleFIN setup token, Montra claims it once and seals the access URL, each institution account is
linked to a Montra account, and a daily sync (plus Sync now for owners, admins and partners, within SimpleFIN's daily
limit) brings posted transactions only through the existing import pipeline, one batch per account, with the provider's
id as the dedupe key. Clean syncs import themselves with Undo; others wait in Review. Feeds sit alongside uploaded
statements, and the first sync starts the day after the account's latest transaction, at most 90 days back, or from a
date picked when linking. A `bankFeeds` plan key, in every plan with `ownStorage`, now shown in the plans. All
six PRs are merged (PR 1 to PR 5, PR 3 in two parts; #157–#162), and a live run against SimpleFIN's demo passed (see §7g).

**Built, the chain complete (2026-11-18):** [ADR-0054](design/adr/0054-family-document-vault-storage.md), the household's Family
Document Vault as a per-workspace storage destination (`fdv`), accepted by the owner on 2026-11-17. Montra connects
with an API key the vault generates for it, pasted by an owner and sealed (a key pair and signed requests until vault
0.9.0-dev.63). Documents go one way, Montra to the vault, one at a time. The vault is
additional storage, and a document filed there is the household's record. Each group (receipts, statements, bills,
payslips, tax documents, other) has a mode, as the owner clarified on 2026-11-17: not sent, sent with a local copy kept,
or sent with no local copy; payslips and tax documents are not sent until an owner chooses otherwise, and the vault
decides whose Inbox each lands in. Montra's copy is removed only for a group sent with no local copy, once the vault has
filed the document. Montra reads back the vault's changes to what
it sent, and opens documents through single-use view links. A file the vault doesn't return is listed in Review to be
uploaded again, and backups and tax packages list any still missing. The owner chose to depend on the vault's client
library as a published package: **PR 1 (contracts, migration 0063), PR 2 (connecting), PR 3 (sending, with a
local copy kept; migration 0064) and PR 4 (keeping in step and view links; migration 0065) are done**, and **PR 5a
(`FileBytes`: every reader of a file's bytes reads it from Montra, the owner's storage or the vault; migration 0066) is
done** on `@fdv/client` 0.9.0-dev.62 from the vault's public GitHub release (see §7g). **PR 5b1** ("sent with no local
copy": removing Montra's copy, missing files and Review's "Files to provide again", quota; migration 0067) is done,
and **PR 5b2** (the move backfill offered after saving, bringing files back, the disconnect choice as a soft disconnect,
the archive's missing count and its one wait, restore marking, and the possible-duplicate warning; migration 0068) is
built, **the API-key PR** (vault 0.9.0-dev.63–65: an owner pastes the API key the vault generates for Montra, in
place of Montra's Ed25519 key and signatures; client dev.65) is built, and **PR 6** (the phone: the vault's status in
Your data, badges, "Open in the vault" through a link answered in the body and handed to the system browser, and the
duplicate question on the phone's own uploads) ends the chain. Still to do by hand: one live run against the vault's
development build behind HTTPS (§15), and trying the phone on the LAN APK. On the vault's side, view links,
deletes, automatic filing and routing to the person a paper is about have shipped. The vault's API contract is private
and is not copied into this repo.

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
  - AIA-09, AI-11: **measured on 2026-11-21** with `claude-haiku-5-5`. Accuracy was 97.3% on the 1,056-row test
    split (86.7% on 2026-11-03; target ≥ 85%), macro-F1 0.972, about 44 s for the split in 10 calls, and $0.05.
    Calibration is refit on the train split (ECE 0.011 on the test split, from 0.140; see §7g). Rerun with:
    ```bash
    pnpm --filter @montra/ai-gateway eval -- --provider anthropic --split test
    ```
    Reports (in `eval/reports/`, not committed) now keep each row's raw score and outcome, so a curve can be fitted
    and checked offline.

- **Finished by a later phase, as planned:**
  - AIA-01: a monthly summary and a budget recommendation by AI.
  - ~~AIA-12 and NFR-14: tax outputs, in Phase 8.~~ Done: every tax and money-advice output carries the line (see §7g).
  - ~~AI-02: AI doesn't suggest a property or unit.~~ Done: the pipeline suggests the rental property and unit (see §7g).
  - PLT-03 and UP-07: mobile screens arrive with each feature phase.
  - AI-07: logos, via reference data.
- **Phase 11 hardening:**
  - NFR-01: the AWS KMS adapter and TLS.
  - NFR-07: performance; the dashboard target is in Phase 6.
  - NFR-12: load testing.
  - ~~AUTH-05: email templates.~~ Done: one layout for the API and Kratos (see §7g).
  - ~~AUTH-08: CAPTCHA at the edge.~~ Done in the auth gateway, off by default (ADR-0056, see §7g).
  - ~~OPS-05: the reference-data admin editor.~~ Done: tax lines and bank import layouts too, and staff edits survive
    deploys (see §7g). Currencies stay with the code.
  - OPS-06: dependency updates beyond Renovate.
  - OPS-07: alerting.
  - PLT-01: Firefox and WebKit run the main flows in CI (see §7g); a manual WCAG audit is NFR-10.

### Cross-phase backlog (known gaps not tied to one requirement)

1. ~~**Transfers.**~~ Done: accepting a suggested transfer in review (web or phone, one at a time or "accept all
   above") makes it a transfer and absorbs the other side (`POST /transactions/:id/make-transfer`). Import now makes
   pairs at or above the workspace's setting (default 0.95) transfers on its own, and either kind can be undone from
   the transaction (see §7g).
2. ~~**Local-mode AI tasks.**~~ Done: a posted answer is used where a provider's would be, and applied to the import
   or receipt it was for (see §7g).
3. ~~**More bring-your-own-key adapters.**~~ Done: OpenAI, Google Gemini and Azure OpenAI (see §7g).
4. ~~**S3 storage** is only stub-tested.~~ Done: CI runs it against a real MinIO (see §7g).
5. ~~**Undoing an import** doesn't take back payee history.~~ Done: an undo forgets what the import's transactions
   taught (see §7g).
6. ~~**Mobile has no React Native Testing Library screen tests.**~~ Partly done: Jest with `jest-expo` and React
   Native Testing Library render screens in `apps/mobile/screens-test` (`pnpm --filter @montra/mobile test:screens`;
   `test` and CI run them too). Six screens have tests so far: settings, books, profile, receipt review, sign-in and
   transactions (see §7g). The other screens still rely on the export builds and the Maestro flows, which haven't
   been run.
7. ~~**Mobile Home**~~ now shows left to spend and left to assign, like the web.
8. **Camera library:** the camera spike uses `expo-camera`. Moving to `react-native-vision-camera`
   (frame processors, ML Kit / VisionKit edge detection) is the Phase 5 option, decided by the spike. ADR-0009
   stays _proposed_ until the spike runs on devices.
9. ~~**Commit speed.**~~ Done: an import commit writes its new transactions 500 at a time (see §7g). 1,000 rows
   commit in about 5.8 s, from 16.2 s, on the owner's dev PC. Most of what's left is the audit and change-feed
   triggers every ledger row runs.
10. ~~**Account-only transfer candidates.**~~ Done: a payment whose text names another account's last 4 digits is
    suggested as a transfer (0.80) before that account's statement arrives, and that statement later matches it.
11. ~~**Payment lines share a payee key.**~~ Done: a payment or transfer to an account is keyed by its last four
    digits ("TO ••4321"), and migration 0076 moved what was stored under the shared key (see §7g).
12. ~~**Patch schemas that fill defaults.**~~ Done: every `Update…` schema now leaves omitted fields out, and
    `packages/schemas/test/patches.test.ts` checks them all.
13. ~~**Receipt line quantity and unit price**~~ Done: every line shows quantity × unit price = total; quantity 1 at
    the line's total when neither is printed (see §7g).
14. ~~**Phone receipts don't show tax and tip**~~ Done: the phone shows subtotal, discount, tax, fees, tip and total
    under the lines (see §7g).
15. **PDF/A for documents sent to the vault.** ADR-0057 renders statements the vault doesn't keep as ordinary PDFs.
    Making them conforming PDF/A for long-term archiving is for later (owner's answer, 2026-11-24). It may mean
    rendering in the document worker with reportlab instead of pdf-lib.
16. **Monthly statement PDFs for bank feeds.** A feed has no file; ADR-0057's renderer could make one per month. Not
    now (owner's answer, 2026-11-24).

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
| Import corpus (22 layouts), dedupe, undo, reconciliation; S3 storage against MinIO                   | A real cloud bucket (AWS S3, Backblaze B2, R2) for files and backups                        |
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
  - The transfer form asks for the amount received across currencies (CUR-08), and previews the FX cost (see §7g).
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
  - ~~CUR-08: FX-cost display.~~ Done: web and phone (see §7g);
  - RCP-10: purge after retention (done since, migration 0079; see the end of §7g);
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
- FLOW-06: done since; owner draws and contributions are drawn as transfers between books (see §7g).
- REC-06: unused subscriptions are now hinted at from spending (see §7g). REC-04's wording can name at-risk bills
  awkwardly.
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

- ~~FAM-10 (could-have) isn't started: marking education expenses for credits or 529 withdrawals.~~ Done (see §7g).
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
- ~~Invoice PDFs print Latin text only.~~ Done: embedded Noto fonts (ADR-0032, §7g). Korean and emoji still print "?".
- A deposit pays one invoice: one cheque for two invoices needs splitting by hand. Bills can't be part paid.
- Foreign-currency invoices and bills are refused.
- Estimated-tax periods are calendar-based on purpose: they're the owner's Form 1040-ES payments. Since ADR-0037 the
  business's fiscal year sets the P&L's year and the Schedule C summary (§7g).
- The mileage rate editor is the admin screen in Phase 11; until then a new rate is a reference-data change.
- Reminders appear on the calendar and as suggestions, and since Phase 10 by push and email too.
- Mobile: invoices and bills are read-only (an invoice's PDF can be shared), and there's no device run yet.
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
- Mobile: logging rent, and (since RNT-22) contacts and tenants read-only. Everything else is managed on the web.
- RNT-15 and RNT-16 (could-haves) aren't started.
- Tenant details, co-signers and occupants, lease set-up costs, HOA and home warranty categories and property contacts came later (RNT-17..22, ADR-0038; see §7g).

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
- **OPS-13**: done since; the phone now edits profile, family, books, AI mode and quiet hours (see 7g).
- **AUTH-12**: password, two-step and device changes are logged (ADR-0045); support access waits for the Phase 11 tool.
- **OPS-10**: SPF, DKIM and DMARC with Phase 11's domains. **BAK-09**: ageing out of backups with Phase 11's infrastructure.
- **BAK-08**: photos are compressed on the web as on the phone, and a person can keep originals (see 7g). Partial until
  tried on a real phone and in real browsers.
- **CUR-06**: done since; net worth now shows unrealized FX gain or loss on the web and the phone (see 7g).
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
3. ~~**Is an emailed code acceptable for AUTH-05?**~~ Yes (owner, 2026-11-21). The requirement now says a code; an
   emailed link is AUTH-19, a future enhancement if users ask for it.
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
- **PLT-01:** Chromium runs every e2e spec; Firefox and WebKit run seven main-flow specs (§7g). No real Safari or Edge.
- **The status page** runs on the same stack it reports on, so it goes down with it. It needs a separate host before launch.
- **Staff sign-in** is the ordinary one with a second factor, not SSO.
- **Reference data:** merchants, mileage rates, tax lines and bank import layouts are edited in the console and keep
  staff's edits through deploys. Currencies ship with the code on purpose (ISO 4217 changes need a release; see §7g).
- **A lapsed plan** stops new books and uploads over quota. Business and rental features on existing books stay on.
- **Profile, family and entities** are edited on the phone too now (OPS-13, see 7g).
- **The zero-downtime claim** rests on the migration check and blue/green config, neither exercised by a real deploy.
- Import parse: a realistic 5,000-row statement now takes 3.6 to 6.0 s locally, from 9.0 to 10.7 s, against the 10 s
  limit, and `perf-parse` holds it to that in CI (§7g). The transfer candidate query still grows with the workspace's
  size. Not measured on real infrastructure.

---

## 7g. Since Phase 11

- **Reconciliation: the statement chain, adjustments, undo and history, web and phone** (DE-11..15,
  [ADR-0039](design/adr/0039-reconciliation-chain-adjustment-undo.md), migration 0039):
  - **Chain**: each statement opens at the last completed one's ending balance (0 for the first) and shows opening,
    cleared deposits, cleared payments, ending balance and difference. A new statement must be dated after the last one;
    the start form suggests the next date (a card's statement day, else a month on, keeping month ends). A warning shows
    when the lines reconciled up to the previous statement no longer add up to the opening balance.
  - **Adjustment**: with a difference left, Finish with an adjustment posts a "Reconciliation adjustment" on the statement
    date (Uncategorized income or expense unless another category is picked), reconciled with the statement and flagged
    in the history.
  - **Undo**: owners and accountants, the account's latest completed reconciliation only, with a reason (audit action
    `reconciliation.undo`) and a recent sign-in; refused in a closed period. Lines go back to cleared and entries unlock
    unless another statement still reconciles them. `app.guard_posting` now refuses every other un-reconcile, even under
    `app.allow_locked_edit`; only the undo sets `app.allow_unreconcile`. `journal-entries/:id/unlock` refuses entries
    with a reconciled line (`journal_entry.reconciled`).
  - **History**: `/accounts/:id/reconcile/history`, linked from the account page; "Reconciled through <date>" on the
    account page and the accounts list, with "statement due" a month after the last statement
    (`AccountDto.reconciledThrough`).
  - **Phone**: `TransactionDto.reconciled` syncs; the transaction screen shows a lock and keeps the account, amount and date
    (`editRules`). No reconcile screen on the phone; not run on a device.
- **Rentals: tenant details, the people on a lease, lease set-up costs and property contacts, web and phone**
  (RNT-17..22, [ADR-0038](design/adr/0038-rental-people-and-contacts.md), migration 0038):
  - **Tenant details**: second phone, mailing address, emergency contact, employer and monthly income (optional screening
    notes), vehicle or plate, and a date of birth sealed under the workspace key (`tenant.birth_date`), shown masked with a
    logged Show after a recent sign-in (`POST tenants/:id/reveal`, audit action `rental.revealed`). No SSN is collected.
    Rentals → Tenants shows where each tenant lives now; a tenant's page lists their leases (signer or co-signer), current
    first.
  - **People on a lease**: `lease_person` holds co-signers (name and contact, or one of the portfolio's tenants) and
    occupants (name, relationship, sealed date of birth). `lease_tenant` stays the tenants who sign, and they're the only
    payers: the rent roll, arrears, matching and payee-name learning are unchanged. The lease form and page group people
    by role.
  - **Lease documents and set-up costs**: the lease page leads with the start and end dates, has a "Signed lease" section
    (attach a PDF or photo, download), an optional broker (a contact with role broker), and a broker's fee or legal fees
    recorded as paid or taken over from a bank line. They post to Commissions (Schedule E line 8) and Legal & professional
    (line 10), tagged to the property and unit and owned by the lease (`lease_cost`). An accountant note says a leasing
    commission may need spreading over the lease term; Montra doesn't amortize it.
  - **Categories for tax**: "HOA dues" and "Home warranty" on Schedule E line 19 (Other), in the rental template and added
    to existing books by `app.add_rental_categories` (skips a category of the same name, any case). Property tax (line 16,
    including the mortgage escrow split), insurance (line 9, including escrow) and utilities (line 17) already reach
    Schedule E by tax line.
  - **Property contacts**: a Contacts card on the property page (`rental_contact`, 14 roles, company, optional contact
    person, website, email, phone, account or policy number, notes), one contact for several properties. The maintenance
    log's vendor can be a contact; free text stays, and deleting a contact keeps its name on old entries.
  - **Phone**: Rentals → Contacts and tenants, read-only, with tap-to-call and tap-to-email and each tenant's current
    property. Editing is web only. Not run on a device.
  - Fixed on the way: `PATCH leases/:id` with only `tenantIds` failed with an empty `UPDATE`.
  - Tests: `apps/api/test/rental-people.test.ts` (details and masking, roles with signers as the only payers, fees on lines
    8 and 10 with property tags, the idempotent category add, contacts with several properties and the maintenance link),
    `apps/web/lib/rentals.test.ts`, `apps/web/e2e/rentals-people.spec.ts`, phone `test/rentals.test.ts`.
- **A business's legal and tax setup and its registrations, web, read-only on the phone** (BIZ-21..26,
  [ADR-0037](design/adr/0037-business-legal-setup-and-registrations.md), migration 0037):
  - **Legal and tax setup** (Business → Settings): the entity type, with an LLC's tax treatment part of the type (sole
    proprietor; single-member LLC as a sole proprietor or S-corp; multi-member LLC as a partnership or S-corp;
    partnership; S-corporation; C-corporation), the federal return it files (Schedule C, 1065, 1120-S or 1120, derived;
    off Schedule C the summary and tax lines say they're a guide only), the Form 2553 election date for the S-corp types,
    and the fiscal year start. Only a workspace owner can change the type or fiscal year (`business.owner_only`); the old
    `llc` and `other` types stay valid until the owner picks one. Overview and Taxes show the type and return form.
  - **Fiscal year**: the P&L's "Year to date" and "Last year" and the Schedule C summary (named by the year it begins in,
    `ScheduleCDto.from`/`to`) follow it. Estimated-tax dates and the payroll year stay calendar-based on purpose.
  - **Registrations**: EIN, IRS name, NAICS; state of formation, SOS entity number, formation date, FTB entity ID, EDD
    employer account, CDTFA seller's permit, registered agent; DBA (county, expiry), city licence (expiry); and any other
    registration (`app.business_registration`). Tax account numbers are masked to their last four; Show
    (`POST /businesses/:id/reveal`) needs a recent sign-in and logs `business.revealed`. They were stored as text, as payroll
    kept the EIN; since migration 0089 they're sealed at rest (BIZ-26, see the entry at the end of §7g). Expiry dates get a `reminder` notification 30 days ahead from the nightly job.
  - **One source of truth**: the EIN, EDD account and filing address moved from `payroll_settings` to `business_profile`
    with a backfill (the business's own value wins). Payroll's Employer details and Year-end → Filing details show them
    read-only with a link to Settings; the worksheets, W-4/I-9 PDFs, W-2s, 1099s and EFW2 read `employerIdentity()`.
    `PayrollSettingsDto.ein`/`caEmployerAccount` became `einMasked`/`caEmployerAccountMasked`, and the payroll PUT no
    longer takes them. Payroll keeps its rates, deposit schedules, BSO user ID and SSA contact. The old payroll columns
    are left unused (commented in 0037) for a later contract step.
  - **The owner on payroll**: a person can be marked as an owner (`payroll_person.is_owner`). As an employee,
    `ownerNote` warns a sole proprietor (draws) or partner (guaranteed payments), and reminds an S-corp owner of a
    reasonable salary; shown on the add form and the person's page. A warning, not a refusal.
  - **Phone**: Business → Business settings (the collapsible section, #71) shows the entity type, return form and masked
    EIN, read-only; editing is web only. Not run
    on a device.
  - Tests: `apps/api/test/business-registration.test.ts` (backfill, payroll and EFW2 reading the moved EIN, fiscal-year
    ranges, the owner rule, renewal reminders, reveal), `payroll-tax` and `payroll-year-end` now set the numbers on the
    business, `packages/domain/test/business-registration.test.ts`, `apps/web/lib/business-registration.test.ts`,
    `apps/web/e2e/business-registration.spec.ts`, phone `test/business.test.ts`.
- **Staff time: vacation and sick leave, California daily overtime, contractor timesheets, web and phone** (PRL-23..29,
  [ADR-0036](design/adr/0036-staff-time.md), migration 0036): Business → Payroll → Time off sets each business's vacation
  policy (none, accrual per hour worked, or a yearly grant, with a balance cap and carry-over limit) and its sick leave
  policy, and the day workweeks start. With no sick policy saved, California employees get the statutory minimum (40
  hours / 5 days, 1 hour per 30 worked, 80-hour cap, 40 usable a year, from the 90th day), pinned in
  `CA_PAID_SICK_LEAVE` in `@montra/domain` from the Labor Commissioner's FAQ (updated 2025-12-31) and shown with its
  source; a policy below it is refused. A person's page shows balances and the hours behind them and takes an opening
  balance or adjustment. A paycheck takes vacation and sick hours, paid at the regular rate (a salary doesn't change);
  using more than the balance warns and approving needs "Allow" on that paycheck. Approving writes the year's grant and
  carry-over cut, the use and the accrual (exempt staff deemed 40 hours a week), and reopening removes them. The payslip
  has a time-off block (the sick leave notice). Accrued leave isn't posted. When the end date falls in the period, the
  paycheck offers to pay out unused vacation at the final rate (required in California); sick leave isn't paid out.
  Hourly employees can enter hours per day instead of totals: `splitOvertime` gives California's over 8 / over 12 /
  40-a-week / seventh-day split (federal: 40 a week), counting days of a workweek already paid on the last paycheck; the
  paycheck says which method it used. A contractor has an hourly rate and a timesheet (date, hours, project, optional
  customer with a link to a new invoice for them); "Bill these hours" makes one bill to their vendor record (Contract
  labor, Schedule C line 11) and locks the hours until the bill is voided; 1099s see it through the bill as before. The
  phone shows balances on Business → Payroll and leave on each paycheck, read-only; contractor time entry is web-only.
  Owner to check: the sourced California figures in ADR-0036 §2 (the statute pages on leginfo refused automated reads),
  that sick leave at the base rate suits anyone with overtime or commissions (FAQ 30 allows a 90-day blended rate), and
  that leave years run by calendar year.
- **Business assets, who spent, meal details and mileage by driver, web and phone** (BIZ-16..20,
  [ADR-0035](design/adr/0035-business-assets-and-expense-details.md), migration 0035):
  - **Asset register** (Business → Assets). Record an asset from a purchase (the transaction's "Record as an asset?" hint,
    the missing-receipt list or the Assets tab's "Purchases that may be assets": business purchases over $2,500 on
    equipment-like categories) or one the owner brought in (posted as an owner contribution). Methods: expense now under the
    $2,500 de minimis safe harbor (the purchase stays an expense), straight line with the half-year convention (software:
    36 months from the month in service), or MACRS half-year from Publication 946 Table A-1; recovery periods 5 years for
    computers and vehicles, 7 for furniture, equipment and other, 3 for software. Section 179 is an amount the owner types:
    no yearly limit is held. Capitalizing takes over the purchase like a bill payment (`asset.managed`): its cost moves
    from the expense category to "Equipment and fixed assets" through the poster, so the DE-08..10 rules apply. "Post
    depreciation through" a year writes one `depreciation` entry per asset and year (December 31), debit Depreciation
    (Schedule C line 13, new in `tax.ts`) and credit Accumulated depreciation, so Schedule C, the P&L and the tax estimate
    include it. Disposal needs the earlier years posted, posts the disposal year's half (or its months for software),
    writes off book value to "Gain or loss on assets sold", takes the proceeds as a deposit (an existing line or a new
    one), and shows the gain or loss. Schedule C leaves that account out (`assetSales`, Form 4797). Everything undoes:
    un-post the latest year, undo a disposal, delete an asset (the purchase gets its categories back).
  - **Assigned to people**: an asset is handed to a payroll person and returned, with its history. The person's page lists
    what they hold, and saving an end date (or deleting the person) is refused until it's returned (`payroll.assets_held`).
  - **Expense details** beside a business transaction (`app.expense_detail`, `TransactionDto.expenseDetail`): spent by
    (you or a payroll person, not the household member), attendees (customers, vendors, free text) and business purpose. A
    meal (line 24b) without attendees or a purpose shows "The IRS expects who and why". The transaction list filters by
    `spentBy`, and Business → Taxes has Expenses by person, linking to that filter.
  - **Mileage by driver**: a trip's driver is you or a payroll person. Only your trips reach line 9 and the tax estimate.
    Reimburse this trip makes an approved payroll reimbursement at the trip's IRS rate to a "Mileage reimbursements"
    category (line 9, kept out of the mileage-and-actual-car warning); an employee's is paid on the next pay run, a
    contractor's becomes a bill. A reimbursed trip's date, miles and driver are fixed. Mileage shows totals by driver.
  - **Phone**: the transaction screen shows spent by, attendees and purpose (read-only; entered on the web) and the meal
    hint; Log a trip has a driver. Assets are web only. Not run on a device.
  - Rules (don't undo): one purchase makes one asset; a purchase another owner holds (a bill, a paycheck) can't be
    capitalized. Expense details live outside the transaction spec, so editing them never re-posts it, and their change-feed
    key starts with the transaction id so phones pull it again.
  - Out of scope: **resale inventory and cost of goods sold**, stock counts, bonus depreciation, the mid-quarter convention,
    Section 280F car limits, part-personal use, several assets from one purchase, and Forms 4562 and 4797 themselves.
  - Tests: `apps/api/test/business-assets.test.ts` (24), `packages/domain/test/business-assets.test.ts`,
    `apps/web/lib/assets.test.ts`, `apps/web/e2e/assets.spec.ts`, phone `test/business.test.ts`.
- **Payroll, stage 4: year-end forms, web** (PRL-17..20, [ADR-0034](design/adr/0034-payroll.md) §7b): Business → Payroll →
  Year-end forms works out each employee's W-2 from the year's approved paychecks (box 1 less both kinds of before-tax
  deduction, Social Security and Medicare wages per person in pay-date order, box 12 code D and box 13 from retirement
  deductions, CASDI in box 14 and California's boxes 15–17) with the W-3 totals, and each contractor's 1099-NEC from
  bills paid by bank in the year (card payments are on a 1099-K) against the year's threshold, $600 through 2025 and
  $2,000 from 2026, with the 1096 totals. People's PDFs (W-2 copies B, C and 2; 1099-NEC copies B and 2) truncate the SSN
  or TIN; the employer's (W-2 copy D and the W-3; 1099-NEC copy C and a 1096 worksheet) carry full numbers. SSA's EFW2
  file (Publication 42-007) is built by a pure function tested byte by byte and refused, with reasons, while SSA would
  reject it. Full numbers need a recent sign-in and each download is logged. Copy A is never rendered: it's the EFW2
  file or the agencies' red forms. Migration 0034 adds the filing address in parts and the SSA contact to the payroll
  settings.
- **Payroll, stage 3: employer tax, web** (PRL-12..16, PRL-21, [ADR-0034](design/adr/0034-payroll.md) §7–7a): the built-in
  engine (`montra`) replaces the manual one. Each paycheck gets federal income tax (Pub 15-T Worksheet 1A from the W-4),
  Social Security to the $184,500 wage base, Medicare and Additional Medicare, and for California work California income
  tax (EDD Method B from the new DE 4), SDI, UI at the business's rate and ETT, plus FUTA. The 2026 tables are reviewed code
  in `@montra/domain` (`payroll-tax-tables.ts`), tested against the EDD's worked examples; a year without tables gets a
  note to enter taxes. Before-tax deductions are `retirement` (out of income tax only) or `section125` (out of all). A
  typed-in tax still overrides its line. Business → Payroll → Payroll taxes keeps the EIN, EDD account, UI and ETT rates
  and deposit schedules; lists what to deposit and when (941 monthly or semiweekly, FUTA by quarter with the $500 carry,
  California PIT/SDI and UI/ETT), each deposit recorded posts one owned transaction (`payroll_deposit.managed`): withholding
  out of its liability and the employer's share to Payroll taxes (Schedule C line 23); and fills in the 941, 940, DE 9
  and DE 9C worksheets. Deposits due within three days are reminded nightly (`bill_due`). California's 2026 FUTA credit
  reduction (1.5%) is the DOL's provisional figure and is flagged on the 940. Migration 0033.
- **Payroll, stage 2: pay runs, payslips and reimbursements, web and phone** (PRL-06..11, PRL-22, [ADR-0034](design/adr/0034-payroll.md)):
  Business → Payroll has pay schedules (every two weeks, twice a month, monthly), pay runs and reimbursement requests. Starting
  a run drafts a paycheck for each employee on the schedule: hours at their rate (overtime at 1.5×) or the salary for the
  period, plus any approved reimbursement, untaxed. Other earnings, deductions and the taxes are entered on the draft: the
  `PayrollTaxEngine` port had only a manual engine until stage 3. Approving (with a confirmation that Montra moves no money)
  posts one transaction per paycheck, owned by the run (`paycheck.managed`): wages to Schedule C line 26, reimbursed costs to
  their category, withholding to liabilities, net pay from the run's bank account. Employer taxes are kept on the paycheck and
  post when deposited (stage 3). A run reopens while none of its transactions is reconciled or closed. Each paycheck has a
  payslip PDF with the year to date. A contractor's reimbursement becomes a bill to their vendor record. Read-only access sees
  runs and payslips (names are kept on the paycheck) but no personal records. The phone (Business → Payroll) shows pay runs
  and payslip lines and submits a reimbursement with a receipt photo; not run on a device. Migration 0032.
- **Import profiles no longer pick another account's rows** (IMP-04, IMP-13): a profile saved after importing one account of a multi-account export (YNAB, Monarch, Mint, …) kept that account as its row filter. Importing the same export into another account then previewed the first account's rows, without offering a choice. Now the filter carries over only to the account it was saved for. Another account gets the account it asks for (`accountFilter`), or the file's accounts offered again (`multiple_accounts_choose_one`). The column choices still carry over. Stored profiles needed no migration: the check is made when a profile is read (`analyze()`).
- **A business's logo, domain and landing page; invoice PDFs in any script** (BIZ-01, BIZ-05, BIZ-10; [ADR-0032](design/adr/0032-business-profile-invoice-pdf-dashboard.md), migration 0030):
  - **Logo and domain.** Business settings (web, and on the phone the collapsible "Business settings" section at the bottom of Business, which also shows the contact details read-only) take a PNG or JPEG logo (≤ 1 MB, 4096 px a side), checked by its content, stored as file kind `logo`; replacing it marks the old file deleted. The domain is the website or email domain as a bare host name: `normalizeDomain` in `@montra/schemas` turns `https://www.example.com/x` or `sales@example.com` into a host and refuses anything else, on both clients and the server. Both print on invoices and head the web invoice page.
  - **Invoice PDF.** Text prints in embedded Noto fonts, script by script (`apps/api/src/business/pdf-fonts.ts`): Latin, Greek, Cyrillic, Vietnamese, Devanagari, Arabic, Hebrew, Thai, Chinese and Japanese; Korean and emoji still print "?". Don't switch back to pdf-lib's own `subset: true` or `drawText` for these fonts: its subsetter drops most glyphs, and its plain widths break Arabic joins and Devanagari conjuncts. Fonts are cut with HarfBuzz (`subset-font`) and each run is drawn as a positioned `TJ` array. `regenerator-runtime` is there because fontkit's Indic shaper needs it. Mixed-direction lines keep runs in reading order (no full bidi). The API image keeps only the regular and bold weights. A PDF already sent stays as sent. On the phone, an open invoice opens its PDF in the share sheet (`expo-sharing`, a new native module, so the APK needs rebuilding).
  - **Landing page** (web Business → Overview, phone More → Business): `GET /businesses/:entityId/dashboard` gives, per month, money in and out (the business's bank, cash and card accounts, transfers between them left out), revenue and expenses (the P&L's own monthly query, `pnlMonths`, so they match `reports/pnl`), profit and cash on hand, plus open invoices and bills today. 3, 6, 12 or 24 months, ending with a month from the dropdown (back to the first activity, 60 at most), as tiles, three charts and a table. `summarizeBusinessMonths` and `monthsEnding` in `@montra/domain`. The P&L, customer and vendor reports stay below it on the web.
- **Moving an account to other books** (ACC-03; [ADR-0033](design/adr/0033-moving-an-account-to-other-books.md), confirmed with the owner): an account's page (web, owners only) has **Move to other books**: pick Personal or a business, see what moves (transactions, other entries, reconciled lines kept, transactions whose categories stay in the old books, defaults cleared) or why it can't (a closed period in either books, different home currencies, a hand-written journal tying it to old-books lines, rental books or a property loan, archived), then move. The poster's `rebookAccount` re-books each transaction from what's posted, not from its spec, so payslips, invoices and rent move too; it settles again between entities around the paying account (in equity mode it also cancels the old owner contribution or draw), takes the account's uncategorized, bank-fee and FX lines along, keeps cleared and reconciled states (under `app.allow_locked_edit`) and checks every account's total is unchanged before writing. Import batches and reconciliations follow by `on update cascade`; the daily balance read model through `app.move_account_read_model`; loan schedules without a property and valuations too. Each move is an `account_move` row. Adding an account on the web now says "Whose books", and a business's settings link to adding one there. The phone has no add-account screen and no move yet.
- **Payroll, stage 1: people and onboarding forms, web** (PRL-01..05, requirements 5.1, [ADR-0034](design/adr/0034-payroll.md)):
  the owner moved payroll into scope on 2026-11-10 (federal plus one state; Montra calculates and fills in forms, and the owner
  files and pays). Business → People lists employees and contractors with what each still needs. A person has contact and pay
  details, and a tax ID, birth date and bank account that are sealed (`_enc`), shown masked, and revealed one at a time after a
  recent sign-in, each reveal written to the audit log. Employees get W-4s (2020+, kept as history; the one in force by
  effective date) and an I-9: Section 1 with the employee, the documents examined with copies, then Section 2. The I-9 is due
  3 business days after the first day, and it can't be deleted until 3 years after hire or 1 year after leaving, whichever is
  later. The screen says the originals must be examined and that E-Verify isn't included. A contractor is a vendor of the
  business (so bills pay them) and has W-9s. Each form downloads as a substitute PDF (logged). ID copies are `app.file` rows
  marked `sealed`: the bytes are encrypted before `StoragePort`, served only through their I-9, decrypted into backups and
  re-sealed on restore. Read-only access to a business sees no payroll (`payroll.no_access`). Migration 0031,
  `/v1/workspaces/{id}/payroll/*`. Stages 2–4 (pay runs, employer tax, year-end) follow; nothing on the phone yet.
- **The receipt by the amount, web and phone** (RCP-06): a transaction's screen has a round receipt button beside its amount. Filled, it opens the receipt; with a "+", it adds one (the camera on the phone, the "Add a receipt" section on the web, which now shows only then). While a receipt added from the transaction is being read or needs a look, the button opens it and says so; on the phone, one waiting to upload opens the queue. `TransactionDto.receipt` (`{ id, status }`) is the linked receipt, else one added from the transaction that isn't linked yet (its only, unscored candidate). The phone reads it fresh from the server when the screen opens, because linking doesn't always change the synced transaction. On the phone, "Chosen by you" (how the category was picked) moved from under the amount to the Category row.
- **Your own storage for files and backups, web and phone** ([ADR-0031](design/adr/0031-your-own-storage.md); BAK-03, BAK-05): Settings → Your own storage lets an owner connect an S3-compatible bucket (AWS S3, Backblaze B2, Wasabi, Cloudflare R2, MinIO) or a WebDAV folder (Nextcloud, ownCloud, Synology).
  - **Mirror, not move.** Montra keeps its own copy, so OCR, previews, matching, retention and quota are unchanged. A copy goes to `<folder>/<kind>/<year>/<date> <name> (<id tail>).<ext>`, by default under `Montra/<workspace>`.
  - **How copying works.** A trigger on `app.file` queues a copy for every upload (receipts, payslips, statements, business files, restores). The system job `storage.mirror` (`apps/api/src/storage/storage-mirror.jobs.ts`) copies under an owner's RLS. It leases rows (`for update skip locked`) and backs off from 1 minute to daily; after 10 tries a row is `failed` until the owner presses "Try failed ones again". Five failures in a row turn the connection to `failing` and send `storage_failing` to each owner, once. Connecting can copy the files already there, and "Copy existing files" does it later.
  - **Credentials.** They're sealed with `FieldCrypto` (`storage_destination.secret`), never returned, and the connection is tested before saving: write a probe file, then delete it. A key that can't delete is accepted, and old backups are then never pruned.
  - **Where Montra may connect.** In production, private, loopback, link-local and metadata addresses and plain http are refused, checked at connect time (DNS rebinding included). `STORAGE_DESTINATIONS_PRIVATE=true` allows them for self-hosting; it's the default outside production.
  - **Deleting.** Trash never touches a copy. Montra's own deletion (trash after 30 days, retention dates) keeps the copy unless the owner turned on "Also delete my copy". Disconnecting forgets the secret and leaves the copies.
  - **Backups.** "Back up now" also saves there (owners; `saveToStorage`). A schedule can go to `storage` instead of an emailed link, and can now have a password: the scrypt key is KMS-wrapped in `backup_schedule.wrapped_key`, and the password is never kept. The newest `keepBackups` (default 12) archives Montra wrote are kept there. `ExportJobDto.storageCopy` says how saving went, and a schedule's owner is told.
  - **Phone.** Status only, on Your data: the connection, its state, and a line on what's copied; each backup row says whether it was saved there.
  - **API.** `/storage-destination` (`GET`, `POST`, `PATCH`, `DELETE`, `/test`, `/backfill`, `/retry`, `/items`). Migration 0029.
  - **Tests.** `apps/api/test/own-storage.test.ts` runs against in-process fake S3 (driven by the real AWS SDK) and WebDAV servers (`test/fakes/storage-servers.ts`), so CI needs no MinIO. The S3 adapter was also checked by hand against the local MinIO on 19000: probe, upload, 3 MB streamed upload, wrong secret, missing bucket.
  - **Not done.** Google Drive, OneDrive and Dropbox each need an OAuth app registered in the owner's name (ADR-0031 §2 lists what), so BAK-05 stays partial. A single PUT caps a copy at 5 GB. Not run on a device or against a real Nextcloud.
- **Patches that kept resetting fields** (BUD-03, BIZ-06, RNT-13): Zod 4's `.partial()` keeps `.default()`, so three patch schemas filled the fields a request left out. Pausing or resuming an expected income on the web cleared its account, payee and member (so deposits stopped matching it); any bill edit dropped its attached files; any maintenance edit, marking it done included, dropped its files and linked transactions. The defaulted fields are now redeclared without a default. `@montra/schemas` has tests now: `test/patches.test.ts` parses every exported `Update…` schema with an empty patch and fails if anything is filled in. A stale expected-income version now answers 409 `version.conflict`, like the rest of the API (it was 422).
- **Editing and archiving goals, web and phone** (BUD-07, BUD-08): each goal on the web has **Edit** (the add form, pre-filled, without kind and books, which can't change) and **Archive** (after a confirmation); archived goals sit in a collapsible list with **Restore**. On the phone, tap a goal for an edit panel with the same fields and Archive behind an `Alert`; archived goals can be restored from the bottom of the screen. Saves send the goal's `version`: a stale one is refused with 409 `version.conflict`, which the web now explains everywhere with a Reload link, and the phone reopens the panel on the latest copy. The patch contract was fixed on the way: Zod 4's `.partial()` keeps `.default()`, so every `PATCH /goals/:id` used to reset the fields it left out (archiving cleared the target, due date, category and linked accounts). The API now also checks a new funding category like create does, and a goal whose linked accounts are all removed gets its own budget category again. Pure phone parts in `src/features/goals.ts`; not run on a device.
- **Explore spending, web and phone** (FLOW-01): Plan → Explore spending on the web, More → Explore spending on the phone. Pick up to 8 categories and 3, 6, 12 or 24 months; see them month by month in a chart and a table (cells drill to transactions), a card per category (trend, average, share of spending, purchases and typical size, biggest month, the pace for 12 months, top places), and what-ifs (cut by a percent or cap a month: the saving, the share of income kept, and months to each goal). Nothing is saved, except through **Make this my budget**: a row with a change shows this month's budget for the category, and the button sets it to the what-if's monthly amount (the average less the cut, or the cap) after a confirmation naming the month, the new amount and what it replaces. It updates the entity's (or member's) budget, or creates one when there is none. `GET /spending/explore` (now with each category's `assigned` and the `budget`), `POST /budgets/set-category`; the arithmetic is `categoryStats`, `whatIf` and `whatIfTarget` in `@montra/domain`.
- **Home's numbers for another period, web and phone** (FLOW-01): the date range under the Home title is a dropdown (a down arrow beside it) that picks the period for the four tiles (income, spent, left to spend, left to assign): the budget's periods, else months, newest first, back to the earliest with any transaction for the entity and member, at most 12 months. Away from the current period it's hard to miss: the tiles sit in a warning-coloured box saying "You're looking at September 2026, not the current period", with **Back to today** and a note that everything else on Home is as of today. It's never remembered: on the web it lives only in the URL (`?period=`), and the phone resets it when you leave Home. The charts keep their own period. `GET /dashboard?period=` returns the list as `periods`.
- **Transfers made real, web and phone** (TXN-04, AI-01): a card payment or move between accounts that was detected as a transfer becomes one when you accept it in review (Make transfer). The other side, when it was recorded separately, is absorbed: both statement lines stay on the transfer and stay cleared, the other side goes to the trash, re-importing either statement finds nothing new, and undoing the import that created the transfer keeps it (reason `transfer`). It stops counting as spending and income. A payment that names another account's last 4 digits is suggested before that account's statement arrives, and that statement later matches the transfer on amount and date. Import dedupe now keys statement lines per account (from `transaction_source`), so a transfer is recognised on both accounts' statements. `POST /transactions/:id/make-transfer`, ADR-0028.
- **Month in review, web and phone** (FLOW-01, AIA-01): Plan → Month in review on the web (and a link on Home), More → Month in review on the phone (and on Home). Pick any of the last twelve months (default: last month). It shows money in and out against your usual (the average of up to three months before with data), what was left over and the share kept, the clearest changes from usual, where the money went, the biggest purchases, how the budget went, and next month's budget from your last three months (BUD-02's median), each line with Make this my budget. The figures are computed; the new `summarize_month` AI task words them in a headline and up to five points (any number it wasn't given fails the call), cached per workspace by its input. With AI off or unavailable, plain sentences from the same figures. `GET /summary/month`.
- **Switching from another app, web** (IMP-13, ADR-0029): Import → "Switching from another app?", the Home card in a workspace without transactions, or the welcome form's choice. Pick the app (YNAB, Monarch, Mint, Lunch Money, Actual, Tiller, Empower, Copilot, Rocket Money, PocketSmith, Simplifi, Goodbudget, Quicken for Windows or Mac, your banks' OFX/QFX downloads, or anything else) for its export steps, upload the export, then confirm a plan: each account found becomes a new account (opening balance from today's balance or the export's), goes into one you have, or is left out; each category is mapped, created with its group, or left uncategorized (transfers by default). Each account then imports as its own batch (preview, dedupe, undo as usual), and transfers between them are paired with one button. A "spending shows as positive" switch per file covers apps whose sign convention isn't documented. Only for a fresh start: a workspace with its own transactions gets a new workspace instead. Not yet: Actual's database backup; the phone points to the web. `POST /migrations/analyze`, `POST /migrations`.
- **QIF and OFX/QFX files, web and phone** (IMP-01, IMP-13, ADR-0030): the Import page, the phone's picker and share sheet, and the Switch page take Quicken QIF (bank, card, cash and other-asset/liability registers, one account or a multi-account export) and OFX 1.x/2.x/QFX bank and card downloads. They are read into a fixed grid with a known mapping, so preview, dedupe, categories and the account split work as for CSVs.
  - QIF: dates such as `1/5'26` are normalized, and day/month order follows the data, then the locale. `Cat:Sub` categories match by their subcategory and bring their group. `[Account]` transfers stay uncategorized and pair. Splits keep their total (common category, or none). Quicken's Opening Balance record is the opening balance. Investment sections are left out with a counted warning.
  - OFX: one account per statement, named "Bank Checking ••1234". `FITID` keys dedupe, so a renamed payee in a re-download is still a duplicate. `LEDGERBAL` is the closing balance, and in the switch flow it sets the new account's opening.
  - The Switch page has Quicken (Windows) and Your banks (OFX or QFX downloads) entries. Migration 0028 widens `import_batch.file_type`.
- **Receipts worth keeping** (UP-09, RCP-11): `/receipts/recommended` now also lists deductible business spending (above the business's threshold) and, when set, everyday spending above the planning settings' reminder amount, cards and imports included. Bills, debt and savings never. Each row has a `reason`. `GET /receipts/habit` gives the week's receipts kept and missing and a streak (`receiptHabit` in `@montra/domain`: the week in progress never breaks it). The phone's Home shows a small card only when something is waiting (three at most, Add or Not needed), or one quiet line when all are kept. The Receipts screen lists them all, and Settings (phone) and Planning settings (web) set the reminder amount. No push notifications.
- **Phone: quick add fits one screen, and asks for the receipt**: the three ways in (scan, type, say) are one row at the top, Expense/Income is a switch, the keypad is slimmer, and the account row shows the three most recently used (the chosen one always among them) with … for the rest (`recentAccountIds`), so nothing needs scrolling. After saving spending, a "Got the receipt?" card opens the camera for that transaction; the photo uploads linked to it (`offersReceipt` in `src/features/quick-add.ts`).
- **Phone: voice entry** (TXN-07): quick add has **Say it** and a microphone beside the sentence box. The phone's speech service (`expo-speech-recognition`) fills the sentence as you speak, and the same parser as typing reads it. No audio is kept. Pure parts in `src/features/voice.ts`. The Android build used to block `RECORD_AUDIO` (left from the camera setup), so Android refused the microphone without asking; it now asks the first time, and a refusal shows **Open settings** for the app's permission page.
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
- **Accounts offered for spending**: quick add (web and phone), a receipt's "record it" account and a bill's "Paid from" offer only accounts purchases are paid from: checking, savings, cash, cards, lines of credit and IOUs. Investments and retirement plans (401(k), IRA), property, loans and mortgages are left out; money reaches them by transfer, and the transfer form still lists every account. The rule is the `spending` trait on each account type (`canSpendFrom` in `@montra/domain`).
- **A receipt's paying account, and changing it later**: recording a transaction from a receipt now offers a choice of account on the phone (it was always the first account) and starts on the card whose last four digits the receipt shows, else the most recently used (`receiptAccountId`); the web does the same. The phone's transaction screen has an Account row: an income or expense nothing else manages can move to another account in the same currency (the server and the sync outbox already took `accountId`). Transfers and payslip, invoice, bill or loan payments still change on the web.
- **Likely duplicate receipts** (RCP-13): `ReceiptDto.likelyDuplicates` lists other receipts with the same date, total and currency, from the same store when both name one (case, punctuation and a store number ignored). Web and phone flag them in the list and on the review screen, link to the other copy, and offer Discard this copy (the soft delete; files stay until their retention date). Nothing is discarded automatically; a rejected or deleted receipt stops counting. Byte-identical uploads were already detected on upload (`duplicateOf`), but neither client showed it.
- **Your own categories** ([ADR-0040](design/adr/0040-category-management.md), ACC-08..12): Settings → Workspace → **Categories** lists each set of books' categories by group, with add (name, spending or income, group), rename, move to another group, archive and unarchive, and the tax line for business and rental categories. Nothing is deleted: an archived category leaves the pickers, the sync pull and AI's options, rules that set it are skipped and history stops suggesting it, while its transactions and reports keep it. Built-in categories (Uncategorized, FX, bank fees) are listed but fixed. On the phone the category picker ends with **Add a category** (the search text becomes the name), which needs a connection, then syncs and picks it. Personal books have a **Miscellaneous** category in Daily living (migration 0040 adds it once to existing books).
- **Settings menu**: the groups of settings (You, Workspace, AI, Your data) are menu items under Settings in the sidebar, and each opens its sections as bordered tabs with the open one highlighted (`apps/web/lib/settings-sections.ts`; `.settings-tab` in `globals.css`). `settings?tab=…` links work as before.
- **Roles and family logins** ([ADR-0041](design/adr/0041-roles-and-family-logins.md), AUTH-14..17, migration 0041):
  - Roles are Owner, Admin, Partner, Member, Viewer and Accountant.
  - An **Admin** can do everything the owner can, except change or remove the owner. Only the owner can **Make owner**
    (hand over to an admin, becoming an admin themselves) or restore a backup over the workspace.
  - A **Member** (children, staff) adds and edits transactions, receipts and trips, and works the review queue, in the
    books granted (the personal books by default). Members see only the "You" settings and no Ask, Journal, Imports or
    Rules. The API refuses their other writes through an allowlist in `WorkspaceGuard` (`MEMBER_WRITES` in
    `apps/api/src/common/roles.ts`): add a route there when members should use it.
  - Inviting asks **Who is this?** (someone in the Family list, someone new, or not family), and accepting links that
    person to the login. The Family list shows "Signs in as …" or "Invite … to sign in" per person, and Sharing shows
    "In the family as …".
  - A linked login sees its own payslips. Only owners and admins can change a person's link.
  - **On the phone** (AUTH-18): each book in the workspace says whether this login may write it (`access`), and
    `useAbilities()` (`apps/mobile/src/features/roles.ts`) decides what each screen shows.
    - A viewer, or books shared read-only, has no Add tab, no swipe or edit actions, no Review, and no receipt or trip
      capture.
    - A member records but gets no setup: categories, budgets, goals, suggestions, payslips, rent and loan payments,
      business settings, receipt reminders and imports.
    - A member with a business's books can submit a staff spending claim with its receipt (`POST payroll/reimbursements`
      and receipt uploads are on `MEMBER_WRITES`). Identity uploads and deciding claims stay closed to them.
    - Backups are for owners and admins.
    - A screen reached by a link or a file shared from another app shows a short "your role can't do this" note.
- **Fuller personal categories** (ACC-13, migration 0042): personal books now start with these groups:
  - **Income**, with Bonus, Dividends, Side income, Pension & Social Security, Tax refund, Refunds & reimbursements and
    Gifts received added.
  - **Fixed bills**, with HOA dues and Home & renters, Auto and Life insurance added. "Insurance" stays as the
    catch-all.
  - **Daily living**, with Gym & fitness, Kids' activities, Allowance, Pets and Legal & professional fees added.
  - **Health** (new, migration 0046): Healthcare (moved from Daily living), Pharmacy & medicine, Dental & vision,
    Health insurance.
  - **Home** (new): Improvement, Maintenance & repairs, Furniture, House cleaning, Gardener & landscaping, Pest control
    & pool service, Laundry & dry cleaning.
  - **Transportation** (new): Fuel, Public transit & rideshare, Parking & tolls, Car maintenance & repairs, Registration
    & DMV.
  - **Fun**, where Gifts and Charitable donations are now separate.
  - **Taxes** (new): Property tax, Income tax payments, Tax preparation.
  - **Debt**, unchanged.

  Migration 0042 (`app.add_personal_categories`) adds what's missing to existing personal books once and renames "Fuel &
  transport" to "Fuel" and "Gifts & donations" to "Gifts" unless those names are taken. It never deletes, archives or
  moves a transaction. Migration 0046 replaces it with the Health group added and Healthcare moved there while it is
  still in Daily living, and runs it again. Keep it and `chart-templates.ts` in step. CVS, Walgreens and Rite Aid hint
  Pharmacy & medicine. Merchant hints follow the new names (Home Depot →
  Home improvement, Uber → Public transit & rideshare). A mortgage's escrowed property tax now lands in Property tax
  (it used to match the first category with "tax" in its name, such as a payslip's Federal income tax), and escrowed
  insurance in Home & renters insurance.

- **Auth gateway** (AUTH-08, [ADR-0042](design/adr/0042-auth-gateway.md), migration 0043): self-hosted Kratos has no
  limits on guessing, so browsers and the phone now reach it only through `apps/api/src/auth-gateway`, its own process
  (`pnpm --filter @montra/api dev:auth-gateway`, port 4455; `auth-gateway` service in Terraform). Kratos's
  `base_url` is the gateway's address, and its own port stays private.
  - Counted: wrong passwords per email (pause after 10 in 15 minutes) and per address (30), wrong authenticator or
    recovery codes per session (5), wrong emailed codes per address and flow (10), recovery and verification emails per
    address (10 an hour), sign-ups per address (20 an hour). Past a few failures each attempt waits 1–8 s.
  - A paused browser goes back to its form with a notice; the phone gets 429 and a flow message (id 4290001).
  - A paused email's account gets a `sign_in_locked` security event and an email; a password reset still works.
  - Counters are HMAC-keyed rows in `app.auth_throttle`, so they hold no email or address.
  - Tried on 2026-11-13 against local Kratos v26.2.0 for native and browser password sign-in. Not yet run in
    production, and the local dev mode (`AUTH_MODE=dev`) doesn't use it.
- **Password policy** (AUTH-02, [ADR-0043](design/adr/0043-password-policy.md)): the admin console's **Security**
  tab sets a minimum length (12–64) and a minimum strength score (0–4, default 3), stored in `app.system_setting`.
  - The auth gateway refuses a new password that falls short at sign-up and in settings (including after a reset),
    before Kratos sees it. Scoring (`@montra/password`, zxcvbn-ts 4.2) runs on a worker thread; the policy is reread
    once a minute.
  - The web's sign-up and security settings show a strength meter that blocks the form until the password passes.
  - Tried on 2026-11-13 against local Kratos through the gateway: the meter rates `password12345678` "Weak", the
    gateway sends a forced submit back with the notice, and a strong password goes through. The phone has no
    password forms yet.
- **Workspace security rules** (AUTH-04, AUTH-07, [ADR-0044](design/adr/0044-workspace-security-rules.md), migration
  0044): on Sharing settings, owners and admins choose who needs two-step verification and the web's idle sign-out.
  - `standard` (default): owners, admins, partners, accountants and anyone who can see business books. `everyone`:
    every login.
  - Without a second factor set up, the API answers `mfa.setup_required` and the web opens security settings with a
    note and a link back. With one, `mfa.required` asks for it as before.
  - Sharing shows owners and admins who has two-step verification (`MemberDto.twoFactor`, from Kratos's admin API).
  - The web signs out after the workspace's idle timeout (5–30 minutes, a one-minute warning first). The API ends a
    browser session unused for 30 minutes. The phone keeps its app lock.
  - Tested against the fake Kratos in `kratos.test.ts`. The phone doesn't yet lead someone to set up a second factor.
- **Password, two-step and device alerts** (AUTH-12, AUTH-05, [ADR-0045](design/adr/0045-identity-change-alerts.md),
  migration 0045): Kratos tells the API after a new password or a change to an authenticator app, security key or
  recovery codes. The API logs it in security activity and emails the owner. A new password signs out the other devices.
  Signing devices out from the device list is logged too. The Kratos config was checked to load in Kratos v26.2.0;
  the hooks are tested against the API, not yet end to end.
- **Account flows on the phone** ([ADR-0046](design/adr/0046-phone-account-flows.md)): sign-up with the strength meter
  and email code, forgot password (with the second factor when there is one), an authenticator and recovery codes on
  More, and a recovery code at sign-in.
  - A workspace that needs two-step verification shows the setup screen in place of the workspace, ending with an
    authenticator code that strengthens the session.
  - Fixed: the phone skipped the authenticator at sign-in, because `whoami` accepts a one-factor session. It now asks
    an `aal=aal2` login flow.
  - Every flow was run against Kratos v26.2.0 (with `use_continue_with_transitions`, now on in `kratos.yml`). The
    screens haven't been tried on a device. The LAN APK uses development sign-in, so they don't show there yet.
- **Receipt scanning and phone screens** ([ADR-0047](design/adr/0047-receipt-document-scanner.md)):
  - Capture opens the phone's own document scanner (ML Kit on Android, VisionKit on iPhone), which crops and straightens
    the receipt. The app's camera is the fallback where the scanner can't run, or when chosen.
  - Every screen now ends above Android's navigation bar, so a long form scrolls above it instead of under it, and
    screens with a title bar lost the extra status-bar space at the top (`src/ui/insets.ts`).
  - The transaction screen has compact split lines; its receipt icon stays by the amount. The receipt screen folds the photo
    away by default, with one zoom hint.
  - Not yet tried on a device.
- **Store details and search by item** (RCP-01, RCP-09, migration 0047):
  - `extract_receipt.v3` also reads the store's address, phone and website as printed. They are plain strings, empty
    when not printed, because the schema already has 15 of Anthropic's 16 nullable fields. The gateway keeps a phone
    only when it has 7 to 15 digits, and a website only when it looks like a host name. They're stored on the receipt
    (`store_address`, `store_phone`, `store_website`) and can be changed in review (`PATCH`). Receipts read before
    this have none until read again.
  - The phone's receipt screen shows them under the store name: tap the address for maps, the number to call, the
    website to open it. The web receipt page shows them as links.
  - **Search by item** (`GET receipts/items?q=&from=&to=`): the lines whose expanded or printed name has every word of
    the query at the start of a word ("milk" finds "Great Value 2% milk", not "buttermilk"). It returns the amount
    per currency, item and receipt counts, and each receipt with its store, date, matching items, their amount and the
    receipt's total, newest first (200 listed, all counted). Discarded, unread and undated receipts are left out. The
    default period is the last three months.
  - On the phone, Receipts → **Search by item**: 3 months, 6 months, 1 year, 2 years or all, and **Search further
    back** below the results; a receipt opens in full. On the web, Receipts → **Search by item** does the same.
  - Not yet tried on a device or with the real provider.
- **The Add wheel and the scanner everywhere** ([ADR-0048](design/adr/0048-add-wheel-scanned-documents-and-billers.md),
  step 1 of 4):
  - The centre + opens a wheel: Transaction (quick add), Receipt, Statement and Payslip on an arc above the button
    (`src/ui/AddWheel.tsx`, `src/features/add-wheel.ts`). Choices the login can't use are left out. Bill joins it with
    bill scanning (step 4).
  - Statements, payslips and reimbursement photos now open the phone's document scanner first, with the camera as the
    fallback (`src/ui/DocumentCapture.tsx`; `scanReceipt` is now `scanPages`). A statement's scanned pages still become
    one PDF. From the wheel, Statement goes straight to scanning.
  - **Step 2:** a scan is read before it's filed (`app.document_scan`, migration 0048, `POST scans`, `scan.read`).
    - A scanned statement finds its account by the last four digits the doc-worker reads from it. The phone shows the
      account found and imports from the same reading (`POST imports` with `scanId`).
    - A scanned payslip finds its person from the pseudonym token `extract_payslip` v2 returns, and its employer by
      name. The phone shows what it found and saves to the employer chosen (`POST payslips` with `scanId`). From the
      wheel, Payslip goes straight to scanning.
  - **Step 3:** bill providers (billers) on the budget (`app.biller`, migration 0049, `GET/POST/PATCH billers`).
    - A provider belongs to a spending category (SDG&E on Utilities), with an optional usual due day, the account
      number's last four digits, the person it's for, and a cadence.
    - Its next bill is estimated from its payments over the last 400 days: the average of the last three, on the due
      day (or the day it was last paid) one cadence on (`nextBill` in `@montra/domain`). No payments, no estimate.
    - Estimates come into the calendar, upcoming, bill-due alerts and the forecast as variable bills, unless a
      recurring item for the same payee already shows them.
    - Web: a **Bills** tab on the budget lists and adds providers, and each category line shows its providers and
      next bills. Phone: the budget shows them under their group, with a **Bill providers** card to add one.
  - **Step 4:** bill scanning (`extract_bill`, `app.household_bill`, migration 0050, `household-bills` routes).
    - Bill is on the Add wheel. The scan is read once (`scan.read`): the biller, the account number's last four
      digits, the amount due, the due date, the bill date and the service period, and the person as a token.
    - The biller is found among the budget's providers by those four digits, else by name. The phone shows what was
      read, lets the person fix the amount and date or pick or add the provider, and files it from the same reading.
    - A household bill's exact amount and date replace the provider's estimate in the calendar, upcoming, bill-due
      alerts and the forecast (overdue when past). A payment to the provider for the amount, from 20 days before the
      due date to 15 after, marks it paid (`settle`, run when bills or estimates are read).
    - A provider on a business's books files the scan as that business's vendor bill (ADR-0017), from a vendor of the
      provider's name, to the provider's category.
    - Phone: **Bills** (from More) lists bills due and paid. Web: the budget's **Bills** tab lists them under the
      providers.
    - Web: **Add a bill** on that tab (writers only) uploads a PDF or photos and reads them like the phone (`POST
      household-bills/files`, a `bill` scan, polled until read), shows what was read, and files it once checked; or
      the bill is typed in. A business's provider files a vendor bill, and the message links to it. A bill has no
      notes field (the API takes none).
    - Not yet tried on a device or with the real provider.
  - Not yet tried on a device.
- **Statements and bills find their account or biller, and learn it** (IMP-01, IMP-04, AI-03,
  [ADR-0051](design/adr/0051-statement-and-bill-matching.md), migration 0058):
  - **Intakes:** `POST intakes/files` takes any statement (CSV, XLS, XLSX, PDF, QIF, OFX/QFX) or a photo of one, with no
    account. It's read once (`intake.read`; PDFs, XLS files and photos go through `doc.extract` first, and the reading is
    kept for the import) and matched: printed last four digits, the issuer the doc-worker finds among the workspace's
    institutions, the OFX `ACCTID`/`BANKID`, digits in the file name, the accounts a saved profile of the same header
    belongs to. Nothing strong: the recent accounts are offered.
  - **Match memory** (`app.match_memory`): one row per kind and signal, with the confirmations in a row. A person's pick
    (Review, the Statements screen, a phone scan's import, a bill filed from a scan) counts; a different pick resets it
    to 1. After **3** the match is automatic. Undoing an automatic import resets it to 0 and puts the statement back in
    Review. Pure rules in `@montra/importers` (`statement-match.ts`).
  - **Import if clean:** a learned statement is imported into its account and committed by `intake.settle` when it went
    straight to preview with no likely duplicates, no rows in error, no failed balance check and something new. Anything
    else waits in Review with the reason, its import in preview.
  - **Bills:** `POST scans { kind: 'bill', autoFile: true }` files the bill for a learned provider when its amount and
    due date were read; otherwise it waits in Review (and the scan can still be confirmed as before). Without `autoFile`
    nothing changes. The phone's bill capture and the web's Add a bill both ask for `autoFile`: a bill filed
    automatically closes the dialog with a message. The web's Bills list has **Void** on open and overdue bills
    (`PATCH household-bills/:id { void: true }`), to undo one filed wrongly; the phone has no void yet.
  - **Review:** web `/review` and the phone's Review show **Statements and bills to file** above the transactions; each
    has the account or provider to pick (candidates first) and Put aside. The web opens a resolved statement in its
    import preview; the phone imports it only when clean (`commitIfClean`).
  - **Doc-worker:** `doc.extract` reads photos (`fileType: image`) with OCR, and returns `statement.issuer`.
  - **Web Statements screen** (`/statements`, in the nav next to Receipts and Payslips; not for members): drop any
    statement or photo with no account picked. It shows the account found to confirm or change, then continues in the
    existing preview, mapping and commit screens (`/imports/[id]`). Once learned it says "Imported automatically into
    X" with Undo. The import history is on the same screen (`ImportHistory`, shared with `/imports`, which stays for an
    account's own history; the nav's Imports entry is gone). The account page's Import statement still imports into
    that account. e2e: `e2e/statements.spec.ts`.
  - Not yet tried on a device, with real bank files beyond the corpus, or with OCR of a real photo (Tesseract isn't
    installed on the dev machine; the photo path is tested with a stubbed engine).
- **Offering Montra as a service, hosted anywhere** (accepted 2026-11-14; **done** 2026-11-14: ADR-0049 in
  #97–#101, tagged `v0.12.0-dev.56`–`60`; ADR-0050 in #96 and #102–#104, tagged `v0.12.0-dev.61`–`64`):
  - ✅ [ADR-0049](design/adr/0049-plans-platform-owner-and-providers.md): plans become data the owner edits in the console
    (tiers, prices by Stripe price id, entitlements, versions), each with an AI allowance; a staff `owner` role above
    `admin`; suspending, trials, given plans and closing accounts; a Providers page that shows but never stores keys;
    texts through Twilio (Kratos's SMS channel and an `SmsPort`). Done in five PRs, in the order the ADR gives.
  - ✅ **Step 1, plans as data and the AI allowance** (#97, migration 0051):
    - `app.plan`, `app.plan_version` (entitlements as JSON, checked by `parseEntitlements` in `@montra/domain`) and
      `app.plan_price` (Stripe price ids). `app.subscription.plan_version_id`. A version with subscribers can't be
      changed (a trigger); a new version is the way. Free is always offered.
    - Seeded so nothing changes: Free and Pro allow what `entitlementsFor` gave them, which is gone. Every feature key
      is on for both, and neither has an AI allowance or a login limit.
    - `Plans` (`apps/api/src/ops/plans.ts`) is the one place that says what the workspace in context is on, through
      `app.current_plan()`, so jobs get it too. Adding books, a payroll person, staff time, a scan, own storage or
      an invite checks it. `BILLING_MODE=off` still gives everything.
    - Checkout takes `{ plan, interval }`; the webhook finds the version from the price id. `STRIPE_PRICE_PRO_*` are
      gone, from the API and Terraform. Prices are added in the console (step 2).
    - Built-in AI is held to min(plan allowance, the customer's budget). Owners get an `ai_allowance` notification at
      80% and 100%, once each a month (`ai_usage.alerted_pct`). The operator's ceiling (`ai_monthly_ceiling_micro_usd`,
      console → AI) stops built-in AI everywhere and emails staff once a month. Customers' own keys and local models
      are held only to their own budget, and don't count towards the ceiling.
    - The phone hides voice entry when the plan lacks `voice`. The web's plan panel names the plan; the plan picker
      and the AI usage bar are step 2.
    - Tests: `apps/api/test/plans.test.ts`. The ceiling is only ever set inside a rolled-back transaction there,
      because test files share a database.
  - ✅ **Step 2, the owner and plans in the console** (#98, migration 0052):
    - Staff roles are `support`, `admin` and `owner`, each including the one below. `staff:add <email> owner` (or
      `--role owner`) makes the first owner; after that, owners add, change and remove staff in the console's
      **Staff** tab, through `admin_*` functions that check the role again. Every change is emailed to every owner.
      The last owner can't be removed or demoted.
    - Owner actions (staff, plans, the AI ceiling) need a sign-in in the last 10 minutes as well as a second factor.
    - The console's **Plans** tab: plans, versions with what they allow, subscriber counts, Stripe prices, and moving
      subscribers between versions. Admins see it; owners change it. Editing a plan adds a version. One that gives
      less starts 30 or more days out, and moving subscribers onto it waits for each one's first renewal after a
      date 30 or more days out. Customers are emailed either way (`app.plan_change_notice`, sent by the hourly billing sweep).
    - The plan picker: `GET /v1/plans`. Web: Settings → Plan lists the other plans with what they include and
      their prices, with a checkout button for each interval. Phone: Settings lists them read-only, since the phone
      doesn't sell.
    - The AI usage bar: the web's AI settings and the phone's Settings show "N% of this month's AI used" from
      `usage.share`. Under a plan's allowance, the web shows the share, not dollars.
    - Tests: `apps/api/test/plans-console.test.ts`, and a look at the Plans tab in `e2e/operations.spec.ts`.
  - ✅ **Step 3, managing accounts** (#99, migration 0053), in the console's account lookup:
    - **Suspend and restore** (admin, with a recent sign-in): abuse, fraud or a legal hold, with a reason. Kratos
      stops the sign-in and ends the sessions. The API refuses the person (`account.suspended`) and closes workspaces
      they own to every member (`workspace.suspended`). The web shows `/account-closed`. They're emailed unless it's a
      legal hold. Restoring reverses all of it.
    - **Extend a trial** by up to 30 days, in Stripe first. **Give a plan** until a date (provider `comp`). It stops
      counting at that time, and the sweep writes it down. A workspace paying through Stripe gets a **coupon** id
      instead, applied to its subscription.
    - **Close on request** (owner): the person's own 30-day deletion, only for a request from the account's address,
      with how it came recorded. They're emailed and can still cancel it.
    - Phone: a screen for each refusal, in the web's words: a suspended account, a closed workspace (with the
      support address from the API's message, and the person's other workspaces), and an account being deleted (when
      it goes, and **Keep my account**). Each offers help, **Try again** and sign-out (which still wipes the phone).
      The sync engine stops on `account.suspended`, `workspace.suspended` or `account.deleting` (a `closed` event),
      keeps the outbox as it was with no attempt counted, and sends nothing, socket included, until reopened
      (`packages/sync` tests, `apps/mobile/src/features/account-state.ts`). Not run on a device.
    - Tests: `apps/api/test/accounts.test.ts`, and `setIdentityActive` against the fake Kratos in `kratos.test.ts`.
  - ✅ **Step 4, the Providers page** (#100, migration 0054), the console's **Providers** tab, for owners:
    - One row each for email, texts, payments, error reporting, AI, file storage, key management, push and exchange
      rates: whether it's set up, its mode, what isn't secret, and its last success and failure
      (`app.provider_status`, `ProviderHealth`). No key is shown or editable.
    - Owners change the API's sender name and address, the support address, which kinds of text are on and the
      countries texts may go to (`ServiceSettings`, kept in `app.system_setting`). The API's SMTP mail and the support
      address use them at once.
    - **Send a test email to me**. The test text answers `sms.not_configured` until step 5.
    - Tests: `apps/api/test/providers.test.ts`. It puts the service-wide settings back afterwards, since test files
      share a database.
  - ✅ **Step 5, texts through Twilio** (#101, migration 0055):
    - `SmsPort` with `off`, `log`, `memory` and `twilio` modes (`SMS_MODE`, `TWILIO_*`). Twilio sends through a
      Messaging Service. `TextsService` decides who gets what: their own verified number only, kinds the owner switched
      on, countries on the allowed list, what the person turned on, and reminders within the plan's `smsMonthly`.
    - Kratos: `phone` in the identity schema, and a texted code as a second factor. The
      channel and the second factor are switched on by `COURIER_CHANNELS` and `SELFSERVICE_METHODS_CODE_MFA_ENABLED` on
      Kratos (`infra/kratos/templates/README.md`). This was checked against Kratos v26.2.0 with a stand-in for Twilio.
      Recovery stays by email.
    - Web: the mobile number is in its own section of Settings → Security (shown only where texts are on), and a
      **Texts** section in
      notification settings turns security alerts and reminders by text on. The Providers page shows Twilio's state and
      sends a test text to the owner's own number.
    - The API's copy of the number is refreshed from each new Kratos session. A change is logged and emailed.
    - The auth gateway limits texted codes per number and per address (`sms_send`).
    - Phone: Settings has **Mobile number** (add, change or remove it, confirmed by a texted code, asking for the
      password when the sign-in is old), and notification settings have the **Texts** section. Both show only where
      texts are on, and the switches work only for a confirmed number, as on the web
      (`apps/mobile/src/features/texts.ts`). Not run on a device.
    - **Confirming a number goes through the API** (migration 0056). Kratos v26.2.0 texts a code when a number is
      saved in its settings, but never names the verification flow the code belongs to, so it couldn't be entered on
      the web or the phone (checked with a stand-in for Twilio). Now:
      - `POST /v1/me/phone` texts a 6-digit code (no link) through `TextsService`. It's hashed, lasts 10 minutes and
        is single use. Codes count under the gateway's `sms_send` limit per number (the same counter) and per person,
        go only to allowed countries, and never to a number confirmed on another account.
      - `POST /v1/me/phone/confirm` allows five tries per code and 10 wrong codes in 15 minutes per person. A right code
        puts the number on the Kratos identity already verified, through the admin API, which texts nothing.
        `DELETE /v1/me/phone` removes it. Both need a recent sign-in, and each change is logged and emailed.
      - Kratos's settings no longer change the number: the web keeps it as a hidden field of the profile form, and
        the gateway turns away a settings save that would change it (`phone_in_app`).
      - Kratos v26.2.0 reorders an identity's verifiable addresses and has no JSON Patch `test`, so the adapter writes
        the whole list back and reads it again. Removing a number also removes the `code` credential, which otherwise
        keeps the old number and stops anyone else adding it. Both checked against Kratos v26.2.0.
      - The email change (AUTH-11) marks the new address verified the same way, found by `via` and value. It used to
        patch `verifiable_addresses/0`, which on an account with a number can be the number's address: Kratos then
        left the new email unverified and took the number's verified mark away. Kratos keeps the recovery address in
        step with the email trait by itself, so it needs no patch. Checked against Kratos v26.2.0 over 8 accounts × 2
        changes, with the number listed first on about half.
    - Not done: the Terraform doesn't set `SMS_MODE` or the Twilio secrets, and nothing has been sent through real
      Twilio. US texting needs A2P 10DLC or a verified toll-free number first (launch checklist).
    - Tests: `apps/api/test/texts.test.ts`, confirming a number in `phone.test.ts`, the number's sync and the admin
      calls in `kratos.test.ts`, the limits and the settings refusal in `auth-gateway.test.ts`, and
      `packages/domain/test/phone.test.ts`.
  - **Next for ADR-0049:**
    - `SMS_MODE` and the Twilio secrets in Terraform;
    - A2P 10DLC (or a verified toll-free number) before the first real text in the US;
    - a first real send through Twilio and a real Stripe checkout by plan.
  - ✅ [ADR-0050](design/adr/0050-hosting-anywhere.md) (**accepted** 2026-11-14): Montra needs containers, PostgreSQL 16,
    S3-compatible storage, SMTP and secrets, nothing more. AWS stays as one target. **The owner starts on a home server
    for family and friends, and moves to a VPS when real customers come** (§11): a Cloudflare Tunnel (no inbound ports,
    no dynamic-IP problem), email through a sending service over SMTP, a UPS and mirrored disks, `BILLING_MODE=off`.
    Done in four PRs:
    1. ✅ **Application changes** (#96):
       - **`_FILE` secrets:** every API setting (`apps/api/src/secret-files.ts`), the API's command-line tools and the
         migration command, the doc-worker (`settings.py`), and Kratos through a small Go entrypoint in its distroless
         image (`infra/kratos/entrypoint`, tested in the image build; only Kratos's secret-bearing settings, as the
         base image's own `SSL_CERT_FILE` is a path). Checked: the built image reads `DSN_FILE`. Both set is an error; empty means not set.
       - **`KMS_MODE=local` in production** from `MASTER_KEY_FILE` only; a key file its group or others can read is
         refused. On Windows the mode isn't checked (no Unix permissions).
       - **`KMS_MODE=vault`** (`crypto/vault-kms.ts`): Vault or OpenBao Transit; `VAULT_TOKEN_FILE` is read on every
         call for a Vault Agent. Tested against a stand-in for the Transit API, not a real Vault.
       - **`crypto:rewrap`** (`crypto/rewrap.ts`, `crypto-cli.ts`): with `KMS_PREVIOUS_MODE` set, the service unwraps
         with either mode (`MovingKms`) while the command moves workspace, backup-schedule, restore and queued-backup
         keys. It resumes by skipping keys the new mode already unwraps, so it needs no table (and no migration).
         Runbook: `docs/runbooks/key-wrapping.md`.
    2. ✅ **The self-hosted target** (#102):
       - **`infra/selfhost/compose.yaml`:** Caddy, cloudflared (profile `tunnel`, the default), Postgres 16, Kratos
         and its courier, the auth gateway, two API replicas (`api-a`, `api-b`, both reachable as `api`), the job
         worker, the doc worker and web. Every Montra container runs as uid 1000; secrets are files in `secrets/`
         read through `NAME_FILE`; no port is published. `compose.direct.yaml` publishes 80 and 443 for a VPS, with
         Let's Encrypt. Caddy refuses `/internal/*` from outside; Kratos's webhooks reach the API internally.
       - **`setup.sh`:** `secrets` generates passwords, URLs, Kratos secrets and the master key (never overwriting);
         `check` checks Docker, `.env`, each secret's owner, mode and content, the bucket, SMTP and ghcr.io, disk and
         memory, and warns about a missing disk mirror, SMART, UPS software, disk encryption or clock sync; `init`
         creates the roles from `production-roles.sql`, then deploys.
       - **`deploy.sh <tag>`:** migrations first as one-off containers, then Kratos, the workers, `api-a` then `api-b`
         (Caddy health-checks each), web, and only then records the tag in `.env`.
       - **`deploy.yml`:** an environment's `DEPLOY_TARGET` picks `aws` (default, unchanged) or `selfhost`, which
         builds the four images to `ghcr.io/<repo>` (web as `web-<environment>`), copies `infra/selfhost` over SSH
         (through Cloudflare Access at home) and runs `deploy.sh`. The AWS path still builds straight into ECR;
         moving it to GHCR-then-copy (ADR-0050 §6) is left for when AWS is used.
       - **The Kratos wrapper** gained `montra-kratos healthcheck`, as the image has no shell or curl.
       - **Fixed: the API and web images couldn't start.** `exceljs` was a devDependency of the API but is imported at
         runtime, so the image's production install left it out; and the web image's build deleted `lib/csp.mjs`,
         which `next.config.mjs` loads at start (both `ERR_MODULE_NOT_FOUND`). The web build now loads its config to
         prove it. They affected the AWS images too, which have never been run. Found by bringing the stack up.
       - **Texts:** `SMS_MODE`, the Twilio secrets and Kratos's SMS channel (ADR-0049 §6) are wired in, off by default.
       - **Brought up locally** on Docker Desktop from images built here, with MinIO and Mailpit standing in and no
         tunnel: `setup.sh secrets`, `check` and `init` from nothing, every service healthy, the three hostnames
         through Caddy, `/internal/*` refused, a sign-up through the auth gateway with its email, and a second deploy
         replacing both API replicas while `/readyz` answered 382 of 382 calls. It found the two image bugs above and a
         doc-worker one in step 1 (it resolved its secret files twice).
       - Runbooks: `selfhost-setup.md` (hardware, mirror, LUKS, UPS, tunnel, email, bucket, VPS variant, secrets,
         first start, GitHub settings) and `selfhost-operations.md` (releases and rollback, patching, power cuts, a
         failing disk, health, rotating each secret, `pg_dump` until step 3).
    3. ✅ **Portable backups and alerts** (#103):
       - **Postgres with pgBackRest** (`infra/selfhost/postgres`, pushed to GHCR as `postgres:16-<hash of the folder>`,
         so a release restarts the database only when that image changes). With `BACKUP_S3_BUCKET` set it archives the
         WAL every 60 seconds (async, a 4 GB queue) to a bucket at another provider with object lock, encrypted with
         `backup_cipher_pass` before it leaves. `BACKUP_ARCHIVE=off` for a restore drill.
       - **`backup.sh`:** `init` (stanza and first full), `db full|diff`, `files` (rclone sync to a versioned bucket at a
         second provider, keys through the environment), `status` (backup ages and `pg_stat_archiver` into a textfile
         for node-exporter), `info`. `setup.sh cron` installs the schedule; `init` runs both.
       - **Alerts:** profile `monitoring` runs Prometheus, Alertmanager (email) and node-exporter, nothing published.
         `infra/observability/prometheus/rules/selfhost.yml`: backup status missing, database or files backup stale,
         WAL archive failing, a scrape target down, the RAID mirror degraded, a disk full or filling, the clock unsynced.
         Unit-tested with `promtool` (`tests/selfhost.test.yml`).
       - **`crypto check`** (`crypto-cli.ts check`, `pnpm --filter @montra/api crypto:check`, the Compose `crypto`
         task): unwraps every stored key with `KMS_MODE` and names any that don't, for a restore drill or after a move.
       - Runbooks: `selfhost-backups.md` (buckets, object lock shorter than pgBackRest's retention, settings, schedule,
         alerts, what to do when one fires) and `selfhost-restore-drill.md` (restore onto a scratch server with
         read-only keys, reconciliation checks, `crypto check`, the files copy, the lock).
       - BAK-01 or BAK-09 is still open: the defaults keep about five weeks, which suits BAK-09.
       - **Brought up locally** with MinIO (TLS and object lock) standing in for the buckets: the stanza, full and
         differential backups, the files copy, `backup.sh status`, Prometheus scraping both API replicas and
         node-exporter with the rules loaded, a locked backup refused deletion, and a restore drill into a second
         project (the WAL replayed, reconciliation clean). It found that Postgres must run under an init process
         (`init: true`): pgBackRest's async archiver leaves a process PID 1 inherits, and Postgres as PID 1 restarted
         every connection when it exited.
       - The Postgres image starts as the `postgres` user, not root (`USER postgres`), which the Trivy file scan
         requires (DS-0002).
    4. ✅ **`docs/runbooks/moving-platforms.md`** (#104): the move from home to a VPS
       or to any cloud, in ADR-0050 §10's order. Logical replication for `montra` and `kratos` (a private link, a
       `bypassrls` replication login, the schema from `pg_dump --schema-only`, a subscription owned by `montra_owner`),
       files by `rclone` only if they change bucket, the master key copied or rewrapped on the old platform first
       (ECS can't hold a key file), the switch with sequences carried across, and 30 days read-only. A small database
       can be restored from pgBackRest instead. The replication steps were rehearsed between two local Postgres 16
       containers: every table matched and the reconciliation checks passed; it found that the replication login
       needs `usage` on schema `public`.
    - **Next for ADR-0050:** a real home server (setup runbook end to end), a real tunnel, bucket and sending service,
      the first restore drill, and settling BAK-01 or BAK-09 before turning object lock on. A GCP or Azure adapter and
      Terraform wait until a move is decided.
- **Zoom on the receipt** (RCP-14): on the phone's receipt review, tapping a page in the **Receipt photo** section (folded away by default) opens it full screen. Pinch zooms around the fingers (up to 5x), a drag moves around the zoomed page without leaving its edges, a double-tap zooms in on that spot or back out, and arrows change page. It uses Gesture Handler 3's hook API (`usePinchGesture`, `usePanGesture`, `useTapGesture`) with Reanimated; the modal has its own `GestureHandlerRootView`, as Android gives a modal its own window. The geometry is pure and tested (`src/features/zoom.ts`).
- **Account types** ([ADR-0023](design/adr/0023-account-type-profiles.md)): one definition per type in `@montra/domain` that the form, the account page, Settings and the server read. The form asks only what a type has, and the page shows those facts and the balance over time. The per-type plan built on it is done (ADR-0024 to ADR-0027). The phone shows the type, balance word and each type's details, but no chart yet.
- **Splitting pay** ([ADR-0022](design/adr/0022-splitting-pay.md)): fixed amounts to other accounts, and the rest to the main one, as a plan on the employer. Each deposit is its own transaction and matches its own statement line. Editing is on the web; the phone shows the split and answers which-deposit questions. Forecasts expect each account's share on payday. The phone hasn't been run on a device.
- **The calendar by book** (FLOW-05, UP-14, migration 0057), as Google Calendar's calendars:
  - **Colours**: each book has a colour (`app.entity.color`, `#rrggbb`, in `EntityDto` and `PATCH entities/:id`, which
    now takes a colour on the personal books too). Unpicked, the clients agree on one from an 8-colour palette by the
    book's id (`bookColors` in `@montra/domain`, each 3:1 on the light and dark surfaces). Settings → Entities picks one.
  - **Each item names its book**: `CalendarItemDto.entityId`, filled in by every source in `FlowService.calendarIn`
    from the queries it already ran (`CardStatementDto.entityId` for cards). The `entityId` query filter, Home's
    upcoming list and bill alerts are unchanged.
  - **Hidden books, per person**: `GET`/`PUT calendar/books` (`app.calendar_book_pref`, own row only under RLS; a
    member may save it). Books the person can't see are dropped; an archived book is left out and comes back hidden.
    The calendar API still returns every book: the clients filter.
  - **Web**: with more than one book, a Books bar of on/off switches above the full-width month grid
    (side by side, one under another on narrow screens);
    hidden books' items and totals drop out. Items have a bar in the book's colour (and its name for screen readers),
    a word for their kind, and green or red amounts. **Phone**: the agenda has book chips with a colour dot, saved
    through the same endpoint; the choice is cached, so it applies offline (`src/features/calendar-books.ts`). Not
    run on a device.
- **Statements on the phone** (IMP-09): More → Everyday's **Statements** row (was "Import a statement", still only
  for those who may import) opens a list of the statements imported so far, newest first, from `GET imports`: file
  name, account, the day it was imported, its status in the web history's colours, and the rows it imported (rows
  read while one waits to be mapped or checked). **Import a statement** opens the import flow; pull to refresh, and the
  list looks again every 5 seconds while one is being read. Rows don't open anything and undo stays on the web
  (`src/features/statements.ts`). Not run on a device.
- **Three access fixes** (from ADR-0053's "Inconsistencies found"; each reproduced by a test before the fix,
  `apps/api/test/access-rules.test.ts`):
  - **A viewer is read-only, always** (migration 0061; 0059 and 0060 are kept for tax forms). The invite and
    `PUT sharing/members/:id/grants` refuse `access: 'write'` for a viewer (422 `grant.viewer_write`); making someone a
    viewer turns their write grants into read; `app.entity_access` caps a viewer at read whatever the grant says, and the
    migration turned existing viewer write grants (and those in open invites to viewers) into read. The web's book
    access lists offer a viewer none or read only.
  - **Planning settings are owners' and admins'.** `PATCH planning/settings` had no role check, and RLS
    (`workspace_update`) let a partner's or accountant's save update nothing while it answered 200. The API now
    answers 403 before the update, and `RecommendationsService.updateSettings` throws 403 if the update reaches no
    row. The web shows the settings read-only to everyone else; the phone shows receipt reminders only with the new
    `workspaceSettings` ability (owners and admins), no longer under `setUp`.
  - **The sync feed tells a person about their own private rows** (migration 0062). `GET sync/changes` listed
    restricted changes to owners and admins only, so a linked login's phone never heard about its own payslips.
    `app.change_log` now records whose restricted row changed (`restricted_member_id`: the column RLS checks), and the
    feed asks `app.can_read_restricted` about each one. Changes logged before 0062 have no person and stay owners' and
    admins' only.

- **Tax forms received, PR 1 of 5** (TAX-01 typing only, TAX-02 partly, TAX-08 storage and row-level security;
  [ADR-0052](design/adr/0052-tax-forms-received.md), migration 0059; requirements section 3.8 adds TAX-01..10):
  - **Storage:** `app.tax_form` (kind, year, issuer name and EIN, the person's SSN and the account number as last four
    digits only, the person, the books, the boxes as JSON, status and reason, `deleted_at` for the Trash, `version`),
    `app.tax_form_target` (an employer, or one or more accounts) and `app.tax_form_waiver` (an expected form that won't
    come). Boxes are checked by one Zod schema per kind in `@montra/domain/tax-forms.ts` (`parseTaxFormBoxes`, money as
    minor-unit strings parsed to bigint, unknown boxes refused), which `@montra/schemas` reuses for the DTOs. The same
    module has the Social Security wage base and the 1099/1098 thresholds by year.
  - **Who sees a form:** `app.can_read_tax_form(member)`: the person, owners and admins, and accountants while
    **`app.workspace.accountant_sees_tax_forms`** is on; the uploader too while the person isn't known; always bounded
    by the books. Writing needs write access to the books, so viewers and read-only grants can't.
    `app.tax_form_payslip_totals(form)` gives a W-2's payslip sums to anyone who can read the form, so an accountant
    gets totals without the payslips.
  - **The owner's setting:** `PUT workspaces/:id/accountant-tax-forms`, owner only with a recent sign-in, audited as
    `workspace.accountant_tax_forms_changed` with the old and new values; a trigger refuses anyone else even by a direct
    update. `WorkspaceDto.accountantSeesTaxForms`. Web: owners get a **Tax forms** switch in Settings → Workspace →
    Sharing, under the members list.
  - **API:** `GET tax-forms?year=`, `GET`/`PATCH`/`DELETE tax-forms/:id` (delete moves to the Trash, restored from
    Settings → Your data), `POST tax-forms` (typed in), `POST`/`DELETE tax-forms/waivers`. Members may handle their own
    forms. No reading, matching rules or checks yet.
  - `match_memory` learns `tax_issuer` and `tax_person` (members may write those kinds); the personal chart's Interest
    income and Dividends carry Schedule B's tax lines (`US_SCH_B_L1`, `US_SCH_B_L5`), set on older books by the
    migration.
  - Where the build differs from the ADR is in its "As built: PR 1" section. Nothing on the phone.
- **Tax forms received, PR 2 of 5** (TAX-04, TAX-05, TAX-06 done; TAX-03 by hand; ADR-0052, no migration):
  - **The checks** (`@montra/domain/tax-form-checks.ts`): `reconcileW2` (payslips: E − P, FICA wages capped at the wage
    base, the taxes, 12 D/AA/W, one state's box 17), `reconcile1099Int` (boxes 1 + 3 + 8 against interest on the
    account(s)), `reconcile1099Div` (1a against dividends), `reconcile1098` (the payments' interest, the principal on 1
    January or the origination date). One check per box: form, books, difference, status, the rule in words and what
    was summed. A box matches within $1.00; known explanations (box 12 C, box 2a, box 4, the year boundary, interest at
    closing) make a difference match; reading checks on the form alone turn a difference into "check the reading"; the
    last payslip's year-to-date figures say "a payslip seems to be missing" with the gap's dates; no payslips or a
    valued account with no income is "not tracked". Worked out on every read, never stored.
  - **API:** every `TaxFormDto` carries `result` and `checks`; `GET tax-forms?year=` adds `expected` (a W-2 per employer
    with payslips, a 1099-INT/DIV per non-retirement account with $10 or more, a 1098 per mortgage with $600 or more of
    interest; received, waived or missing) and `unexpectedFormIds`; `GET tax-forms/review`; `POST tax-forms/:id/accept`
    (a box's difference with a note, held while it stays the same); `POST`/`DELETE tax-forms/:id/record` (Record from
    the form on a valued account: income moved from investment gains on 31 December, balance unchanged; taken back by
    a reversal). The books are read under the reader's row-level security; a W-2's sums come from
    `app.tax_form_payslip_totals`, so an accountant sees totals without payslips. `interestEarned()` finds interest by
    Schedule B's tax line first.
  - **Matching by hand** teaches `match_memory`: `tax_issuer` (W-2 by EIN, else name; 1099/1098 by EIN and last four,
    EIN, or name; one account only) and `tax_person` (`tin4:` + a keyed hash of the SSN's last four,
    `FieldCrypto.keyedHash`). Accountants can't match a W-2 to an employer (`W2_EMPLOYER_MATCHERS`; the owner confirmed this on 2026-11-16).
  - **Web:** **Tax forms** in the Books group of the menu (USD workspaces, not viewers): a year picker, the expected forms
    grouped by person (Received with the result, Not yet with "Won't come", Won't come with "Expect it again"), the forms
    received but not expected, and **Type a form in**. A form's page shows its result, the checks with "How this was
    worked out" (rule, explanation, links to the payslips and transactions), Accept the difference, Record from the
    form, Change the form (boxes, issuer, person, match) and Delete. Review gains **Tax forms to check** under the
    statements and bills. The menu's **Review badge** counts tax forms to check as well as transactions (owner's
    choice, 2026-11-16; `reviewBadgeTotal`). The phone's badge gains them in PR 4.
  - Tests: domain table tests per box, the $1.00/$1.01 edge, the year boundary, YTD cross-check, not tracked, reading
    checks, expected forms; API tests (`tax-form-checks.test.ts`) against real payslips, interest, a mortgage and an
    accountant; web helpers; e2e `tax-forms.spec.ts`. Where the build differs from the ADR is in "As built: PR 2".
- **Tax forms received, PR 3 of 5** (TAX-01, TAX-02, TAX-03 done; TAX-08 AI minimization; ADR-0052, no migration):
  - **Doc-worker `taxform.read`** (`taxform.py`): the PDF's text layer, else Tesseract; form titles per page (W-2, W-2c,
    1099-INT, 1099-DIV, 1098, other 1099 sections), year and CORRECTED; copies B, C and 2 dropped; the person's SSN
    and SSN-shaped TINs to their last four, the issuer's EIN, the account to its last four, by their labels; then the
    text masked (members' names as `MEMBER_n`, every TIN and account number, digit runs, emails, phones, addresses and
    the person's name lines). Nothing else leaves the worker. A file it can't read is a result with an `error`.
  - **Gateway `extract_tax_form` v1:** text only (the document has no image field), masked again; boxes validated per
    kind into minor units, a returned name dropped, counts only in the audit event. Fake provider `fake-tax-form.ts`
    and an eval corpus (`packages/ai-gateway/test/tax-forms`: W-2s, 1099-INT, 1099-DIV, 1098, a consolidated 1099, a
    W-2c and a corrected 1099).
  - **API:** `POST tax-forms/files` (several files; the same file again refused with its form) makes a form in `reading`
    per file and queues `taxform.read` then `tax_form.match`, which makes one form per form found, matches the issuer
    (an EIN learned once, or the one clear candidate, with the reason in words; `decideTaxFormMatch` in
    `@montra/importers`) and the person, finds probable copies and the forms a corrected one replaces, and confirms the
    reading when every check agrees with the books. `POST tax-forms/:id/confirm` (Confirm reading),
    `GET tax-forms/:id/files/:fileId` (audited), a misread form's kind changed by `PATCH`, `TaxFormDto.reading`.
    Accountants match nothing to an employer. `GET jobs/:id` hides the chain's results.
  - **Web:** a drop zone on `/tax-forms` (several PDFs or photos), a Being read list that refreshes itself, and on a
    form: its file, where its reading stands, why it was matched or the matches to pick, a probable copy, Confirm
    reading, and the kind of a form that couldn't be read.
  - Tests: pytest on reportlab forms and rendered images (no SSN-shaped string, nine-digit TIN, name or address in the
    output; real Tesseract in CI), the gateway's corpus, minimization and dropped names, matcher units, API tests
    (`tax-form-reading.test.ts`: upload, the chain, the automatic rules, copies, corrections, consolidated 1099s, person
    conflicts, accountants, unread forms, the file and jobs, and a W-2 rendered by `year-end-pdf.ts` read back to the
    same boxes), web helpers and an e2e upload. Where the build differs from the ADR is in "As built: PR 3".
- **Tax forms received, PR 4 of 5** (TAX-09 done; ADR-0052, no migration, no API change). Not run on a device yet:
  the owner tries it on the LAN APK build.
  - **More → Tax forms** (Everyday group; USD workspaces, not viewers; `showsTaxForms`): a year picker (the last four
    years, last year until April), the forms being read, the expected forms by person (Received with the result, Not
    yet, Won't come with its reason) and the forms received but not expected. Read with `useCached`, so the last copy
    shows offline. Typing a form in and waivers stay on the web.
  - **Scan a form** (`/tax-forms/scan`): `DocumentCapture`; scanned, shot or picked photos become one PDF (Print, as a
    statement's scan), picked PDFs go as they are, to `POST tax-forms/files` with the year and `source` (`scan` for the
    phone's own pages). The app's pages and the PDF it made are removed after the upload. One file opens its form.
  - **A form** (`/tax-forms/[id]`): the result, the reading (stage, problem, a probable copy, why it was matched), the
    boxes read (to compare with the paper; editing them is on the web), and the checks (form, books, difference,
    status, how it was worked out, links to payslips and transactions). Actions: the suggested matches, change the
    match (an employer for a W-2, one or more accounts for a 1099, the mortgage for a 1098) and the person, Confirm
    reading, accept a difference with a note, Record from the form and take it back. Accountants never match a W-2 to an
    employer, as on the web. Writes need a connection and write access to the form's books.
  - **Review** shows **Tax forms to check** under statements and bills to file; each opens its form.
  - **The Review badge** (tab bar and More) adds tax forms to check to the sync feed's `reviewCount`. The phone reads
    `GET tax-forms/review` (at most once a minute when sync runs, at once after an action on a form, and from Review's
    list; a failed read keeps the last count) rather than the server adding the forms to `reviewCount`: the forms'
    checks are worked out on read, which every sync pull would otherwise pay for. `TaxFormsToCheck` in
    `src/features/tax-forms.ts`, `useTaxFormsToCheck`.
  - Tests: `apps/mobile/test/tax-forms.test.ts` (who sees them, the year, results and checks, reading stages and
    Confirm reading, the boxes against the domain's schemas, the year's sections, the match sent, scan uploads, the
    badge's sum and its once-a-minute counter, the client's endpoints and multipart fields, and every i18n key the
    screens use). Where the build differs from the ADR is in "As built: PR 4".
- **Tax forms received, PR 5 of 5** (TAX-07, TAX-08 and TAX-10 done; ADR-0052 complete; migration 0060). The phone's
  new Tax package card isn't run on a device yet.
  - **The tax package** (`runTaxPackage`, `src/tax-forms/tax-form-package.ts`): `tax-forms/` (each form's file once,
    `W-2-Acme Corp-Sam.pdf`), `tax-forms.csv` (one row per form, then one per expected form not received or waived),
    `tax-forms-check.pdf` (each form's checks as on the screen) and a README line that Montra checked the forms and
    didn't prepare a return, counting any forms left out. Read under the maker's row-level security, so an accountant's
    package has members' forms only while the owner's setting is on. USD workspaces; a package with no forms to show is
    as before.
  - **The panel's warning** (forms that differ or need a look, expected forms not yet come): web Settings → Your data,
    Schedule E and business taxes (`TaxPackageWarning`, `packageWarning`); the phone's Your data gains a **Tax package**
    card (books, year, warning, Make; not for members, whose exports the API refuses).
  - **Retention**: tax form files are their own file kind, `tax_form` (moved from `other` by the migration), kept until
    31 December of the tax year + 7 by a trigger that follows the year, purged by `data.retention`. Forms in the Trash
    for 30 days are purged with the files no other form holds (`app.purge_trash`, now run first). The owner's storage
    copies `tax_form` by default, as payslips; connections that copied `other` keep copying them.
  - **Backups** restore the three tables (round trip tested); a partner's or one set of books' backup leaves out the
    files of tax forms it doesn't hold. Payslip files had the same gap, closed afterwards for every kind of file (see
    "Files in partial backups" below).
  - **The reminder** `tax_forms_missing`: from 16 February (caught up to the 22nd), once per person and year, last
    year's expected forms not received or waived as each person can see them; nothing when nothing is missing. A row in
    notification settings on the web and the phone.
  - Tests: `apps/api/test/tax-form-package.test.ts` (personal and rental packages, accountant off and on, a partner's
    package, retention and its year, the upload's kind, the Trash purge with a shared file, a backup round trip and a
    partner's backup, the reminder's day, recipients and dedupe, and a workspace with nothing missing),
    `packages/db/test/tax-forms.test.ts` (the migration's data update, the storage mirror with and without `tax_form`,
    staff grants), web and phone helpers. Where the build differs from the ADR is in "As built: PR 5".
- **Files in partial backups** (PAY-09, BAK-04, ADR-0019 §7; no migration). Files carry no books or person, so row-level
  security lets every member read their `app.file` rows, and an archive of less than the whole workspace took every file
  but tax forms'. A partner's backup of their personal books held another member's payslips (the payslip rows were left
  out, their files weren't), the owner's scans, the files of books the partner had no grant to, and, with a read-only
  grant to a business, its I-9 ID copies, decrypted. An owner's backup of one set of books held the other books' files.
  - **Now** such an archive takes a file only with a row it holds that holds it: a payslip, receipt, bill, invoice, lease,
    maintenance log, household bill, import, scan, intake, reimbursement, I-9 document, business logo or tax form. The
    holders are `FILE_HOLDERS` in `apps/api/src/data/catalog.ts`, read in the archive's snapshot under the maker's RLS
    and the archive's books (replacing PR 5's tax form rule). A test pins the list against the schema (every `uuid[]`
    column named for files or attachments, and every foreign key to `app.file`). An owner's or admin's backup of the
    workspace is as before. A file no row holds (an upload never used) is left out of a partial archive too.
  - **Not a backup gap**: no journal entry or transaction holds a file; a receipt matched to a restricted entry (such as a
    payslip's) follows the receipt's own row-level security (its books), in the app as in a backup.
  - Tests: `apps/api/test/backup-files.test.ts` (a partner's backup without Sam's payslip file but with their own, without
    the owner's scan or the rental's receipt; an owner's full and one-book backups; restores of both),
    `payroll-people.test.ts` (no I-9 copies for a partner with read access), `data-ownership.test.ts` (the holders list).
- **Family Document Vault, PR 1 of 6: contracts** (VLT-02, VLT-03 and VLT-07 partial; requirements 13.6 adds
  VLT-01..11, traced to P14; [ADR-0054](design/adr/0054-family-document-vault-storage.md), migration 0063). No vault code
  and no dependency on the vault; nothing can connect a vault yet, and nothing anyone sees changes except the plan key
  (below).
  - **Storage:** `app.storage_destination.kind` gains `fdv` and `status` gains `needs_vault` (vault rows only); the one
    connection per workspace becomes one mirror and one vault. `app.vault_connection_state` (feed position, checks,
    daily-cap holds, clock offset, key change) and `app.vault_item` (the outbox: `queued` → `pending` → `received` →
    `filed`, or `not_kept`, `failed`, `out_of_reach`, `delete`; the id saved once and never changed, by trigger), both
    owners and admins only and pinned to vault connections by a foreign key on the kind. `app.file` gains `location`
    (`montra`, `vault`), `missing_since` and `missing_reason`, and `replaced_sha256`; `storage_key` stays NOT NULL
    until PR 5.
  - **Triggers and functions:** a stored file is queued for the vault when its group is on (never sealed copies, logos
    or exports); deleting a file for good withdraws an Inbox item and deletes a filed document only when asked and
    allowed. `app.vault_due()` and `app.vault_next()` for PR 3's job. The mirror's trigger, functions, settings, job and
    backups to storage now look at mirrors only.
  - **Contracts:** the DTOs and the group mapping (`vaultGroupOf`, `vaultFileKinds`; receipts, statements and bills on,
    payslips, tax documents and other papers off) in `@montra/schemas`; the `VaultDestination` port and `VaultError` in
    `apps/api/src/storage/destinations/vault.ts`, with no adapter. Five `vault_*` security log kinds; the notification
    types are in the database only, for the PRs that send them.
  - **Plan key `familyVault`**, on wherever `ownStorage` is (every existing version, by the migration). The staff
    console lists it; customers don't see it until a vault can be connected (`FEATURES_NOT_YET_SHOWN` in
    `@montra/domain`, which PR 2 or 3 empties).
  - Waits for the vault's first client release tarball (0.9.0-dev.60) before PR 2.
  - Tests: `packages/db/test/vault.test.ts` (one mirror and one vault, kinds and statuses, the outbox's checks and fixed
    id, RLS for each role and workspace, staff with no table or function, a file's place, the triggers, the job's
    functions), `packages/schemas/test/vault.test.ts` (the group mapping, table-driven over every file kind, and the
    DTOs, never a private key), `apps/api/test/own-storage.test.ts` (a mirror beside a vault),
    `apps/api/test/plans.test.ts` and `packages/domain/test/operations.test.ts` (the plan key). Where the build differs
    from the ADR is in its "As built: PR 1".
- **Family Document Vault, PR 2 of 6: connecting** (VLT-01 and VLT-08 partial, VLT-02 updated; ADR-0054 "As built:
  PR 2"; no migration). Nothing is sent yet.
  - **The dependency:** `@fdv/client` (MIT), pinned by URL to the vault's public release tarball
    `v0.9.0-dev.59/fdv-client-0.9.0-dev.59.tgz` in `apps/api` (integrity in the lockfile). ESM only; the API is ESM, so
    it imports it directly. It has no install scripts, makes no network call on import and depends only on
    `libphonenumber-js`. Its contract scenarios need vitest 5 or 6 and aren't used; `.pnpmfile.cjs` dropped their
    optional vitest peer, so the API's production image didn't carry vitest (gone with dev.61, which has no peers; PR 4).
  - **Connecting** (`apps/api/src/storage/vault/`, `/v1/workspaces/:id/family-vault`): an owner with a recent sign-in
    starts; Montra makes a fresh Ed25519 pair and seals the private key at once (`FieldCrypto`, `secret_enc`); the card
    shows the public key and fingerprint to register in the vault; the pasted code is checked in order (names that key,
    public https address with no loopback exception, a vault that takes apps and which one, pinned, then a signed
    connection test through the package). Waiting for approval is saved and checked again on request (owners and
    admins). A different vault at the pinned address, or the app paused or removed there, stops the connection with the
    words to show; five unreachable checks in a row turn it `failing`.
  - **Replacing the key:** a new pair sealed beside the current one, which keeps signing until the vault's code for the
    new key checks out; the old key is then retired. Built through the vault's Settings (someone there adds the key and
    gets a code), because the package's fake has no route for an app to add its own key; see the ADR.
  - **Disconnecting** deletes the connection with its key, state and outbox. Security log rows: `vault_connected`,
    `vault_changed`, `vault_key_replaced`, `vault_disconnected`.
  - **The owner's clarification** (2026-11-17): the connection-wide role and backup choice are replaced by a mode per
    group (not sent; sent, keep a local copy; sent, no local copy) in the ADR, the DTOs and the helpers
    (`VaultGroupMode`, `vaultGroupModes`, `vaultKeepsCopy`). No migration: they only lived in `config`.
  - **Web:** a "Family Document Vault" card in Settings → Storage for owners and admins whose plan has `familyVault`
    (only an owner changes anything): the three steps, waiting for approval, status, the clock warning, Check again,
    Replace the key, Disconnect. The per-group choices come with sending (PR 3). The plan key stays hidden from the
    billing page (`FEATURES_NOT_YET_SHOWN`) until then.
  - **Test-only switch:** `FAMILY_VAULT_FAKE=on` runs the package's own fake vault inside the API process (refused in
    production), with a dev-only route that stands in for the vault's owner registering Montra. Tests and the e2e run
    never reach a real vault.
  - Tests: `apps/api/test/family-vault.test.ts` (keys, the address guard incl. the socket, failures mapped to words,
    connecting with good and bad codes, private and loopback addresses, identity pinning, waiting for approval, paused
    and removed apps, failing, key replacement and cancel, disconnecting, owner-only and recent sign-in, secrets never
    in answers, logs, the security log or archives), `apps/api/test/plans.test.ts` (a plan without the vault),
    `packages/schemas/test/vault.test.ts` (the modes), `apps/web/lib/vault.test.ts`, and the Playwright spec
    `apps/web/e2e/family-vault.spec.ts` (connect, check, replace and cancel, disconnect, against the fake).
  - Next: PR 3 (sending with a local copy kept, the job, the per-group choices), on `@fdv/client` 0.9.0-dev.60 when it
    is out.
- **Family Document Vault, PR 3 of 6: sending** (VLT-07 done; VLT-01, VLT-02, VLT-03, VLT-04, VLT-08, VLT-09 partial;
  ADR-0054 "As built: PR 3"; migration 0064). The plan key is now shown to customers (`FEATURES_NOT_YET_SHOWN` is empty).
  - **The dependency** moves to `@fdv/client` 0.9.0-dev.60 (`v0.9.0-dev.60/fdv-client-0.9.0-dev.60.tgz`, 496,636
    bytes, sha256 `303cac17c6a7455c…`, checked against the vault side's numbers; integrity in the lockfile). It adds
    `content_available` on every intake state (stored on `vault_item`), routing to the Inbox of the person a paper is
    about, and `sentFile()` (unused until PR 5).
  - **Migration 0064:** a filed row may have no document id (a vault that lets Montra send but not read says only
    "filed"); `vault_item.content_available`; the trigger on `app.file` wakes `storage.vault` two minutes after it
    queues a file; `app.vault_file_busy(file)` (definer, owners and admins: is any receipt, payslip, import, scan,
    intake or tax form still reading the file or in review) and `app.vault_file_states(files)` (definer, the badges).
  - **The job** (`apps/api/src/storage/vault/vault.jobs.ts`, `storage.vault`, registered in the worker): per due
    connection, under an owner's RLS: the signed check when it is due, failed or waiting (so approval is now noticed on
    its own); `queued` → `pending` once Montra has finished with the file (or `not_kept` for a statement export or a type
    or size the vault doesn't take); one send at a time with a pause, the id saved before the first send, a row whose
    answer was lost asked about before it is sent again; the vault's hash checked; Inbox items asked about every 30
    minutes, a hundred at a time; withdrawals and deletes for files deleted for good. Daily cap: a hold, not a failure.
    A wait the vault asks for (busy, too many requests): waited out with jitter and backoff, never given up over. A
    problem with the connection itself: `needs_vault` at once, owners and admins told once (`vault_attention`, a new
    notification type they can't switch off, as `storage_failing`). Five failures in a row: `failing`, told once.
  - **What Montra says** (D5): the group's vault kind, a title from the file's name (and a business's or rental's name),
    the paper's date, the tax year, and the person a payslip, tax form or household bill belongs to (by name; the vault
    routes it to their Inbox when they can receive it). Amounts and account last four only with "Describe documents in
    more detail". Only hints the vault says it takes.
  - **API** (`/v1/workspaces/:id/family-vault`): `PATCH` (groups, more detail, deletes, pause; payslips and tax
    documents owner-only with a recent sign-in, an admin may turn them off; `sent_no_copy` refused), `GET`/`POST
    existing` (the count and days at the daily limit; send them, owner-only, recent sign-in, the count shown must match),
    `POST retry` (Try again; Send again for a file not kept), `GET items`, `GET files?ids=` (badges, for anyone who can
    see the files).
  - **Web:** the card's "Send these to the vault" table (each group's mode and vault kind, suggestions, the warning for
    payslips and tax documents, the note that sending without a local copy comes later), the counts and the daily-limit
    hold, Try again and Send again, Send existing documents with its estimate, Describe documents in more detail, Pause
    sending. Badges ("Sending to the vault", "In the vault's Inbox", "In the vault", "Not taken by the vault") beside the
    files of receipts, payslips and tax forms.
  - **Not done here:** sent with no local copy, `FileBytes`, missing files (PR 5); the changes feed and the vault's own
    name for a document, view links (PR 4); the phone (PR 6); badges on statements and bills (their screens don't list
    files by id yet).
  - **The fake vault reads a multipart body as UTF-8**, so a binary file (a real PNG or JPEG) hashes differently there
    and Montra's hash check fails it. Tests send text-only bytes; asked of the vault's side. The real vault is
    unaffected as far as Montra knows.
  - Tests: `apps/api/test/family-vault-sending.test.ts` (the id saved before the first send and reused after a lost
    answer, waiting while Montra reads a file, filed without a document id, one at a time oldest first and the backfill
    with its count, statement exports, types and sealed copies never sent, the person hint and the vault's routing (to
    the person, and to the acting member when that person is locked), the daily cap, busy waits, failing after five,
    the connection stopped and owners told once, family-removed and lapsed items, a kind no longer allowed, a hash
    mismatch and Try again, withdrawals, badges, pausing, group modes and owner-only payslips),
    `apps/api/test/family-vault.test.ts` (updated for sending columns), `packages/db/test/vault.test.ts` (migration
    0064), `packages/schemas/test/vault.test.ts`, `apps/web/lib/vault.test.ts`, and the Playwright spec (choosing what
    is sent, the warning, the count of existing documents).
  - Next: PR 4 (keeping in step: the changes feed, the vault's names, out of reach, view links).
- **Family Document Vault, PR 4 of 6: keeping in step and view links** (VLT-05 and VLT-06 partial; VLT-03, VLT-08,
  VLT-09 updated; ADR-0054 "As built: PR 4"; migration 0065).
  - **The dependency** moves to `@fdv/client` 0.9.0-dev.61 (`v0.9.0-dev.61/fdv-client-0.9.0-dev.61.tgz`, 501,417
    bytes, sha256 `535a6bff7f8520f1…`, checked against the vault side's numbers; integrity in the lockfile). It has no
    peer dependencies, so `.pnpmfile.cjs` and its Dockerfile copies are removed (the API's production install still has
    no vitest). A network failure's short code (`ECONNREFUSED`) goes into `VaultError.detail`; its `cause` is never
    logged. Its new key routes aren't used: vault 0.9.0-dev.63 replaces signing with API keys, and a separate PR follows.
  - **Migration 0065:** `vault_connection_state.feed_next_at` and `full_read_started_at`, `vault_item.feed_seen_at`;
    `vault_due()`/`vault_next()` count the feed while a connection is active or failing; `app.vault_file_open(file)`
    (definer, members of the workspace: the document to open, its status and the owner the connection acts as).
  - **The feed** (`apps/api/src/storage/vault/vault.feed.ts`, in `storage.vault`): every 20 minutes while the vault lets
    Montra read, and caught up before a document is opened. Each page is applied with its position in one transaction,
    only if nobody moved it meanwhile. Only Montra's own documents (by document id, or Montra's id for a filed item it
    wasn't told the document of); the rest is skipped, never stored. `vault_meta` keeps the vault's title, kind, date
    and version, never amounts or digits; the books are never touched. Unavailable: `out_of_reach` ("No longer available
    in Family Document Vault"), filed again when shown again. A position refused (too old, or unknown after a restore):
    the whole feed is read again, and filed documents it didn't show are out of reach.
  - **Opening:** "Open in the vault" beside the badges of receipts, payslips and tax forms (filed documents the feed has
    shown). A plain link to `/w/:id/vault/:file/open` (web route: no prefetch, no other site), which calls `POST
    /v1/workspaces/:id/family-vault/files/:file/open` and passes its 303 straight to the browser. The API checks the
    person can see the file, mints a single-use link under the connection's owner context, and audits
    `file.vault_link_made` without the link. A type the vault can't draw opens as a download when allowed; the hourly
    link limit is a wait in words (429, `Retry-After`); not allowed, not filed, no longer available: words, on
    `/w/:id/vault/:file?problem=…`.
  - **Settings:** "Also delete it in the vault when Montra deletes a file for good" (owner, off by default, offered when
    the vault allows deletes) and when the vault's changes were last read. DTOs: `FileVaultSummaryDto` gains `kind` and
    `canOpen`, `VaultConnectionDto` gains `feedReadAt`, new `VaultOpenQuery` (web fixtures updated; the phone has no
    vault types yet).
  - **For the owner:** with no read grant, a document the family puts a newer version into stops being readable to
    Montra, so it shows as "No longer available" rather than "the vault has a newer version" (ADR "As built: PR 4").
  - Tests: `apps/api/test/family-vault-feed.test.ts` (the feed's terms; a full read, then changes, from the saved place;
    the books unchanged; a newer version; never storing the family's own papers; resuming after a page; out of reach
    and back; starting over after a restore and an unknown position; a connection problem and an unreachable vault
    while reading; no feed without read access; links made per click, 303, never in any table, output or answer;
    audit; who may open; the hourly limit as a wait; download instead of view; not allowed to open; catching up before
    opening), `packages/db/test/vault.test.ts` (migration 0065), `apps/web/lib/vault.test.ts` (names, the open route and
    its outcomes, prefetches refused, the feed line), and the Playwright spec (the delete switch, the feed line, opening
    a file that isn't there).
  - Next: PR 5 (sent with no local copy, `FileBytes`, missing files, bringing files back).
- **Family Document Vault, PR 5a of 6: reading a file whoever holds it** (VLT-11 partial; VLT-05 and VLT-09 updated;
  ADR-0054 "As built: PR 5a"; migration 0066). PR 5 is split: 5a moves every reader onto `FileBytes` and removes
  nothing; 5b turns on "sent with no local copy".
  - **The dependency** moves to `@fdv/client` 0.9.0-dev.62 (`v0.9.0-dev.62/fdv-client-0.9.0-dev.62.tgz`, 504,907
    bytes, sha256 `aa97e8fbc64bbe16…`, checked against the vault side's numbers; integrity in the lockfile). Its fake
    keeps a file's bytes exactly as sent, so the vault suites now send binary files of every byte value. Not dev.63
    (API keys), which a separate PR takes.
  - **Migration 0066:** `app.file.storage_key` drops NOT NULL (the 0063 check still keeps a key on every file Montra
    holds); `app.workspace_storage_keys` skips null keys and adds sources the vault's job still has to remove;
    `app.file_copies(file)` (definer, members: where the mirror's and the vault's copies are, and the owner the
    connections act as).
  - **`FileBytes`** (`apps/api/src/storage/file-bytes.ts`): Montra's copy, then the mirror's (a new `get` on S3 and
    WebDAV), then the vault's (`sentFile`, by Montra's own id, the exact file sent), each checked against the file's
    hash; or a typed reason in words (`in_vault`, `vault_refused`, `vault_read_cap`, `vault_unavailable`, `not_held`).
    The vault's daily read cap is held until its reset (`read_held_until`), never a failure; a connection problem wakes
    the connection's check. Every reader uses it: previews (a file only the vault holds is a 409 "Open it there"; one
    the mirror holds is served), AI reading, imports, intakes and migrations (jobs: permanent in words, or retried on a
    hold), backups and tax packages (they hold every file they can get and list the rest in the README instead of
    failing), payroll documents, invoices, and the mirror's and the vault's own sending (which never ask the vault). A
    receipt, payslip, scan, intake or import made from a file only the vault holds puts Montra's copy back first
    (`ensureHeld`), since the doc-worker reads by key. A test fails if any other code reads a file by its key.
  - **Not done here (5b):** the third mode in Settings and the API, removing sources and resuming after a crash, missing
    files (`missing_since`, Review's "Files to provide again" with Upload, the badge, `files_missing` once a day,
    uploading again under the same id), the count of missing files on an archive's screen, the move backfill, bringing
    files back, the disconnect choice, the web's handling of `file.in_vault`, and whether a background archive waits for
    the vault's daily reset.
  - Tests: `apps/api/test/family-vault-file-bytes.test.ts` (the schema; reading back every byte of a file only the
    vault holds, counted against the vault's reads; Montra's id, not the vault's newer version; refused, a different
    file, the read cap held, a paused or stopped connection; Montra's copy first, a lost object read back; previews sent
    to the vault; jobs; a new receipt putting Montra's copy back; a backup and a tax package with a file from the vault
    and one the vault won't return; the vault's and the mirror's jobs never asking the vault; the mirror read back,
    under the owner's context for a partner, and passed over when its copy differs; the client's refusals in Montra's
    terms; no other reader by key), and the PR 3 and PR 4 vault suites, now with binary files.
  - **For the dev.63 PR:** the owner chose that the app that sent a document keeps reading it, in the feed and through
    view links, after the family adds a newer version; from dev.63 the feed reports the newer version, so PR 4's "No
    longer available" for that case changes then. `sentFile` already returns Montra's exact bytes, so 5a and 5b don't
    depend on it.
  - Next: PR 5b (sent with no local copy: removal, missing files, the move backfill, bringing files back, deletes).
- **Family Document Vault, PR 5b1 of 6: sent with no local copy** (VLT-02, VLT-04, VLT-05, VLT-08, VLT-11 and BAK-08
  updated; VLT-10 started; ADR-0054 "As built: PR 5b1"; migration 0067). PR 5b is split again: 5b1 turns the third
  mode on with its removal and missing files; 5b2 does the rest.
  - **The third mode** is offered in Settings and the API (owner only, a recent sign-in, §5a's warning); Settings says
    when the owner's own storage still keeps a copy of such a group, and counts files kept only in the vault and to
    upload again (`VaultConnectionDto.files`, `.mirrorGroups`).
  - **Removing Montra's copy** (`storage.vault`, `removeSources`/`moveOne`): only for a document filed while its group
    is in that mode (or a file put back to be read again), and only when the vault has filed it, says it could give the
    exact file back (`content_available`, asked again first), the owner's mirror has it when it copies that kind, nothing
    reads it or has it in Review (`app.vault_file_busy`, now also while a backup or tax package is being made), and the
    connection is active. One transaction moves it (`location = 'vault'`, the key to `source_key`, an audit row
    `file.moved_to_vault`), then the object is deleted and `source_removed_at` set; a crash in between is finished by the
    next run. `vault_item.remove_at` (0067) says when to look, counted by `vault_due()`/`vault_next()`.
  - **Missing files** (§5a): a file only the vault holds that it doesn't give back, or whose document the feed says is
    out of reach, gets `missing_since` and a reason in words (audited); never for the daily read cap, never for a file
    Montra holds. Review → "Files to provide again" on the web and the phone (`GET/POST …/missing-files`), with what
    uses each file and an Upload action; its count joins the Review badge on both. `files_missing` (no file names, at
    most once a day) to owners, admins and the uploader. Uploading again keeps the file id, clears the mark, notes a
    different hash (`replaced_sha256`), and sends it to the vault again as a new send.
  - **The web's `file.in_vault`:** receipt and payslip viewers say the file is kept in the vault, with "Open in the
    vault"; a link to such a file goes, through the API proxy, to the vault page with the same link.
  - **Quota (BAK-08):** files held only in the vault don't count (`check_storage_quota`, `workspace_storage`).
  - **Disconnecting** is refused while files are held only in the vault, until 5b2's choice.
  - Tests: `apps/api/test/family-vault-no-copy.test.ts` (the mode offered and existing filed files kept; each removal
    condition alone, the crash and the resume; missing on refusal and out of reach, the Review list and who sees it, one
    notification a day; found again; never for a file Montra holds; uploading again, a different hash, who may; the
    quota; disconnecting refused), web `vault.test.ts`, `missing-files.test.ts`, `phase3.test.ts`, phone
    `missing-files.test.ts`, and e2e `files-to-provide.spec.ts` and `family-vault.spec.ts`.
  - **Not done here (5b2):** the move backfill for files filed before a group was switched, bringing files back and
    "Disconnect anyway", the missing count on an archive's screen (`ExportJobDto`, web fixtures and phone types), a
    background archive waiting once for the vault's daily reset, and restore marking files that weren't in the archive.
  - Next: PR 5b2, then the dev.63 PR (API keys) and PR 6 (the phone).
- **Family Document Vault, PR 5b2 of 6: the vault as the record, the rest** (VLT-04 and VLT-11 done; VLT-08, VLT-10
  and BAK-06 updated; ADR-0054 "As built: PR 5b2"; migration 0068). Still on `@fdv/client` 0.9.0-dev.62.
  - **Move existing documents** (`GET/POST …/family-vault/move`, `VaultMoveDto`): right after a group is saved as "no
    local copy", the web offers "Move these N files too?" for what the vault had already filed; nothing moves without
    the owner's yes (the count confirmed, recent sign-in). Confirmed rows get `remove_at`, and the job's removal step
    moves each under §5's conditions, one file per transaction. Settings keeps the action for later.
  - **Bring the files back** (`POST …/family-vault/bring-back`, and as a disconnect choice): groups sent without a copy
    keep one again, and `storage.vault` copies each file held only in the vault back into Montra, one at a time, through
    `FileBytes` (audited `file.brought_back`), waiting for the vault's reset at its daily read cap
    (`vault_connection_state.bring_back_*`).
  - **Disconnecting** with files held only in the vault is a choice: bring them back, then disconnect; or disconnect
    anyway, a soft disconnect (the owner's decision): the row stays `disconnected` with its outbox, `secret_enc` is wiped
    (null allowed only then), nothing is sent or due, and those files are missing ("disconnected from the vault") in
    Files to provide again. "Connect again" makes a new key on the same row; the same vault (by installation id) clears
    those marks and reads them back; another vault drops the old outbox. A disconnected row is removed only once no
    file is held only in the vault.
  - **Archives:** `ExportJobDto.missingFiles` and `.waitingUntil` (web list and phone's Your data); an archive meeting
    the vault's daily read cap waits once (re-queued for after the reset, `JobQueue.enqueue({ runAfter })`) and then
    lists what is still unavailable. **Restore** marks files the archive didn't hold as missing, with the reason.
  - **Possible duplicates:** one hash lookup (`storage/duplicates.ts`), files held in Montra or only in the vault;
    receipts' existing `duplicateOf` now shown on the web, and payslip, household-bill and business-bill uploads answer
    it too; Files to provide again answers 409 `file.possible_duplicate` unless `?anyway=true` (web and phone ask).
    Statements and intakes already warned; tax forms keep refusing exact duplicates.
  - Tests: `apps/api/test/family-vault-move-back.test.ts`, `packages/db/test/vault.test.ts`,
    `packages/schemas/test/vault.test.ts`, web `vault.test.ts` and `missing-files.test.ts`, phone `missing-files.test.ts`
    and `data-settings.test.ts`, e2e `files-to-provide.spec.ts` (the duplicate warning).
  - Next: the dev.63 PR (API keys) and PR 6 (the phone's vault status, badges and opening).
- **Family Document Vault: API keys** (vault 0.9.0-dev.63–65; VLT-01, VLT-05, VLT-08 and VLT-09 updated, statuses
  unchanged; ADR-0054 "API keys (vault 0.9.0-dev.63–65)" and "As built: API keys"; no migration). On `@fdv/client`
  0.9.0-dev.65 (509,935 bytes, sha256 `5f97657d1dd676e8…`, checked).
  - **Connecting:** an owner (recent sign-in) pastes the `fdvapp2.` connection string the vault showed with Montra's API
    key, and the secret when the string doesn't include it (`POST …/family-vault`, `ConnectVaultRequest`). Montra checks
    the string, the key's shape, the public-HTTPS guard, the vault's identity (pinned) and `/apps/me` before saving; the
    secret is sealed in `secret_enc` and never in a DTO, log, table, archive or backup. The key pair, the fingerprint,
    "Montra makes a key" and `POST …/family-vault/code` are gone.
  - **The key's state:** each check stores the key's name, permissions and expiry; Settings warns, and owners get one
    `vault_attention` notification, 14 days before it expires. The vault's 401s say "revoked / expired / isn't valid — an
    owner needs to paste a new key" and stop the connection; a 403 says which permission the key lacks, per action.
  - **Replacing the key:** owner-driven, a new connection string or client ID with its secret, checked with `/apps/me`
    (same app, same vault) before switching. The rotation states (`key_rotation`) are left unused.
  - **Acting as:** Settings shows whether Montra acts as itself or as a person (APP8); a 503 busy is retried with
    backoff, never a failure.
  - **Newer versions:** a family version stays readable, updates "In the vault as: …" and is noted; `sentFile()` still
    reads back the exact file Montra sent.
  - **Cutover:** connections made with Ed25519 read as needing a new key, in Settings, when checked and from the job
    (owners told once); never sent to the vault.
  - Tests: `family-vault.test.ts` (rewritten), the sending, feed, file-bytes, no-copy and move-back suites,
    `vault-port.test.ts`, `packages/schemas/test/vault.test.ts`, web `vault.test.ts`, e2e `family-vault.spec.ts`.
  - Next: PR 6 (the phone's vault status, badges and opening).
- **Family Document Vault, PR 6 of 6: the phone** (VLT-06 and VLT-10 done; VLT-03 updated; ADR-0054 "As built: PR 6";
  no migration). The last PR of the chain.
  - **Open in the vault from the phone:** `POST …/family-vault/files/:fileId/link` makes the same single-use link as
    PR 4's redirect, after the same checks, and answers it in a `no-store` body (`VaultOpenLinkDto`, `{ url, mode }`),
    because a React Native client can't read a redirect's target. Outside the idempotency store and never logged; only
    the phone's client calls it (not `@montra/api-client`). The app hands it straight to the system browser
    (`Linking.openURL`) and keeps it nowhere. The hourly link limit (429, `Retry-After` in minutes), not allowed, no
    longer available and a type the vault can't show as pages (a download, or words when it may not) are said in words.
  - **Status in Your data** (owners and admins, read only): connected, waiting for approval, needs attention (with the
    vault's words or why the key no longer works), key expiring, paused, disconnected; where, acting as, the key's
    expiry, daily-limit holds, counts, the feed; files to upload again link to Review; changes are on the web.
  - **Badges** on receipts, payslips, tax forms and household bills (bills have none on the web), with "In the vault as:
    …", the newer version, "No longer available", kept only in the vault and missing, and "Open in the vault". A
    receipt's or payslip's page kept only in the vault is shown in words with "Open in the vault" instead of asked for
    (the API's 409 `file.in_vault`).
  - **The duplicate question** on the phone's receipt, payslip and bill uploads (`duplicateOf`): payslips and bills ask
    right after the upload; a receipt capture waits in the offline queue in a new `duplicate` state until the person
    uses it anyway or discards it on the Receipts screen (`ReceiptUploadQueue.useAnyway`).
  - The `family-vault-file-bytes` clock-skew flake is fixed: the test asks Postgres whether the check is due.
  - Tests: `apps/api/test/family-vault-feed.test.ts` (the body link), `packages/schemas/test/vault.test.ts`,
    `packages/sync/test/receipt-queue.test.ts`, phone `vault.test.ts`. The phone wasn't run on a device; the Android
    bundle builds (`expo export`).
  - Left for later: badges on statements (no screen lists their files by id), and the hand-run live test against the
    vault's development build behind HTTPS (§15). VLT-01, -02, -05, -08 and -09 stay partial as their PRs left them,
    for the owner to close or keep open after that run.
- **The storage mirror claims one batch at a time** (ADR-0031 §5; no migration). `storage-mirror.jobs.ts` claimed files
  and backups with `update … where (…) in (select … limit n for update skip locked)`. When the planner expects about one
  row, it runs that subquery again on the inner side of a semi-join for every row it updates; rows it has just updated are
  skipped by the lock, so each run brings in the next ones and the update leases more than `n`. Rows leased but not
  processed wait out the 10-minute lease. The backup claim did this in tests with no help (its row policy has the planner
  expect one row: 6–8 leased for a limit of 5); the file claim leased the whole queue (31 for 20) once the statistics were
  from an almost empty table, as on a new install. Both now claim in a CTE, as `vault.jobs.ts` does (PR #133).
  Checked and left as they are: `app.dequeue_job` (migration 0006) compares `id = (select … limit 1)`, a scalar
  subquery run once; the `/ai/tasks` claim in `ai.controller.ts` has `in (select … limit 20)` but no row lock, so a rerun
  sees the same rows and can't lease more. Tests: `apps/api/test/own-storage.test.ts` ("claiming a batch at a time").
- **Local-mode AI task claim** (`GET ai/tasks`): two clients asking at once could both claim the same tasks, because the
  unlocked `in (select … limit 20)` let the second update re-claim rows the first had just taken. It now claims through a
  CTE with `for update skip locked`, like the mirror and vault jobs, so each task goes to one client and the batch is
  `TASK_BATCH` (20). Tests: `apps/api/test/ai-local-tasks.test.ts` (the concurrent case failed before the fix: both
  callers got the same 20 tasks).

- **A local vault in development** (ADR-0054 D6, amended): `FAMILY_VAULT_ALLOW_LOCAL_HTTP=on` in the API's environment
  lets an owner connect Montra to a vault running on the same machine at `http://localhost:…` (or `127.0.0.1`, `[::1]`),
  for a live run against a local vault preview. Only loopback, only as an origin; production refuses to start with it,
  and `FAMILY_VAULT_FAKE=on` takes precedence. Tests: `family-vault.test.ts` ("a vault on this machine…") and
  `operations.test.ts` (refused in production).

- **PDF previews in the viewers** (receipts, payslips, bills): every response, the `/api` file proxy included, was sent
  with `X-Frame-Options: DENY` and `frame-ancestors 'none'` (NFR-01, since 2026-11-04), so the browser refused to show a
  PDF in the viewer's `<iframe>`. Responses under `/api` now allow framing by Montra's own pages only (`SAMEORIGIN`,
  `frame-ancestors 'self'`; `securityHeaders` in `apps/web/lib/csp.mjs`); pages stay unframeable. The viewer also
  catches an image that failed before hydration, which left a PDF as a broken image on a fresh page load. Tests:
  `csp.test.ts`, e2e `operations.spec.ts`.

- **PDF statements with `MM/DD` dates and long descriptions** (IMP-03, IMP-05; no migration). A common US layout
  (`DATE | DESCRIPTION | AMOUNT | BALANCE`, dates without a year) came up with no mapping guessed and every date
  unreadable, and long descriptions spilled into Amount (`ID: Citicardap -130.00`).
  - **Doc-worker**: unruled tables are split by the header's positions: an amount column takes only a money value that
    reaches under its header (one per column, the rightmost); every other word goes to the text column it starts in.
    Without a period range, a closing or statement date gives `periodEnd`.
  - **Importers**: new date formats `MM/DD` and `DD/MM`. Their year comes from the statement period, else its end, else
    the upload day (`statementDates`, `withYear`): the year nearest the range, so December dates on a December–January
    statement get the earlier year. Without any of these they read nothing rather than guess. With a year-less format
    detected, the header row, start row and columns are inferred as for any statement. An amount cell holding spilled
    text (`text -130.00`) reads its trailing amount and gives the text back to the description (defensive; old grids).
  - **API, web, phone**: `ImportBatchDto.analysis.dates` carries the range, so the mapping editor's preview reads the
    same years; the editor labels the two formats "(year from the statement)". Statements uploaded before this keep
    their old grid when the mapping is changed: upload them again to have the columns split anew.
  - Tests: doc-worker `test_extract.py` (synthetic fixture `make_yearless_pdf`), `importers/test/yearless-pdf.test.ts`,
    web `imports.test.ts`, API `imports.test.ts` ("reads PDF dates printed without a year…").

- **Discard an import that was never committed** (IMP-09; migration 0069). `POST imports/:id/discard` (owner, admin,
  partner, accountant) takes an import in `uploaded`, `parsing`, `needs_mapping`, `preview` or `failed`; `committing`,
  `committed` and `undone` get 409 `import.not_discardable`. It deletes the preview rows, cancels the batch's queued jobs
  (`app.cancel_import_jobs`, security definer: `montra_app` can't update jobs; a parse already running skips a discarded
  batch), sets the new terminal status `discarded` (kept rather than deleted: intakes and the audit log point at it) and
  writes an `import_batch.discarded` audit row. The uploaded file is kept, and a re-upload of it isn't flagged as a
  duplicate. A statement (ADR-0051) that led to it goes back to Review with reason `discarded`, its import link cleared
  and its reading kept, to pick the account again or put it aside; an automatic one forgets its signal, as after undo.
  `GET imports` leaves discarded imports out (web history and phone list); the web shows "Discard this import" with a
  confirm step on the import page and in history rows. The phone lists imports without actions, so it has no button.
  Tests: API `import-discard.test.ts`, web `imports.test.ts`, mobile `statements.test.ts`.

- **"Make transfer…" by hand** (TXN-04, AI-05; ADR-0028 amendment; migration 0070). Card and loan payments whose line carries
  the payee's ID ("CHASE CREDIT CRD AUTOPAY PPD ID: …", "USBANK LOAN") aren't detected, so Review rows with no transfer
  suggestion and the transaction editor offer "Make transfer…": a picker of the other open accounts in the same currency
  (cards, loans, bank, other), in words ("Transfer to Chase Sapphire"). `POST transactions/:id/make-transfer` already took
  any `accountId`; it now also refuses archived accounts (`transfer.archived`) and categories or system accounts
  (`transfer.not_an_account`), and returns `loan`. A loan with tracked payments takes the line as its scheduled payment
  (`LoansService.paymentForLine`: same amount with escrow, within 5 days, same books and currency, and no line of its own
  on the loan account) through the existing `recordPaymentIn`; otherwise it's a plain transfer and `loan.number` is null,
  which the screens say. Learning: `app.payee_transfer` (payee key → account, count) is bumped on every make-transfer
  and decremented when a category is chosen for the payee; the pipeline's step 3 suggests the most-used account at 0.90
  (`rememberedTransfer`), below the 0.95 that a sure pair keeps, so it's never applied without Review's "Make transfer"
  (which, like accept-all, goes through `transferToInTrx` and so reaches the loan too). The phone has no make-transfer
  action, so it has none of this; remembered suggestions show there as before. Tests: API `manual-transfers.test.ts`,
  categorize `pipeline.test.ts`, web `phase3.test.ts`.
- **Family Document Vault: access tokens** (vault 0.9.0-dev.72; ADR-0054 "Access tokens (vault 0.9.0-dev.72)"; no
  migration). On `@fdv/client` 0.9.0-dev.72, which trades the API key for a fifteen-minute Bearer token and asks again
  when it ends or on a 401 (Basic on every request is deprecated in the vault). The vault gives a key ten tokens a
  minute, so connections now share the package's client per vault and key for fifteen minutes (`appClientFor` in
  `storage/vault/connection.ts`) instead of making one per request or job run. Montra builds nothing for vaults without
  tokens (the owner's answer; the package's own fallback stays). The tests follow view links in dev.68's two steps (a
  GET page that spends nothing, then Open as a same-origin POST). Tests: API `family-vault*.test.ts`, with a new one
  that two runs share one token, every app call is Bearer, and an ended token is replaced without a failure.
- **PDF statements in titled sections** (IMP-03, IMP-05; no migration). Some credit unions print a summary, then
  sections such as "Deposits and Credits" and "Electronic Withdrawals", each with its own header ("Eff. Date, Syst.
  Date, Description, Amount"), every amount unsigned and "$" in a column of its own. The doc worker took "Deposits and
  Credits" for the header (two of its words are header words), so each line became one cell. Now:
  - a header must name a date (`date`, `posted`, `posting`);
  - a short line that is a section title sets which way money went until the next one, and under a withdrawals title
    an unsigned amount in a lone Amount column is read as money out (a title naming both ways changes nothing);
  - the same header seen again (a new section or page) gives its own positions, so a header placed further left on
    page 2 still lines up;
  - a lone "$" is dropped rather than joining the description.

  Tests: doc-worker `test_extract.py` (`make_sectioned_pdf`).
- **Explore spending leaves Uncategorized out** (FLOW-01; no migration). "Uncategorized expense" (the books'
  `uncategorized_expense` system account) was offered as a category to explore and cut, and counted in all spending.
  It is now never a choice, a default pick or a what-if, and `spending` and the shares count categorized spending only
  ("All categorized spending"). `SpendingExploreDto.uncategorized` (total, per month and a drill, or null with none)
  drives a warning with the amount: the web links to those transactions, the phone to Review. The what-if's share of
  income kept still counts it (`whatIf({ uncategorized })`): the money left all the same. Tests: API
  `spending-explore.test.ts`, domain `spending-explore.test.ts`.
- **Bank feeds, PR 1 of 5: contracts** (FEED-01..10 added as requirements 13.7, phase P15; ADR-0055 "SimpleFIN's
  limits are settings" and "Delivery"; migration 0071). Nothing is visible yet: `bankFeeds` is a plan key on wherever
  `ownStorage` is, kept in `FEATURES_NOT_YET_SHOWN`.
  - Migration 0071: `bank_feed` (one live per workspace and provider, the access URL sealed in `secret_enc` until
    disconnected), `bank_feed_account` (new, linked or ignored; one feed per Montra account; start date and cursor),
    `bank_feed_run`; `import_batch.source` (`file`, `feed`) with `bank_feed_account_id`, and `file_id` null for a
    feed batch; `app.bank_feed_due()` and `bank_feed_next()`; the security log kinds and `bank_feed_attention`. RLS:
    owners, admins and partners read the feed and runs, whoever imports reads the accounts, owners write; nothing for
    staff. Archives leave all three out (catalog).
  - SimpleFIN's limits are settings (`SIMPLEFIN_*` in `config.ts`: allowed hosts, 12 requests a day, the 90-day
    window, the 5-day overlap, syncs a day, Sync now spacing, timeout, response cap, the local-http switch refused in
    production), read by the pure rules in `bank-feeds/limits.ts` (start date, window, budget, Sync now).
  - `bank-feeds/provider.ts` (the port and its provider-neutral snapshot) and `bank-feeds/simplefin.ts` (the setup
    token and access URL checked against the allowed hosts, `/accounts` in v2 and v1, exact amounts, UTC dates,
    pending dropped, sanitized messages). DTOs in `@montra/schemas` `bank-feeds.ts`; `ImportBatchDto` gains `source`
    and `bankFeedAccountId`, and `fileId` may be null. The parse job refuses a batch with no file.
  - Tests: API `bank-feeds-simplefin.test.ts` (settings, URLs, the protocol, limits, and a synthetic SimpleFIN in
    `test/fakes/simplefin.ts`), db `bank-feeds.test.ts` (constraints, RLS, staff, the due functions, the plan key).
  - Next: PR 2, connecting and linking.
- **Bank feeds, PR 2 of 5: connecting and linking** (FEED-01, FEED-02, FEED-05, FEED-09 partial; ADR-0055 "As built:
  PR 2"; no migration). Settings → Bank feeds (owners, admins and partners whose plan has `bankFeeds`; owners change
  it): paste SimpleFIN Bridge's setup token, then link, create, ignore or unlink each account it reports. Nothing is
  imported yet, and the card says so.
  - API: `bank-feeds/transport.ts` (https to SIMPLEFIN_ALLOWED_HOSTS, the storage guard's lookup, no redirects, the
    timeout and size cap), `simplefin.adapter.ts` (claim once; `/accounts` with HTTP Basic, never credentials in a
    URL; 403 revoked, 402 payment required), `bank-feeds.service.ts` and `bank-feeds.controller.ts`
    (`GET/POST /bank-feeds`, `PATCH /bank-feeds/:id`, `POST /bank-feeds/:id/refresh`, `PATCH
    /bank-feeds/:id/accounts/:accountId`, `POST /bank-feeds/:id/disconnect`). Connecting and disconnecting need an
    owner with a recent sign-in; connect skips the idempotency store. Every request counts against
    SIMPLEFIN_REQUESTS_PER_DAY per UTC day (429 `bank_feed.daily_limit` before asking).
  - Suggestions use ADR-0051's tiers with match memory (`feed:simplefin:<hash>`); Create account works out the
    opening balance the day before the start date from one request. A reconnect within 30 days takes over the old
    feed's links.
  - Web: `components/settings/bank-feeds.tsx`, `lib/bank-feeds.ts`; api-client `bankFeed`, `connectBankFeed`,
    `updateBankFeed`, `refreshBankFeed`, `updateBankFeedAccount`, `disconnectBankFeed`.
  - Tests: API `bank-feeds.test.ts` (against the synthetic SimpleFIN: roles, recent sign-in, refused tokens, the
    claim, the sealed access nowhere else, suggestions, links, Create account's opening balance, refresh, problems,
    the daily limit, pausing, disconnecting and relinking, the transport), web `bank-feeds.test.ts`.
  - Next: PR 3a, syncing into Review.
- **Bank feeds, PR 3a of 5: syncing into Review** (FEED-03, FEED-04, FEED-06 partial, FEED-05 updated; ADR-0055 "As
  built: PR 3a"; migration 0072).
  - `bank-feeds/bank-feeds.sync.ts`: the `bankfeed.sync` job (registered in `worker-main.ts`), one sync per due feed
    as its owner: one request for every linked account (`syncWindow`), counted against the day's limit (a feed at it
    waits for the next UTC day, as for a quota warning), each account's new rows staged as one import batch
    (`ImportJobs.stageFeedRows`: dedupe, matching, transfers, loans and categories as for a file) waiting in Review,
    the cursor moved, the feed rescheduled at its minute of the workspace's day (`nextSyncAt`, `zonedInstant`). A
    failed sync backs off and turns `failing` after five; 403 and 402 stop it.
  - Migration 0072: `import_row.external_id` (the provider's id; a sync skips ids already brought in, waiting,
    committed or discarded), `app.bank_feed_sync_now` (Sync now for owners, admins and partners, spaced by
    SIMPLEFIN_SYNC_NOW_MINUTES) and `app.bank_feed_rewind` (Undo of a feed batch moves the cursor back).
  - Committed feed rows are `source = 'feed'` transactions. A discarded feed batch keeps its rows, so its ids stay
    out. Linking an account makes the feed due at once; connecting schedules the first daily sync.
  - API: `POST /bank-feeds/:id/sync`; `GET /imports?waiting=feed`. Web: Review's "Bank feed" card and its count in
    the Review badge; Sync now, last and next sync on the Settings card; a feed import's discarded page.
  - Tests: API `bank-feeds-sync.test.ts` (scheduling and daylight saving, one request and the window, start dates,
    pending, staging, overlap, commit as feed transactions, Undo and Discard, Sync now roles and spacing, the daily
    limit, backoff, failing, revoked), web `bank-feeds.test.ts`, `phase3.test.ts`.
  - Next: PR 3b, hands-off syncing (auto-commit if clean, the balance check, problems and the notification).
- **Bank feeds, PR 3b of 5: hands-off syncing** (FEED-04, FEED-06, FEED-07, FEED-08 partial; ADR-0055 "As built: PR
  3b"; no migration).
  - A staged feed batch with no probable duplicates and no unreadable rows commits itself (`warnings`
    `auto_commit`, Undo 30 days); anything else waits in Review.
  - The balance check (`ImportJobs.feedBalanceCheck`, after a feed batch commits): the account's ledger balance at
    the end of the feed's balance date against the institution's; `ok` or `mismatch` with the gap on the batch, shown
    as a statement's. A mismatch on an automatic import holds the account's next clean batch in Review until someone
    imports one by hand.
  - `bank_feed_attention` notifications (owners, once per problem; no amounts): revoked, payment required, failing, or
    a linked account's bank to sign in to again (`attentionWords`); cleared when fixed.
  - `GET /bank-feeds/links` and the Statements screen's note on an intake whose account has a feed.
  - A feed import no longer offers "Change mapping".
  - Tests: API `bank-feeds-sync.test.ts` (auto-commit, the balance check ok and mismatch, the hold and its release,
    the attention notifications, the links).
- **Bank feeds, PR 4 of 5: the phone and the e2e spec** (FEED-10 partial; ADR-0055 "As built: PR 4").
  - Phone: `src/features/bank-feeds.ts` (pure: the Your data card, Sync now, the account line, what waits in Review),
    `src/ui/BankFeed.tsx` (Your data card with Sync now; Review's Bank feed section), `use-feed-imports.ts` (the
    Review badge's fourth count), `/import?batch=` opening a waiting import in the phone's preview, and "Bank feed,
    synced through …" on an account's screen. Connecting and linking stay on the web.
  - e2e: `e2e/bank-feeds.spec.ts` against the synthetic SimpleFIN, which `playwright.config.ts` now starts
    (`apps/api/test/fakes/simplefin-server.ts`, port 4655, `GET /__token`); the API and the worker run with
    SIMPLEFIN_ALLOW_LOCAL_HTTP=on there.
  - Left for PR 5 (needs the owner): the live run against their own SimpleFIN Bridge, then `bankFeeds` leaves
    `FEATURES_NOT_YET_SHOWN` and the FEED items turn done.
- **Bank feeds, PR 5 of 5: live run, fixes, shown in plans** (FEED-01..10 done; ADR-0055 "Live run (2026-11-20) and
  PR 5"). The owner connected SimpleFIN's demo locally and linked two accounts: one request per sync, payee and memo
  present, UTC dates. Fixed: a sync now takes rows up to the later of the workspace's day and UTC's (`lastSyncDay`),
  so rows posted that UTC day aren't left for the next sync (both first balance checks had missed by exactly those);
  the first sync is labelled `first`. `bankFeeds` leaves `FEATURES_NOT_YET_SHOWN`. Tests: API
  `bank-feeds-sync.test.ts` (`lastSyncDay`), domain `operations.test.ts`, web `billing.test.ts`.
- **Receipt line quantity and unit price; the phone's receipt totals** (owner, 2026-11-18; backlog 13 and 14; RCP-01,
  no migration).
  - `lineQuantity` (`@montra/domain`): what the receipt printed is kept as printed. Neither printed: quantity 1 at the
    line's total. Only the quantity: the unit price when it divides the total exactly. Only the unit price: the
    quantity when the total is a whole multiple of it. Otherwise the missing one stays empty (a weighed 0.452 lb at
    1.35 gets no rounded guess). The API applies it on capture and on every line it returns.
  - Editing: a PATCH that changes a line's total, quantity or unit price without sending the other works that one out
    again rather than keeping a stale value. The web review has Qty and Unit price columns; a new quantity or unit
    price sets the total (half up), and a new total sets the unit price when it divides exactly.
  - Phone: each line says "2 × $0.81"; a totals card under the lines shows subtotal, discount, tax (or "tax
    included"), fees, tip and total, so the lines add up to the receipt.
  - Tests: domain `receipt.test.ts`, API `receipts.test.ts`, web `lib/receipts.test.ts`, mobile `receipts.test.ts`.
- **Local-mode AI answers are used** (backlog 2; 06 §2; migration 0073). On the hosted service with local AI, the
  server parks AI work for a browser on the user's network. Before this, the answers it posted were stored and never
  used, and the parked input wasn't a request the browser could send.
  - Parking: the parked input is now the ready `chat/completions` body (`chatCompletionBody`, shared with the
    OpenAI-compatible adapter), with the request's hash, each row item's cache key (`item_keys`), the subject and who
    it was for (`created_by`). The same request is parked once while it waits or its answer lasts.
  - Using an answer: when the same work runs again, the gateway finds the answer by the request's hash, or for row
    tasks (categorize) by each item's cache key, whatever batches the run makes, and puts it through the task's schema
    and checks like a provider's; answered items go to the cache.
  - Applying it: a posted answer queues `ai.local_result.<subject>` (after 10 s, one per subject) as the person the
    work was for. An import in preview gets suggestions for the rows nothing placed, auto-applied as parse would; a
    committed import's transactions still waiting in Review get them as suggestions; a receipt waiting for its reading
    (`pending_local`, no lines typed) is read again from its text. Other work uses its answer the next time it runs.
  - Not done: an answer that fails the task's checks isn't asked for again until it expires (7 days); the phone has no
    local runner.
  - Tests: gateway `gateway.test.ts` (parked once, used item by item across different batching, a single-call task
    through its checks), API `ai-local-results.test.ts` (preview, committed import, receipt).
- **Your own key with OpenAI, Google Gemini and Azure OpenAI** (backlog 3; UP-13; migration 0074 widens
  `ai_credential.provider`). Settings → AI → Your own API key lists them beside Anthropic and "Other OpenAI-compatible
  server".
  - All three go through `OpenAiCompatibleAdapter`, which now speaks per provider:
    - OpenAI: api.openai.com/v1, a bearer key, and `max_completion_tokens`, which its reasoning models need.
    - Gemini: Google's OpenAI-compatible endpoint, a bearer key.
    - Azure OpenAI: the resource URL + `/openai/v1`, the key in `api-key`, and deployment names as the models.

    Cached prompt tokens now count at the cached rate.
  - Models: defaults as of 2026-11-20. OpenAI uses gpt-6-luna, gpt-6.1-terra and gpt-6.2-sol; Gemini uses
    gemini-3.5-flash-lite, gemini-3.8-flash and gemini-4-hydrogen. A workspace can name others. Azure needs at least
    one deployment, which is used for any group left blank, and its resource URL. Without them, saving is refused, and
    AI turns off with the `azure_incomplete` problem.
  - Prices: OpenAI and Gemini rates come from their pricing pages on 2026-11-20. Announced changes are dated steps:
    gemini-4-argon and gemini-4-carbon double on 1 December, gemini-3.8-flash on 1 January. `AI_MODEL_PRICES` (JSON)
    sets any model's rate without a release, and a bad value stops the server at start. An unpriced model, such as an
    Azure deployment name, costs nothing, so a budget can't hold it back until it is priced there.
  - Not tried against the real services: no keys here. The adapters are tested against stubs of each API.
  - Tests: gateway `adapters.test.ts` (each provider's URL, auth, token field and cached usage), `units.test.ts`
    (defaults, dated prices, snapshots, overrides), API `categorization.test.ts` (keys and Azure's URL and
    deployment), web `phase3.test.ts`.
- **AI confidence refit, and an AI threshold of its own** (AIA-09; owner, 2026-11-21; no migration).
  - Measured: Claude Haiku categorizing the benchmark is right 97.3% of the time on both splits but under-states its
    confidence. ECE was 0.140 on the test split as reported. Total cost $0.39 across four runs.
  - The fit kept too little: `fitIsotonic` drew lines between block midpoints, so a wide block of right answers
    became a slope. Now each block keeps its range of raw scores as a flat level, adjacent blocks with the closest
    levels merge down to 6, and levels are smoothed so none is 0% or 100%. The curve fitted on the train split has
    ECE 0.011 on the test split.
  - Honest scores are high, so the owner chose a separate **AI threshold**, default 95%, beside the review
    threshold, which stays at 80% for rules, transfers, past transactions, file categories and merchants. At 95%,
    89.6% of test rows apply at 99.2% precision; before, at 80%, 78.8% applied at 100%. It applies to categorized
    rows and to receipt lines. It's a second slider in Settings → AI (`aiThreshold`; a workspace's saved value
    wins).
  - The fake provider's keyword matches now score 0.97 rather than 0.9, as a calibrated provider's sure answers do,
    so tests and e2e behave as before. e2e that send everything to Review set both thresholds to 99%.
  - Tests: gateway `units.test.ts` (the curve, the fit's flat blocks and smoothing), API categorization, imports,
    receipts and bank-feed suites.
- **Undoing an import takes back what it taught** (backlog 5; no migration). A category chosen in an import's preview
  (or later in Review) counts in the payee's history and may record a correction, which feeds rule suggestions.
  Undoing the import voided its transactions but kept both, so the same payee was still suggested the undone choice.
  - Now each transaction the undo voids gives back what it counted (`Categorizer.unlearn`): its place in the payee's
    history, read from `categorization.learned`, and its corrections. The undo reports how many (`unlearned`).
  - Left as they are: a rule already made or a rule suggestion already shown; transfers made by hand for the payee
    (their count can't be restored exactly); transactions the undo keeps (reconciled, carrying a payslip, invoice or
    bill, or a transfer with another statement's line).
  - Not changed: deleting a single transaction by hand still keeps what it taught.
  - Tests: API `categorization.test.ts` (choose in preview, commit, undo: history and corrections gone, and the next
    import of the payee isn't suggested the undone category).
- **Import commits no longer slow down with their size** (backlog 9; migration 0075).
  - The posting guard (`app.guard_posting`) looked up its journal entry by `coalesce(new.…, old.…)`. PL/pgSQL plans
    that once per session. When the journal had been analyzed while small (a new install, a test database), the
    planner chose a sequential scan and kept it while the import added entries. Each posting then scanned every
    earlier entry of the batch, with the row-level-security check on each.
  - Measured on such a database for 1,000 rows: 1.07 million `entity_access` calls and 31 s, now 47,000 calls and
    15 s. 2,000 rows went from 97 s to 34 s, and 5,000 rows take 82 s (16 ms a row), on the owner's busy dev PC. The
    guard now looks the entry up by its key in plain variables; its checks are unchanged.
  - Not reproduced on a fresh or well-used database, where the planner picks the index anyway. So there is no test
    for the slowdown itself; a ratio test didn't fail against the old guard and was dropped.
  - Left: about 12 ms of each row is Node-side work (spec, ledger build, four statements). Bulk posting would cut
    that, but this PC is too loaded to measure it reliably.
  - Tests: DB `ledger.test.ts` (locks and reconciled lines), API `reconciliation.test.ts`, `imports.test.ts`.
- **Payments to different accounts are different payees** (backlog 11; migration 0076).
  - Before: the payee normalizer drops masked numbers, which is right for merchants. But it left "ONLINE PAYMENT TO
    CARD XXXX4321" and "… XXXX8765" with the one key `TO`, sharing a payee, its history, corrections and transfer
    memory.
  - New lines: `payeeKeyFor` (@montra/importers) adds the account's last four digits to the payee key: "TO ••4321",
    "AUTOPAY TO AMEX ••1002". It applies to a line with payment or transfer wording, or one whose key is only
    "TO"/"FROM", that names a masked number (XXXX, ****, ..., ••) or "ENDING IN dddd". Imports and typed
    transactions use it; each account gets its own payee row, named as before ("Payment to Card ••4321").
  - Unchanged: a card purchase that prints the card's own masked number has no payment wording and keeps its merchant
    key. Duplicate detection still uses `normalizeDescription`, so lines already imported are still recognised.
  - Migration 0076 re-keys existing transactions the same way, in SQL with the same patterns, and moves along with
    them: payee history (what each counted, `categorization.learned`), corrections, transfer memory (one count per
    transfer to the account it went to), and the payee row. Keys already ending in "••dddd" are left, so it can run
    twice.
  - Left as they are: rules (they match "payee contains", which still matches), rule suggestions and insights already
    made, and keys on names (business parties, payslips, expected income, tenants).
  - Tests: importers `units.test.ts` (keys and names; merchants and an ID-only autopay unchanged), API
    `payee-keys.test.ts` (an import, a typed payment, the migration and its re-run), `imports.test.ts`.
- **S3 storage is tested against a real MinIO** (backlog 4; no migration). The in-process fakes check what Montra
  sends; `apps/api/test/s3-minio.test.ts` checks that a real S3 server takes it, in a bucket of its own that it removes
  afterwards. It covers:
  - Montra's own file store (`S3Storage`, STORAGE_MODE=s3): put, get, a 256 KB file streamed from disk and back (as
    archives are), delete twice, and an unsafe key refused;
  - your own storage (`S3Destination`): put, a get within and over the size limit, delete, and a wrong key or missing
    bucket reported as `refused` or `not_found`;
  - the API with STORAGE_MODE=s3: an upload lands in the bucket and reads back.

  MinIO itself was archived in April 2026 and its images and binaries are gone, so CI and the dev compose file use
  `pgsty/minio`, a community-maintained build, pinned to RELEASE.2026-08-04T00-00-00Z (the owner's choice).
  CI's verify job starts it (a step, since a service container can't be given its `server` command) and sets
  S3_TEST_REQUIRED, so there a missing server fails the run rather than skipping. Locally the tests run when
  S3_TEST_ENDPOINT is set (the compose MinIO, port 19000 here) and skip otherwise.

- **`AI_MODEL_PRICES` on the hosted service** (no migration). The setting was only in the self-host compose file; the
  Terraform `ai_model_prices` variable (envs → stack → compute) now sets it on the API and worker, empty by default,
  checked to be JSON at plan time. The example tfvars show its shape. Not applied anywhere: no `terraform apply`.
- **The phone checks it's new enough for its server, and sends the person to update** (OPS-04; owner, 2026-11-21; no
  migration).
  - Before: a too-old app was refused with 426 only by the staff-set minimums, which default to 0.0.0, so nothing
    was refused, and a self-hosted server has no staff. The update screen had no way to get a newer app.
  - Each server version now has its own minimum: `MIN_PHONE_APP_VERSION` in `apps/api/src/ops/metrics.ts`, now
    0.5.0, the current app. Raise it in the change that drops something older apps rely on. Staff can ask for newer
    per platform, never older.
  - `GET /v1/app/requirements?platform=` is public and never refused for the app's version. It gives the minimum and
    `MOBILE_UPDATE_URL`, a setting that defaults to the project's GitHub releases page (the owner's choice for now,
    until the stores).
  - The phone asks on start (before sign-in), on coming back to the app, and after a 426. The update screen says both
    versions and has "Get the update", which opens the link (https only, else the GitHub releases).
  - Tests: API `operations.test.ts` (the server's minimum under staff's, the public endpoint, a too-old app still
    asking), mobile `app-update.test.ts` and `clients.test.ts`.
- **The phone answers local AI work too** (06 §2; the follow-up to backlog 2; no migration). With local AI on the
  hosted service, only an open web page answered the work the server parks for the person's own model.
  - Now the phone does too, while the app is open and in front (`src/ai/LocalAiRunner.tsx`, `src/features/local-ai.ts`):
    every 15 s and on coming back to the app, it claims the parked tasks, sends each one's `chat/completions` body to
    the model, and posts the answer, which the server applies as it does the web's.
  - Silent: an unreachable model ends the round and is tried again; a 403 stops it.
  - Android reaches a plain-http model only in builds that allow cleartext traffic (the LAN build, whose API is http
    too). A production build needs the model over https. The cleartext policy is unchanged.
  - Tests: mobile `local-ai.test.ts`.
- **APK releases publish themselves, and the admin console shows the app minimum in effect** (OPS-04; no migration).
  - The "Android APK" workflow publishes the APK as the repository's latest GitHub release when the branch's
    `.github/android-apk.env` has `MONTRA_PUBLISH_RELEASE=true`; `android-apk/lan` has it. The release is
    `android-<branch>-<app version>-dev.N`, after the develop tag it was built from (plus the run number when that
    release exists already), with the APK's SHA-256 and GitHub's list of merged PRs. The phone's "Get the update"
    points there, so it no longer depends on someone publishing by hand.
  - The workflow's token can now write contents (for the release); checkout no longer leaves it in `.git/config`.
  - `GET /v1/admin/app-versions` adds `serverMinimum`. Under the per-platform fields the admin console says the
    server's own minimum and the minimum in effect for each platform, since a lower staff setting has no effect.
  - Tests: API `operations.test.ts`. The workflow step was dry-run locally with a stub `gh`.
- **Email templates** (Phase 11 hardening, AUTH-05; no migration). See [`runbooks/email.md`](runbooks/email.md).
  - Before: the API's emails were built inline at each sender, almost all plain text (only the invite had HTML),
    with times as raw ISO strings and no common footer. Kratos's had bare HTML of their own.
  - Now there's one layout (`apps/api/src/mail/layout.ts`): the brand at the top, a card, a button for the main
    action, a code box, a footer saying why the person got the email, and a text part that says the same thing with
    every link written out. There are no images, tracking, remote fonts or stylesheets, and every value is escaped.
  - Every email the API sends is in `apps/api/src/mail/templates.ts` (23 of them), with subjects unchanged. The senders
    call it, so `SmtpMail` wraps any message still sent without HTML in the layout.
  - Security alerts give times in the person's own time zone (`app_user.time_zone`), else UTC, always naming the
    zone. The sign-in pause email stays UTC, since the auth gateway knows only the email address.
  - An invoice carries the business's name at the top rather than Montra's, and its note is set apart as a quote.
  - Kratos's recovery and confirmation emails are generated into `infra/kratos/templates` from
    `apps/api/src/mail/kratos-templates.ts` (`pnpm --filter @montra/api kratos:templates`); a test fails when the files
    drift.
  - Checked against Kratos v26.2.0 locally with `scripts/kratos-smoke.mjs` and Mailpit. Every email check passed (arrives,
    30 minutes stated, code in both bodies, nothing left unfilled, unknown address gets nothing). The recovery hook
    check failed only because the local API wasn't running with Kratos's webhook secret.
  - AUTH-05 is done: the owner accepted the emailed code on 2026-11-21. An emailed link is AUTH-19, for later.
  - Tests: API `mail-templates.test.ts`, plus the existing tests that read emails.
- **The audit trails on screen: Settings → Your data → Audit log, and the console's Staff log** (NFR-03, OPS-01;
  migration 0077). Both logs were recorded but had no screen.
  - **Audit log** (`app.audit_log`), owners and admins only (the tab is hidden from other roles, and RLS and the API
    agree). `GET /v1/workspaces/:id/audit-log` now takes a cursor (`id`) and filters: `actorUserId` or `actorType`,
    `subjectType`, `action`, `subjectId`, `from`/`to` (the workspace's calendar days) and `bookkeeping=hide`. Each entry
    carries the person's name (null for someone who has left). The default is unchanged (everything), so the existing
    callers and tests read as before.
  - The screen hides the ledger's own trigger rows by default (`AUDIT_BOOKKEEPING_SUBJECTS`: journal lines, journal
    entries, ledger accounts, transaction tags; most of the dev DB's 60k rows are these), with a "Show bookkeeping
    detail" switch. Explicit actions on those records (`journal_entry.unlock`) always show. Rows one save wrote (same
    `at`, which is the transaction's start, and same person) are shown as one group. Actions read as words
    ("Transaction changed", "Reconciliation undone"), with the record's name from the row, Details (before → after; a
    JSON column such as `spec` as the keys that changed) and History (that record's whole history, bookkeeping
    included). Helpers in `apps/web/lib/audit-log.ts`; a new action or table reads as plain words until it gets a label.
  - **Staff log** (`app.admin_log`), admins and owners, not support: `GET /v1/admin/log` with a cursor (time at
    Postgres precision plus id) and filters (staff, action, subject, UTC days). `montra_admin` can't read `app_user`, so
    `app.admin_log_staff(p_staff)` (0077, security definer, admin role checked again) returns the people in the log and
    only them; the console shows their email and offers them in the Who filter.
  - Not done: the phone has no audit screen; the log can't be exported; `bank_account` rows have no name of their own
    (the name is on the ledger account), so an account shows as "Account added" without it.
  - Tests: API `audit-log.test.ts` and `operations.test.ts` (staff log), DB `rls.test.ts` (the new function in the
    console role's list), web `audit-log.test.ts` and `i18n-keys.test.ts`. Tried on the dev stack: both screens, the
    filters, History and paging.
- **One split per category on a receipt** (RCP-03, RCP-07; owner, 2026-11-21; no migration).
  - Before: a receipt with four grocery items showed two Groceries splits ($7.26 and $5.64). Lines are grouped by
    category, entity and member. A line that came in uncategorized has no entity, and picking its category kept it
    that way, since no client sends one. So it didn't join the lines already in the receipt's entity.
  - Now picking a category without naming an entity puts the line in that category's entity (a category is a ledger
    account, which has one). In grouping, a line with no entity counts as the receipt's, which also fixes receipts
    saved before this on their next read. Applying to a transaction uses the same grouping.
  - The phone's Splits card follows each category pick before Save (`previewSplits`, the same `groupReceipt`
    arithmetic as the API), then shows the server's splits once saved.
  - The web review does the same once the form is edited (`previewSplits` in `apps/web/lib/receipts.ts`): category,
    member, amount, tax, discount, fee and tip edits, and added or removed lines, show in the Splits card at once,
    marked "Not saved yet". While a field doesn't parse, it keeps showing the saved splits.
  - Tests: API `receipts.test.ts` rebuilds the owner's $12.90 receipt (it fails without the fix, with the two splits);
    mobile `receipts.test.ts`; web `receipts.test.ts`. Checked on the local stack: the three picks went $7.26 + $5.64,
    then $10.08 + $2.82, then one Groceries split of $12.90, and Save kept it.
- **Back links return to the list as it was left** (owner, 2026-11-21; web only; no migration).
  - Before: "← Transactions" after opening a transaction from Needs review went to All. "← Receipts" from the Matched
    tab went to the Inbox. Lists keep their filters and tabs in the URL, and every back link pointed at the bare list.
  - Now `RememberUrl` (root layout) keeps each page's last full URL per browser tab (`sessionStorage`,
    `lib/back-links.ts`). `BackLink` (`components/ui/back-link.tsx`) uses it, in `PageHeader` and on every "← list"
    link: transactions, receipts and their items, accounts, invoices, assets, payroll, people, rentals, journal,
    payslips, tax forms, help and the support page. A back link that names its own query (the tax year) keeps it. The
    previous-month arrows aren't back links and are unchanged.
  - Going to a list after an action (deleting a receipt, invoice or asset, finishing a payslip) uses it too
    (`listHref`).
  - The phone already kept its filters: its detail screens go back on the navigation stack.
  - Tests: web `back-links.test.ts`. Checked on the local stack: Needs review and Matched both come back after "←".
- **Import commits write in chunks** (backlog item 9; no migration).
  - Before: each new transaction took about five round trips (its row, its entry, its postings, the account's default
    member). The posting read models' statement trigger also ran once per transaction. 1,000 rows took 16.2 s.
  - Now `TransactionsService.prepareCreate` works out each transaction without writing it. `insertPrepared` writes them
    500 at a time: one insert for the rows, then `LedgerService.postMany` with one for the entries and one for the
    postings. `createInTrx` is the same two steps for one transaction, so every other caller is unchanged.
  - The commit keeps statement order. What's waiting is written before a matched row is confirmed. A category picked
    during import is learned once its transaction exists.
  - A foreign-currency account (`TransactionPoster.postsInOrder`) still posts one at a time, as each line's carrying
    value (ADR-0010) reads the postings before it.
  - Measured with `PERF_ROWS=1000 pnpm --filter @montra/api test:perf`: commit 5.8 s, from 16.2 s. The 30 ms per row
    budget is unchanged.
  - Tests: API `imports.test.ts` imports 520 rows, so the commit crosses a chunk, with a category picked in the second
    chunk. It also imports three lines into a EUR account and checks the USD amounts match the same lines entered one
    by one. That test fails, 7 cents out, if the account is batched.
- **The phone edits its settings, as the web does** (OPS-13; no migration, no new endpoint).
  - Before: the phone switched notification channels, backed up, showed security activity and deleted the account. Your
    profile, family members, books, AI mode and quiet hours were read-only there.
  - Now Settings opens a screen for each, with the web's API calls and the web's rules
    (`apps/mobile/src/features/settings-edit.ts`):
    - **Profile** (`PATCH /v1/me`): your name and your own time zone, with a "use this phone's time zone" button. The
      language, date format and first day of the week stay on the web, since the phone formats by its own settings.
    - **Family** (`/family-members`): add, rename, change the relationship, archive and restore. Owners, admins and
      partners, as RLS allows (0041). Invites and each account's default member stay on the web.
    - **Books** (`/entities`): add business or rental books, rename, archive and restore, and the calendar colour.
      Owners and admins (`requireWorkspaceAdmin`). The personal books take only a colour (the API refuses the rest, so
      the phone doesn't offer it). The plan's limits come back in the API's own words (402 `plan.required`, 422
      `plan.limit`). Closing and reopening a period (DE-09) stays on the web.
    - **AI mode** (`PATCH /ai/settings`): owners and admins, each mode with its privacy disclosure. BYOK, local and Azure
      are offered once their key, URL or deployment is saved on the web, by the web's own pre-save checks. Local mode
      sends the OpenAI-compatible provider, as the web does.
    - **Quiet hours and the daily cap** (`PATCH /v1/me/notification-prefs`), typed as `22:00`. Both ends or neither,
      and a cap from 0 to 50. Only those three values are sent, so the per-switch saves stay independent.
  - Everyone else sees the same lists read-only. Server errors read as on the web: no connection, known codes in plain
    words, otherwise the server's message.
  - The workspace's base currency and time zone stay read-only. They're set when the workspace is made, and no API
    changes them, on the web either.
  - Tests: mobile `settings-edit.test.ts` (rules, request building, the API paths, and every key the screens use),
    `routes-guarded.test.ts` and `clients.test.ts`; web `i18n-keys.test.ts`. Not tried on a device.
- **Reference data without a release: tax lines, bank import layouts, and staff edits that survive deploys** (OPS-05;
  migration 0078).
  - Before: the console edited merchants and mileage rates only, and the reference loader, which runs after every
    `pnpm db:migrate` and so on every deploy, put the shipped content back on any seeded row staff had changed. Tax
    lines and `ref.import_profile` could only change by migration, and the importer never read `ref.import_profile`.
  - **Edits survive deploys:** `ref.merchant`, `ref.mileage_rate`, `ref.tax_line` and `ref.import_profile` have
    `staff_edited_at`. Every console save sets it, and `loadReferenceData` leaves those rows alone. Clearing it hands a
    row back to the shipped data on the next load. A shipped merchant whose match text a staff-saved merchant already
    uses is skipped instead of failing the whole load on the unique key.
  - **Tax lines** (Reference tab): list by country and order; add or change by (country, code): line, label, order and
    deductible share (entered as a percentage, stored in basis points). `PUT /v1/admin/reference/tax-lines`, staff log
    `reference.tax_line.save`. The form is one of Schedules B, C and E, the forms the readers know. Two rules keep the
    readers (categories' `setTaxLine`, Schedule C and E, the AI tax-line mapper) sound: an existing line keeps its form
    (`409 tax_line.form_fixed`, since moving it would move every category mapped to it to another schedule), and
    **there's no delete**, since `ledger_account.tax_line_code` isn't a foreign key and a category may hold the code.
    A line no longer wanted can be relabelled; removing one still needs a migration that remaps categories first.
  - **Bank import layouts** (`ref.import_profile`): list, save by id, delete. Name, institution, kind (`bank` or
    `app_template`), and the column mapping, checked against the importer's `ColumnMappingDto`. The file shape is
    either the fingerprint or the file's first lines (header and a row, which can be made up), from which the API
    works out the fingerprint as the importer does (`sheetFingerprint`); the sample isn't stored. One layout per
    fingerprint (`409 import_profile.fingerprint_taken`). Staff log `reference.import_profile.save` and `.delete`.
  - **The importer uses them:** after the workspace's own profiles (this account's first), the parse step looks up the
    staff layout for the file's fingerprint and passes it to `analyze` as a fallback (`reference: true`, never
    `sameAccount`). It's reported as `mappingSource: 'reference'` with the layout's id as `analysis.templateId`, and
    `profile_id` stays null (that names a workspace profile). Committing saves the workspace's own profile as before,
    which wins from then on. QIF and OFX ignore staff layouts: every such file has the same shape.
  - **Currencies stay with the code (decision):** money math uses `CURRENCY_CODES` and `minorUnits` from
    `@montra/domain`, not `ref.currency`, which the loader fills from that list. Editing the table would change nothing
    that counts and would mislead, so it isn't editable; an ISO 4217 change ships with a release. The console says so.
  - No grant changes: `montra_admin` already had select, insert, update and delete on the four tables (0021).
  - Tests: API `operations.test.ts` (staff-only, validation, the staff log, the form rule, no delete, workspace readers
    seeing a new line), API `imports.test.ts` (a statement of a staff-saved shape is read without asking, then the
    workspace's own profile wins), db `reference.test.ts` (staff edits survive `loadReferenceData`, untouched rows are
    restored, the match-text clash), importers `units.test.ts`, web `reference-data.test.ts`.
- **A CAPTCHA after repeated sign-in failures** (AUTH-08, [ADR-0056](design/adr/0056-turnstile-captcha.md); owner
  chose Cloudflare Turnstile, off by default, on 2026-11-21; no migration).
  - Before: the auth gateway (ADR-0042) delayed wrong passwords after 5 and paused after 10, but never asked for a
    CAPTCHA. AUTH-08 was partial for that alone.
  - Now, with `TURNSTILE_SECRET_KEY` on the gateway, a browser password sign-in whose email or address has reached
    `CAPTCHA_AFTER_FAILURES` failures (default 5, ADR-0042's counters), or a browser sign-up from an address past
    `CAPTCHA_AFTER_SIGNUPS` (default 5 an hour), must carry `cf-turnstile-response`. The gateway checks it with
    siteverify (5 s timeout) and strips it before Kratos. Missing, refused or unreachable: nothing is forwarded or
    counted, and the browser goes back with `notice=captcha_required`. The failure that reaches the threshold already
    comes back with that notice. The pause after 10 still comes first.
  - Web: with the notice and a build-time `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, sign-in and sign-up render the widget in
    the form before the submit button, loading Turnstile's script only then. Without a site key the page says the check
    can't be shown here. The CSP allows `https://challenges.cloudflare.com` (script, frame) only with a site key.
  - Unset (the default, and for LAN and self-hosted installs), nothing changes. **The phone's JSON flows are never
    asked**, so a script using Kratos's API flows meets only the delay and pause; documented in the ADR.
  - **Not wired into deployment:** Terraform, the self-host Compose file and `deploy.yml` don't pass the settings
    yet; `apps/web/Dockerfile` takes the site key as a build argument. How to get keys and turn it on, and Cloudflare's
    always-pass and always-fail test keys for development: [first-time setup §9](runbooks/first-time-setup.md).
  - Not tried against real Turnstile: tests replace siteverify, and no browser run with the widget was made.
  - Tests: API `auth-gateway.test.ts` (off by default, below and at the threshold, missing, refused and good tokens,
    per address, sign-ups, JSON never asked, siteverify unreachable or timing out, the secret in no log, response or
    Kratos body, settings), web `csp.test.ts`, `gateway-notice.test.ts`, `kratos-ui.test.tsx` and `i18n-keys.test.ts`.
- **End-to-end tests in Firefox and WebKit** (PLT-01; CI only; no migration).
  - Before: Playwright ran only Chromium, so Safari and Firefox were never exercised.
  - Now `playwright.config.ts` has `firefox` and `webkit` projects for seven main-flow specs: happy path, phase 1a,
    quick add, import, review, receipts and accessibility. `E2E_PROJECTS` picks the projects (default `chromium`, which
    still runs every spec). CI runs each extra browser in its own job (`e2e-browsers`), after `verify`.
  - WebKit keeps no Secure cookie on http://localhost, so the dev sign-in cookie is Secure in a production build only off
    this machine (`devCookieSecure` in `lib/session.ts`). Before that, every WebKit test ran signed out.
  - Chromium stands in for Chrome and Edge, WebKit for Safari. Neither is the branded browser, and nothing runs on a
    phone.
  - Locally: `pnpm --filter @montra/web exec playwright install firefox`, then `E2E_PROJECTS=firefox pnpm --filter
    @montra/web test:e2e`.
- **Screen tests on the phone** (backlog item 6; test tooling only, no app change).
  - Before: Vitest tested the phone's pure modules (`apps/mobile/test`). Nothing rendered a screen; screens were
    checked only by the `expo export` builds, and the Maestro flows have never run.
  - Now Jest with the `jest-expo` preset (`~58.0.15`, Expo SDK 58's) and React Native Testing Library (14.1, on
    `test-renderer` 1.3, as `jest-expo` uses) render screens. They live in `apps/mobile/screens-test/*.test.tsx`, and
    `jest.config.js` looks nowhere else. Vitest still takes only `test/**/*.test.ts`. The mobile `test` script runs
    Vitest, then Jest, so `pnpm verify` (turbo `test`) and both CI workflows run them. Run them alone with
    `pnpm --filter @montra/mobile test:screens`.
  - The real `SessionProvider`, screens and UI run. Mocked (`screens-test/setup.tsx`, `harness/`):
    - the API client at its module boundary: `createApi` returns `jest.fn`s, and one a test hasn't answered never
      settles;
    - the sync layer: @montra/sync's `MemoryStore` stands in for SQLite;
    - expo-router's hooks, SecureStore (in memory), the build-time config (dev sign-in), safe-area insets and Lucide's
      icons (decorative; loading its 1,600 modules took longer than the tests);
    - the transaction row's swipe actions and the receipt zoom viewer. Gesture Handler and Reanimated's worklets need
      the phone's UI thread.
  - jest-expo's own mocks cover the other Expo native modules.
  - Tests (13):
    - `settings.test.tsx`: an owner sees the receipt reminders and a viewer doesn't. An owner can rename and add books;
      a viewer sees them read-only.
    - `profile.test.tsx`: Save stays off until something changes. A time zone that doesn't exist shows the error and
      sends nothing. A save sends only what changed, then shows the toast.
    - `receipt.test.tsx`: the Splits card follows each category pick before Save, and same-category lines make one
      split (owner, 2026-11-21, PR #180). The two fail with the preview taken out.
    - `sign-in.test.tsx`: the API's error shows on the form.
    - `transactions.test.tsx`: rows from the offline store, newest first, open their transaction. An empty store shows
      the empty state.
- **Unrealized FX gain or loss on net worth** (CUR-06, [ADR-0010](design/adr/0010-fx-accounting-policy.md) §6; no
  migration).
  - Before: net worth valued foreign-currency accounts at the date's rate, but nothing showed how much of that was
    unrealized FX. CUR-06 was partial for that alone.
  - Now, for each account in a currency other than its books', net worth works out its balance at the date's rate less
    its carrying value (the sum of its postings' functional amounts, so realized gains and any `fx_revaluation` entry
    already count). A gain in the books' currency is translated to the base currency at the date's rate. An account
    without a rate is left out, as net worth already does. Nothing is posted.
  - `NetWorthDto` has `unrealizedFx` (total), `accounts[].unrealizedFx` (null for an account in its books' currency)
    and `trend[].unrealizedFx`. `@montra/domain` has `unrealizedFxIn` for the sum.
  - The net worth report gets an "Unrealized FX" column for each date, and a note saying it isn't booked, but only when
    some account is in a foreign currency. Export includes the column.
  - Web: the net worth tab of Cash flow shows the total under net worth and a column per account. Phone: the net worth
    tab shows the total, and each foreign account's line shows its own.
  - Not added: an unrealized line on the income statement or balance sheet. Both stay at booked (carrying) values.
  - Tests: domain `ledger-fx.test.ts` (gain, loss on a foreign debt, translation, own currency, no rate), API
    `unrealized-fx.test.ts` (a EUR account after a spend, each date's rate, the report column, note and CSV, nothing
    booked, no column without a foreign account), web `i18n-keys.test.ts`.
- **Subscriptions you may not be using** (REC-06; no migration: the thresholds live in the planning settings).
  - Before: REC-06 flagged only price increases. Nothing said a subscription might be unused.
  - Montra has no usage data from the services. So "unused" is a hint from the person's own spending, and the
    suggestion says "may", never "is". Two patterns, in `@montra/categorize` `unusedSubscriptions`:
    - **No other spending there:** there was other spending at the subscription's merchant before (rides beside
      Uber One), but none for `unusedSubscriptionMonths` (default 3), while the charge kept coming. The merchant is the
      first name word of the payee key. Its own charges (linked, or within 5% of the price) don't count. A
      subscription with no other spending there at all (Netflix) gets no hint either way.
    - **Similar ones:** `similarSubscriptionsMin` (default 2) or more active subscriptions in one category whose
      payees match reference merchants with the same MCC (Netflix and Hulu; not Netflix and Spotify). Merchants
      without a reference entry are never grouped, so two utility bills don't count.
  - Only active recurring expense items count. An ended or paused one is left alone.
  - Each is a REC-06 recommendation with a `review_subscription` action, once per period. On web the action links to
    Recurring, and the dismiss button reads **Keep it** (phone too). Kept or accepted: that subscription, or that
    exact group, isn't suggested again. Ignored: it expires with the period and comes back.
  - Settings: `unusedSubscriptionMonths` (0–24, 0 off) and `similarSubscriptionsMin` (0 off, or 2–10) in
    `PlanningSettingsDto`, stored in `workspace.priorities` like the others. Web Settings › Planning edits them.
  - Tests: categorize `subscriptions.test.ts`, API `unused-subscriptions.test.ts` (both hints, wording and links, keep
    stops it, ignored comes back, settings, ended items), API `planning.test.ts` (settings defaults).
- **The FX cost of a transfer between currencies** (CUR-08; no migration).
  - Before: a transfer between currencies kept both amounts and booked the gap to `fx_gain_loss`, but no screen showed
    how its rate compared with the market. `transferFxCost` in `@montra/domain` was never called.
  - Now each `TransactionDto` has `transferFx` (null unless the transfer is between currencies). It holds the amounts
    sent and received and the rate they imply. It also holds the stored reference rate for the date, the day that rate
    was published (up to a week earlier, as elsewhere), and the cost in the source books' base currency, with its
    percent.
  - The cost is what was sent at the market rate minus what arrived at the market rate. Both legs use the market, not
    the account's carrying value, so earlier gains on held currency don't count as cost. Positive is a cost, negative
    is better than market. Math is bigint (`transferFxQuote` in `ledger/fx.ts`).
  - No stored rate for the date: the market rate, cost and percent are null. The screens say no market rate is stored
    for that date. They never guess.
  - `POST /transactions/transfer/fx-cost` gives the same figures for a transfer being typed, without saving. The web
    transfer form calls it once both amounts are entered and shows the result under the fields.
  - The web transaction page and the phone's transaction screen show an "Exchange rate" card: your rate, the market rate
    and the FX cost (or "Better than market"). `transferFxView` in `@montra/domain` shapes it for both.
  - The list loads rates once per page, only when the page has a transfer between currencies.
  - Tests: domain `ledger-fx.test.ts` and `transfer-fx-view.test.ts`; API `foreign-currency.test.ts` (on the transfer,
    its GET and the list, against carrying value, the preview, no rate, one currency, wrong currency); phone
    `screens-test/transaction-fx.test.tsx` (the card, no rate, nothing on other transactions). The phone's screen-test
    harness now has an empty receipt queue, so the transaction screen renders there.
- **Owner draws and contributions as transfers in the money flow** (FLOW-06; no migration).
  - Before: owner draws never counted as spending, but the Sankey dropped them. The business showed the money as
    "Not spent", and the personal book showed spending it covered as "From savings or credit".
  - Now `GET /flow/sankey` reads the money between each pair of books in the window from the inter-entity accounts
    (DE-05): the personal book's clearing account in equity mode, the due-to and due-from accounts otherwise. Each pair
    nets to one link, so a draw and a contribution in the same month make one band.
  - With all books in the view, the link runs from one book's node to the other's, with a `kind`: `owner_draw`,
    `owner_contribution`, or `transfer` (money between a business and a rental). With one book in the view, the link
    goes to or from a `transfer` node named after the other book ("Owner draw from Studio"). That node opens the
    transactions behind it.
  - Income and spending don't change. Only each book's "Not spent" or "From savings or credit" moves, by the money that
    went to or came from the other books. Every book passes on exactly what came in.
  - `SankeyDto` links gain an optional `kind`. Links without one are ordinary flows.
  - Web: a book that gets money from another book sits one column to its right (`sankeyColumns` in
    `lib/planning.ts`), so the band runs left to right. Transfer bands and nodes have their own colour, the band's
    tooltip names the kind, and a note under the chart says these are transfers, not income or spending.
  - Phone: the cash-flow list gains a "Between your books" card, one row per transfer with its kind.
  - Tests: API `planning.test.ts` (a draw, a contribution back, a contribution to the rental and a business-to-rental
    transfer, in the consolidated view and in single-book views), web `planning.test.ts` and `i18n-keys.test.ts`,
    mobile `planning.test.ts`.

- **Receipts and files purged at their retention date, once an owner approves** (RCP-10, BAK-09; migration 0079).
  - Before: receipts and their files got a date 7 years out, written in code. The hourly retention job removed a file
    past its date, but never the receipt. Its lines, OCR text and extraction stayed, pointing at a file that was gone.
  - Now nothing past its date is deleted until a workspace owner approves it (owner's decision, 2026-11-22):
    - The hourly job (`data.retention`) lists each receipt and file newly past its date in `app.retention_item`, per
      workspace. A receipt's files are part of the receipt, not listed apart.
    - Each owner gets one `retention_due` notification per new set (in the app and by email, at most once a day). It has
      no names or amounts and says to review them on the web. The phone has no screen for it.
    - On the web, Settings › Data lists them for owners only: the merchant or file name, the dates and amount, and the
      transaction a receipt belongs to. Admins and other roles can't see or act on it (`retention.owner_only`).
    - **Delete these** approves exactly the items listed, never ones found later, and needs a recent sign-in
      (`reauth.required`). The job then runs at once: each receipt goes with its lines, OCR text and extraction, then
      its files, then the objects in storage (local or S3).
    - **Keep for longer** moves the date of all the listed items, or the selected ones, `RETENTION_EXTEND_YEARS`
      (default 1) from today. They leave the list.
    - Files deleted from the Trash (a tax form's, 30 days on) still go on their own, as before.
  - The transaction a receipt was matched to stays, with the same splits. A split posting only loses its pointer to the
    receipt line, in a locked or reconciled period too, so the books don't change. The owner decided this on
    2026-11-22, amending ADR-0014 §6 (which said a locked period blocks the purge).
  - What stays: a receipt not yet past its date, with its files; a file another record needs by foreign key; an object
    another file row still names. A legal hold on any active member of the workspace keeps everything, approved or not,
    until it is lifted.
  - The vault (ADR-0054 §10): a file held only in the vault loses its row, and any old copy Montra still had to remove.
    The vault keeps its document unless the owner turned on "Also delete it in the vault". The owner's own storage is
    the same as before.
  - Logged in the audit log: `retention.approved` and `retention.extended`, with who and which items; then
    `receipt.purged` and `file.purged`, by `system`, with who approved and no contents. The receipt's earlier audit
    entries keep who and when, but their contents are cleared, since they held the same extracted text.
  - Settings, not code: `FILE_RETENTION_YEARS` (default 7) dates each new receipt and each file uploaded with a
    receipt, payslip, bill, invoice or payroll form. Dates already set don't change. `RETENTION_EXTEND_YEARS`
    (default 1) is what "Keep for longer" adds. `RETENTION_BATCH` (default 500) caps what one run lists, and what it
    removes. Tax forms keep their own date (tax year + 7, ADR-0052 §8.5). Since migration 0088 this is for business
    and rental receipts only: personal receipts have no minimum (`PERSONAL_RECEIPT_RETENTION_YEARS`, default 0; see
    "Delete forever" at the end of §7g).
  - A receipt in the trash still waits for its retention date. The Trash showed a purge date 30 days out; it shows the
    retention date now (next entry). A personal receipt has none since migration 0088, and goes after 30 days.
  - Tests: API `receipt-retention.test.ts` (nothing goes without an approval; listed and told once; owners only;
    approving needs a recent sign-in; approval covers only the items listed; then the receipt goes with its lines,
    image and bytes while its locked transaction keeps its splits; the audit entries; keep for longer; a legal hold
    blocks after approval; a shared object; the batch size; a vault-held file). `data-ownership.test.ts` now approves
---
    before a file goes. Web `retention.test.ts`.
- **The translation adjustment on net worth** (CUR-01, [ADR-0010](design/adr/0010-fx-accounting-policy.md) §7; no
  migration).
  - Before: net worth converted books kept in another currency (a business in EUR in a USD workspace) at each date's
    rate, but nothing said how much of that came from the rate moving. §7's translation adjustment line wasn't built.
  - Now, for each account in books whose currency isn't the base, net worth works out its carrying value at the
    date's rate less each of its postings at its own day's rate. Income, spending, transfers and opening balances all
    count at their own day's rate. That is the closing-rate net assets less the opening translated net assets and the
    movements at their rates, cumulative from the books' first posting. Nothing is posted.
  - It doesn't overlap CUR-06's unrealized FX, which is measured in the books' own currency before translation. Net
    worth less every posting at its day's rate is the two added together (to a cent or so of cross-rate rounding when
    an account's currency is neither its books' nor the base).
  - `NetWorthDto` has `translationAdjustment` in total, per account (null when the books are in the base currency) and
    per trend date. `@montra/domain` has `translationAdjustment` (one period, bigint) and `translationAdjustments`
    (rolled forward over dates).
  - The net worth report gets a "Translation adjustment" column and a note, only when some books are in another
    currency. Export includes the column.
  - Web: the net worth tab of Cash flow shows the total under net worth and a column per account. Phone: the net worth
    tab shows the total.
  - Left out: properties (their worth isn't booked, so there are no days' rates); an account missing a rate counts as
    zero, as net worth already leaves it out. Not changed: the income and spending reports still convert other books
    at the period end's rate (ADR-0019 §2), and there's no other comprehensive income line on an income statement.
  - Tests: domain `ledger-fx.test.ts` (EUR books in USD with the rate moving: from the start, one period, rolled
    forward, flat rates give zero, after the money has gone, no rate), API `translation-adjustment.test.ts` (the
    figure per account, in total and per date, no double count with unrealized FX, the report column, note and CSV,
    nothing booked, no column when every set of books is in the base currency), web `i18n-keys.test.ts`.
- **Receipts in the Trash, and a legal hold on account deletion** (BAK-06, NFR-06, BAK-09, RCP-10; migration 0080).
  - Before: a deleted receipt waits in the Trash for its retention date (RCP-10), but the Trash said it would go 30
    days after it was deleted. And the hourly job purged a closed account, and the workspaces that went with it, after
    its 30 days, under a legal hold too. `purge_user` even deleted the hold.
  - Now the Trash says how and when each item goes. `TrashItemDto` has `removal` and `until` in place of `purgeOn`:
    - `trash`: transactions and tax forms, removed for good 30 days after they were deleted (as before). Personal
      receipts too since migration 0088, and an owner or admin can delete any of these forever now.
    - `retention`: a receipt (a business or rental one since migration 0088). It is a tax record, so it is kept until
      its retention date, and can be restored until then. Deleting it doesn't shorten that.
    - `owner_approval`: a receipt past its retention date. It is listed for the owners in Settings › Data like any
      other, and goes only once one approves.
    - `in_use`: a transaction still there 2 hours after its 30 days. The hourly job couldn't delete it because another
      record (a payslip deposit or a rent payment, say) still points at it, so it stays until that changes.
  - The web's Trash and Settings › Data say so. The phone has no Trash screen. How files in the Trash go is unchanged.
  - A legal hold on a closing account keeps it, and its workspaces, as they are: `retention_due()` leaves them out, and
    `purge_user` and `purge_workspace` refuse them. A closing workspace is also kept while any active member is under
    a legal hold. The account that closed it is still purged.
  - The job notes when it first held one back (`purge_held_at` on the user and the workspace) and logs a warning once,
    not every hour. The staff console shows "Deletion held back by a legal hold since …" on the account and on the
    workspace. When the hold is lifted (or the deletion cancelled) the note is cleared and logged, and the same run
    purges what is due.
  - The person is not told: a legal hold is never emailed to them (ADR-0049 §4), so nothing goes in their security
    log either.
  - No new settings: the 30 days and the hourly job are as before.
  - Tests: API `receipt-retention.test.ts` (a deleted receipt shows its retention date and outlasts the 30 days; it can
    be restored; past its date it waits for an owner and goes only after an approval). New `deletion-legal-hold.test.ts`
    (a closing account under a hold isn't purged, the purge functions refuse it, it's logged once, the console shows it,
    and it goes on the next run after the hold is lifted; a workspace held by another member's hold).
    `data-ownership.test.ts` and web `i18n-keys.test.ts` updated.
- **Import makes sure transfer pairs transfers** (TXN-04, AI-03, backlog item 1; ADR-0028 amendment of 2026-11-23;
  migration 0081).
  - Before: a pair step 3 was sure of (0.95) waited in Review like any other, so every card payment had to be accepted
    by hand on each statement. A transfer made in Review couldn't be taken apart again.
  - Now an import commit makes each such pair a transfer on its own, the same way accepting it in Review does: the
    other side is absorbed and its statement line moves to the transfer. It runs once all the rows are written in their
    chunks of 500, so it costs a few statements per pair and nothing per other row.
  - Setting, not code: `ai_settings.transferThreshold` (default 0.95; 0.90 to 0.99; null is off), in Settings › AI as
    "Make pairs … transfers when importing". Below it, pairs wait in Review as before.
  - Left in Review, not forced: a row that was a possible duplicate or got a category picked in the preview; a pair
    with no other side yet (0.80); two rows of one import claiming the same other side; another currency (it needs the
    amount received); an other side that changed since the preview or whose account is archived; an other side that is
    reconciled or in closed books (DE-10). A switch from another app keeps its own pairing step.
  - Undo: `app.transfer_conversion` records what making a transfer changed (by an import, in Review or by hand).
    `POST /transactions/:id/undo-transfer` puts both sides back as they were, statement lines and their roles included,
    and the editor has an "Undo transfer" button. Undoing the import that made one takes it apart first, so the other
    side comes back and this import's line is removed. One that was changed since, or is reconciled or closed, is
    kept with reason `transfer`, as before.
  - Shown: the import summary says "N transfers matched" (`counts.transfers`, from `import_batch.rows_transferred`;
    the phone too), the undo result how many were taken apart, and the transaction that the import made it
    (`categorization.transfer.made`: `import` or `you`). An automatic one stays `auto_applied` and doesn't teach the
    payee its account.
  - Tests: API `import-auto-transfers.test.ts` (a sure pair converts with balances and both cleared lines kept, a 0.60
    pair waits, off and 0.99 convert none, a threshold below 0.90 is refused, a reconciled and a closed other side are
    skipped, a side claimed twice and another currency wait, undoing the import restores both sides and balances,
    re-importing finds duplicates, undo from the transaction for an automatic and a manual one). `transfers.test.ts`
    turns the setting off to keep testing the Review path.

- **Photos compressed before upload on the web too, and originals kept by choice** (BAK-08; migration 0083).
  - Before: the phone's camera and scanner saved JPEGs at quality 80 to 85, at full size. Photos picked on the phone,
    and every photo uploaded on the web, went as they were. There was no way to keep an original.
  - Now photos are compressed the same way on the web and the phone, before they upload or are queued:
    - JPEG, PNG and WebP are drawn upright (EXIF orientation applied) with the long edge at most 2,000 px, and saved as
      JPEG at quality 80. While the result is over about 1 MB, the quality steps down by 10, to 60 at the lowest.
    - The saved JPEG has no EXIF, so no location. A JPEG is always sent re-encoded for that reason. A small PNG is sent
      as it is when the JPEG would be no smaller.
    - PDFs, CSVs and anything else are never touched. A photo the browser can't read goes as it is.
    - The decisions are pure functions in `@montra/schemas` (`photo-uploads.ts`), shared by both clients. The web draws
      on a canvas (`apps/web/lib/photo-upload.ts`); the phone uses expo-image-manipulator (`src/receipts/photo-tool.ts`).
  - Where: on the web, receipts, reimbursement receipts, business bills, household bills, payslips, rental files, I-9
    documents and tax forms. On the phone, receipts (camera, scanner and picked photos; the camera now shoots at full
    quality and is compressed once) and payslips. The phone's tax-form scan now uses the same width and quality for its
    PDF (it was 1,800 px). Statement imports, logos, restores and "Files to provide again" are not changed: a provided
    file must match the original's bytes.
  - Keep originals: `app_user.keep_original_photos`, off by default, as the design says ("kept if the user opts in").
    It is in Profile on the web (saved with the profile) and on the phone (a switch, saved at once). The web's receipt
    upload also shows "Upload the original photos this time", ticked from the profile's choice. `MeDto` gains
    `keepOriginalPhotos` and `photoLimits`; `PATCH /v1/me` takes `keepOriginalPhotos`.
  - Settings, not code: `PHOTO_MAX_EDGE_PX` (2000), `PHOTO_QUALITY` (80), `PHOTO_MIN_QUALITY` (60) and
    `PHOTO_TARGET_BYTES` (1048576), checked at start and sent to the clients with `GET /v1/me`. The defaults live once,
    in `PHOTO_UPLOAD_DEFAULTS`, which the phone also uses offline before it has a profile with limits.
  - The meter: unchanged, and it already counts what is stored. A file's `bytes` is the length of what the client sent,
    so a compressed photo counts at its compressed size.
  - Duplicate checks compare the compressed bytes. The same photo compressed twice in the same browser gives the same
    bytes, so it is still found; across browsers or a phone and a browser it may not be.
  - Not tried on a real phone or in a real browser; the canvas and manipulator paths are covered by tests with fakes.
  - Tests: schemas `photo-uploads.test.ts` (what is compressed, the sizes, the quality steps, which file goes, the
    settings), web `photo-upload.test.ts` and mobile `photos.test.ts` (compressing with a fake encoder: resized, quality
    stepped down, PDFs and originals left alone, unreadable photos sent as they are, dropped copies removed), API
    `photo-uploads.test.ts` (the profile's choice and limits, a bad setting stops the start, the meter counts the bytes
    stored).

- **Delete an account added by mistake, when it is empty** (ACC-14; no migration).
  - Before: an account could only be archived (ACC-06). One added by mistake stayed in the lists for good.
  - Now `DELETE /accounts/:id` deletes an empty account. `GET /accounts/:id/deletion` says first what stops it.
    - Owners and admins only, as for moving an account to other books, and only after a recent sign-in
      (`reauth.required`).
    - Empty means no transactions (posted, scheduled or in the trash; since migration 0088 those in the trash go with
      it when they touch nothing else, see the next entry), receipts on them, balance adjustments, journals,
      values that changed the balance, statement imports or statements waiting for it in Review, reconciliations, loan
      payments, other loans, cards or assets that use it, recurring items, rules or pending rule suggestions. Every other
      table that points at it counts too: employers and payslips, payroll, business and rental settings, invoices and
      bills, goals, expected income, tax forms.
    - Otherwise the answer is 409 `account.not_empty` with a sentence such as "This account has 12 transactions.
      Archive it instead, or remove them first." The web shows it.
    - What goes with it, in one transaction: its opening-balance entry (only when its other lines are on
      opening-balance equity), values that posted nothing, its loan details, its saved import mapping and its
      statement memory. Visibility, past moves, payee transfers and tax-form waivers go by cascade, and a linked feed
      account is left unlinked. The books stay balanced.
    - An opening balance in closed books, or a locked one, is refused with 409 `account.opening_locked` and the date.
    - The audit log gets `account.deleted` with who, the name, kind, type, currency, books and opening balance.
    - Sync: the pull reads deletes from the change feed and sends `removedAccounts`; the phone drops them from its
      accounts. Quick add picks another account if the chosen one was deleted. The phone has no account settings
      screen, so Delete is on the web only: Settings › Accounts, beside Archive, for owners and admins. It asks the API
      first, shows the reason or asks to confirm by name, and a stale sign-in shows the step-up link.
    - Not changed: the read models (`account_balance_daily`, `category_activity_monthly`) keep zeroed rows for the
      deleted account; nothing reads them without the account.
  - Tests: API `account-delete.test.ts` (an empty account goes with its opening entry, books balanced; partner refused;
    stale sign-in refused; 409 with a transaction, a receipt, a statement; closed books refused; the audit entry; the
    sync pull's `removedAccounts`). Sync `engine.test.ts`, mobile `store.test.ts`, web `account-delete.test.ts`.
- **The rental property and unit suggested for a line** (AI-02; migration 0082).
  - Before: the pipeline suggested a category, its books and a member. A line's property and unit were tagged by hand,
    or by a rent, mortgage or capital improvement link.
  - Now the pipeline also finds the property, and the unit when the property has more than one, for lines that land
    in rental books. Same order as categories:
    - a rule (rules may now set `propertyId` and `unitId`; a unit needs its property);
    - the payee's history: where most of its lines went (at least 2 and 80%), kept in the new `app.payee_property`;
    - the text: the property's street address ("12 ELM ST" or "12 North Elm Street"), its name as a phrase, or a unit
      ("APT 2B", "#2B", "UNIT NO 1"). A unit on its own counts only when one property has it. Two properties named
      means none. A house's only unit ("Main") is never matched by its label;
    - AI: the new `suggest_property` task, once per set of books with the lines still open. It gets masked text, a
      rounded amount and the category's name, and the properties as short ids with their names (masked, so a street
      number becomes "#") and unit labels. Never an address. A failure returns `ok: false` and the line keeps what
      the earlier steps found, or nothing. The fake provider answers by distinctive words in a property's name.
  - Settings, not code: `propertyThreshold` (default 0.80) in the AI settings, on the web's AI settings page. At or
    above it the property goes on the line; a property from AI also needs the AI threshold. Below it, the line waits
    in Review with the property offered, even when its category was applied.
  - Applied on manual entries, imports and bank feeds. The property goes on with the category, or on the uncategorized
    line in the account's own books. A line whose category is in other books only gets a suggestion.
  - Review: the web shows the property on each row ("Suggested property: Elm duplex, 2B" and its confidence, the reason
    on hover). Accept puts it on with the category. "Property" (or `p`) picks another property or unit, or none. The
    phone's review card shows the suggested property, and accepting there applies it. Choosing another one on the phone
    isn't there yet: that's on the web.
  - Learning: accepting a property, choosing one in Review, on a transaction or with a new entry counts it for the
    payee. Changing it takes back what that transaction counted. Undoing an import takes it back too.
  - Never overridden: a property given with an entry, set on the transaction, or put there by a lease or mortgage link
    stays. Accept skips the property when the line has one, belongs to a lease or loan, or the property is in other
    books than the category.
  - Not done: "apply to existing" for a rule leaves properties alone, and the web rule editor doesn't offer a property
    yet (the API takes one). There is no benchmark for properties, so AI scores aren't calibrated.
  - Tests: categorize `property-suggest.test.ts` (address, name and unit matching, history, the order rules → history
    → text → AI, thresholds, AI failure, kept properties, transfers, books); gateway `suggest-property.test.ts` (the
    fake provider, what is sent, ids, failures, the cache); API `property-suggestions.test.ts` (two properties: a
    learned payee, a unit from the text, AI, an import, a set property and a lease win, a correction learned, the
    setting); web `phase3.test.ts`; mobile `models.test.ts`.
- **Import parsing is faster, with the same results** (NFR-07; migration 0085, an index only).
  - Before: a realistic 5,000-row statement took 9.0 to 10.7 s to parse on this machine, at the 10 s limit. Most of
    the time went to work done again for every row:
    - each row was compared with every reference merchant, and both sides' trigrams were rebuilt for each pair;
    - the pipeline compiled 17 keyword patterns for each row;
    - each row was checked against every transfer, dedupe and match candidate, whatever its amount;
    - each AI cache key was read in its own transaction, and each answer written in its own.
  - Now:
    - a payee key is matched to the merchants once per import (`MerchantDirectory.match` remembers it), and each
      merchant's trigrams are built once;
    - keyword patterns are compiled once (`hasWord`);
    - transfer, dedupe and match candidates are grouped by amount, and a row looks only at those with its amount (or
      the opposite one for a transfer), in the same order as before. Each text's trigrams are built once
      (`similarityCache`);
    - the gateway reads the AI cache for a whole run in one query and writes each batch's answers in one statement,
      when the store offers it (`cacheGetMany`, `cachePutMany`; the API's store does);
    - migration 0085 adds an index on `transaction_source (workspace_id, import_row_id)`. Deleting an import's rows (a
      parse run again after a mapping change, a discarded import) looked up each row's statement-line records by
      reading all of the workspace's. 5,000 rows took 7.2 s with 5,000 such records, and 0.28 s with the index.
  - Rows, statuses, scores, categories, confidences, explanations and transfer candidates come out the same. The new
    perf test's dump (`PERF_PARSE_DUMP`) matched line for line before and after, at 1,000 and 5,000 rows.
  - Measured on this machine, which was busy with other work, so the numbers move by a second or so between runs.
    Before is develop's parse code with the same tests:

    | Test (`@montra/api test:perf`)                    | 1,000 rows        | 5,000 rows         |
    | ------------------------------------------------- | ----------------- | ------------------ |
    | `perf-parse` (realistic statement, 10k txns)      | 4.1 s → 2.1 s     | 10.7 s → 3.6 s     |
    | `perf-commit` (five payees, empty workspace)      | 1.8 s → 1.2 s     | 5.5 s → 2.3 s      |

    An earlier pair of runs of `perf-parse` at 5,000 rows gave 9.0 s → 6.0 s.
  - Still the largest costs, and left as they are: inserting the rows (about 0.3 ms a row, mostly the row-level
    security check), and two candidate queries whose time grows with the workspace, not the file. The transfer
    candidate query reads every posting of the other accounts, not only those in the file's dates, and returns them in
    no fixed order. Making it read by date would change which candidate wins a tie, so it needs a decision first.
  - Tests: `perf-parse.test.ts`, new in `@montra/api test:perf`: 5,000 lines with many payees, card payments and
    rules, into a workspace with 10,000 transactions on other accounts, an earlier import over the last month and a
    card named by its last 4 digits. Budget: the requirement's 10 s for 5,000 rows. `perf-commit.test.ts` now uses
    the fake AI provider, as the app would, and its 30 ms a row commit budget is unchanged. Gateway
    `gateway.test.ts` (the bulk cache gives the same answers in one read and one write per batch), importers
    `units.test.ts` (remembered trigrams compare the same; a merchant's changed key is used).

- **A date window and filters on the Transactions, Review and Receipts lists** (RPT-05, nearest ID; migration 0087).
  - Before: Transactions had only the All, Needs review, Scheduled and Trash tabs, and showed the newest 200 of all
    time. Review showed the whole queue. Receipts had tabs and a text search. The receipt list's column said "Store".
  - Now each list opens on the **last 90 days**, with a filter bar above it (`components/list-filter-bar.tsx`):
    - **Period:** the last 7, 30, 60 or 90 days, 6 months, a year, all time, or custom dates open on either side.
      "Today" is the workspace's (TZ-01). A preset has no end, so scheduled items still show. The choice is
      remembered per list in this browser (localStorage, as the theme is). Under the list, "Showing the last 90
      days. Show older" widens it one step, up to all time.
    - **Merchant:** words of the payee or description on Transactions and Review ("star" finds Starbucks, through the
      search index); anywhere in the store's name on Receipts.
    - **At least / at most:** in the workspace currency, compared without the sign, so "20 to 100" finds spending and
      income alike. "In or out" narrows to money out (spending) or money in; transfers are neither. Not on Receipts.
    - **Account and category** on Transactions. The tabs keep the filters.
    - Active filters show as chips with a remove button, and "Clear all". Everything is in the URL (`range`, `from`,
      `to`, `merchant`, `min`, `max`, `dir`, `account`, `category`), so a filtered list can be bookmarked and shared,
      and Back undoes a change. A report's drill-down dates open as a custom range.
    - When the filters hide everything: "No transactions match these filters", with Clear filters. Review also says
      how many items to review are older than the window. "Accept all above" takes only what the filters show.
    - Receipts: the column header **Store** is now **Merchant**, and so are the receipt's field and "Unknown merchant".
      The search box stays and keeps the filters. Database columns and DTO fields are unchanged. (Since moved into
      the filter row as "Words on the receipt"; see the next entries.)
    - **Load more** under each list adds the next page (200 transactions, 100 review items or receipts) with the same
      filters. Show older appears only once the window is all loaded. A refresh after an edit starts again from the
      first page.
  - API: `GET /transactions` gains `merchant`, `amountMin`, `amountMax` (unsigned minor units) and `direction`, and
    keyset paging: `cursor` in, `nextCursor` out, by date then id, so rows sharing a date are neither repeated nor
    skipped. `listTransactions` in the API client still returns the rows; `listTransactionsPage` returns the page.
    `GET /review` and `POST /review/accept` gain those and `from`/`to`. `GET /receipts` gains `merchant` and the amount
    range; its `from`/`to` now count a receipt without a date by the day it arrived. `q` works as before, with them.
  - Speed: row-level security checks entity access on every row before a condition like `@@` or a cast out of
    `spec`, so a narrow filter over all time took about 3 s on 50,000 transactions. Migration 0087 adds
    `app.transaction_filter_ids`, which finds the matching ids in the current workspace without that check (ids only,
    to a member). The API then asks for those ids and applies the same filters under RLS. With more than 5,000
    candidates it skips that step, since the date order then finds a page quickly. Each page decides this again, and
    looks only up to the day the page starts on. The perf test now times three filtered lists.
  - Not done: the phone's lists don't have these filters yet.
  - Tests: API `list-filters.test.ts` (the amount range with both signs, money in and out, merchant words, dates, the
    filters combined, `q` with them, bad values; the review queue and "accept all above" with filters; receipts by
    merchant, dates, an undated receipt and totals in other currencies; 250 filtered rows over 25 shared dates paged
    40 at a time, each once and in order, with and without the id lookup and with it on some pages only; the review
    queue paged the same way); db `rls.test.ts` (the ids only for a member); `perf-dashboard.test.ts` (three filtered
    lists); web `list-filters.test.ts` (presets, month ends, leap days, the workspace time zone, the URL round trip,
    amounts, widening and chips) and `paging.test.ts` (Load more and when Show older appears). The e2e specs for review, AI settings and
    the happy path now date their transactions in the last few days, and the receipts spec searches over all time.

- **Delete forever, personal receipts with no minimum, and deleting a matched receipt** (BAK-06, ACC-14, RCP-10;
  migration 0088).
  - Before: nothing left the Trash early. An account added by mistake couldn't be deleted while one of its transactions
    sat in the Trash. Every receipt was kept 7 years, personal ones too. A matched receipt couldn't be deleted at all.
  - Now, deleting an empty account (ACC-14) also deletes its transactions in the Trash, in the same database
    transaction, with any entries they still have; the books stay balanced.
    - Only those that touch nothing else: every posting is on this account, categories or system accounts.
    - Still blocking, each with its reason: a trashed transfer to another account (`trashed_transfers`), a trashed
      transaction with a receipt (`trashed_receipts`), one in closed or reconciled books (`trashed_closed`), and a
      legal hold (`legal_hold`, 409 `account.legal_hold`).
    - `GET /accounts/:id/deletion` has `trashedTransactions`. The web confirm says "Delete “Auto Loan” and 1
      transaction in the Trash? This can’t be undone." The audit entry `account.deleted` has the count.
  - **Delete forever** (BAK-06): `DELETE /trash/:kind/:id` removes one item that would go after 30 days, now.
    `POST /trash/empty` (**Empty Trash**) removes all of them and says how many stayed.
    - Owners and admins only, with a recent sign-in. The web asks to confirm, then shows the step-up link if needed.
    - The same cleanup as the 30-day job (`app.purge_trash_item`): a transaction with what cascades from it; a tax form
      with its files and their stored bytes; a personal receipt with its lines, OCR text, files and bytes.
    - Refused under a legal hold (`trash.legal_hold`), in closed or reconciled books (`trash.closed_period`), for a
      transaction with a receipt (`trash.has_receipt`), for a business or rental receipt (`trash.retention`), and when
      another record still uses it (`trash.in_use`).
    - Audited with who and when: `transaction.purged`, `tax_form.purged`, `receipt.purged`, `file.purged`.
    - The web Trash page has the buttons. The Receipts screen has a Trash tab with the deleted receipts, their date,
      merchant, amount and when they go, with Restore and Delete forever. The phone has no Trash screen.
  - **Personal receipts have no minimum retention** (RCP-10, owner's decision, 2026-11-23).
    - A receipt is personal when its books, its lines' books and its matched transaction's books are all personal. An
      inbox receipt with no books named counts as personal.
    - It gets no retention date. It is kept while it isn't deleted and is never listed for an owner's approval. Deleted,
      it is in the Trash for 30 days like a transaction (`removal: 'trash'`), then `purge_trash` removes it.
    - Once a business or rental part shows up (a line, or a match to a business transaction), it gets the business date
      from when it came in. A date only ever moves later.
    - Business and rental receipts keep `FILE_RETENTION_YEARS` and the owner-approval rule.
    - The migration cleared the dates of existing personal receipts, and took them off the owners' approval list.
  - **Deleting a matched receipt**: `DELETE /receipts/:id?unlink=true`, owners and admins with a recent sign-in.
    - The receipt is unlinked and moved to the Trash. Its transaction stays exactly as it is: amount, date, payee, and
      the splits, memos and categories the receipt gave it. So the books don't change.
    - Refused in closed or reconciled books (`receipt.closed_period`) and under a legal hold (`receipt.legal_hold`).
    - Restored, it comes back unmatched, in Review. Matching never links a receipt in Review on its own.
    - Audited as `receipt.deleted_matched` with the transaction it was linked to.
    - Other writers, and the phone, keep the old rule: unlink first (`receipt.matched`). The web review screen has
      Delete; for a matched receipt only owners and admins see it, and the confirm explains the effect.
  - Also: `purge_trash` now skips a workspace under a legal hold (as retention has since migration 0079), and a
    transaction it can't delete stays in the Trash instead of stopping the run.
  - Settings, not code: `PERSONAL_RECEIPT_RETENTION_YEARS` (default 0, no minimum).
  - Not checked in a real browser: the shared dev database isn't migrated to 0088.
  - Tests: API `trash-delete-forever.test.ts` (the owner's Auto Loan case with balanced books; a trashed transfer, a
    receipt in retention, a legal hold and closed books still block; Delete forever for a transaction, a tax form and
    its file, and a personal receipt; refused for a partner, without step-up, under a legal hold, in a locked period,
    and for a business receipt; Empty Trash; a personal receipt has no date and goes 30 days after deletion; the
    migration clears only personal dates; a matched receipt deleted by the owner with its transaction unchanged,
    refused to a writer, in closed books and under a hold, restored unmatched, audited; no system job left queued).
    `account-delete.test.ts`, `receipts.test.ts` and `receipt-retention.test.ts` updated for the new fields and the
    personal rule. Web `trash.test.ts`, `account-delete.test.ts`.
- **Receipts: the search joins the filters, and the tabs look like Transactions** (RCP-10, IMP-11; no migration).
  - Before: the Receipts list had a separate search box and button above the filter row. It found words anywhere on
    the receipt (the merchant or the text read off it), so it overlapped with the Merchant filter and was easy to
    miss. The Inbox, Needs review, Matched, All and Trash tabs were small links on the left. The Total and Status
    headers ran together.
  - Now: the search is a field in the filter row, **Words on the receipt** (`text` in the URL), applied as you type
    like the other filters, with its own chip. Merchant still matches only the merchant's name. With words and no tab
    chosen, the list looks in All, as the search did. An old `?q=` link opens with the same words. The tabs use
    the Transactions style on the right, with the list's name on the left. Status has room after Total.
  - Tests: web `list-filters.test.ts` (the new filter round-trips through the URL, has its own chip, counts as a
    filter); e2e `receipts.spec.ts` finds a receipt by a word on it through the new field. Checked in a browser on
    the Frame check workspace: a word that matches nothing shows "No receipts match" with a chip, a matching word
    finds the receipt, and `?q=` opens as `?text=`.
- **Not-advice lines on every tax and money-advice output** (AIA-12, NFR-14; no migration).
  - Before: the shared line ("Informational only — not tax advice…") showed only on Insights and AI settings. Some
    tax screens had their own notes, but the tax forms screens, the business and rental set-aside, mileage, pay runs,
    suggestions, the month in review, debt payoff plans and every phone screen had none. A Schedule C or E downloaded
    as CSV or XLSX didn't say it either.
  - Now: one web component (`components/ui/disclaimer.tsx`) and one phone component (`Disclaimer` in
    `src/ui/components.tsx`), with the two existing keys `disclaimer.tax` and `disclaimer.financial`. Each screen shows
    it once, small, at the end. `recommendationDisclaimer` in `@montra/schemas` picks the tax line for a list of
    suggestions with a tax set-aside or tax due date (REC-09, BIZ-09), and the financial one otherwise.
  - Newly added, web: Tax forms (the year and one form); the business page, once for its set-aside and suggestions;
    rental settings, under the set-aside; every suggestions list (home, Suggestions, business and rental pages);
    Month in review; Goals, when a debt payoff plan shows; Mileage; a pay run; an asset.
  - Newly added, phone: Tax forms (the year and one form); the business screen's tax card; Suggestions; Month in
    review; Goals, with a payoff plan; Mileage; a pay run.
  - Newly added, files: a Schedule C or E report as CSV or XLSX ends with "For your records and your tax professional,
    not tax advice." after a blank row, from the reports page and inside the tax package. The rental Schedule E export
    does the same.
  - Already there, kept: Insights and AI settings (the shared line); Schedule C and E reports on screen and as PDF (their
    note); the Schedule E page; Business taxes; assets and the depreciation helper; payroll people, pay runs, taxes,
    year-end and onboarding forms (their own notices); the investment panel ("Figures, not advice"); the tax package
    README and `tax-forms-check.pdf`; the payslip PDF.
  - Left out on purpose: the W-2, W-3, 1099-NEC and 1096 PDFs and the EFW2 file (official forms and a filing format,
    given to employees or agencies; the screen that makes them has the notice); W-4, DE 4 and W-9 forms; the accountant
    journal export (QuickBooks and Xero import it); the cash-flow forecast, Explore and Ask (they report your own
    figures and suggest nothing); the phone's AI settings and payroll list (no tax or money-advice figure on them).
  - Tests: web `disclaimer.test.tsx` (the two lines, which one a list of suggestions gets, once per list, off when the
    page shows its own); e2e `tax-forms.spec.ts` (once on the year and on a form); API `reports.test.ts` (a Schedule C
    CSV ends with the line, a P&L doesn't), `rentals.test.ts` (the Schedule E export ends with it),
    `data-ownership.test.ts` (the tax package's README and its Schedule C CSV say it, its P&L doesn't); phone
    `disclaimers.test.tsx` (tax forms once; suggestions with the financial or the tax line; none with no suggestions).
- **Education tax helpers** (FAM-10; migration 0090).
  - Before: a family member could be marked as a dependent and a 529 plan was a plan type, but nothing tied
    education spending or 529 withdrawals to a student, so nothing showed what might matter for the education credits.
  - Now, a personal spending category can be marked as one kind of education expense: tuition and fees, books and
    supplies, room and board, or computers (`ledger_account.education_expense_type`, the one new column).
    - Settings → Categories has the choice on each personal spending category. `PATCH categories/:id` takes
      `educationExpenseType` (null clears it). Income is refused (`category.education_type`).
    - The student is the family member on each transaction, as for every member report. The Dependent flag is the
      member's existing one. No student flag or school year was added.
    - Why a category and not a per-transaction mark or a tag: categories already say what money was for, rules and
      the AI already set them, and the member is already on each posting. One nullable column covers it.
  - `GET reports/education?year=` gives, per student and calendar tax year (this year in the workspace time zone by
    default), the marked spending by kind and the money out of 529 plans (`plan_type = '529'`). A 529 posting with no
    member counts for the plan's default member. Contributions, market value changes, opening balances and reversed
    entries aren't withdrawals. What has no member is its own row, so it can be assigned.
  - The By member page shows it for this year (last year with the Last year tab), with notes on what may matter: the
    American Opportunity and Lifetime Learning credits, room and board counting for a 529 but not the credits, 529
    withdrawals above the expenses marked, and not using the same expenses twice. Then the existing tax disclaimer.
    Nothing works out a credit, eligibility or a taxable amount. With nothing marked and no 529 plan, it is one line
    pointing to Settings → Categories.
  - Not done: the phone and the tax package export don't show it. No category is marked out of the box.
  - Tests: API `education.test.ts` (marking and clearing, income, unknown kinds and a viewer refused; expenses by kind
    and member with a refund; a 529 transfer counted for the plan's member and tuition paid from the plan for the
    member on it; contributions, a valuation drop, a deleted withdrawal and opening balances left out; 31 December
    and 1 January in their own years; the default year in a +14 time zone; a viewer reads it, another workspace sees
    none of it). Web `education.test.ts` (kinds shown, each note, no member, netting to nothing) and the i18n key
    coverage for the new dynamic keys.
- **Every number traceable, and the export readable in a spreadsheet** (UP-05; no migration).
  - Before: UP-05 wasn't tracked. Most numbers already drilled down (FLOW-01/02, RPT-03), but some didn't: Month in
    review's figures and categories, the budget's total spent, a goal's savings, the business tiles, totals and
    customers, and the rental portfolio row. The forecast, net worth and 50/30/20 didn't say how they were worked
    out. The export's workbook had amounts in cents and no account or category.
  - The audit, web screens (→ is the drill-down; "says" is a line on how it's worked out):

    | Screen | Number | How to see what's behind it |
    | --- | --- | --- |
    | Home | Income, Spent | → transactions (already) |
    | Home | Left to spend, Left to assign | → Budget (already) |
    | Home | Charts, where it went, changes, pace | → transactions (already) |
    | Home | Net position, low balance | → Net worth, Forecast (already) |
    | Budget | Each line's activity, unbudgeted | → transactions (already) |
    | Budget | Total spent | → transactions in the budget's categories (**new**) |
    | Budget | 50/30/20 | says (**new**) |
    | Cash flow | Money flow nodes | → transactions (already) |
    | Cash flow | Forecast | says, items listed (**new**) |
    | Cash flow | Net worth, assets, liabilities | says (**new**); each account → its register (already) |
    | Explore | Month cells, totals, uncategorized | → transactions (already) |
    | Month in review | Money in, money out | → transactions (**new**, `drill` on the DTO) |
    | Month in review | Categories, changes, over budget | → transactions (**new**) |
    | Month in review | Largest purchases | → the transaction (already) |
    | Reports | Rows and bars | → transactions (already, RPT-03) |
    | Accounts | Balance | → the account's register with running balance (already) |
    | Business | Revenue, expenses tiles | → the P&L for that month (**new**) |
    | Business | P&L lines | → transactions (already); totals (**new**) |
    | Business | Customers, vendors | → transactions found by name (**new**) |
    | Business | Money in and out, cash | says (already) |
    | Rentals | Property rows | → transactions (already); Portfolio row (**new**) |
    | Rentals | NOI, cap rate, cash on cash | says (already) |
    | Goals | Saved | → the linked accounts' transactions, or Budget (**new**); debts → account (**new**) |
    | Upcoming | Scheduled items, card and loan dues | → the item or account (already) |

  - The export: not plan-gated (ADR-0020 §3). Owners and admins take the workspace, partners one set of books. Every
    table as JSON lines and CSV, plus `summary.xlsx`. That workbook's Transactions sheet now has Account and Category
    ("Split" when there are several), and amounts as 12.34 rather than 1234. The README says the JSON and CSV
    amounts are minor units.
  - Left for the owner: the budget's income actual has no drill-down (the page has no income categories); the
    "Not on a property" rentals row has no filter; Net worth over time and Receipt items report rows have none;
    business money in and out are explained, not drillable; a customer's drill-down finds by name, as the spending
    report's payee rows do, so a payment under another name is missed; the phone screens weren't audited; an
    export can't be taken while an account deletion is pending (`account.deleting`).
  - Tests: API `month-summary.test.ts` (the drills add up to money in and out), `data-ownership.test.ts` (the
    workbook's columns, account, category and amounts); e2e `traceable-numbers.spec.ts` (new: budget total, Month in
    review's money out and a category, a goal's savings, the forecast and net worth lines), `business.spec.ts`
    (revenue tile, total revenue, a customer) and `rentals.spec.ts` (the portfolio row).
- **A business's tax account numbers sealed at rest** (BIZ-26, migration 0089; ADR-0037 §5 amended).
  - Before: the EIN, EDD employer account, FTB entity ID and CDTFA seller's permit were masked on screen, but stored
    in plain text on `business_profile`. Every edit also copied them into the audit log. Payroll's unused copies of
    the EIN and EDD account (`payroll_settings`, unread since 0037) still held plain text.
  - Now:
    - Each number is sealed with `FieldCrypto`, like payroll's personal data: `ein_enc`, `ftb_entity_id_enc`,
      `ca_employer_account_enc` and `cdtfa_permit_enc`. The last four sit beside each (`*_last4`) for the masked
      display. Writes seal the number and clear the plain column in the same update.
    - Reads show only the masked last four. A number other than an EIN now masks as "••••1234", since its length
      isn't kept. Show (`POST /businesses/:id/reveal`) still needs a recent sign-in, unseals on the server and logs
      `business.revealed`. The DTOs didn't change.
    - The 941/940/DE 9/DE 9C worksheets, the W-4/I-9 PDFs, W-2s, 1099s and the EFW2 file still get the full numbers,
      unsealed on the server (`employerIdentity()` now takes `FieldCrypto`). Payroll settings use `employerMasked()`,
      which unseals nothing.
    - **Backfill:** the worker's `business.seal_tax_ids` job seals the numbers stored before 0089 and clears the plain
      columns. It's queued at every worker start. It works one business at a time, each in its own transaction, as
      the workspace's owner (or an admin). It only looks at rows that still hold a plain number, so it is safe to stop
      and run again. A run that hits its 2-minute budget queues the next one. `app.tax_ids_to_seal(limit)` lists
      what's left. A business in a workspace with no active owner or admin is skipped and counted. Until a row is
      sealed, reads and Show use its plain value, so nothing breaks in between.
    - **Audit log:** the audit trigger now redacts these columns, plain and sealed, as it already did every `*_enc`
      column. The migration redacted the numbers already in the log (`business_profile` and `payroll_settings`
      entries keep the key, with "[redacted]" as the value). It also cleared `payroll_settings.ein` and
      `ca_employer_account`.
    - **Backups** still hold the numbers in full, under their plain names (`ein` and so on), so archives from before
      and after 0089 look the same. A restore seals them again and fills in the last four. Payroll's old columns are
      no longer restored.
    - **Not changed:** `tax_form.issuer_ein`, a payer's EIN read off a W-2 or 1099. It's another business's number,
      printed on every form that payer sends, and Montra matches forms by it (`tax-form-reading.ts`,
      `statement-match.ts`). Sealing it would need a keyed hash for that matching. It stays as migration 0059 left it.
    - No search, unique index or matching used the business's own numbers, so nothing else needed a hash.
  - Settings, not code: `TAX_ID_SEAL_BATCH` (default 200), how many businesses the job looks up at a time.
  - Follow-up: a contract migration drops `business_profile.ein`, `ftb_entity_id`, `ca_employer_account` and
    `cdtfa_permit`, and `payroll_settings.ein` and `ca_employer_account`, once every install has run the job. Check
    first that `select count(*) from app.tax_ids_to_seal(1000000)` is 0. That step also takes the plain-value fallback
    out of `business/tax-ids.ts` and the backup's "plain wins" check.
  - During a deploy, an older API task still reads the plain columns, so it shows a sealed number as blank until it
    stops. A number it writes is sealed by the next job run.
  - Tests: API `business-tax-ids.test.ts` (writes seal and clear, masked reads on the business and payroll, Show only
    after a recent sign-in and audited, no full number in reads, errors or the audit log, worksheets and year-end in
    full; the job seals plain rows, keeps a newer plain value over an older sealed one, runs again with nothing to
    do, stops at its budget and carries on; the migration's audit redaction and payroll clearing).
    `data-ownership.test.ts` (the archive has the numbers in full and once in the CSV; a restore seals them).
    `business-registration.test.ts` masks updated. Domain `business-registration.test.ts` (`maskLast4`).
- **An account's holders and its full number, sealed** (ACC-15, ACC-16, migration 0091; ADR-0057 §5, §6, PR 1 of 3).
  - Before: an account had a default member (whose spending it is) and the last four of its number. Nothing said who
    the bank says owns it, and `bank_account.account_number_enc` existed (0001) but nothing wrote it.
  - Now:
    - **Holders:** a new table, `app.account_holder`: position, name, and an optional family member. A child table
      rather than a jsonb list, so a member link is a foreign key bound to the workspace, each change is its own audit
      entry and change-feed row, and backups pick it up from the catalog. RLS follows the account's books (read to see,
      write to change). Deleting the account takes them with it.
    - `AccountDto.holders` lists them in order. `PATCH` and `POST accounts` take the whole list (`holders`). A holder
      with a member and no name gets the member's name. A row that stays in its place keeps its id, so the audit log
      shows a rename as a change. A member outside the household is refused (`account.holder_member`), and the
      database refuses it too. The default member is unchanged.
    - **Full number:** sealed with `FieldCrypto` in `account_number_enc` (label `bank_account.account_number`), with
      its last four in `last4`. The DTO has `accountNumberMasked` ("••••1234") and `fullNumberKept`, never the number.
      Owners and admins set it (`accountNumber`) or remove it (`null`, which keeps the last four). Others get 403.
      Spaces and dashes are dropped; it must be 4 to 34 letters and digits ending in four digits, and the error
      doesn't repeat it. While it's kept, `last4` can't be changed on its own (`account.number_last4`). A check
      (`not valid`, for old rows) makes a kept number always have its last four.
    - **Show:** `POST accounts/:id/reveal-number`, owners and admins, after a recent sign-in. Each one is logged as
      `account.number_revealed`, with no number in it. The audit trigger already writes "[redacted]" for `*_enc`
      columns. Sealing and the reveal's audit entry are shared with BIZ-26 in `crypto/sealed-numbers.ts`.
    - **Backups** hold the number in full (`account_number`, as the catalog already said) and the holders in
      `account_holder.jsonl`. The summary workbook's Accounts sheet has a Holders column. A restore seals the number
      again and fills in the last four. A restore now keeps an archive's `last4` when there is no full number (it used
      to clear it), which also covers BIZ-26's columns. A one-book archive has only that book's accounts' holders.
    - **Web:** Settings → Accounts has Holders (name, family member, add, remove) and Account number (masked, Show,
      type in, remove; owners and admins). The account page shows "Held by …" and "••••1234"; the accounts list and
      Home show "••••1234" instead of "••1234".
    - **Phone:** the account screen shows the masked number and the holders, and edits holders online (owners, admins
      and partners who can write the books). The phone has no Show.
  - Settings, not code: `ACCOUNT_MAX_HOLDERS` (default 4), how many holders an account may list
    (`account.holders_limit` above it).
  - Next: PR 2 renders statements as PDFs with a cover page that uses the holders (VLT-13); PR 3 sends them (VLT-12).
  - Tests: API `account-holders.test.ts` (new: list, rename in place, add and remove, holders on create, the limit and
    the setting, a member from another workspace refused by the API and the database, deleted with the account, RLS
    for another workspace and a partner without the business's books, the change feed; the number sealed with its
    last four, owners and admins only, last four kept with it, a bad number not echoed, Show after a recent sign-in
    and logged each time, never in reads, the sync pull or the audit log, removed keeping the last four).
    `data-ownership.test.ts` (the archive has the number in full and the holders, the workbook's Holders column; a
    restore brings back holders with their member remapped and the number sealed, and keeps a last four with no
    number). `business-tax-ids.test.ts` still passes on the shared helpers. Domain `account-holders.test.ts`, web
    `account-holders.test.ts`, phone screen test `account-holders.test.tsx` (shown, none, add a member and save, a
    refusal shown, read-only for a viewer).
- **Statements rendered as PDFs with a cover page** (VLT-13 partial, migration 0092; [ADR-0057](design/adr/0057-vault-statement-pdfs.md) PR 2 of 3).
  - Before: the vault keeps documents and images, so a CSV, XLS or OFX statement stayed in Montra only, shown as "not a
    type the vault keeps".
  - Now:
    - `StatementRenditions.render(ctx, fileId, { detail, accountNumber, attachOriginal })` draws a statement file as a
      PDF from its committed import's parsed rows, never from the file. One renderer covers every format the import
      reads. It is in `apps/api/src/renditions/`.
    - The PDF has one cover page, then a table of date, description, money out, money in and running balance. Each
      table page has a header with the account name, the period and "page n of m". The totals come at the end.
    - The cover comes from a document summary model (`document-summary.ts`), so other kinds of document can have one
      later. With the detail switch off it shows the account, institution, type, holders, currency and period only. With
      it on, it also shows the account number, the balances, money in and out, the count, the balance check, and the
      original file's name, format, SHA-256 and import date. The number is the last four by default, or none. Full is
      only ever passed in by the caller.
    - The holders are the account's holder list (ACC-15), else its default member, else the book's name. Full unseals
      the account's kept number (ACC-16) for the cover only; with none kept, it shows the last four.
    - The running balance is the bank's own when every row has one. Otherwise it is worked out from the opening balance,
      or back from the closing one. Otherwise it is left blank. A file listed newest first is turned round.
    - The original can be attached inside the PDF, related as its source, byte for byte. With several parts it goes in
      the first part, and the other covers say so.
    - A file the import couldn't read gives a cover-only PDF that says so, but only when the original is attached.
      Otherwise the answer is "not converted" and no file is made. An import still open answers "not ready".
    - Fonts are embedded (Noto, as invoices use), without ligatures, so the text layer reads back as written. The
      metadata is set, and the same input gives the same bytes.
    - Each part is stored as its own `app.file` of the original's kind, through the usual storage and quota (BAK-08).
      `derived_from_file_id` links it to the original in the same workspace, and `rendition` is `statement_pdf`. A
      trigger refuses rendering a rendering, or a different kind. A rendering goes in the Trash and comes back with its
      original. If the original is deleted for good, the rendering keeps its row, unlinked, and retention removes it.
    - A rendering is not queued for the vault when it is stored (`storage_file_added` skips it). The owner's own
      S3/WebDAV copy takes it like any file. Sending is PR 3.
    - Rendering again replaces a rendering not yet sent and removes its stored copy. One the vault has had (any state
      past `queued`) is kept and not redone. Undoing the import drops the unsent renderings; one the vault has stays.
    - The worker's `statement.render` job (queue `report`) runs it for a file, as the user who queued it.
      `StatementRenditions.enqueue()` queues it. Nothing queues it yet; PR 3 will, after a commit or a backfill.
  - Settings, not code: `STATEMENT_PDF_MAX_ROWS` (default 5,000), the most rows in one PDF. A longer statement is split
    into parts, each titled "part n of m".
  - Left for PR 3 (VLT-12): the per-group "Files the vault doesn't keep" and "Account number on the cover" settings,
    sending renderings, hints, "import undone" on a sent one, and §7's rule for removing the original. A file with two
    committed imports (one file, two accounts) renders the latest only.
  - Tests: API `statement-pdf.test.ts` (rows and running balances, the cover at each detail level and number choice, no
    full number unless passed in, rows and totals drawn, metadata, the same bytes twice, the attachment byte for byte,
    the split, a cover-only file). `statement-renditions.test.ts` (CSV, XLS and OFX imports each give a PDF whose rows
    and totals match the batch; the cover from the account; an unreadable file with and without attaching; an open
    import; the split by the setting; the derived-file columns, their checks and RLS; Trash with the original; not
    queued for the vault; replace, keep and drop on undo; the job). `data-ownership.test.ts` (a rendering's link to its
    original isn't a file holder).
- **Statements sent to the vault as PDFs** (VLT-12, VLT-13 done, migration 0093; [ADR-0057](design/adr/0057-vault-statement-pdfs.md) PR 3 of 3).
  - Before: a CSV, XLS or OFX statement stayed in Montra only, shown as "not a type the vault keeps". PR 2 could render
    one as a PDF, but nothing asked for it or sent it.
  - Now:
    - Each sent group has "Files the vault doesn't keep": Don't send, Convert to PDF and send, or Convert to PDF and
      attach the original. Only statements offer the last two (Montra has no other renderer); the API refuses them for
      other groups. The default is convert with the original attached for statements, Don't send for the rest. It is
      kept in the vault connection's `config` (`groups[].unkept`), so a later S3/WebDAV copy could use it too.
    - "Account number on the cover": Last four (default), Full or None, in `config.coverNumber`. It only matters with
      "Describe documents in more detail" on. Full is owner-only, needs a recent sign-in, shows the ADR's warning first,
      and is recorded in the security log (`vault_changed`, the choice only) and the audit log
      (`vault.cover_number_full`). Each cover made with it is audited too (`statement.full_number_on_cover`). The number
      is never in a DTO, an error, a log, a job or a hint to the vault (tested).
    - The flow: when a statement the vault doesn't keep has its import committed (the commit nudges it through
      `app.vault_conversion_due`), or a backfill reaches it, the vault's job (`promote`) marks its outbox row
      `converted` and queues `statement.render` as an owner. The transaction that stores the PDFs gives each part an
      outbox row of its own (`queueRenditions`); the part with the original inside is marked `carries_original`. What
      the rendering said otherwise (kept, not converted, import undone, not ready) is recorded on the original's row
      (`recordConversion`, `render_state`, `render_options`). All of it is in `storage/vault/vault.conversions.ts`.
    - Each PDF is sent like any file, with the original's hints, the title "<file name> (PDF)" (", part n of m" when
      split) and the statement's end date (its own when the file said it, else its last row's).
    - Don't send keeps today's state. A file the import couldn't read, without attaching, is "couldn't be converted"
      in words.
    - A change to the choice, the detail switch or the cover number has the job look at every converted file again:
      unsent PDFs are made again with the new settings (or dropped when the group stops converting); ones the vault has
      are kept. Statements left as "not a type the vault keeps" go back in line when their group starts converting.
    - "Send again" (owners and admins, `POST …/family-vault/retry` with the file) sets the PDFs the vault has aside
      (`app.file.superseded_at`; they stay in the vault and in Montra with their original) and makes and sends a new
      one with today's settings.
    - Undoing the import drops unsent PDFs (PR 2) and marks a sent one "import undone"; it stays in the vault.
    - §7: for a group sent with no local copy, the original goes only once the vault has filed the PDF carrying it,
      with the same conditions as any file (the vault could give it back, the mirror, nothing reading it, the
      connection active). Read back, `FileBytes` reads that PDF (Montra's copy, the mirror's, then the vault's) and takes
      the attachment whose hash is the original's. Without the attachment the original stays; Settings says why. The
      move backfill counts such originals too.
    - Badges: `FileVaultSummaryDto.converted` (state, attached, the PDFs in counts, `canSendAgain`), from the definer
      `app.vault_file_conversions`. The web's import history (Statements and Imports) shows each statement file's
      vault state, with Send again for owners and admins. Settings shows both settings, the counts gain "sent as PDFs",
      and a group sent with no local copy says what happens to its originals. The phone shows no statements' files, so
      it only gained the new count and badge words.
  - Migration 0093: `vault_item.status` gains `converted`, with `render_state`, `render_options` and
    `carries_original`; `app.file.superseded_at`; `app.vault_conversion_due()` and `app.vault_file_conversions()`;
    `vault_due()`/`vault_next()` count converted rows that are due.
  - Not done: the "belongs to" hint from a holder linked to a member (ADR-0057 §4) isn't sent: statements send no
    person hint today. A change of holders or of the account doesn't remake an unsent PDF on its own; the next change of
    settings or import does. A statement already marked "not a type the vault keeps" before this release goes once its
    group's choice is saved again or with "Send existing documents" only if it isn't in the outbox.
  - Tests: API `family-vault-converted.test.ts` (defaults and what is offered; Full needing an owner and a recent
    sign-in, logged; each choice; couldn't be converted; parts with their titles, dates and the original in part 1; the
    cover number reaching the cover; replace before sending, keep after; Send again; undo before and after sending; §7
    with and without the attachment, read back from the PDF; no full number anywhere). `family-vault-sending.test.ts`
    and `family-vault-no-copy.test.ts` updated for the new DTO field. db `vault.test.ts` (the new checks and functions,
    staff get none). Schema, web `vault.test.ts` and `i18n-keys.test.ts`, phone `vault.test.ts`.
- **Wider pages on large screens, and a roomier receipt line table** (no requirement change; no migration).
  - Before: every page stopped at 1200 px wide, so a large monitor left wide empty margins. On a receipt, item names
    were cut off, the "For" picker shrank to its first letter, and the "Taxed" and "Category" headers ran together.
  - Now: pages grow to 1760 px (`components/shell/app-shell.tsx`). The receipt's picture takes 38% instead of 42%. The
    line table's headers have the same gap as its cells, the item fields are at least 12rem wide and "For" 8rem, and the
    table scrolls sideways on its own when the screen is too narrow, so the page doesn't.
  - Checked in a browser at 1920 px (content 1605 px wide, item names whole, headers apart) and on a narrow window (no
    page overflow).
- **Who a receipt line is for** (RCP-03, RCP-06, FAM-05, UP-02; owner, 2026-11-24; migration 0094).
  - Before: a line's member ("For") came from an item rule, the same item's member on an earlier receipt (whatever set
    it), or the AI's guess, else Household. Who added the receipt was never used. Rules couldn't check who added it or
    the category, and couldn't set Household.
  - Now a line's member is the first of:
    1. a person's pick on the line;
    2. a receipt-item rule that sets a member or Household;
    3. the member a person picked by hand for the same item on an earlier receipt (never one from a default, a rule
       or the AI);
    4. the member linked to the login that added the receipt (a scan, an upload or an order import);
    5. Household.
  - The AI no longer sets it. It still suggests categories. Members are still sent to it, so their names are
    pseudonymized in item text.
  - `receipt_line.member_reason` (0094) keeps why: `{ source, explanation, ruleId }`, with source `user`, `rule`,
    `history`, `adder` or `household`. `ReceiptLineDto.memberReason` carries it. The web review shows it under "For"
    (e.g. "Added by Sam", "Rule: …"), and the category's explanation under the category.
  - Receipt-item rules can check "Added by" (`added_by`, member ids) and "Category" (`category`, category ids), and set
    `household: true`. They run in two steps in `@montra/categorize`: `applyRules` decides the category, where a
    category condition can't match yet; then `applyMemberRules` runs every rule again with the category known. A rule
    that checks the category can't set the category or the books. Transaction rules refuse all three with
    `rule.invalid`; an unknown member or category is `rule.member_invalid` / `rule.category_invalid`.
  - The web rule editor asks "Runs on: Transactions / Receipt items" for a new rule. Receipt-item rules offer the item,
    store, amount, books, day, "Added by" and "Category", and "For" with Household; they hide tags, rename and
    "reviewed", and have no preview. The list marks them and shows "for …". The phone doesn't edit rules.
  - "Apply to existing" changes transactions, so receipt-item rules don't offer it: the web hides the button, and the
    API refuses it with `rule.apply_receipt_line`.
  - A line added in review starts on "For: Automatic", which leaves `memberId` out of the request, so the line goes
    through the order. Picking Household sends null, and counts as a person's pick, as on a saved line. On a saved
    line, a member left out or sent unchanged is kept, so the phone's save is unchanged.
  - Re-running: a line's member is decided when the line is new, or when its category is worked out again (left
    uncategorized, or a category picked in review), unless a person picked the member. So picking Groceries in review
    can turn a line to Household by rule. Lines stored before this keep their members; one with no member and no
    category is filled in when its category is redone, as before.
  - Tests: API `receipt-members.test.ts` (the adder default, a login linked to nobody gives Household, an order import;
    a rule over a hand-picked member over the adder; a pick kept through later saves; a hand-picked Household reused;
    a default or a pre-0094 member not reused; a pre-0094 line left alone; "Added by Mansoor and Category is Groceries"
    gives Household, and follows a category picked in review; the fields and Household refused on transaction rules, by
    create and by edit; new lines in review on Automatic, Household and a member; "Apply to existing" refused for a
    receipt-item rule, with no job queued; the AI's member ignored, sure or not). Categorize `rules.test.ts`
    (validation by scope, the conditions, both steps). Web `phase3.test.ts` (receipt-item drafts, Household, switching
    kind, describing them, no "Apply to existing"), `receipts.test.ts` (Automatic leaves the member out, Household
    sends null).
- **Daily simple interest, the lender's split, editable loan dates, grace periods and late fees** (RNT-08, DE-04; owner,
  2026-11-24; migration 0095; [ADR-0024](design/adr/0024-loan-tracking.md) §13, §14).
  - Before: every loan charged balance × rate ÷ 12 each payment, as mortgages do. An auto loan ($15,000 at 7.56%, financed
    28 Sep, first due 27 Oct, $301) showed $94.50 interest on payment 1 where the lender charged $93.20. There was no way
    to enter the lender's own split, and the start date couldn't change after the loan was added.
  - `loan_schedule.interest_method` (`monthly` default, so every existing loan stays as it was; `daily`). Daily: interest =
    balance × rate × days ÷ 365, half up to the cent (`dailyInterest`, `interestDays` in `@montra/domain`), from the
    previous payment's date (payment 1: the start date, required, on or before the first payment) to the day it's paid. A
    recorded payment uses its transaction's date; projected ones their due dates; the projection after recorded payments
    starts from the ledger balance and the latest recorded payment's date. The payment stays level and the last clears what's
    left. The monthly path is unchanged. `LoanDto` gains `interestMethod` and `next.accruesFrom`.
  - Recording a payment takes optional `interest` and `principal` (both or neither) from the lender's statement: stored and
    posted instead of Montra's; principal ≤ owed, and with escrow and any late fee they must make up the bank line or the new
    transaction (`loan.split`). Without them a daily loan's interest runs to the payment's real date (e.g. $93.21 paid on day
    30, actual/365 half up; the lender's $93.20 can be entered).
  - `PATCH loans/:id` takes `startDate`, `interestMethod`, and `firstPaymentDate` only while nothing is recorded
    (`loan.first_payment_locked`); daily without a start date is `loan.start_date`. Recorded payments keep their parts.
  - Grace period and late fee per loan (`grace_days` 0–60, `late_fee_minor`, `late_fee_bps`: fixed, percent of the
    scheduled payment with escrow, or the greater of the two; `loanLateFee`, half up). Late = paid after due + grace
    (`next.late`, `next.lateFee` on `LoanDto`). A payment's `lateFee` (stored on `loan_payment.late_fee_minor`) is its own
    split to the books' Bank fees system account. A late line for payment + escrow + the loan's fee is taken as both. Bank
    lines now match from 5 days before the due date to max(5, grace) after (`inLoanMatchWindow`), automatically and through
    "Make transfer". Automatic linking skips a payment that can't be recorded (a daily loan's last one overpaid) instead of
    failing the job.
  - Web: the loan form offers "Monthly (mortgages)" or "Daily simple interest (auto and personal loans)", daily by default
    for a `loan` account and monthly for a mortgage, plus grace period and late fee (amount and/or percent). The loan panel
    shows "Due the 27th, grace period 10 days", the method and fee, "Late — a fee of $X may apply" past the grace period,
    and the record form has a late fee (filled in once the date is past the grace) and "Enter the lender's split" with
    principal and interest filled in with Montra's figures for the chosen date. Settings edit the method, start date, first
    payment date (locked once one is recorded), grace and fee. The rental mortgage form stays monthly.
  - Phone: the loan card shows the method, grace period, late fee and the late note; recording a payment takes a late fee
    (filled in once late) and optional lender principal and interest. Not run on a device.
  - Tests: domain `rental.test.ts` (29 days 90.10, 30 days 93.21, half-cent rounding, February and 31-day months, the
    fallback date, level payments and the last clearing, the monthly path unchanged, a property test; late/grace, fixed,
    percent, greater-of and half-up fees, the matching window). API `loans-daily.test.ts` (payment 1 from the start date, a
    payment a day late and the next from its date, start date rules, an old client's loan stays monthly, the lender's split
    by both paths and its refusals, switching to daily keeps recorded parts, moving the first payment and its lock, fee terms
    and editing them, a late line with its fee to Bank fees, an entered fee, the grace window in matching). Web
    `loans.test.ts`; mobile `accounts.test.ts`.

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
