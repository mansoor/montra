# 01 — Phased Delivery Plan (Release 1)

R1 ships every **M** requirement. **S** items are planned into phases; if one slips,
it moves to R1.x. **C** items are out of R1 unless noted. The requirement-to-phase
mapping for every ID is in [traceability.md](traceability.md).

## Overview

| Phase | Theme | Est. (weeks) | Dev release | Depends on |
| --- | --- | --- | --- | --- |
| **0** | Foundations and walking skeleton | 2 | `v0.1.0-dev` | — |
| **1** | Core ledger, accounts, entities, manual transactions, auth, web shell | 5 | `v0.2.0-dev` | 0 |
| **2** | Statement import pipeline and reconciliation | 4 | `v0.3.0-dev` | 1 |
| **3** | AI gateway, categorization pipeline, rules, review queue | 4 | `v0.4.0-dev` | 2 |
| **4** | Mobile app foundation and parity for phases 1–3 (parallel track) | 4 (+ ongoing) | `v0.5.0-dev` | 1 (starts after 2) |
| **5** | Receipts, camera capture, multi-currency and FX | 4 | `v0.6.0-dev` | 3, 4 |
| **6** | Budgeting, goals, money flow, forecast, recommendations | 5 | `v0.7.0-dev` | 3 |
| **7** | Family members (reports) and payslips | 3 | `v0.8.0-dev` | 6 |
| **8** | Small business | 3 | `v0.9.0-dev` | 6 |
| **9** | Rental properties | 4 | `v0.10.0-dev` | 6 |
| **10** | Reports, search, notifications, export/backup/restore, settings | 4 | `v0.11.0-dev` | 7–9 |
| **11** | Hardening, compliance, beta and R1 launch | 4 | `v1.0.0-rc.N` → **`v1.0.0`** on `main` | all |

Critical path about 38 weeks with 3 engineers. Phases 7, 8 and 9 can run in parallel
once Phase 6 lands (about 30 weeks with a fourth engineer). Each phase ends with a demo
on the dev environment, a `develop` tag and a short phase review that updates this plan.

```
wk  0    4    8    12   16   20   24   28   32   36   40
P0  ██
P1    █████
P2         ████
P3             ████
P4             ░░░░████████ (mobile track, then continuous parity)
P5                     ████
P6                     █████
P7                          ███
P8                          ███        (parallel with 7/9 if staffed)
P9                             ████
P10                                ████
P11                                    ████  → v1.0.0
```

---

## Phase 0 — Foundations and walking skeleton (2 weeks)

**Goal:** a repository where the hardest invariants (money, double entry, tenant
isolation) are built and tested first, plus one end-to-end vertical slice through the
API and database.

Scope:
- pnpm + Turborepo monorepo, TS strict config, ESLint, Prettier, Vitest, GitHub Actions
  CI with a Postgres service container, Renovate.
- `packages/domain`: `Money`, ISO 4217 currency table, decimal parsing and formatting,
  rounding, `allocate` (largest / largest-remainder), `CalendarDate`, journal entry
  builder and validation, posting templates (expense, income, split, transfer, card
  payment, loan payment, opening balance, inter-entity), FX functional amounts with a
  rounding residual. Property tests.
- `packages/db`: SQL migrations for identity/tenancy, entities, chart of accounts, bank
  accounts, family members, transactions, journal entries, postings, tags, audit log,
  change feed; the **deferred balance trigger**, the **lock trigger**, **RLS** on every
  table; migration runner; default chart of accounts seed per entity type.
- `packages/schemas`: Zod DTOs for money, dates, workspaces, accounts and transactions.
- `apps/api`: NestJS on Fastify with config validation, health checks, a
  request-scoped RLS unit of work, a dev auth guard (behind `AuthPort`, replaced by
  Kratos in Phase 1), problem+json errors, idempotency keys, and endpoints for
  workspace bootstrap, accounts, categories, transactions (expense, income, split,
  transfer) and the account register.
- `infra/docker-compose.yml`: Postgres, Redis, MinIO, Mailpit.

Exit criteria: CI green; property tests show every built entry balances; an
integration test shows the database rejects an unbalanced entry; an RLS test shows
workspace A can't read B; API e2e: create workspace → account → transactions → the
register shows correct running balances.

## Phase 1 — Core ledger and manual capture (5 weeks)

Scope: ACC-01..06; TXN-01..05, TXN-10; DE-01..07, DE-09, DE-10; FAM-01..04 (fields and
defaults), FAM-11; CUR-01, CUR-02, CUR-10; TZ-01, TZ-02, TZ-05, TZ-06; AUTH-01..11 (Ory
Kratos integration: sign-up, verification, MFA, recovery, sessions, invites);
NFR-02/03 (RBAC + audit); PLT-01 (web shell), PLT-06 (WebSocket change events), PLT-11;
UP-03 onboarding templates (without AI proposals); UP-04 sharing and roles.

