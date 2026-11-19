# ADR-0055: Bank feeds per workspace, starting with SimpleFIN Bridge

- Status: proposed (draft for the owner; nothing built)
- Date: 2026-11-19
- Builds on: ADR-0051 (intakes, signals and match memory), ADR-0028 (transfers), ADR-0024 (loan payments), ADR-0031
  and ADR-0050 (sealed per-workspace secrets, the address guard, the outbox job shape), ADR-0054 (an owner-connected
  outside service: recent sign-in, audit, an attention notification, backoff), ADR-0049 (plan feature keys)
- Requirements: IMP-07, IMP-08, IMP-09, IMP-12, NFR-03, NFR-04, TZ-02; R1 §14.1 (bank connection readiness); adds
  FEED-01..10 (§13)

## Context

Every transaction that reaches Montra from a bank today arrives as a file someone downloads and uploads: CSV, XLS,
XLSX, OFX/QFX, QIF, PDF or a photo, through an account's Import or the Statements screen (ADR-0051). The pipeline
behind that is complete: preview, exact and probable duplicates, matching manual and scheduled entries within ±3 days,
the other side of transfers (ADR-0028), loan payments (ADR-0024), categorization, the balance check, Undo and Discard.

The owner asked for automatic feeds from banks and other institutions, set up **per workspace**, starting with
**SimpleFIN Bridge**, with better options named for later. R1 §14.1 already planned for this: import batches carry a
source, dedupe must handle feed-and-file overlap, and any account can stay on files only.

SimpleFIN Bridge suits Montra as a first provider:

- **The person holds the bank connection, not Montra.** They sign up at the Bridge, connect their institutions there,
  and give Montra a one-time **setup token**. Montra holds no aggregator contract, no per-connection fee and no
  bank credentials, and a self-hosted install works the same way.
- **The protocol is small and public**: one claim call and one read endpoint.
- **It is cheap for the person**, and they can revoke Montra at the Bridge at any time.

Its limits shape the design: it is meant for **daily** updates, it covers mostly US institutions, coverage and history
vary by institution, and it gives no account numbers.

### SimpleFIN facts this ADR relies on (checked 2026-11-19 against simplefin.org)

Confirmed from the protocol page (`simplefin.org/protocol.html`, now "2.0.0-draft", changelog v2.0.0 dated 2026-03-19)
and the Bridge's developer guide (`beta-bridge.simplefin.org/info/developers`):

- **Setup token → claim → access URL.** The setup token is a Base64-encoded claim URL. The app sends one `POST` to it
  and gets back the **access URL**, `https://<user>:<password>@<host>/simplefin`. A token claims once; a `403` means
  it doesn't exist or was already claimed, and the protocol tells apps to warn the person that it may be compromised.
- **`GET {access URL}/accounts`** with HTTP Basic credentials, and `version=2`. Parameters: `start-date` (Unix epoch,
  on or after), `end-date` (epoch, before but **not on**), `pending=1` (include pending "if supported"; off by
  default), `account` (an account id, repeatable), `balances-only=1` (no transactions).
- **Response (v2).** `accounts[]`: `id`, `name`, `conn_id`, `currency` (ISO 4217 or a custom currency URL),
  `balance` and optional `available-balance` (numeric strings), `balance-date` (epoch), `transactions[]` ordered by
  `posted`, `extra`. `connections[]` (replacing v1's `org`): `conn_id`, `name`, `org_id`, `org_url`, `sfin_url`.
  Transactions: `id`, `posted` (epoch; may be `0` while pending), `amount` (numeric string, positive is money in),
  `description`, optional `transacted_at`, `pending` (default false), `extra`.
- **Errors.** v2 has `errlist[]`: `code` (`gen.*`, `con.*` such as `con.auth`, `act.*` such as `act.failed`,
  `act.missingdata`), `msg` meant for people, optional `conn_id`/`account_id`. The older `errors[]` of strings is
  deprecated but the Bridge still uses it for quota warnings. `/accounts` answers `200`, `402` (payment required) or
  `403` (access revoked or wrong credentials). Apps must sanitize messages before showing them, and should show them.
- **Ids.** A transaction id is never reused within an account; an account id is unique within its connection.
- **Limits.** "24 requests or fewer per day", with separate quotas for all-accounts and single-account requests,
  replenished through the day, a little leeway for setup, warnings past the limit and then **the access token is
  disabled**. A request's `start-date`..`end-date` may span at most **90 days**. The Bridge suggests a random minute
  for scheduled fetches and overlapping windows by about 5 days.
- **Price.** The Bridge's home page (seen through search, not opened directly) shows US$1.50 a month or US$15 a year
  plus tax, for up to 25 institutions and 25 apps. Paid by the person to SimpleFIN, not by Montra.

**Not confirmed** (to check in the live run, §12): how far back each institution's history goes ("varies for each
institution"); how often the Bridge itself refreshes from banks (only "daily updates"); whether a pending transaction
keeps its id once posted; which time zone `posted` is meant in; the access URL's host name (the demo uses
`beta-bridge.simplefin.org`, sign-up is on `bridge.simplefin.org`); `payee` and `memo` on transactions, which the
current protocol page doesn't list; whether the Bridge offers an API to revoke an access URL (the protocol defines
none, so revoking is done by the person at the Bridge).

