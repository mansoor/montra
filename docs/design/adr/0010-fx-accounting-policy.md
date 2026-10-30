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