Deliverables: the web app (Next.js) with onboarding, accounts, register (ledger/simple),
transaction list and editor with splits, quick-add bar, bulk edit, journal view, manual
journals, period lock, family members, settings (profile, security, entities,
currencies, time zone). Recurring templates create scheduled transactions (the
`schedule` worker queue starts here).

Exit: a user can sign up with MFA, set up personal + business entities, enter a month of
transactions including splits across entities and transfers, see correct registers, and
invite a partner with restricted entity access. Playwright happy-path suite green.

## Phase 2 — Import pipeline (4 weeks)

Scope: IMP-01, IMP-03..10, IMP-13 (YNAB/Mint/Monarch/Quicken/Stessa templates); DE-08
reconciliation; UP-01 loss-proof import; OPS-05 reference-data loader (import profiles,
merchant aliases).

Deliverables: `apps/worker` (BullMQ), `packages/importers` (CSV/XLS/XLSX parsing,
header and column detection, fingerprints and profiles), `apps/doc-worker` (Python,
pdfplumber for digital PDFs; scanned PDFs through OCR), payee normalization,
dedupe/match engine, preview UI, summary with balance check, undo within 30 days,
reconciliation UI, golden-file import corpus (≥ 50 files).

Exit: re-importing the same file adds 0 rows; an overlapping statement adds only new
rows and matches manual entries; summary counts always reconcile; 5k-row CSV parses in
< 10 s.

## Phase 3 — AI gateway and categorization (4 weeks)

Scope: AIA-01..07, AIA-09, AIA-10, AIA-12; AI-01..06, AI-08, AI-09, AI-11; AI-07
(merchant enrichment, S); TXN-06 natural-language quick add; FAM-05 member prediction;
UP-02 rules + "apply to existing"; UP-13 provider choice; UP-03 AI category proposals
from the first import; PLT-10 keyboard shortcuts; OPS-07 provider failover; NFR-14
disclaimers; IMP-03 AI-assisted column mapping.

Deliverables: `packages/ai-gateway` with Anthropic, OpenAI-compatible (Ollama/LM
Studio/vLLM) and Null adapters (OpenAI/Gemini/Azure BYOK adapters as follow-ups); routing
config; minimizer; cache; budget controls; the six-step pipeline; rules engine (RE2);
review queue (web, keyboard-first); learning loop and rule suggestions; recurring
detection and anomaly flags; evaluation harness and benchmark v1; AI settings page with
per-mode privacy disclosure; AI audit log view.

Exit: benchmark accuracy ≥ 85% on held-out data with the default provider; 1,000-row
import categorized in < 60 s; AI *off* mode still categorizes via rules and history.

## Phase 4 — Mobile foundation and parity (4 weeks, then continuous)

Scope: PLT-02, PLT-03, PLT-04, PLT-07, PLT-05 (S), IMP-02, BAK-10; UP-07 mobile parity
for phases 1–3.

Deliverables: **camera/OCR spike (week 1)** → go/no-go on Expo; `apps/mobile` with auth
(biometric unlock), home, transactions, quick add (≤ 3 taps), swipe review queue,
accounts and register, import via share sheet/files, encrypted offline store and outbox
with field-level LWW conflict handling, push registration; EAS build pipeline, Maestro
flows. From here on, every later phase delivers its mobile screens in the same phase.

## Phase 5 — Receipts and multi-currency (4 weeks)

Scope: TXN-08, TXN-09; IMP-11; RCP-01..08, RCP-10, RCP-11, RCP-12; ACC-04;
CUR-03..09; TZ-03; BIZ-12 receipt vault and missing-receipt list; UP-09.

Deliverables: receipt capture (mobile camera with edge/blur/glare, multi-shot) and
upload (web/mobile); `extract_receipt` task + local OCR path; line-item categorization
with item rules; tax/discount allocation; validation with gap; receipt inbox and
matching; receipt review screen; FX rates service (ECB daily + Open Exchange Rates),
foreign spend capture, FX rounding, travel mode; attachment retention (7 years) and OCR
text indexing.

Exit: the requirements' Walmart example produces exactly the documented splits; a
foreign receipt matches its home-currency statement line within ±3%.

## Phase 6 — Budgeting, money flow and recommendations (5 weeks)

Scope: BUD-01..10; FLOW-01..07; REC-01..08; FAM-06, FAM-07; PAY-07 hook (expected
income); UP-11 light mode; UP-14 upcoming bills and price-change alerts; TZ-04
scheduling in user time zone.

