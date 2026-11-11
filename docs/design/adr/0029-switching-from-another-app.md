# ADR-0029: Switching from another app

- Status: accepted
- Date: 2026-11-11

## Context

People switching from YNAB, Monarch, Mint, Lunch Money and similar apps export everything at once: one file (or a few)
holding every account, with each app's own category names, transfers between those accounts and, for YNAB, each
account's starting balance.

The statement import (IMP-01..09) was built for one account at a time:

- A batch belongs to one Montra account. App templates (IMP-13) could filter a multi-account file to one account, so
  switching meant uploading the same file once per account.
- The file's category names were only a hint for categories that already exist.
- Nothing created accounts or categories, or set opening balances.
- Transfers between accounts in the same export weren't paired.

Merging an export into books that already have their own transactions would also mean matching two histories that
overlap in unknown ways.

## Decision

- **A migration groups one import batch per account** (`app.import_migration`, `import_batch.migration_id`). Each batch
  is an ordinary statement import with the account filter, so dedupe, preview, the review queue and undo all work
  unchanged. The plan the user confirmed (category mapping, files whose signs are flipped) lives on the migration, and
  the import worker reads it.
- **Analyze, then start.** `POST /migrations/analyze` reads the files (CSV, TSV and XLSX) without creating anything. It
  lists each account in the export with its dates, money in and out and opening balance, and each category with its
  group, totals and whether it looks like a transfer.
  - `POST /migrations` creates the chosen accounts and categories and starts the batches.
  - A new account's opening balance comes from today's balance when one is given (worked back through the export's rows),
    otherwise from the export's own (YNAB's Starting Balance rows, which are no longer imported as transactions).
- **Templates and fallbacks.**
  - Templates: YNAB, Mint, Monarch, Stessa and Quicken, plus Actual, Lunch Money, Tiller, Goodbudget and Empower.
    Header names compare without case or underscores.
  - Other exports are read by their column names and split by an Account column when there is one.
  - Because several apps' sign conventions are undocumented, the plan shows money in and out per account, and each file
    has a "spending shows as positive" switch. Batches from a migration read signs as written (or flipped there) and
    never guess them from the account type.
- **Transfers.** After the import, uncategorized transactions with the opposite amount on another of the migration's
  accounts within 3 days, where the text says so (step 3's payment or transfer words, YNAB's "Transfer : …"), are paired
  one-to-one and made transfers on request (ADR-0028).
- **Fresh start only.** A migration starts only while the workspace has no transactions of its own; transactions from an
  earlier migration don't count. Otherwise the Switch page offers a new workspace (`/welcome?switch=1`), which goes
  straight to switching. Nothing has to be merged or reset.
- **Instructions.** The Switch page gives each app's export steps as its own help pages describe them, linking those
  pages. Where a detail couldn't be confirmed, the steps avoid it.

## Consequences

- One export becomes several accounts in two clicks. Undo works per account, as for any import.
- Rows with a zero amount (split parents, $0 holds) are now skipped and counted for every import, not just migrations.
- Quicken for Windows (QIF), bank OFX/QFX files and Actual's database backup aren't read yet. The page points those users
  to bank statements or the Import page in the meantime.
- Budgets and goals from the old app aren't brought over; categories are.
- The phone has no Switch screen. Switching is a one-off desk task, done on the web.

## Alternatives considered

- **One batch holding every account.** This would mean a new commit path, dedupe across accounts and a different undo,
  instead of reusing the per-account pipeline that's already tested.
- **Merge into existing books.** This needs an overlap detector across two histories, and a wrong merge doubles or loses
  transactions. A new workspace gives the same result with no risk.
- **Reset the workspace to allow switching.** It destroys data to get a clean slate that a second workspace gives for free.
