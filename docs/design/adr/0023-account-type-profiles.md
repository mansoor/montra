# ADR-0023: One definition for each account type

- Status: accepted
- Date: 2026-11-06

## Context

All ten account kinds behaved alike. The form asked the same questions, and the detail page showed the same register. What
did differ lived in separate lists of kinds: the API's liabilities, the web form's liabilities, the forecast's cash kinds, the
cash-flow chart's savings and debt kinds, and the loans service's check.

The owner wants each type handled in its own way: full tracking for mortgages and loans, statements and gains for retirement
accounts, due dates for cards. Each of those would have added more lists.

## Decision

1. **`accountProfile(kind)` in `@montra/domain` says what makes a kind different:** which side it's on, how its balance is
   described, who holds it, whether it has a number, which optional facts it holds, its role on the forecast and the cash-flow
   chart, and whether it can follow a schedule. Forms, pages and the server read this rather than keeping their own lists.
   `ACCOUNT_KINDS` is the one list of kinds, and also sets the display order.
2. **A profile only holds what something reads today.** Later work adds a trait with the code that uses it. This isn't a
   configuration system, and a type can't be defined by data.
3. **New sub-types come as a field on a kind, not as new kinds.** A 401(k) will be an `investment` with a plan type, for
   example. A new kind means a database check and every reader of the kind, while the ledger only needs to know that it holds
   an investment.
4. **Balance history is a read of the existing `account_balance_daily`, on request (ADR-0015 §6).** Nothing new is stored. It
   reads the same restricted-aware rows as other balances, so nobody learns a private amount from a chart. It plots every day
   for about three months, weekly for about two years, then month ends, so a long-lived account stays a few hundred points. A
   period never starts before the account's first activity, which would draw a false zero.
5. **Rates are parsed as text.** `19.99 * 100` in floating point is 1998.9999…, which Settings used to truncate to 19.98%.

## Consequences

- Moving the lists didn't change what any type does, except where noted here. A test pins each list.
- **Settings now follows the profile.** A line of credit gains a limit, and an investment or other asset no longer shows a
  low-balance warning, which had no effect because they aren't forecast. A value already saved stays in the database.
- The form asks only what a type has. Cash asks for no bank, and a property asks for no bank or number.
- The phone shows the type and the right balance word, but no chart yet. It has no chart component.
- The `investment` label still says "balance only", until investment tracking changes that.

## Alternatives

- **A table of account types in the database.** It would let types change without a release, but every behaviour here is code,
  so a row couldn't add one. It would also need RLS, grants and backup rules for no gain.
- **A class per kind on the server.** Forms and phones need the same answers, so it would have to be repeated in each client.