Deliverables: budget engine (zero-based, category limits with rollover, 50/30/20),
draft from history, sinking funds, goals (with snowball/avalanche simulation), moves
with history, copy last/avg; dashboard; Sankey; 30/60/90 forecast with low-balance
warnings; spending pace; calendar; net worth; recommendation engine + AI wording;
monthly review; read-model tables (`account_balance_daily`,
`category_activity_monthly`).

Exit: the dashboard's numbers drill down to transactions; left-to-assign is always
consistent with lines; dashboard p95 < 2 s on the 50k seed.

## Phase 7 — Family members and payslips (3 weeks)

Scope: FAM-08, FAM-09 (reports and filters), FAM-10 (C, if time permits);
PAY-01..06, PAY-08, PAY-09; RPT-01 "by member" reports.

Deliverables: employers, payslip capture (PDF/photo → `extract_payslip`), payslip
journal posting, net-pay-to-deposit matching, per-member reports, payslip privacy
controls.

## Phase 8 — Small business (3 weeks)

Scope: BIZ-01..07, BIZ-09..11, BIZ-13; REC-09; AI-10 tax hints; BIZ-03 business/personal
separation flags.

Deliverables: business setup with Schedule C chart, customers/vendors, invoices (PDF +
email, auto-match), bills in the forecast, mileage log with the IRS rate table, quarterly
estimate calculator and reminders, P&L and Schedule C report, accountant access and
QuickBooks/Xero-compatible export.

## Phase 9 — Rental properties (4 weeks)

Scope: RNT-01..14; UP-10.

Deliverables: properties/units/tenants/leases, rent roll generation and deposit
matching, arrears and late fees, Schedule E chart and report, shared-expense allocation,
mortgage amortization and escrow split, capital-improvement flags and depreciation
helper, security deposit liabilities, rental metrics (NOI, cap rate, cash-on-cash,
occupancy), reminders, maintenance log, per-property budgets with capex reserve.

## Phase 10 — Reports, search, notifications, data ownership (4 weeks)

Scope: RPT-01..06 (complete set), RCP-09 item-level reports; NOT-01..03; AUTH-12;
NFR-05, NFR-06; BAK-04..06, BAK-08, BAK-09; OPS-10, OPS-13 (complete).

Deliverables: the full report catalogue with saved reports and PDF/CSV/XLSX export,
year-end tax package ZIP, global search with OCR text and amount operators,
ask-your-data, notification engine (push/email/in-app, quiet hours, caps, weekly
digest), full export, backup/restore with preview, trash, storage meter, account
deletion purge.

## Phase 11 — Hardening and launch (4 weeks)

Scope: NFR-01, NFR-04, NFR-07, NFR-08, NFR-10, NFR-11, NFR-13; BAK-01..03, BAK-07;
OPS-01..04, OPS-06, OPS-08, OPS-09, OPS-11, OPS-12; PLT-08 widgets (S).

Deliverables: production Terraform (Aurora, ECS, S3, KMS, backup vault with Object
Lock), observability dashboards and alerts, admin console and support access, billing
(Stripe + store billing), help center and guided tours, legal pages and DPAs, WCAG audit
fixes, performance tuning against NFR-07, external pen test and fixes, restore drill,
closed beta → `release/1.0` → `v1.0.0-rc.N` on staging → **`v1.0.0` merged to `main`**.

R1 exit (success metrics §1.4 measured in beta): ≥ 85% auto-categorization accepted
without edit, a month of statements imported and reviewed in < 10 min, NFR-07
performance met, no Sev-1/Sev-2 security findings open.

---

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Bank export formats are messier than expected | Import accuracy, support load | Golden-file corpus from day one; AI-assisted mapping; import-failure analytics by institution; profiles shared as reference data. |
| Receipt line-item OCR accuracy on long or crumpled receipts | RCP goals | Vision model + validation gap + review UI; multi-shot capture; eval set of receipts; fallback to merchant categorization. |
| Expo camera performance | Mobile UX | Spike at Phase 4 start; native module fallback. |
| Ledger correctness bugs | Trust (fatal) | DB-enforced invariants, property tests, nightly reconciliation job over all workspaces (Σ = 0, read models = postings). |
| AI cost overrun | Margin | Cascade (rules → history → cache → small model), per-workspace budgets, batch calls, prompt caching. |
| Scope (≈ 250 requirements) for a small team | Schedule | Strict M/S/C ordering; S items slip to R1.x; parallel phases 7–9 with a fourth engineer. |
| Privacy expectations (local AI with a hosted product) | Positioning | Clear local-mode limitation (assumption 7); self-hosted edition next. |
