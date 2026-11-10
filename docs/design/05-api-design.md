# 05 — API Design

One versioned REST API (`/v1`) serves web, mobile and (later) partners. It is described
by OpenAPI 3.1, generated from the Zod schemas in `packages/schemas`. Real-time updates
use a WebSocket channel.

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Base path | `/v1/workspaces/{workspaceId}/…` for all tenant resources; `/v1/me`, `/v1/auth/*` for user-level ones |
| Format | JSON, `camelCase`, UTF-8. Ids are UUIDv7 strings. |
| Money | `{ "amount": "-4210", "currency": "USD" }`: **minor units as a string** (bigint-safe). Clients format with `packages/domain`. |
| Dates | Business dates `"2026-10-29"`; timestamps RFC 3339 UTC `"2026-10-29T14:03:11Z"`. |
| Pagination | Cursor based: `?limit=50&cursor=…` → `{ data: [...], nextCursor }`. Stable sort keys (`txnDate desc, id desc`). |
| Filtering | Query params per resource (`entityId`, `accountId`, `categoryId`, `memberId`, `propertyId`, `from`, `to`, `q`, `minAmount`, `maxAmount`, `reviewState`, `tag`). The same filter object powers reports (RPT-02). |
| Concurrency | Responses carry `ETag: "v{version}"`; mutating requests on existing resources must send `If-Match`. A mismatch returns `412`. |
| Idempotency | `Idempotency-Key` header on every `POST`. Keys are stored for 24 h per workspace; a replay returns the stored response. |
| Errors | RFC 9457 `application/problem+json`: `{ type, title, status, detail, code, errors?: [{ path, message }] }`. Stable `code`s such as `ledger.unbalanced`, `period.locked`, `import.mapping_required`. |
| Async | Slow operations return `202 Accepted` + `Location: /v1/workspaces/{id}/jobs/{jobId}`. |
| Auth | Bearer session token (mobile) or HttpOnly cookie through the web BFF. Re-auth (AUTH-09) is enforced by `X-Reauth-Token` from a fresh Kratos privileged session. |
| Rate limits | Per user and per IP with a Redis token bucket; `429` with `Retry-After`. |
| Versioning | Additive changes within `v1`. Breaking changes go to `/v2`. Mobile sends `X-App-Version`; versions below the minimum get `426` with update info (OPS-04). |

## 2. Resources (R1)

Paths are relative to `/v1/workspaces/{wid}` unless they start with `/v1`.

### Identity, workspace, settings

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET /v1/me`, `PATCH /v1/me` | Profile, locale, time zone, formats | TZ-01, CUR-10 |
| `GET /v1/me/sessions`, `DELETE /v1/me/sessions/{id}` | Device list, remote sign-out | AUTH-07 |
| `GET /v1/me/security-activity` | Security log | AUTH-12 |
| `POST /v1/workspaces`, `GET /v1/workspaces` | Create (with an onboarding template: household/freelancer/landlord) and list | UP-03 |
| `GET/PATCH /` | Workspace settings (base currency, time zone, AI mode, priorities, thresholds) | OPS-13 |
| `GET /sharing/members`, `PATCH/DELETE /sharing/members/{userId}`, `POST /sharing/invites`, `POST /v1/invites/{token}/accept` | Sharing and roles (app users) | UP-04, AUTH-10 |
| `GET/POST /entities`, `PATCH /entities/{id}` | Entities | ACC-01, BIZ-01 |

### Ledger and accounts

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET/POST /accounts`, `GET/PATCH /accounts/{id}`, `POST /accounts/{id}/archive` | Bank/card/loan/asset accounts | ACC-02..06 |
| `POST /accounts/{id}/balance-adjustments` | Audited adjustment | ACC-05 |
| `GET /accounts/{id}/register?view=ledger|simple` | Date, description, debit, credit, running balance | DE-06 |
| `GET/POST /loans`, `PATCH /loans/{id}`, `GET /loans/{id}/schedule`, `POST /loans/{id}/payments`, `DELETE /loans/{id}/payments/{number}` | Tracked loans on any account, from the real balance ([ADR-0024](adr/0024-loan-tracking.md)) | RNT-08, ACC-02 |
| `GET/POST /accounts/{id}/valuations`, `DELETE /accounts/{id}/valuations/{id}` (latest only), `GET /accounts/{id}/performance?range=` | Statement values and gain over time ([ADR-0025](adr/0025-retirement-and-gains.md)) | ACC-07 |
| `GET /accounts/{id}/interest-earned` | Interest paid into a savings account this year ([ADR-0027](adr/0027-remaining-account-types.md)) | ACC-02 |
| `GET /accounts/{id}/statement`, `GET /card-statements` | A card or line of credit's latest statement, what's due and the planned payment ([ADR-0026](adr/0026-card-statements.md)) | ACC-02, FLOW-03 |
| `GET /accounts/{id}/balance-history?range=3m|6m|1y|all` | Natural balance over time, for the account's chart ([ADR-0023](adr/0023-account-type-profiles.md)) | ACC-02 |
| `GET/POST /categories`, `PATCH /categories/{id}`, `GET/POST /category-groups` | Category ledger accounts and groups | DE-02, BUD-04 |
| `GET /ledger-accounts` | Full chart of accounts | DE-02 |
| `GET /journal-entries/{id}`, `POST /journal-entries` | Journal view; manual journals (accountant/advanced) | DE-07 |
| `POST /accounts/{id}/reconciliations`, `GET /reconciliations/{id}`, `POST /reconciliations/{id}/cleared` `{clear[], unclear[]}`, `POST /reconciliations/{id}/complete` | Statement reconciliation; completion requires a zero difference, then marks the lines reconciled and locks their entries | DE-08 |
| `POST /entities/{id}/period-locks`, `POST /locked-entries/{id}/unlock` (re-auth + note) | Period close and audited unlock | DE-09/10 |
| `GET /trial-balance?entityId&asOf` | Trial balance | RPT-01 |

