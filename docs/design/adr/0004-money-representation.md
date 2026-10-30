# ADR-0004: Money as bigint minor units + ISO 4217 currency

- Status: accepted
- Date: 2026-10-30

## Context
NFR-09 forbids floating-point money. CUR-02 requires per-currency decimals (JPY 0, KWD 3).

## Decision
- Database: `bigint` minor units + `char(3)` currency.
- TypeScript: `Money { amount: bigint; currency: CurrencyCode }`, exponent from a
  currency table; arithmetic only through `packages/domain`.
- JSON: `{ "amount": "<minor units as integer string>", "currency": "USD" }`.
- Rates: `numeric(20,10)` in DB, decimal strings in TS, applied with scaled-integer
  arithmetic and explicit rounding modes.

## Consequences
No precision bugs, safe beyond 2^53. Clients must format with the shared formatter.
