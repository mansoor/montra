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
- **Import doesn't convert pairs on its own,** even at 0.95. They wait in review, where one tap or "accept all above"
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