## Decision

### 1. A provider port, SimpleFIN its first adapter

A `BankFeedProvider` port in `apps/api/src/bank-feeds/` (types in `packages/schemas` where the clients need them),
with a SimpleFIN adapter as its only implementation:

```ts
interface BankFeedProvider {
  readonly kind: 'simplefin';
  readonly limits: { maxWindowDays: number; requestsPerDay: number; includesPending: boolean };
  /** Turn what the person pasted into a sealed secret. Called once; never retried on its own. */
  connect(input: { setupToken: string }): Promise<{ secret: string; host: string }>;
  /** Institutions and accounts, with balances; no transactions. */
  listAccounts(secret: string): Promise<FeedSnapshot>;
  /** Transactions for one window (≤ maxWindowDays), for all linked accounts in one request. */
  fetchTransactions(secret: string, q: { from: CalendarDate; to: CalendarDate; pending: boolean }): Promise<FeedSnapshot>;
  /** A cheap check for Settings: reachable, credentials accepted, problems per institution. */
  health(secret: string): Promise<FeedHealth>;
}
```

- `FeedSnapshot` is provider-neutral: institutions (`id`, `name`, `url`, problem), accounts (`id`, `institutionId`,
  `name`, `currency`, `balance`, `available`, `balanceDate`, problem) and transactions (`id`, `date`, `amount` as
  bigint minor units, `description`, `payee`, `memo`, `pending`). Problems are typed (`reauth_needed`,
  `account_failed`, `missing_data`, `quota_warning`, `revoked`, `payment_required`, `unknown`) with the provider's
  message sanitized (plain text, length-capped).
- The **cursor** is a date per account (§5), not a provider token: SimpleFIN has none, and a date works for every
  provider in "Later providers" except Plaid's sync cursor, which the adapter can keep in its own state.
- The adapter reads v2 and tolerates the v1 shape (`org`, `errors[]`), and reads `payee` and `memo` only when present.
- Amounts are parsed with `@montra/domain` money parsing for the account's currency: more decimals than the currency
  allows makes that row an error, never a rounding. An account in a custom (non-ISO) currency can't be linked.
- Dates: `posted` becomes a `CalendarDate` (TZ-02) in UTC; the ±3-day dedupe absorbs a day's skew, and the live run
  checks the assumption.

### 2. Data model and migration sketch

One migration (number assigned when written), append-only:

- **`app.bank_feed`**, one per workspace and provider (partial unique index on live rows): `provider` (`simplefin`),
  `status` (`active`, `needs_attention`, `revoked`, `payment_required`, `paused`, `failing`), `secret_enc` (the access
  URL sealed with `FieldCrypto`, bound to `bank_feed.secret`), `host` (the access URL's host, not secret), `label`,
  `connected_by`, `connected_at`, `sync_minute` (random, §5), `last_sync_at`, `last_success_at`, `next_sync_at`,
  `attempts`, `last_error` (words), `requests_today`/`requests_day`, `version`, timestamps. One SimpleFIN access URL
  covers up to 25 institutions, so one row is enough.
- **`app.bank_feed_account`**: `bank_feed_id`, `provider_account_id`, `provider_institution_id`, `name`,
  `institution_name`, `currency`, `ledger_account_id` (null while unlinked), `state` (`new`, `linked`, `ignored`),
  `start_date` (the first date the feed imports, §5), `synced_through` (the cursor), `last_balance_minor`,
  `last_available_minor`, `balance_date`, `last_error`, `last_seen_at`. Unique on (`bank_feed_id`,
  `provider_account_id`) and on `ledger_account_id` where linked (one feed per Montra account).
- **`app.bank_feed_run`**: one row per sync (trigger `schedule`/`manual`/`first`, requests used, accounts, batches
  made, outcome, sanitized error), kept 90 days. Quota counting reads it.
- **`app.import_batch`**: `source text not null default 'file'` (`file`, `feed`), `bank_feed_account_id`; `file_id`
  loses `not null` with a check that a `file` batch has one; `file_type` gains `feed`. Rows keep their shape; the
  provider's id goes into the existing `externalId`/dedupe key as `sfin:<account id>:<transaction id>`.
- **RLS** enabled and forced on the three new tables. `bank_feed` and `bank_feed_run`: owners and admins read, owners
  write; the secret column is read only by the connect and sync code paths. `bank_feed_account`: members who may import
  statements read (AUTH-18), owners change links. No grants to `montra_admin` or `montra_support`.
- **Security log kinds**: `bank_feed_connected`, `bank_feed_changed` (links, pending, auto-import), `bank_feed_disconnected`.
  **Audit**: one row per account linked, unlinked or ignored.
- **Notification type** `bank_feed_attention` (daily dedupe, no amounts or transaction text), and **job** `bankfeed.sync`
  with a definer function `app.bank_feed_due()` as `app.storage_mirror_due()`.
- **Plans** (ADR-0049): feature key `bankFeeds` (§11).

DTOs: `BankFeedDto` (provider, status, host, last sync, problems in words, counts), `BankFeedAccountDto`, requests to
connect, link, ignore, set the start date, sync now, pause and disconnect; `ImportBatchDto` gains `source`. Mobile types
and web fixtures change with them (CLAUDE.md).

### 3. Connecting

- **Owner only, with a recent sign-in** (AUTH-09), in Settings → Bank feeds (default; open question 5). Admins see the
  status.
- The owner pastes the setup token. Montra decodes it and checks the claim URL against the **address guard** before
  sending anything (§9), then claims it **once**. The token itself is never stored.
- On success the access URL is sealed at once, `listAccounts` runs (`balances-only=1`, one request), and the owner moves
  on to linking (§4). The security log gets `bank_feed_connected` (host and institutions count; never the URL).
- A claim `403` says, in words: "This setup token was already used or doesn't exist. If you didn't use it, disable it at
  SimpleFIN Bridge and make a new one." Montra never claims a token twice on its own.
- **Disconnect** (owner, recent sign-in) wipes `secret_enc` at once, stops the job, keeps the accounts' links for 30
  days in case of a reconnect, and tells the owner to remove Montra at the Bridge too. Imported transactions stay;
  they're ordinary ledger data.

### 4. Linking accounts

- Each provider account starts `new` and is shown with a **suggestion** from ADR-0051's matching:
  - the signal is `feed:simplefin:<hash of provider account id>`, so `match_memory` learns it like a statement's;
  - candidates come from the last four digits in the account's name (feeds often name "…1234"), the institution's name
    against `bank_account.institution`, and the currency, in ADR-0051's tiers.
- The owner confirms, picks another account, chooses **Create account** (type, name, institution and currency
  prefilled; opening balance from the feed's balance on its date), or **Ignore**. Unlinked and ignored accounts are
  never fetched for import; their balances still show in Settings.
- Linking asks for the **start date** (§5). An account already linked to another feed can't be linked again.
- A learned signal makes later reconnects (a new setup token, a restore) relink silently; a correction resets it, as in
  ADR-0051 §3.

### 5. Syncing

- **When.** One scheduled sync a day per feed, at a random minute in the early morning of the workspace's time zone
  (the Bridge asks for a random minute), plus **Sync now** (owners and admins; open question 5), at most once an hour.
- **One request per sync.** A sync asks `/accounts` once for all linked accounts, from the earliest
  `synced_through` less 5 days (the overlap the Bridge advises) to tomorrow, split into ≤ 90-day windows only for a
  first sync or a long gap. Single-account requests aren't used.
- **The budget.** Montra stops at **12 requests per feed per UTC day**, half the Bridge's figure, so setup, retries and
  Sync now never reach the point where the Bridge disables the token. A quota warning in `errors[]` stops requests until
  the next day and is shown, not counted as a failure.
- **First sync and start date.** By default the feed starts the day after the last date already imported into that
  account from a statement (`max(import_batch.max_date)` of committed batches); an account with no imports starts **90
  days back**, which is one request. The owner can choose an earlier date, fetched in 90-day windows over the following
  days within the budget; how far back the institution goes is the Bridge's. Rows dated before `start_date` are dropped
  before the pipeline, so a feed never re-imports a period a statement already covered.
- **Through the existing pipeline.** Each sync makes **one import batch per linked account with new rows** (`source`
  `feed`), which goes straight to preview (no mapping) and through dedupe, manual and scheduled entry matching,
  transfers, loan payment linking, payee normalization and categorization exactly as a file does. Undo (30 days) and
  Discard apply per batch.
- **Dedupe key.** The provider's transaction id is the batch row's `externalId`, as an OFX `FITID` is: the 5-day
  overlap and any re-sent row become exact duplicates and are skipped, even if the bank renames the payee.
- **Clean batches commit by themselves** (ADR-0051 §4's "import if clean": no probable duplicates, no row errors, the
  balance check didn't fail). Anything else waits in Review as "Bank feed: 3 transactions need a look", with the batch
  in preview. Open question 4.
- **Balance check.** After a commit, the account's ledger balance on `balance-date` is compared with the feed's
  `balance`; the batch records `ok` or `mismatch` with the gap (IMP-08). A mismatch blocks the next clean auto-commit
  for that account until someone looks, as a statement's does.
- **Pending.** Posted only (`pending` not sent) by default: a pending card charge often changes amount (tips) and may
  change id when it posts, and either would leave a duplicate. Open question 3.
- **Cursor.** `synced_through` moves to the latest `posted` date committed or waiting in preview, never past today.
  Undoing a feed batch moves it back to the batch's first date, so the next sync brings the rows again.
- **Retries.** A failed sync backs off at ADR-0031 §5's steps (1 minute up to daily); five failures in a row make the
  feed `failing`. Redirects aren't followed; each request has a connect and a total timeout and a response size cap.

### 6. Feeds and uploaded statements for the same account

- Default: **side by side** (open question 1). A statement uploaded for a feed-linked account goes through the same
  pipeline; its rows have no feed id, so rows the feed already brought show as **probable duplicates** (same amount
  within ±3 days, similar text) and are never added twice without a person deciding. Its opening and closing balances
  still check the account.
- The Statements screen says so when the account it matched has a feed: "This account has a bank feed through
  {date}; rows it already brought will show as likely duplicates."
- A statement that ends after the feed's start date never moves the start date; the feed stays the source from then
  on, and the statement mostly confirms balances.

### 7. Problems, attention and the one notification

| What the provider says                       | Status             | What people see                                                                  |
| -------------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `403` on `/accounts`                         | `revoked`          | "SimpleFIN no longer accepts Montra's access. Connect again with a new token."  |
| `402`                                        | `payment_required` | "Your SimpleFIN Bridge subscription needs attention."                            |
| `con.auth` for one institution               | account problem    | "{Institution} needs you to sign in again at SimpleFIN Bridge." Others continue |
| `act.failed`, `act.missingdata`              | account problem    | The sanitized message, on that account; others continue                         |
| Quota warning                                | held until tomorrow | "Waiting for SimpleFIN's daily limit"; not a failure                            |
| Network, `5xx`, unparseable                  | retry with backoff | Last error and when; `failing` after five in a row                               |

- `revoked`, `payment_required` and a lasting `con.auth` need a person: the feed (or account) stops, and each owner gets
  **one** `bank_feed_attention` notification (no amounts, no transaction text), then nothing more until it's fixed and
  breaks again. `failing` uses the same notification.
- An account that disappears from the feed is marked "No longer in your SimpleFIN Bridge" and stays linked, unfetched.

### 8. What is stored, and what isn't

- **Stored:** the sealed access URL; the host; institution and account names, ids and currencies; the last balance and
  its date; per sync, the run row. Imported transactions are ordinary ledger data, with the provider id as their
  dedupe key and description, payee and memo as the row's raw text (IMP-10).
- **Not stored:** the setup token, the provider's raw responses, `extra`, and anything for unlinked or ignored accounts
  beyond name and balance. Nothing goes to the AI gateway that a file import wouldn't send.
- **Never logged or returned:** the access URL, its user and password, the `Authorization` header. The logger's
  redaction paths gain them; request logs record only method, path shape, status and duration; errors from the HTTP
  client are rewrapped so the URL can't reach a message. The DTO says only that a secret is set.
- **Backups and archives** exclude `bank_feed`, its secret and `bank_feed_run`, with a reason in the catalog test;
  `bank_feed_account` is excluded too (it is useless without the secret, and the match memory relinks). Feed import
  batches are included like any batch. A restored workspace starts unconnected.
- **Staff** can't read any of it: no grants, and the secret is sealed under the workspace's key (ADR-0050 §3).
- **Retention:** the secret goes on disconnect; links 30 days after; run rows after 90 days; a purged workspace loses
  everything (ADR-0019 §12).

### 9. Where Montra may connect

- The address guard (`destinations/guard.ts`) checks the claim URL and every request: **HTTPS, a public address, no
  redirects**, and the host must be on an allow list, by default `bridge.simplefin.org` and `beta-bridge.simplefin.org`
  (an operator setting can change it). The host returned in the access URL must pass the same check, or the claim is
  thrown away and the owner told. This keeps a pasted token from pointing Montra at anything else.
- Development and tests use a loopback fake over http behind a setting production refuses to start with, as ADR-0054
  §8.

### 10. The phone

- Settings → Bank feeds shows the status, the last sync, linked accounts and problems, read-only, with **Sync now** for
  the roles allowed. Connecting, linking and disconnecting stay on the web.
- An account's screen shows "Bank feed, synced {when}". Feed batches waiting in Review appear in the phone's Review as
  statements do (ADR-0051 §5); nothing is synced through the outbox (ADR-0013).

### 11. Plans

A feature key `bankFeeds` (ADR-0049 §1), added with a default for every existing plan in the same migration (on, as
`ownStorage`, since the person pays SimpleFIN; open question 6), and kept in `FEATURES_NOT_YET_SHOWN` until syncing
works. A plan without it can't connect; an existing feed on a plan that loses it pauses, keeping its links.
`BILLING_MODE=off` has it, so self-hosted installs do.

### 12. Testing

- **A fake SimpleFIN server** in the API's integration tests (real Postgres): claim (ok, `403`, used twice), `/accounts`
  in v2 and v1 shapes, the date parameters and the 90-day rule, `402`, `403`, `errlist` codes per institution and
  account, quota warnings, pending then posted (same and different id), a custom currency, malformed amounts, a huge
  response, slow and dropped connections. Its responses are **synthetic**, written for the tests, never recorded from a
  real account. **No test, CI job or e2e calls the real service.**
- **Pure tests** for the parser, amounts, dates, window splitting, the request budget and the start date.
- **Guarantees, each with a test:** the URL or credentials never appear in a log line, DTO, error, archive or audit
  row; a token is claimed at most once; the guard refuses other hosts, http and private addresses in production; an
  overlap never adds a row twice; rows before the start date never import; Undo brings the rows back next sync; a
  problem on one institution doesn't stop the others; the budget is never exceeded.
- **RLS and catalog tests** for the new tables. **Web** unit tests and one Playwright spec against the fake (connect,
  link, sync, Undo). **Phone** pure-module tests for the status line.
- **One live run by hand** before the key is shown: the owner's own Bridge account (or SimpleFIN's public demo token),
  to settle the unconfirmed facts above.

### 13. Requirements

A new subsection, **13.7 Bank feeds**, added by the first PR:

| ID      | Requirement                                                                                                                                                 | Priority |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FEED-01 | An owner connects the workspace to SimpleFIN Bridge with a setup token, claimed once; the access is sealed, never shown, logged, archived or sent elsewhere. | S        |
| FEED-02 | Each institution account is linked to a Montra account by suggestion (learned), created, or ignored; ignored and unlinked accounts are never imported.       | S        |
| FEED-03 | Linked accounts sync daily and on request, within the provider's limits, through the import pipeline, one batch per account, with Undo.                     | S        |
| FEED-04 | The provider's transaction id is the dedupe key; overlapping syncs and statements for the same account never add a transaction twice without a decision.     | M        |
| FEED-05 | A feed starts after the last imported statement by default, or from a date the owner picks, within the provider's history.                                   | S        |
| FEED-06 | Clean feed batches commit automatically; others wait in Review. Pending transactions follow the owner's setting.                                              | S        |
| FEED-07 | The feed's balance checks each account after a sync.                                                                                                         | S        |
| FEED-08 | Problems are shown per feed and account in words; owners are told once when a person must act.                                                              | S        |
| FEED-09 | Connecting, link changes and disconnecting are in the security log; disconnecting wipes the secret; staff can't read it.                                     | M        |
| FEED-10 | The phone shows each feed's status and offers Sync now.                                                                                                      | C        |

## Delivery

A small chain into `develop`, each PR with its dev bump:

1. **Contracts**: the migration, Kysely types, DTOs, the port, the `bankFeeds` key (hidden), FEED-01..10 in the
   requirements and `status.json`; the SimpleFIN parser, amounts, dates, windows and budget as tested pure functions;
   the fake server.
2. **Connecting and linking**: claim, guard, sealing, security log, the Settings page, suggestions and learning, Create
   account, Ignore, disconnect. Nothing is imported yet.
3. **Syncing**: the job, Sync now, budget and backoff, feed batches through the pipeline, start date, auto-commit if
   clean, the balance check, problems and the notification, the Statements screen note.
4. **Phone and showing it**: the phone status and Sync now; the live run; the key leaves `FEATURES_NOT_YET_SHOWN`.

## Later providers

The port takes these without changing §2–§8; each would be its own short ADR.

- **Plaid**: the widest US/Canada coverage, OAuth bank connections and a real sync cursor; when Montra is ready to be
  the aggregator's customer (contract, per-connection fees, a security review, NFR-04's SOC 2 readiness).
- **Teller**: US, direct bank APIs with fewer middlemen and a free developer tier; a good second US option if SimpleFIN's
  coverage or daily cadence isn't enough.
- **GoCardless Bank Account Data** (formerly Nordigen): free PSD2 access across the UK and EU, 90-day consents to renew;
  when Montra has European workspaces.
- **MX, Finicity (Mastercard), Yodlee, Akoya**: enterprise aggregators with strong US coverage and, for Akoya, the
  bank-owned API network; only at a scale that justifies their contracts.
- **OFX Direct Connect**: free, bank-by-bank, with per-institution credentials and fading support; only for a bank
  that offers nothing else, and it would need credential storage Montra avoids today.

## Consequences

- Linked accounts update themselves daily with no files, and the whole pipeline (dedupe, matching, transfers, loans,
  categories, balance check, Undo) applies unchanged.
- The person pays SimpleFIN and manages institutions there; Montra holds one sealed URL per workspace and no bank
  credentials.
- Coverage is SimpleFIN's: mostly US, history and freshness per institution. Files remain the fallback for any
  account.
- `import_batch` gains a source and a nullable file, which code reading `file_id` must handle.
- A wrong link imports into the wrong account until noticed; Undo per batch and the learning reset are the guard.

## Alternatives considered

- **Plaid first.** Better coverage and UX, but Montra would need a contract, pay per connection and pass a security
  review before R1 has launched. SimpleFIN proves the design at no cost to Montra.
- **Store each response as a file and import it as a statement.** Keeps `import_batch.file_id` required, but puts raw
  bank data into storage, mirrors and the vault (ADR-0031, ADR-0054) and into backups.
- **One batch per sync across all accounts.** A batch is per account (dedupe, currency, Undo all depend on it).
- **Import pending transactions and replace them when they post.** Needs a pending state the ledger doesn't have, and
  SimpleFIN doesn't promise the id stays the same.
- **Sync several times a day.** The Bridge is daily and a disabled token costs the person a reconnect.

## Open questions for the owner

1. **Feeds and statements:** does a feed replace statement uploads for its account, or sit alongside them (the default
   here)?
2. **First sync:** how far back by default: from the last statement (else 90 days, the default), always 90 days, or as
   far as the institution allows?
3. **Pending:** posted only (the default), or include pending transactions?
4. **Auto-import:** commit clean feed batches automatically (the default, as ADR-0051), or review every sync?
5. **Roles:** only owners connect (the default); may admins also connect or press Sync now? Members?
6. **Plans:** is `bankFeeds` on every plan (the default, since the person pays SimpleFIN), or a paid-plan feature?
