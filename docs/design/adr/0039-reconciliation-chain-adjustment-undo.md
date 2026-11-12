# ADR-0039: Reconciliation: the statement chain, adjustments, undo and history

- Status: accepted
- Date: 2026-11-12

## Context

Statement reconciliation (DE-08, Phase 2) let you tick cleared lines until the cleared balance matched a statement's
ending balance, then complete: lines became `reconciled`, their journal entries `locked`, and edits to amount, account
and date were refused (DE-10, `ReconciledError`). The posting trigger in migration 0001 refused any un-reconcile, yet
`errors.transaction_reconciled` told people to un-reconcile, which nothing on the web could do. The only way back was the
owner's audited `POST journal-entries/:id/unlock`, one entry at a time, which no client called.

The owner asked whether Montra supports reconciling each month, and that reconciled transactions stay put. A comparison
with Quicken (an adjustment when the difference can't be found; the opening balance taken from what's already
reconciled), QuickBooks Online (undo from the reconciliation history by an admin; a discrepancy report) and YNAB (a lock
icon; a balance adjustment as a last resort) left these gaps: no opening balance or chain between statements, no
adjustment, no undo, no history page or monthly hint, and a phone that didn't know a transaction was reconciled.

This is DE-11..15 and migration 0039.

## Decision

### 1. A chain of statements (DE-11)

A reconciliation records `opening_balance_minor`: the previous completed statement's ending balance, 0 for the first.
The DTO adds the opening balance, the previous statement's date, cleared deposits and cleared payments (what this
statement's cleared lines add and take away, both ≥ 0, natural terms) beside the ending balance, the cleared balance and
the difference. Opening + deposits − payments = cleared balance while the chain holds.

**The difference still comes from the ledger**, as before: the ending balance less the sum of every cleared or reconciled
line up to the statement date. If something reconciled earlier changes (a line deleted on restore, an entry moved), the
ledger is right and the stored opening is stale. So an in-progress reconciliation carries `chainBreak` when the lines
reconciled up to the previous statement date no longer add up to its opening balance, with what they add up to now. The
screen warns; it doesn't guess which line changed. A discrepancy report like QuickBooks' is left for later.

Statements follow one another: a new one must be dated after the last completed one
(`reconciliation.statement_date_order`). That keeps "the latest" well defined for undo. Starting one suggests the next
date: a card's statement day when it has one (ADR-0026), else a month on, staying on month ends (Jan 31 → Feb 28 →
Mar 31) (`nextStatementDate` in `@montra/domain`).

A completed or undone reconciliation keeps the deposits and payments it closed with (`deposits_minor`, `payments_minor`),
so the history doesn't change as later statements reconcile older lines. Its difference shows as 0, as it was when
finished. Migration 0039 fills these in for existing reconciliations, chaining openings by statement date.

### 2. Adjustments, as a last resort (DE-12)

`POST reconciliations/:id/complete` takes `{ adjustment?: { categoryId? } }`. With a difference left and an adjustment
asked for, it posts an ordinary income or expense transaction on the account: payee and description "Reconciliation
adjustment", dated on the statement date, already cleared, for the difference in the account's direction (for a card,
more owed is a charge). It is then reconciled with the rest of the statement. Without an adjustment a difference is still
refused (`reconciliation.difference`).

The category is the user's choice. The default is the books' **Uncategorized income or expense** by sign: an unexplained
difference isn't income or spending of any known kind, and it stays visible in reports until someone recategorizes it. We
considered posting to opening-balance equity, as ACC-05's balance adjustment does, but that's a journal, not a
transaction: it wouldn't show in the register as a line with a payee, and the reconciler couldn't tick it. The
reconciliation records `adjustment_transaction_id` and `adjustment_minor`, so the history flags it.

### 3. Undo: the latest only, by an owner or accountant, with a reason (DE-13)

`POST reconciliations/:id/undo { reason }`:

- **Who:** owners and accountants. Montra has no "admin" role; the accountant is the bookkeeper who may close periods
  (design 07 §2), so undoing a reconciliation sits with them. Partners and viewers can't. Like other sensitive actions
  (unlocking a period), it needs a recent sign-in (AUTH-09).
- **Which:** only the account's most recent completed reconciliation (`reconciliation.not_latest`), newest first, as in
  QuickBooks. Undoing from the middle would leave later statements opening on a balance that no longer exists.
