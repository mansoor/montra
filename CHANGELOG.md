# Changelog

## v0.12.0-dev.1 — Phase 11: hardening, code complete

Everything here that talks to an outside service has been tested with stubs only, and nothing has been deployed. `v1.0.0` needs what's
in `docs/runbooks/launch-checklist.md`.

- **Plans** (UP-12, OPS-08; ADR-0020): personal books free, Pro for business and rental books and 50 GB, Stripe checkout and portal, a
  14-day trial and grace period. A lapse only stops adding: data stays readable, editable and exportable.
- **Staff console** (OPS-01, OPS-05, NFR-13): account lookup, plans, flags, import failures by bank, AI accuracy, requests, and reference
  data, on a database role with no grant on any financial table. A test fails if that changes.
- **Support access** (OPS-02): the owner allows it, read-only, 72 hours by default, on its own role in a read-only transaction. It shows
  books, imports and AI outcomes, not money, and each look appears in the owner's activity log.
- **Notices and versions** (OPS-03, OPS-04): banners with a 48-hour rule, a public status page, an update screen for old phone apps, and a
  check that refuses destructive migrations.
- **Help** (OPS-09): a help center, a tour on request, and contact with an optional screenshot and logs.
- **Observability** (NFR-13, OPS-07): error tracking behind a port, metrics, a nightly reconciliation of every workspace's books, dashboards
  and alert rules.
- **Security** (NFR-01, OPS-06): AWS KMS adapter, security headers, functions no longer public, `fastify`, `nodemailer` and `postcss`
  patched, dependency and image scans in CI.
- **Accessibility** (NFR-10): an automated WCAG 2.2 AA pass over the main screens in both themes, and what it found fixed.
- **Infrastructure** (BAK-01..03, BAK-07, OPS-12): Terraform for AWS and Cloudflare, images, a deploy workflow, runbooks and k6 scripts.
- **Legal** (OPS-11): terms, privacy, cookies and subprocessor pages, marked as drafts until a lawyer has read them.
- **Fixes from Phase 10**: the unsubscribe page sent signed-out people to sign-in, which is who it's for. Function grants were open to any role.
- **Not done**: widgets (PLT-08), which move to R1.x. Store billing. The pen test, legal review, DPAs and the beta, which are for the owner.

## v0.11.0-dev.1 — Phase 10: reports, search, notifications, data ownership

- **Reports** (RPT-01..04, RCP-09; ADR-0019): thirteen reports with one shape, filters kept in the URL, saved reports, every row and
  bar leading to its transactions, and PDF, CSV and Excel export. Consolidated figures use the period-end rate and say when a rate
  is missing.
- **Search** (RPT-05): from the header, across payees, descriptions, encrypted notes and receipt text, with `>500` and `tag:travel`.
- **Ask** (RPT-06): a question in plain words. The AI only works out what's being asked; the figures, the chart and the transactions
  come from SQL, and no amounts reach the provider.
- **Notifications** (NOT-01..03, TZ-04): an inbox and bell, email and push per type, quiet hours, a daily cap and a weekly digest,
  all in your time zone. Push and email carry no figures, apart from the digest's email. One-click unsubscribe (OPS-10).
- **Backup and restore** (BAK-04..06, NFR-06): a file with JSON, CSV, Excel and your documents, optionally encrypted with a password
  that isn't stored, on the web and the phone. Scheduled backups email a link. Restore previews first, then adds a new workspace or
  extra books, all or nothing.
- **Tax package** (RPT-04, UP-10): a year's reports as PDF and CSV with its receipts, per set of books.
- **Trash, storage and leaving** (BAK-06, BAK-08, BAK-09): deleted transactions and receipts come back for 30 days; a storage meter
  and a quota; deleting your account closes it at once, can be undone, and purges inside 30 days.
- **Settings** (OPS-13, AUTH-12, NFR-05, UP-06): notifications, security activity, backups and your data, and a plain page on privacy
  per AI mode. On the phone: an inbox, channel switches, back up now, security activity, delete account, and the rest to read.
- **Not done**: Drive, OneDrive, Dropbox and iCloud backups (BAK-05). SPF, DKIM and DMARC, and ageing out of infrastructure backups,
  with Phase 11. Editing profile, family and entities on the phone (OPS-13). Password changes, session revocations and support
  access in the security log (AUTH-12).

## v0.10.0-dev.1 — Phase 9: rental properties

- **Properties, units, tenants and leases** (RNT-01..03; ADR-0018): a portfolio per rental entity, with lease documents. A unit's
  occupied or vacant status follows from its leases, and overlapping leases are refused.