### Transactions and capture

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET /transactions` | Search and filter (RPT-05 syntax: `q=coffee >20 tag:travel`) | TXN, RPT-05 |
| `POST /transactions` | Create: `{ date, accountId, payee, amount, splits[], memo, tags, attachments[] }` | TXN-01..03 |
| `POST /transactions/transfer` | Transfer between accounts (including FX) | TXN-04, CUR-08 |
| `PATCH /transactions/{id}`, `DELETE /transactions/{id}` | Edit (with automatic reversal when locked), delete to trash | DE-10, BAK-06 |
| `POST /transactions/bulk` | Bulk edit category, entity, tags, member | TXN-10 |
| `POST /transactions/parse` | Natural-language quick add → prefilled draft | TXN-06 |
| `GET /review`, `POST /review/accept` (`{ transactionIds }` or `{ minConfidence }`), `POST /review/{transactionId}/resolve` | Review queue; resolve = a correction (returns any rule offered) | AI-03/04/05 |
| `GET/POST /recurring`, `PATCH /recurring/{id}`, `POST /recurring/{id}/confirm-occurrence` | Recurring templates and detection proposals | TXN-05, AI-08 |
| `GET/POST /rules`, `PATCH/DELETE /rules/{id}`, `POST /rules/preview`, `POST /rules/{id}/preview`, `POST /rules/{id}/apply` (202, job) | Rules with live preview and apply to existing | UP-02, AI-05 |
| `GET /rule-suggestions`, `POST /rule-suggestions/{id}/accept` (`{ applyToExisting }`), `POST /rule-suggestions/{id}/dismiss` | Rules suggested from corrections | AI-05 |
| `GET/PATCH /ai/settings`, `POST /ai/settings/test`, `GET /ai/events`, `DELETE /ai/events[/{id}]`, `GET /ai/tasks`, `POST /ai/tasks/{id}/result` | AI mode, provider, key, threshold, budget; audit log; local-mode tasks | UP-13, AIA-08/10 |
| `POST /categorize/suggest`, `POST /transactions/parse` | Editor suggestion; natural-language quick add | AI-01, TXN-06 |
| `GET /imports/{id}/category-proposals`, `POST /imports/{id}/category-proposals/accept` | Categories proposed from the first import | UP-03 |
| `GET /insights?status=`, `POST /insights/{id}/accept`, `POST /insights/{id}/dismiss`, `POST /insights/detect` | Recurring proposals and anomaly flags | AI-08/09 |
| `GET/POST /payees`, `PATCH /payees/{id}`, `POST /payees/{id}/merge` | Payee directory (customers/vendors) | IMP-10, BIZ-04 |
| `GET/POST /family-members`, `PATCH /family-members/{id}` | Family members (profiles, not logins) | FAM-01..11 |

### Files, imports, receipts

| Method & path | Purpose | Req |
| --- | --- | --- |
| `POST /uploads` (multipart, field `file`) → `{ fileId, fileType, sha256, duplicateOf }` | Upload of up to 25 MB, type checked by magic bytes and content-hashed; `duplicateOf` flags a re-upload. Presigned direct-to-S3 uploads are added for mobile (Phase 4) | IMP-01/02 |
| `POST /imports` `{ fileId, accountId, accountFilter? }` (202), `GET /imports?accountId` | Start an import batch (parsing runs in the worker; XLS and PDF go through the doc worker first); history | IMP-01, IMP-13 |
| `GET /imports/{id}` | Status, counts, balance check | IMP-08 |
| `GET /imports/{id}/rows?status=` | Preview rows with suggestions | IMP-06 |
| `PUT /imports/{id}/mapping` | Confirm or edit the column mapping (saves the profile) | IMP-03/04 |
| `PATCH /imports/{id}/rows/{rowId}` | Change one preview row (category, skip, not-duplicate) | IMP-06 |
| `POST /imports/{id}/commit`, `POST /imports/{id}/undo` (202) | Commit atomically, undo within 30 days (the result lists kept rows) | IMP-08/09 |
| `GET /jobs/{id}` | Job status, progress and result (commit/undo summaries) | — |
| `POST /receipts/files` (multipart photo or PDF) → `fileId`; `POST /receipts` `{ fileIds[], source, transactionId?, entityId?, id? }` (201, extraction runs as a job); `GET /receipts?status&q&from&to&cursor`; `GET /receipts/{id}`; `GET /receipts/{id}/files/{fileId}`; `PATCH /receipts/{id}` (header and lines, `version`); `POST /receipts/{id}/apply` `{ transactionId \| createTransaction, version }`; `POST /receipts/{id}/match`; `POST /receipts/{id}/reject`; `DELETE /receipts/{id}` | Receipt pipeline, inbox, review, search | TXN-08, IMP-11, RCP-01..08, RCP-10 |
| `GET /receipts/recommended`, `POST /receipts/recommended/{transactionId}/dismiss` | Spending worth a receipt with none: multi-department stores above 50, business spending above its threshold, everyday spending above the planning settings' `receiptReminderMinor` (off unless set); each with its `reason` | RCP-11, UP-09 |
| `GET /receipts/habit` | This week's receipts kept and missing, the streak of weeks with none missing, and the latest three waiting | UP-09 |
| `POST /receipts/order-history` (multipart CSV) | Amazon order history, one receipt per order | RCP-12 |
| `GET /trips`, `POST /trips`, `PATCH /trips/{id}`, `DELETE /trips/{id}` | Travel mode | CUR-09 |
| `GET /fx/rates?base&quote&date` | Reference rate (direct, inverse, cross; 7-day lookback) | CUR-05 |
| `GET /attachments/{id}/url` | Short-lived presigned GET | RCP-10 |

### Planning

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET/POST /budgets`, `PATCH /budgets/{id}`, `GET /budgets/{id}/periods/{start|current}`, `PATCH …/periods/{start}` (income override) | Budget with lines, available, left to assign; every write sends the budget `version` (409 when stale) | BUD-01..06 |
| `PUT /budgets/{id}/periods/{start}/lines/{categoryId}` | Assign (and rollover mode) | BUD-06 |
| `GET/POST /budgets/{id}/periods/{start}/moves` | Move money between categories; history | BUD-10 |
| `POST /budgets/{id}/periods/{start}/copy` `{ from: "last" \| "avg3", overwrite }` | Copy | BUD-09 |
| `POST /budgets/draft` (200) | Draft from 1–3 months of history; AI writes only the explanation; nothing is saved | BUD-02 |
| `GET/POST /goals`, `GET/PATCH /goals/{id}` | Goals, sinking funds (own category), debt payoff simulation | BUD-07/08, FAM-07 |
| `GET/POST /expected-income`, `PATCH /expected-income/{id}` | Expected take-home income, matched to deposits | BUD-03 |
| `GET /dashboard?entityId&memberId` | Home numbers (one round trip), each with a transactions `drill` filter | FLOW-01, FAM-09 |
| `GET /dashboard/charts?months&entityId&memberId` | Home charts for 3, 6, 12 or 24 months: income, spending and net worth per month, the budget so far (paced categories against the pro-rata budget, bills when over), this month's top 5 spending, and last month's 5 biggest changes from the 3 before | FLOW-01, FAM-09 |
| `GET /flow/sankey?from&to&entityId` | Sankey nodes and links with drill-down filters | FLOW-02, FLOW-06 |
| `GET /flow/forecast?days=7..90&entityId` | Daily balances per cash/card account, items, low-balance warnings | FLOW-03 |
| `GET /calendar?from&to&entityId` | Bills, paydays and goal due dates | FLOW-05, UP-14 |
| `GET /net-worth?date&months&entityId` | Assets, liabilities, per-account values in the base currency, monthly trend | FLOW-07 |
| `GET /recommendations?entityId&status`, `POST /recommendations/refresh`, `POST /recommendations/{id}/accept` (optionally edited actions) `\|dismiss` | Recommendations | REC-01..08 |
| `GET/PATCH /planning/settings` | Category priorities and the high-interest threshold for the rules | REC-01/03 |
| `GET /transactions?entityId&memberId&categoryIds&accountIds&from&to` | Drill-down: transactions behind a dashboard number | FLOW-01/02 |