- **What:** its lines go back to `cleared` with `reconciliation_id` cleared, so redoing the statement is a matter of
  checking the ticks. Each entry's `locked` is released unless another statement still reconciles one of its lines (a
  transfer between two reconciled accounts keeps its lock until both are undone). An in-progress statement after it opens
  at the new last ending balance.
- **Refused in a closed period** (`reconciliation.period_closed`): if any line is dated on or before the entity's
  `locked_through`, the period has to be reopened first. A closed period stays closed.
- **Recorded:** the reconciliation becomes `undone` with `undone_at`, `undone_by` and `undo_reason`, and the audit log
  gets `reconciliation.undo` with the reason, account, statement date and number of lines. An undone reconciliation keeps
  its row in the history and holds no lines.
- **The adjustment stays.** It's a real transaction; after an undo it's an ordinary cleared line that the redone
  statement can tick again or that the user can delete.

### 4. Only the undo un-reconciles

`app.guard_posting` (migration 0039) now refuses any update that turns a `reconciled` line into anything else unless
`app.allow_unreconcile` is `on` for the transaction. Only the undo endpoint sets it, around its two updates. The check
runs **before** the locked-edit bypass, so even `app.allow_locked_edit` (account moves, restores, purges) can't
un-reconcile; those paths delete and re-insert lines with their states, which is unaffected. `app.guard_journal_entry`
lets the undo path release `locked` outside a closed period, and nothing else.

The audited `journal-entries/:id/unlock` endpoint (DE-08's "unlocked with an audit note") now refuses an entry that has a
reconciled line (`journal_entry.reconciled`) and points to the undo. It still unlocks an entry locked for any other reason.
DE-08's audit note is now the undo's reason.

`errors.transaction_reconciled` now says to undo the statement's reconciliation on the account's reconciliation history.

### 5. History and the monthly hint (DE-14)

`GET accounts/:accountId/reconciliations/history` lists the account's reconciliations, newest statement first: statement
date, opening and ending balances, status, who started and finished it and when, any adjustment, who undid it, why, and
`canUndo` on the latest completed one for an owner or accountant. It also returns `reconciledThrough` and what the next
statement would start with. The web shows it at `/accounts/:id/reconcile/history`, linked from the account page and the
reconciler.

`AccountDto.reconciledThrough` is the last completed statement's date. The accounts list shows "Reconciled through
<date>", and "statement due" once more than a month has passed since then (`reconciliationDue`). It's a hint on the
list, not a notification: a reminder for a habit the user may not keep for every account would be noise.

### 6. The phone (DE-15)

`TransactionDto.reconciled` is true when any of its lines is reconciled. Sync carries it like any other field: reconciling
or undoing changes postings, and the change feed already maps posting changes to their transactions. The transaction
screen shows a lock and a note, and `editRules` (`src/features/transaction-edit.ts`) stops the account picker
(`canMove`) and the date; the phone never edited the amount. The category, payee, memo and tags can still change, as on
the web (DE-10). There's no reconcile screen on the phone yet.

## Consequences

- Reconciling becomes a monthly chain, and an unexplained difference can be closed knowingly rather than left open.
- A reconciled line can only be un-reconciled with a reason that lands in the audit log, by someone who may close periods.
- Undoing several statements means undoing them one at a time, newest first.
- A broken chain is reported, not repaired: the user finds the line that changed.
- The journal-entry unlock no longer un-reconciles. No client used it.
- Rows synced to the phone before this change have no `reconciled` flag; the phone treats them as not reconciled until the
  next pull of that transaction, and the server still refuses the edit.

## Alternatives considered

- **Undo any reconciliation, not only the latest.** Rejected: the later statements' openings would rest on a balance that
  no longer exists, and the chain warning would fire on every later statement.
- **Store the opening balance only, and compute the difference from it** (Quicken's way). Rejected: a stale opening would
  hide a real change in the ledger. The ledger decides; the opening is checked against it.
- **Default the adjustment to opening-balance equity.** See §2.
- **A reminder notification when a statement is due.** Left out for now; a quiet hint on the accounts list first.
- **Keep un-reconciling on the entry unlock.** Rejected: it breaks the chain one entry at a time with no record on the
  reconciliation.