- **Rent roll** (RNT-04): charges written a month ahead, paid oldest first, with extra kept as a credit. A statement line naming the
  tenant, or the exact rent with nothing competing, links by itself and remembers the name it came under. This is matched in code
  rather than by AI, so tenant names stay local.
- **Arrears and late fees** (RNT-05): days late, fees from the lease's rule once per period, and waiving a charge.
- **Security deposits** (RNT-10): a liability, not income. Returned is capped at what's held; forfeited becomes income.
- **Shared expenses** (RNT-07): split by percent, units or square feet, to the cent, one off or from a saved rule.
- **Mortgages** (RNT-08): a schedule from the terms. A payment posts principal to the loan, interest to Mortgage interest and escrow
  to Taxes and Insurance, tagged to the property. A bank line for the exact amount links by itself.
- **Capital improvements** (RNT-09): large repairs flagged in code, smaller ones by AI, and the owner decides. Accepting moves the
  item to the property's improvements account and starts a 27.5 or 39 year depreciation helper, which never enters the ledger.
- **Reports** (RNT-06, RNT-11, UP-10): income, expenses, NOI, debt service, capex, cash flow, cap rate, cash on cash and occupancy
  per property and portfolio, and Schedule E with your share, as CSV or Excel. The full tax package comes in Phase 10.
- **Reminders, maintenance and budgets** (RNT-12..14): lease ends and entered dates on a list and the calendar; a maintenance log
  with photos; a budget per property with a capex reserve per unit.
- **Everywhere else**: rent and mortgage payments in the forecast and calendar; a tax set-aside for a portfolio (REC-09); your share
  of property values in net worth (FLOW-07); a property on the transaction editor (TXN-02).
- **Mobile**: More → Rentals shows the month's rent and arrears, and logs a payment.
- **Fix from Phase 8**: applying a rule or attaching a receipt only skipped payslip transactions, so one could touch an invoice or
  bill payment. They now share one check with everything else.
- **Not done**: RNT-15 and RNT-16 (could-haves). AI doesn't suggest a property for a transaction yet (AI-02).

## v0.9.0-dev.1 — Phase 8: small business

- **Businesses** (BIZ-01, BIZ-02; ADR-0017): a profile per business, a chart mapped to Schedule C, and any category mappable
  to a line. Everything is on a cash basis: invoices and bills post nothing until they're paid.
- **Customers and vendors** (BIZ-04): listed from activity, with details kept per business so a partner with no access to it
  doesn't see them. A payment linked to a customer credits them however the bank spelled the name.
- **Invoices** (BIZ-05): lines, sales tax, PDF and email, with status following the payments and date. A statement line that
  is the exact amount, or quotes the number, links by itself; anything ambiguous is offered instead. Linking keeps the
  line's date and amount, counts it once, and sends sales tax to a liability rather than income.
- **Bills** (BIZ-06): in the forecast and calendar until paid, with the document kept beside them.
- **Mileage** (BIZ-07): the IRS rate for each trip's date, including mid-year changes, on the web and the phone. It reaches
  Schedule C and never the ledger.
- **Estimated tax** (BIZ-09, REC-09): a set-aside from profit after mileage at the user's own rate, the IRS payment dates, and
  a suggestion that makes the transfer when accepted.
- **Reports** (BIZ-10, BIZ-11, BIZ-12): P&L for any dates, income by customer, expenses by vendor, a Schedule C summary, a
  revenue target on business budgets, a monthly margin note and a list of expenses missing a receipt.
- **Business or personal** (BIZ-03, AI-10): nightly flags from the user's own filing and AI, with one tap to move a
  transaction; tax line hints on transactions and proposals for categories with no line.
- **Accountants** (BIZ-13): read-only or edit access to chosen businesses, and the journal as CSV, XLSX, QuickBooks Desktop IIF
  or a Xero manual journal.
- **Mobile**: More → Business shows profit, what's owed and the tax to set aside, and logs trips.
- **Fixes from Phase 7**: deleting a payslip re-posted its deposit on the pay date instead of the statement date. The web proxy
  also dropped `Cache-Control: no-store` from private documents such as payslips; it now passes it on.
- **Not done**: BIZ-08, BIZ-14 and BIZ-15 (could-haves).

## v0.8.0-dev.1 — Phase 7: family members and payslips

- **Employers** (PAY-01): employers and other income sources per member, with pay frequency and the account the pay
  lands in.
