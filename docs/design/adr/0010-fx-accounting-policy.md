# ADR-0010: FX accounting policy

- Status: accepted
- Date: 2026-10-30

## Context
CUR-03..08 require foreign spending, foreign-currency accounts, cross-currency transfers
and net-worth revaluation. The design review found that without a carrying-value rule a
foreign account at €0 could keep a non-zero functional balance, and that "home
currency" (CUR-07) and per-entity currency (CUR-01) needed reconciling.

## Decision
1. **Functional currency per entity.** Journal entries balance in the entity's
   functional currency (default = workspace home currency).
2. **Historical rates on inflows.** Money arriving in a foreign-currency account is
   recorded at the transaction's actual rate (implied by both amounts when known,
   otherwise the day's reference rate, CUR-05).
3. **Carrying value on outflows (average cost).** Money leaving a foreign-currency
   account is valued at the account's average carrying rate
   (functional balance ÷ foreign balance before the posting). The difference to the
   transaction's own rate posts to `fx_gain_loss` as **realized** gain or loss. A
   foreign account with a zero foreign balance therefore always has a zero functional
   balance.
4. **Cross-currency transfers.** Both legs are recorded. The functional difference
   between them (spread and fees versus the carrying value) posts to `fx_gain_loss`, and
   the UI shows it as FX cost against the market rate (CUR-08).
5. **Rounding.** Residuals from rounding converted splits post to `fx_rounding`
   (a few minor units at most).
6. **Unrealized revaluation** is computed in reports (latest rate × foreign balance −
   carrying value) and is not posted, except optionally by an `fx_revaluation` entry at
   period close (CUR-06).
7. **Translation to home currency** for consolidated and workspace reports when an
   entity's functional currency differs: balance sheet at the closing rate, income and
   expense at transaction-date rates, and a separate translation adjustment line.

## Consequences
The posting builder needs the account's carrying rate for outflows from foreign
accounts. The API provides it from `account_balance_daily`. Phase 0's builder accepts an
explicit `fxRate` per transaction; Phase 5 supplies the carrying rate for outflows and
adds realized gain/loss lines.

Implemented in `@montra/domain` (`ledger/fx.ts`, `ledger/builder.ts`) in Phase 5:
- Any posting that *shrinks* a foreign position is valued at carrying value. That covers spending from a
  foreign bank account and paying off a foreign card. Closing the position takes exactly the remaining
  functional balance, and an amount that crosses zero opens the new position at the transaction rate.
- A transfer between two accounts in the same foreign currency carries the value over and realizes
  nothing.
- `unrealizedFx`, `buildRevaluationEntry` and `transferFxCost` cover §6 and the CUR-08 display.
- §6 is shown on net worth (CUR-06): `unrealizedFxIn` measures each foreign account's gain in its books' currency at
  the date's rate and translates it to the base currency. `NetWorthDto` carries it per account, in total and per trend
  date, and the net worth report adds an "Unrealized FX" column. It is not posted.
- §7's translation adjustment is shown on net worth, the consolidated balance sheet in the base currency.
  `translationAdjustment` is the IAS 21 / ASC 830 figure: net assets at the closing rate less (the opening translated
  net assets plus each movement at its own date's rate). `translationAdjustments` rolls it forward over the trend
  dates from the books' first posting, so it is cumulative. Read this way:
  - For each account in books whose currency isn't the base, the net assets are its carrying value in the books'
    currency, and the movements are its postings' functional amounts per day. Income, spending, transfers and opening
    balances are all movements, each at its own day's rate (equity contributions at historical rates, as IAS 21 does).
  - It is measured on carrying values, so it never includes §6's unrealized FX, which is measured in the books' own
    currency first. Net worth less every posting at its own day's rate is the two added together (to a cent or
    so of cross-rate rounding when an account's currency is neither its books' nor the base).
  - It is shown, not posted, and isn't recycled when money leaves the books: it stays as the books' history made it.
  - Properties are left out. Their worth isn't booked, so there are no days' rates to set it against.
  - A missing rate for a movement or the closing date leaves the account's adjustment at zero, as net worth leaves out
    an account without a rate.
  - `NetWorthDto` carries it in total, per account (null for books in the base currency) and per trend date. The net
    worth report adds a "Translation adjustment" column and a note, only when some books are in another currency.
- Not done from §7: no other comprehensive income line on an income statement (§7 doesn't ask for one), and the
  consolidated income and spending reports still translate at the period end's rate (ADR-0019 §2), not each
  transaction's date. The balance sheet, trial balance and P&L are for one set of books, in its own currency.
- The API (`transactions/poster.ts`) supplies each foreign account's balance before the posting: the
  sum of its postings up to the transaction date, without the transaction's own entries. Postings on
  the same day all count as earlier.
- A back-dated transaction doesn't revalue later ones; they keep the carrying value they were posted
  with until they are edited.
