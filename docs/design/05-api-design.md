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
| `GET /review-queue`, `POST /review-queue/accept` (`{ ids }` or `{ minConfidence }`) | Review queue | AI-03/04 |
| `GET/POST /recurring`, `PATCH /recurring/{id}`, `POST /recurring/{id}/confirm-occurrence` | Recurring templates and detection proposals | TXN-05, AI-08 |
| `GET/POST /rules`, `PATCH/DELETE /rules/{id}`, `POST /rules/{id}/apply-existing` (202) | Rules | UP-02, AI-05 |
| `GET /rule-suggestions`, `POST /rule-suggestions/{id}/accept` | Rules suggested from corrections | AI-05 |
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
| `POST /receipts` `{ uploadIds[] }` (202), `GET /receipts?status=inbox`, `GET /receipts/{id}`, `PATCH /receipts/{id}` (lines), `POST /receipts/{id}/match` | Receipt pipeline and inbox | TXN-08, IMP-11, RCP |
| `GET /attachments/{id}/url` | Short-lived presigned GET | RCP-10 |

### Planning

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET/POST /budgets`, `GET /budgets/{id}/periods/{start}` | Budget with lines, available, left to assign | BUD-01..06 |
| `PUT /budgets/{id}/periods/{start}/lines/{categoryId}` | Assign | BUD |
| `POST /budgets/{id}/periods/{start}/moves` | Move money between categories | BUD-10 |
| `POST /budgets/{id}/periods/{start}/copy` `{ from: "last" | "avg3" }` | Copy | BUD-09 |
| `POST /budgets/draft` (202) | AI-drafted first budget | BUD-02 |
| `GET/POST /goals`, `PATCH /goals/{id}` | Goals and sinking funds | BUD-07/08 |
| `GET /dashboard?entityId&memberId` | Home numbers (one round trip) | FLOW-01, FAM-09 |
| `GET /flow/sankey?from&to&entityId` | Sankey nodes and links with drill-down filters | FLOW-02 |
| `GET /flow/forecast?days=90` | Daily balances per account + warnings | FLOW-03 |
| `GET /calendar?from&to` | Bills and paydays | FLOW-05 |
| `GET /recommendations`, `POST /recommendations/{id}/accept|dismiss`, `PATCH` (edit) | Recommendations | REC |

### Business, rental, payroll

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET/POST /invoices`, `POST /invoices/{id}/send`, `GET /invoices/{id}/pdf` | Invoices | BIZ-05 |
| `GET/POST /bills`, `GET/POST /mileage-trips` | Bills, mileage | BIZ-06/07 |
| `GET /tax/estimates?entityId&year` | Quarterly estimate | BIZ-09 |
| `GET/POST /properties`, `/properties/{id}/units`, `/tenants`, `/leases` | Rental master data | RNT-01..03 |
| `GET /rent-roll?month`, `GET /arrears` | Rent roll and arrears | RNT-04/05 |
| `GET/POST /allocation-rules`, `POST /transactions/{id}/allocate` | Shared expense allocation | RNT-07 |
| `GET/POST /loans/{accountId}/schedule` | Amortization | RNT-08 |
| `GET/POST /maintenance` | Maintenance log | RNT-13 |
| `GET/POST /employers`, `GET/POST /payslips`, `POST /payslips/extract` (202) | Payslips | PAY-01..08 |

### Reports, search, export, notifications

| Method & path | Purpose | Req |
| --- | --- | --- |
| `GET /reports/{type}` (`spending`, `income-expense`, `budget-actual`, `cash-flow`, `net-worth`, `pnl`, `schedule-c`, `schedule-e`, `general-ledger`, `trial-balance`, `balance-sheet`, `by-member`, `payslip-summary`, `property`, `items`) | JSON report with drill-down filters | RPT-01..03 |
| `POST /reports/{type}/export` `{ format: pdf|csv|xlsx }` (202) | Export | RPT-04 |
| `GET/POST /saved-reports` | Saved custom reports | RPT-02 |
| `POST /tax-package` `{ entityId, year }` (202) | ZIP of reports + receipts | RPT-04, UP-10 |
| `POST /ask` | Ask-your-data (number + chart spec + transaction ids) | RPT-06 |
| `POST /exports` (re-auth, 202) / `POST /backups`, `POST /restores` (preview → confirm) | Full export, backup, restore | NFR-06, BAK-04/06 |
| `GET /trash`, `POST /trash/{id}/restore` | Trash bin | BAK-06 |
| `GET /notifications`, `PATCH /notification-prefs` | Notifications, quiet hours, caps | NOT-01..03 |
| `GET /ai-events`, `DELETE /ai-events` | AI audit log | AIA-10 |
| `POST /support-grants`, `DELETE /support-grants/{id}` | Support access | OPS-02 |

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