- **Payslip capture** (PAY-02, PAY-03; ADR-0016):
  - Web: a PDF or photos, a start from the last payslip, or by hand. The payslip stays in view beside its lines, and it
    confirms only when the lines add up to the printed net pay.
  - Mobile: camera or file, then check and confirm. Amounts are corrected on the web.
  - The `extract_payslip` AI task drafts the fields. Images go to the provider only with "Allow documents" on; otherwise
    they're read in our own infrastructure and only masked text goes out. Nothing posts without confirmation.
- **Posting** (PAY-05): one balanced entry tagged to the member. Taxes and deductions go to a system category group kept
  out of budgets, retirement and health savings to an investment account, and employer contributions stay on the payslip.
- **Deposit matching** (PAY-04): the exact net pay in the employer's account within 3 days takes the imported deposit
  over, so pay counts once. Several candidates are offered to choose from. Deleting the payslip restores the deposit.
- **Budgets** (PAY-07, FAM-06, FAM-07):
  - Budget income is take-home pay, and expected income follows each employer's payslips. A missing payslip, or pay more
    than 10% under the pattern, triggers REC-04.
  - Budgets and goals can now be set up per member from the screens.
- **Reports by member** (FAM-08, FAM-09, PAY-06, PAY-08, RPT-01): income by earner, spending by member and category,
  Household as its own group, cost over time and withholding against last year. Every total drills down, and Home filters
  by member.
- **Privacy** (PAY-09): only workspace owners and the member's linked login see a payslip, enforced by RLS on the tables,
  the postings and the files. Only the net-pay line is public, so a partner's balance on a shared account stays right.
