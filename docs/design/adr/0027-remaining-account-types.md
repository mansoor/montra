# ADR-0027: Savings, homes and cars, cash, and other money owed

- Status: accepted
- Date: 2026-11-07

## Context

This is the last step of the account-type plan the owner accepted. It covers savings interest; homes and cars, with their value,
the loan against them and equity; cash, which you count rather than import; and money owed outside a bank, with an optional
due date. HSA came with retirement accounts (ADR-0025).

The Accounts page and net worth on Home also disagreed. Home counts your share of each rental property, but the Accounts page
counts only accounts.

## Decision

1. **Savings shows interest earned this year.** That's what came in against an income category whose name says "interest". The
   account's rate, already a planning input, now applies to savings too.
2. **A home or car can hold a purchase price, a purchase date and a loan.** The loan must be money owed in the same books.
   Equity is the asset's value less what's owed on that loan, worked out on the page. Values are updated as in ADR-0025, so a
   home's value doesn't move income either.
3. **Cash has no statements.** The profile gains `imports`, which is false for cash, other assets and other money owed, so
   their pages don't offer import or reconcile. "Count your cash" sets the balance through the audited adjustment (ACC-05), with
   the note "Counted cash".
4. **Money owed outside a bank can have a holder and a due date.** The holder reads "Owed to". While anything is owed, the due
   date appears on the calendar as a bill, so the existing reminder covers it.
5. **The Accounts page counts your share of rental properties,** from the same net-worth figures Home uses. They're listed under
   "Rental properties (your share)" and added to what you have and the net.

## Consequences

- **Interest is found by category name,** so interest filed under another category isn't counted. Banks usually label it
  clearly, and the categorizer files it under Interest income.
- **One loan per asset.** A home with a mortgage and a home-equity line shows equity against the first only.
- **Currencies:** properties are in the base currency, as on Home. Accounts in other currencies are still totalled per currency.
- **The phone** shows interest earned, equity and the due date, read-only, and its Accounts list counts properties too. Setting them up stays on the web.
