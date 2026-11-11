# ADR-0033: Moving an account to other books

- Status: accepted
- Date: 2026-11-10

## Context

Every account belongs to one entity's books (ACC-03): Personal, a business or a rental portfolio. Its ledger account
row carries the entity, and so does every posting on it: the foreign key `(workspace_id, entity_id, ledger_account_id)`
pins a posting to its account's entity, and a journal entry can't change entity (a trigger refuses it). One transaction
writes one journal entry per entity (ADR-0005); a split for another entity's category goes through the inter-entity
accounts (DE-05: due to / due from).

People open a card for personal use, start using it for the business and want it in the business's books, or the
reverse. Until now the only way was a new account and moving the lines by hand. The account's history may include:

- statement imports (`import_batch`, keyed by account and entity), reconciliations (`reconciliation`, the same) and
  reconciled lines (locked, DE-08);
- entries in a closed period of either books (DE-10);
- transactions owned by an invoice, bill, payslip, lease or loan, some of which are posted by their owner's own builder
  rather than from the transaction's spec (payslips with restricted entries, rent);
- entries with no transaction: the opening balance, balance adjustments, valuations, revaluations and hand-written
  journals;
- defaults pointing at it (a business's deposit or tax savings account, a loan's schedule, valuations).

## Decision

**Move the whole history, as if the account had always been in the new books, in one database transaction; refuse,
with reasons, whatever that can't do without changing a closed figure.** Amounts, dates, members, memos and cleared or
reconciled states never change; only which books hold each line does.

- **API:** `GET /accounts/:id/move?entityId=…` previews (counts, what's cleared, blockers) and changes nothing;
  `POST /accounts/:id/move { entityId }` does it and returns the same with `moved: true`. Needs write access to both
  books (RLS on `account_move`, `ledger_account` and every entry touched).
- **Where it can go:** to Personal or a business. Accounts in rental books don't move (their mortgages, deposits and
  rent are tied to properties), nor does a loan whose schedule has a property.
- **Refused (blockers), nothing changed:**
  - any entry to be rewritten is dated on or before either books' period lock (`closed_period`);
  - the two books keep different home currencies (`currency_mismatch`);
  - a hand-written journal touches the account together with a line only the old books have, such as a category
    (`manual_journal`): it's the user's own entry, so they change it first;
  - the account is archived.
- **Transactions are re-booked from what's posted, not rebuilt from their spec.** For each transaction with a line on
  the account, take its net postings per entity (as the poster does, adjustments and reversals collapsed), move the
  account's lines to the new books, drop the old inter-entity lines and settle each entity's difference again through
  the inter-entity accounts, around the entity that pays (the entity of the transaction's main account). So a business
  expense paid by a personal card, once the card moves to the business, becomes a plain business expense, and its
  "due to Personal" pair disappears. This works the same for owned transactions (payslips, invoices, bills, rent,
  loans), because it never asks their owner to build anything.
- **Lines that follow the account.** In a transaction whose main account is the one moving, the old books' system
  lines go with it to the new books' same system account: uncategorized income and expense, bank fees, FX gain/loss and
  rounding. The transaction's spec is rewritten to match, so a later edit posts the same way.
- **Categories stay where they are.** A transaction categorized in the old books stays so: after the move it shows as
  paid by the new books for the old (an amount one owes the other), which is what happened. The preview counts these
  (`crossBooks`) so people know to recategorize. Moving categories by name was left out: two books' "Office supplies"
  needn't mean the same thing.
- **Entries without a transaction** (opening balance, adjustments, valuations, revaluations) move whole: the account's
  line, and the old books' system accounts mapped to the new books' (opening balance equity, investment gains, FX).
- **Reconciled lines stay reconciled.** The rewrite runs with the audited `app.allow_locked_edit` for that one database
  transaction, which the triggers already honour; every rewritten line keeps its cleared state and reconciliation id.
  The rewrite is checked before it commits: for every transaction, each account's total and each line on the moving
  account must be exactly what they were, or the move fails (`ledger.move_changed`). Closed periods are never touched.
- **What else moves:** the ledger account's entity, its import batches and reconciliations (their foreign keys now
  cascade on update), loan schedules without a property, valuations, the transaction's `primary_entity_id` (so sync
  re-sends it) and the daily balance read model (a definer function, since the app can only read it). Defaults in the
  old books that point at it (a business's deposit and tax savings accounts) are cleared, and said so in the preview.
- **History:** an `account_move` row (who, when, from, to, how many transactions and entries) and an audit-log entry.
- **Web and phone:** the account's settings offer "Move to other books" with the preview; the phone shows the same.
  Adding an account already asks whose books it's in (web and phone).

## Consequences

- Most moves are one step and leave the books as if the account had always been there; reports for open periods
  change accordingly, which is the point.
- A closed period blocks a move until the owner reopens it (the audited unlock). That's deliberate: a filed tax year
  shouldn't change by moving a card.
- Moving many years of a busy account is one long database transaction. It's bounded by the account's own lines (each
  re-booked once) and runs within the request; very large accounts may need a job later.
- The re-booking is a third way the ledger changes besides the poster's edit rules and owners' builders, so it lives
  in `transactions/poster.ts` next to them, with its own tests.

## Alternatives considered

- **Close and reopen (move from a date forward):** the account stays in the old books up to a date, and its balance
  transfers to a new account in the new books. Nothing old is rewritten, so it's always allowed, but the account
  becomes two accounts with two registers and two import histories, which is what people wanted to avoid.
- **Refuse when any line is reconciled:** simplest and strictest, but most imported accounts have reconciled
  statements, so most moves would be refused, although a reconciled line keeps its account, amount and date.
- **Rebuild every transaction from its spec:** reuses the poster's builders, but payslips and rent are posted by
  their owners' builders, and foreign-currency carrying values would be recomputed and could drift.
- **Move categories by name along with the account:** convenient, but it guesses what the user meant.