### Business, rental, payroll

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET /businesses`, `GET/PATCH /businesses/{entityId}`, `POST /businesses/files` | Business profile, documents | BIZ-01, BIZ-12 |
| `GET /parties?entityId&kind`, `POST /parties`, `PATCH /parties/{id}` | Customers and vendors; rows with a null `id` come from activity | BIZ-04 |
| `GET/POST /invoices`, `GET/PATCH/DELETE /invoices/{id}`, `POST /invoices/{id}/send`, `POST /invoices/{id}/void`, `GET /invoices/{id}/pdf`, `GET /invoices/{id}/candidates`, `POST /invoices/{id}/payments` `{ transactionId \| accountId, date, amount }`, `DELETE /invoices/{id}/payments/{paymentId}` | Invoices and their payments (ADR-0017) | BIZ-05 |
| `GET/POST /bills`, `GET/PATCH /bills/{id}`, `GET /bills/{id}/candidates`, `POST/DELETE /bills/{id}/payment`, `GET /bills/{id}/files/{fileId}` | Bills | BIZ-06 |
| `GET/POST /mileage-trips`, `PATCH/DELETE /mileage-trips/{id}` | Mileage; the rate is set by the trip's date | BIZ-07 |
| `GET /tax/estimates?entityId&year`, `GET /tax/lines?form`, `PATCH /categories/{id}/tax-line`, `POST /businesses/{entityId}/tax-lines/suggest` | Estimated tax, tax lines and AI proposals | BIZ-02, BIZ-09, AI-10 |
| `GET /reports/pnl`, `/reports/parties`, `/reports/schedule-c`, `/reports/missing-receipts` | P&L, by customer or vendor, Schedule C, missing receipts | BIZ-10, BIZ-12 |
| `GET /exports/accounting?entityId&from&to&format` (`csv`, `xlsx`, `quickbooks_iif`, `xero_csv`; recent sign-in required) | Journal for an accountant | BIZ-13 |
| `GET/POST /properties`, `GET/PATCH /properties/{id}`, `POST /properties/{id}/units`, `PATCH /units/{id}`, `GET/POST /tenants`, `PATCH /tenants/{id}`, `GET/POST /leases`, `GET/PATCH /leases/{id}` | Rental master data; a lease writes its charges | RNT-01..03 |
| `GET /rent-roll?entityId&month`, `GET /arrears?entityId`, `PATCH /rent-charges/{id}` (edit or waive) | Rent roll and arrears | RNT-04/05 |
| `GET/POST /leases/{id}/payments`, `DELETE /leases/{id}/payments/{paymentId}`, `GET /leases/{id}/candidates` | Rent received: entered, or a bank line taken over and given back on removal | RNT-04 |
| `POST /leases/{id}/deposit-events`, `DELETE /leases/{id}/deposit-events/{eventId}` | Security deposit received, returned or forfeited | RNT-10 |
| `GET/POST /allocation-rules`, `DELETE /allocation-rules/{id}`, `POST /transactions/{id}/allocate` | Shared expense allocation | RNT-07 |
| `GET/POST /loans`, `PATCH /loans/{id}`, `GET /loans/{id}/schedule`, `POST /loans/{id}/payments`, `DELETE /loans/{id}/payments/{number}` | Amortization and split payments | RNT-08 |
| `GET /properties/{id}/depreciation?year`, `POST /depreciation`, `DELETE /depreciation/{id}` | Depreciation helper; never posted | RNT-09 |
| `GET/POST /reminders`, `PATCH /reminders/{id}` | Stored reminders, plus lease ends worked out on read | RNT-12 |
| `GET/POST /maintenance`, `PATCH /maintenance/{id}`, `POST /rentals/files`, `GET /rentals/{leases\|maintenance}/{id}/files/{fileId}` | Maintenance log; a file is served only through a record it's on | RNT-03, RNT-13 |
| `GET/PUT /properties/{id}/budget?month` | Expected rent, planned expenses, capex reserve, actuals | RNT-14 |
| `GET /reports/rental?entityId&from&to`, `GET /reports/schedule-e?entityId&year`, `GET /exports/schedule-e?entityId&year&format` (`csv`, `xlsx`; recent sign-in required) | Metrics and Schedule E per property and portfolio | RNT-06, RNT-11, UP-10 |
| `GET/POST /employers`, `PATCH /employers/{id}`; `POST /payslips/files` (multipart PDF or photo) → `fileId`; `POST /payslips` `{ employerId, fileIds[], fromLast, payDate? }` (201, reading runs as a job); `GET /payslips?memberId&employerId&status`; `GET/PATCH/DELETE /payslips/{id}`; `GET /payslips/{id}/files/{fileId}`; `POST /payslips/{id}/confirm` `{ version, depositTransactionId? }` | Payslips; a confirm comes back unposted with `matchCandidates` when several deposits fit (ADR-0016) | PAY-01..09 |

### Reports, search, export, notifications

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET /reports/catalog/{type}` (`spending`, `income-expense`, `budget-actual`, `cash-flow`, `net-worth`, `pnl`, `schedule-c`, `schedule-e`, `general-ledger`, `trial-balance`, `balance-sheet`, `by-member`, `items`) | One report shape: columns, rows with a drill, totals, chart | RPT-01..03, RCP-09 |
| `GET /reports/catalog/{type}/export?format=pdf\|csv\|xlsx` (re-auth) | The same report as a file | RPT-04 |
| `GET/POST /saved-reports`, `DELETE /saved-reports/{id}` | Saved custom reports, per person | RPT-02 |
| `GET /search?q=` | Transactions, payees, receipts. Syntax: words, `"phrases"`, `>500`, `tag:travel` | RPT-05 |
| `POST /ask` | A question: the plan comes from AI, the figures and transactions from SQL | RPT-06 |
| `POST /backups` (re-auth), `GET /backups`, `GET /backups/{id}`, `GET /backups/{id}/download` | Backup, optionally with a password; kept 7 days | NFR-06, BAK-04 |
| `POST /tax-package` `{ entityId, year }` (re-auth) | ZIP of reports + receipts, listed with the backups | RPT-04, UP-10 |
| `GET/PUT/DELETE /backup-schedule` | Weekly or monthly, by emailed link | BAK-05 |
| `POST /v1/me/restores` (multipart, re-auth), `GET /v1/me/restores`, `GET /v1/me/restores/{id}`, `POST /v1/me/restores/{id}/confirm` | Preview, then restore into a new workspace or as added books | BAK-06 |
| `GET /trash`, `POST /trash/{kind}/{id}/restore` | Trash bin | BAK-06 |
| `GET /storage` | Usage against the quota | BAK-08 |
| `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/{id}/read`, `POST /notifications/read-all` | Inbox | NOT-01 |
| `GET/PATCH /v1/me/notification-prefs` | Channels per type, quiet hours, cap, digest day, thresholds | NOT-01..03 |
| `POST /v1/unsubscribe?token=` (no session) | One-click unsubscribe | OPS-10 |
| `GET /v1/me/security-activity` | Security log | AUTH-12 |
| `GET/POST/DELETE /v1/me/deletion` | Delete the account, or cancel within the window. While it's closing, only this and reading `/v1/me` work (403 `account.deleting`) | NFR-06, BAK-09 |
| `deposits` on `POST/PATCH /employers` and on `PATCH /payslips/{id}` before posting; `otherDeposits` on `POST /payslips/{id}/confirm` | Splitting pay across accounts ([ADR-0022](adr/0022-splitting-pay.md)) | PAY-01, PAY-04 |
| `GET /ai-events`, `DELETE /ai-events` | AI audit log | AIA-10 |
| `GET/POST /support-grants`, `DELETE /support-grants/{id}` | Support access: owner only, read-only, 72 h by default | OPS-02 |
| `GET /billing`, `POST /billing/checkout` `{ interval }`, `POST /billing/portal` | Plan, flags and links to pay; 402 `plan.required` when adding books | UP-12, OPS-08 |
| `POST /v1/billing/stripe/webhook` (signed) | Provider events, each handled once | OPS-08 |
| `GET /v1/status` (no session) | Status and notices | OPS-03 |
| `POST /v1/support/requests`, `GET /v1/support/requests`, `POST /v1/client-errors` | Help and error reports | OPS-09, NFR-13 |
| `/v1/admin/*` (staff, 404 for anyone else) | Accounts, plans, flags, notices, app versions, analytics, requests, reference data, support view | OPS-01, OPS-02, OPS-05 |
| `GET /internal/metrics` (bearer token, 404 without) | Prometheus metrics | NFR-13, OPS-07 |

