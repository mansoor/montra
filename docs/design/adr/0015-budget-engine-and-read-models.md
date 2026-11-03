# ADR-0015: Budget engine and read models

- Status: proposed
- Date: 2026-11-03
- Phase: 6

## Context

Phase 6 adds budgeting (BUD-01..10, FAM-06/07, UP-11), money flow (FLOW-01..07, UP-14) and recommendations
(REC-01..08). 04 §8, §11 and §12 give the formulas; 03 §4.4 and §7 name the planning tables and two read
models. The exit criteria are strict: every dashboard number drills down to transactions, left-to-assign
always agrees with the lines, and the dashboard's p95 stays under 2 s on the 50k-transaction seed.

Open points were:

- what is stored and what is computed (carried-in amounts, available, left to assign);
- how the read models stay correct when postings are edited, re-dated, reversed or deleted;
- how restricted (payslip) amounts and member budgets fit into aggregates;
- where the engine lives, and how its numbers reach AI wording without AI changing them;
- how concurrent edits to a budget are detected.

## Decision

1. **Only user intent is stored; every derived number is computed.**
   - Stored (migration 0015): `budget` (method, period type, anchor, light-mode savings target),
     `budget_period` (dates, optional expected-income override), `budget_line` (assigned amount and
     rollover mode per category), `budget_move` (history, BUD-10), `goal`, `expected_income`,
     `recommendation`.
   - Computed by the pure engine in `@montra/domain` (`budget/`): activity, carried-in, available, moves,
     left to assign, pace, the 50/30/20 split, sinking-fund contributions, goal projections, debt
     payoff (snowball/avalanche), the forecast and the recommendation rules. All arithmetic is `bigint`
     minor units; divisions use `divRound`, contributions round up (`ceil`) so a sinking fund is never
     short.
   - Carried-in is computed by walking periods from the first one forward, so changing an old period
     (a backdated transaction, a rollover mode) changes every later period consistently. Periods are
     few (≤ 12 a year), so the walk is cheap.
   - Money is conserved: a surplus a category doesn't carry (`carry_deficit`, `reset`) and an overspend
     it doesn't carry (`carry_surplus`, `reset`) go back to next period's left to assign. So for every
     period, left to assign + Σ available = Σ budgeted income − Σ activity to date. Property tests check
     this invariant.
   - Period rows are created on the first write to a period (assign, move, copy, income override). Reads
     don't need one: rollover modes carry forward from earlier lines, so "left to assign" never depends on
     whether a period row exists.

2. **Two read models, maintained by statement-level triggers in the posting's transaction.**
   - `category_activity_monthly` (functional amounts per ledger account, month, member and restriction)
     and `account_balance_daily` (account-currency and functional deltas per account, date and
     restriction; a balance is the sum of deltas through a date).
   - One trigger function handles insert, update and delete through transition tables and does one
     aggregated upsert per statement into each model. An update only contributes rows whose keys or
     amounts changed (`except all` of old and new), so reconciling or clearing postings costs nothing.
   - Postings now carry `restricted_member_id` (copied from the entry, like `restricted`), so the
     trigger needs no join and still works while an entry's postings are cascade-deleted.
   - The models are exact by construction (same transaction, no queue, no eventual consistency). The
     function is `SECURITY DEFINER`; the app role can only select. A test applies random inserts,
     re-dates and deletes and checks the models against the postings.
   - Weekly and biweekly budgets read activity from postings directly (indexed by account and date);
     the monthly model serves monthly budgets, the dashboard, trends and the Sankey.

3. **Restricted amounts and members are dimensions, not filters applied later.**
   - Both models key on `restricted` and `restricted_member_key`, and their RLS policy is the payslip
     rule (`can_read_restricted`). A partner who cannot see a payslip cannot see its amount in any
     aggregate either.
   - `member_key` (zero uuid = Household) lets a member budget (FAM-06) be the same computation with a
     member filter; the household budget ignores it, so a member's spending counts against both.
   - Payslip taxes and deductions sit in `system` category groups and are excluded from budget
     activity by default (04 §8 "gross vs net").

4. **The budget's `version` is the concurrency token for the whole budget.** Assign, move, copy and
   period edits send the version they read; the API bumps it in the same transaction and returns 409
   on a mismatch. One change-feed row (on `budget`) tells clients to refetch.

5. **Recommendations: computed in code, stored with their inputs, worded by AI.**
   - The engine produces a payload (figures, subjects, proposed actions) per rule; `dedupe_key`
     (type + subject + period) stops repeats, so a dismissed recommendation stays dismissed. An hourly
     system job calls `app.enqueue_workspace_nightly`, which queues one `planning.nightly` job per
     workspace after 03:00 in its time zone (TZ-04); that job materializes schedules and runs the rules.
     `POST /recommendations/refresh` runs them on demand.
   - Stored recommendations are computed without restricted (payslip) amounts, because anyone who can
     read the entity can read them.
   - AI wording (the `word_summary` gateway task, also used for the draft-budget explanation) receives
     only the formatted figures and names. An answer containing any number that isn't in them is
     rejected (AIA-05) and the template title is shown alone.
   - Accepting applies the proposed (or edited) actions as ordinary budget writes in one transaction.

6. **Forecast and net worth are computed on request** from the read models plus recurring items,
   expected income and budgets. The 90-day simulation per account is a few thousand additions; caching
   is added only if the perf budget needs it.

7. **On mobile, planning reads are cached and planning writes are online-only.**
   - Budgets, goals, forecasts and recommendations are computed by the server, and the app keeps no budget
     logic. The last answer for each screen is saved in the encrypted store and shown while offline, marked
     as saved.
   - Assign, move, copy and accepting a recommendation need a connection and aren't queued in the outbox
     (ADR-0013). Each depends on the budget's version and on left to assign at that moment, so replaying it
     later could apply a decision the user made against numbers that have since changed.

## Consequences

- Budget numbers can never drift from the ledger: there is no stored "available" to repair.
- Every posting write pays for two small upserts per statement, however many rows the statement
  writes. The perf-commit budget (5,000-row import) covers it.
- Read-model rows are never deleted (a zeroed row stays). Queries filter on non-zero values where it
  matters; a maintenance job can prune them later.
- Changing the read-model shape later means a new migration that rebuilds from postings (the same
  `insert … select` used for the backfill in 0015).

## Alternatives considered

- **Refresh materialized views** (nightly or on demand): stale between refreshes, and a refresh is
  workspace-wide. Rejected; the exit criterion needs exact numbers.
- **Queue-based incremental updates** (a job per posting batch): eventually consistent, so a budget
  read right after an import would be wrong. Rejected.
- **Row-level triggers**: correct but one upsert per posting row; a 5,000-row import would do 10,000
  upserts. Statement-level triggers with transition tables do two.
- **Storing carried-in and available per line**: faster reads, but every backdated edit would need a
  cascade of updates across later periods. Rejected; the walk is cheap.