- **Also since v0.6.0-dev.1, missing from earlier entries**: a setting to allow receipt photos to go to the AI provider
  (PR #11), off by default.
- **Not done**: FAM-10 (optional education and dependent tax helpers).

## v0.7.0-dev.1 — Phase 6: budgeting, money flow and recommendations

- **Budgets** (BUD-01..10, UP-11; ADR-0015):
  - Zero-based, category-limit and light (50/30/20) methods; monthly, weekly and biweekly periods.
  - Assign, move money (with history), copy last period or the 3-period average, and rollover per category.
  - Only intent is stored. Carried-in, available and left to assign are computed by walking the periods, and
    what a category doesn't carry returns to left to assign, so money is always conserved.
  - A draft from 1–3 months of history; AI writes only the explanation.
- **Goals** (BUD-07, BUD-08): sinking funds, savings and emergency funds with projections, and snowball or
  avalanche debt payoff plans.
- **Expected income** (BUD-03): entered income matched to the deposits that fulfil it.
- **Money flow** (FLOW-01..07, UP-14): a dashboard whose numbers drill down to their transactions, a Sankey, a
  30/60/90-day forecast with low-balance warnings, spending pace, a calendar and net worth.
- **Recommendations** (REC-01..08):
  - Computed in code, stored once and applied only when the user accepts.
  - The `word_summary` AI task words them from named figures, and an answer with a number it wasn't given is
    rejected (AIA-05).
  - A nightly run per workspace in its time zone (TZ-04) also creates due scheduled transactions.
- **Read models**: `category_activity_monthly` and `account_balance_daily`, kept by statement-level triggers in the
  posting's own transaction. Account balances now come from them.
- **Web restyle**:
  - Light and dark themes, a grouped sidebar that collapses to a rail, settings sections and shared page styles.
  - The receipt stays in view beside its lines, with page turning and zoom.
- **Mobile**: a Budget tab (assign, move, copy, pace), planning cards on Home, Goals, Cash flow, Calendar and
  Suggestions. Planning reads are cached for offline viewing; budget writes need a connection. Review moves from a
  tab to Home and More.
- **Performance** (NFR-07):
  - The Home page is visible in 1.0 s at p95 with 50,000 transactions (2 s target), measured in a browser against
    a production build on a development machine.
  - A new `test:perf` budget seeds 50k transactions and holds the API work behind Home to 1.5 s.
  - Finding it took a benchmark: a partial index on deposits and balances from the read model took that API work
    from 2.2 s to 0.7 s.

## v0.6.0-dev.1 — Phase 5: receipts and multi-currency

- **Receipts, end to end** (TXN-08, IMP-11, RCP-01..08, RCP-10..12; ADR-0014):
  - **Reading.** `extract_receipt` reads lines, plain-language item names, tax (and whether the prices
    include it), discounts, fees, tip, total and card ending.
    - Images go to the model in builtin and BYOK modes. Local mode OCRs them in the doc-worker
      (`receipt.ocr`) and sends only the masked text.
  - **Categorizing items.** Item rules, then item history, then AI on the item name. Lines with the same
    category, entity and member become one split, and tax, discounts, fees and tip are allocated so the
    splits sum exactly.
  - **Matching.** Receipts are matched to transactions (±5 days, tip tolerance, merchant, ±3% across
    currencies) when created and after every import.
    - A clear match is applied automatically: the transaction is split by the receipt, and a foreign
      receipt stores the rate actually charged.
    - Unmatched receipts wait in the inbox, or can record the transaction themselves.
  - **Review.** The receipt image beside its lines; changing a line's category re-splits the transaction
    and creates an item rule.
  - **Also:**
    - receipt recommended for big purchases at multi-department stores;
    - Amazon order-history import;
    - 7-year retention and search over receipt text;
    - trips (travel mode);
    - the receipt's local time on the transaction.
- **Multi-currency** (ACC-04, CUR-03..09; ADR-0010):
  - **Rates.** An FX rates service loads ECB daily and historical rates, plus Open Exchange Rates with
    `OXR_APP_ID`, through a self-rescheduling daily job. Lookups cover direct, inverse and cross rates, with
    a 7-day weekend lookback.
  - **Foreign-currency accounts.**
    - Opening balances post at the day's rate.
    - Spending and transfers out are valued at the average carrying cost, with realized FX gain or loss;
      an emptied account is at exactly 0.
    - A rate override is available on any transaction.
  - **Foreign spending on home-currency cards** records the original amount, the rate and the foreign
    transaction fee (posted to Bank fees).
  - **Transfers between currencies** record both amounts; the gap is FX gain or loss.
  - **Domain helpers:** `valueAtCarrying`, `unrealizedFx`, a period-close `fx_revaluation` entry and
    `transferFxCost`.
- **Web:**
  - Receipts page (upload, inbox, search, recommendations, order import) and the review screen.
  - Trips page.
  - On transactions: an FX panel (original amount, rate and source, override, "Paid in another
    currency?") and "Add a receipt".
  - Transfers ask for the amount received across currencies.
- **Mobile** (`expo-camera`, ADR-0009 amended):
  - Receipt capture with several photos per receipt and a blur/glare check with retake after each shot,
    or a photo or PDF from Files.
  - An offline upload queue that resumes interrupted uploads (TXN-09).
  - The receipts list and review.
- **Platform:**
  - Migrations 0012 (receipts, trips, currencies, FX rates), 0013 (system jobs) and 0014 (receipt API
    additions).
  - Local setup works on Windows checkouts (LF line endings, storage keys, cross-platform scripts) and
    alongside other stacks (configurable Compose ports).
- **Exit criteria:**
  - The requirements' Walmart receipt splits into exactly Groceries 5.10, Electronics 13.91,
    Clothing 9.70 = 28.71. This is checked by a domain test, an API test and an e2e test through the UI.
  - A €40.00 receipt matches its $43.60 statement line within ±3%, with the rate 1.09 stored. This is
    checked by API and e2e tests.

## v0.5.0-dev.1 — Phase 4: mobile foundation and offline sync (on feature branch)

- **Offline sync** (ADR-0013):
  - `GET /sync/pull`: a bootstrap and incremental pulls of resolved rows, re-read under RLS, with removals.
  - `POST /sync/push`: an idempotent outbox. Creates keep their client ids.
  - Field-group last-write-wins: the ledger group is atomic, and payee, date, memo, tags and review are
    independent. Conflict notices go back to the device, and rejected ops become drafts.
  - Migration 0011 adds the field-group clocks, the op replay log and push devices.
- **`@montra/sync`:** a platform-neutral engine (bootstrap, pull, optimistic outbox with coalescing and
  backoff, conflicts, drafts, wipe), plus `MemoryStore` and `FetchTransport`. It is tested against a fake
  server and, in a two-device test, against the real API.
- **`apps/mobile`** (Expo SDK 58):
  - Dev and Kratos sign-in; biometric app lock with a timeout and an app-switcher blur.
  - A SQLCipher-encrypted store with its key in the Keychain/Keystore, wiped on sign-out.
  - Screens: home, transactions with swipe actions, a 3-tap quick add, a swipe review stack, accounts and
    registers.
  - Import from Files, the share sheet or camera pages, with a guided column mapping.
  - Push-token registration, a sync activity screen, the camera spike harness, EAS profiles, a mobile CI
    workflow and Maestro flows.
- **Push devices:** `POST/GET/DELETE /v1/me/push-devices`.

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