## 3. Sync and real-time (PLT-05, PLT-06)

- **Push**: clients open `wss://api/v1/ws` and send
  `{ type: "subscribe", workspaceId }`. The server sends
  `{ type: "changes", workspaceId, seq, tables: ["transaction","posting"] }` after each
  commit, plus `job.updated` and `notification` events.
- **Pull**: `GET /sync/changes?since={seq}&limit=500` returns
  `{ changes: [{ seq, table, id, op, row? }], latestSeq }`. Web uses it only to
  invalidate TanStack Query keys. Mobile applies the rows to its local SQLite store for
  the tables it keeps offline. The feed applies the same entity grants and payslip
  restriction as RLS (through `change_log.entity_id/restricted`), so a partner never
  receives rows of an entity they can't see. Rows are re-read under RLS before they are
  returned (accounts, categories, members, payees, recent
  transactions with splits, budgets for the current and previous period, rules).
- **Offline writes** (mobile): an outbox of mutations. Creates use the client-generated
  UUID as the resource id, so a replay days later is still idempotent
  (`ON CONFLICT (workspace_id, id) DO NOTHING` and return the existing row). On replay,
  `PATCH` requests carry `baseVersion` and `changedFields`. The server applies
  **field-level last-write-wins** over *field groups*: `{amount, currency, account,
  splits}` is one atomic group (so the result always balances), and payee, date, memo,
  tags and review state are separate groups. Groups not changed on the server since
  `baseVersion` are applied; conflicting groups are applied if the client's `changedAt`
  is newer, and the response lists the `conflicts[]` the client shows in a notice. A
  merged result that fails validation (for example, a period locked since) is rejected
  with a problem response, and the outbox item is kept as a draft for the user.

## 4. Schema-first contract

```ts
// packages/schemas/src/transactions.ts (illustrative)
export const MoneyDto = z.object({ amount: z.string().regex(/^-?\d+$/), currency: CurrencyCode });
export const SplitInput = z.object({
  categoryId: z.string().uuid(), amount: MoneyDto,
  entityId: z.string().uuid().optional(), memberId: z.string().uuid().nullable().optional(),
  propertyId: z.string().uuid().optional(), unitId: z.string().uuid().optional(), memo: z.string().max(500).optional(),
});
export const CreateTransaction = z.object({
  date: CalendarDateDto, accountId: z.string().uuid(), payee: z.string().max(200),
  amount: MoneyDto, splits: z.array(SplitInput).min(1).max(250).optional(),
  memo: z.string().max(2000).optional(), tags: z.array(z.string()).max(20).optional(),
});
```

NestJS controllers validate with these schemas (a `ZodValidationPipe`). The OpenAPI
document is generated from the same schemas and published at `/v1/openapi.json`.
`packages/api-client` exposes typed functions on top of them.
