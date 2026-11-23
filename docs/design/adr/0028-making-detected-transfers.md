# ADR-0028: Making detected transfers real

- Status: accepted
- Date: 2026-11-10

## Context

Pipeline step 3 (04 §5) detects a likely transfer or card payment: the same amount, opposite sign, on another of the
user's accounts within 3 days. Until now it only explained the match in review. The row stayed a plain transaction on
the uncategorized account, so a card payment counted as spending on the bank side and as income on the card side,
and nothing turned the pair into one transfer.

A transfer is one transaction with a posting on each account (TXN-04). The two sides usually arrive as two separate
transactions from two statement imports, each carrying its own statement line: a dedupe key, a cleared posting and a
`transaction_source` row that import undo relies on. Import dedupe keyed a transaction by one `dedupe_key`, and
treated anything an import had touched as "dedupe only" on every account.

## Decision

- **Accepting a suggested transfer makes it one** (`POST /transactions/:id/make-transfer`; review's accept calls it).
  The transaction is rewritten in place as a transfer through the poster, so the DE-10 rules apply.
- **The other side is absorbed.** Its statement line moves to the transfer: the posting stays cleared, and its
  `transaction_source` rows move with role `second_leg` and a matched-style before image. The other transaction is
  voided into the trash.
- **Import dedupe keys statement lines per account.** The keys come from `transaction_source` and `import_row`, not
  `transaction.dedupe_key`. A transaction with a line on the account being imported is a duplicate candidate by that
  line's key. A transfer without a line on that account is matchable on amount and date alone, because its text came
  from the other statement.
- **Undo:**
  - Undoing the import that brought the absorbed line unclears it on the transfer.
  - Undoing the import that created the transfer keeps it, with reason `transfer`, while it holds another
    statement's line.
- **No other side yet:**
  - A payment whose text names another account's last 4 digits, together with a payment or transfer word, is
    suggested as a transfer to that account (0.80).
  - Making it one leaves that account's line to be matched by its statement later.
- **Refusals:** either side reconciled, split, or owned by a payslip, invoice or bill.
- **Import doesn't convert pairs on its own,** even at 0.95 (changed by the amendment of 2026-11-23 below). They wait in review, where one tap or "accept all above"
  does it.

## Consequences

- Transfers stop counting as spending and income once accepted, and re-importing either statement adds nothing.
- The surviving transfer has one date (the accepted side's); the other statement's date may differ by up to 3 days.
- The absorbed transaction stays in the trash until it's purged. Restoring it while the transfer exists would count the
  money twice, the same as restoring any duplicate.

## Alternatives considered

- **Keep both transactions and link them,** each posting to a clearing account. This means no rewrite and a simple
  undo. But every report would need to net the clearing account, and the register would show two entries for one
  movement.
- **Create a new transfer and void both sides.** This loses both sides' import provenance, so undo and dedupe would
  need special cases on both accounts instead of one.
- **Convert automatically at import for 0.95 pairs.** This is the fastest path, but a wrong pair rewrites the user's
  data with no prompt. It's left for later, once the review path has been used for a while.

## Amendment (2026-11-19): making a transfer by hand

Card and loan payments often carry the payee's ID rather than the account's last 4 ("CHASE CREDIT CRD AUTOPAY PPD ID: …",
"USBANK LOAN"), so step 3 doesn't suggest them and they stayed as uncategorized spending.

- **"Make transfer…"** in Review (rows without a transfer suggestion) and the transaction editor picks any of the
  person's other open accounts in the same currency. It's the same `make-transfer` with the same rules: the other side
  on that account is absorbed if it's there, statement lines stay cleared, and the refusals above apply, plus archived
  accounts and anything that isn't a bank, card, loan or other balance-sheet account.
- **A tracked loan (ADR-0024)** takes the line as its scheduled payment, split into interest, principal and escrow, when one
  matches by ADR-0024 §8 (exact amount, within 5 days) and the loan account has no line of its own for it. Otherwise it's a
  plain transfer to the loan account, and the response says so (`loan.number` null).
- **Remembered per payee** in `payee_transfer`, beside `payee_history` (whose entries are applied as categories). The next
  line from that payee is suggested as a transfer to the same account at 0.90: above the weak pairs (0.60, 0.80) and below
  a sure pair (0.95). Like every detected transfer it waits in Review. Choosing a category for the payee counts against it.

## Amendment (2026-11-23): import makes sure pairs transfers

The review path has been used for a while, and a sure pair still had to be accepted by hand on every statement. AI-03
says high-confidence items apply on their own, so the alternative left for later above is taken, with an undo.

- **A setting, not a constant:** `ai_settings.transferThreshold`, default 0.95 (a sure pair). Null turns it off, and
  every pair waits in Review as before. It can be 0.90 to 0.99; lower would take pairs on amount alone (0.60). It is in
  Settings › AI next to the review thresholds.
- **What converts:** a committed row that was new (not a possible duplicate), that nobody chose a category for, and whose
  pair is a recorded other side at or above the setting. It's made a transfer by the same `makeTransferInTrx` as Review,
  so the other side is absorbed and its statement line moves to the transfer. It is marked `made: 'import'`, stays
  `auto_applied`, and doesn't teach the payee its account (no one chose it).
- **What waits in Review instead:** a pair with no other side yet (0.80); another row of the same import claiming the
  same other side; another currency (it needs the amount received, CUR-08); an other side that changed since the
  preview, or whose account is archived; an other side reconciled or in closed books (DE-10: skipped, not forced). A
  switch from another app keeps its own pairing step.
- **Speed:** the conversions run once all the batch's rows are written in chunks of 500, a few statements per pair and
  none per other row.
- **Undo:** making a transfer (by an import, in Review or by hand) records what it changed in `app.transfer_conversion`:
  the plain transaction's spec, suggestion, review state and cleared line, and the other side's review state, cleared
  line and statement lines with their roles and before images.
  - `POST /transactions/:id/undo-transfer` takes it apart: both sides come back as they were. It's refused when the
    transfer was changed since, is reconciled or in closed books, or the other side was restored by hand. When the other
    side's own import was undone since, it stays in the trash.
  - Undoing the import that made it takes it apart first, so the other side comes back and this import's line is
    removed as usual. One that can't be taken apart is kept with reason `transfer`, as before.
- **Visibility:** the import summary says how many transfers it matched (`counts.transfers`), and the transaction says
  the import made it, with an "Undo transfer" button.

