# ADR-0018: Rental properties: derived rent status, and what stays out of the ledger and the AI provider

Status: accepted (2026-11-04)

## Context

Phase 9 adds properties, leases, a rent roll, mortgages, depreciation and rental reports (RNT-01..14). It builds on the
cash-basis decisions of ADR-0017 and its payment takeover. Three things are particular to rentals: money arrives irregularly
against a monthly schedule, a security deposit looks exactly like rent but isn't income, and tenants are third parties whose
names are in the bank statements.

## Decision

1. **Cash basis, per property.** A rent charge posts nothing; a payment becomes income. Postings carry `property_id` and
   `unit_id`, so a property's ledger is a filter on the same journal rather than a second set of books (UP-10). An expense with
   no property is a portfolio expense: it's in the portfolio's totals and in no property's.

2. **What's been paid is derived.** A lease has charges and payments; `applyRentPayments` applies the payments to the charges,
   oldest first and rent before its fee. Nothing stores "paid" per charge, so removing or adding a payment can't leave them
   disagreeing. Paying ahead is a credit that later charges use up: on a cash basis it was income when it arrived.

3. **Matching is done in code, and tenant names don't go to the AI provider.** RNT-04 says "AI-matched". The evidence that
   matters is a tenant's name on the statement line, and sending third parties' names to a provider to compare with text
   already on hand isn't worth it. So:
   - A line naming a tenant, or under a name a past payment was linked from, is theirs, for any amount.
   - Otherwise it takes the exact rent, with one lease and one line in the running.
   - Security deposits are matched first, because one the same size as a month's rent mustn't become income.
   - Anything else is offered, never guessed. Only lines in the portfolio's own accounts link by themselves.

   If accuracy on real statements turns out poor, a provider step could work on pseudonymized names (`minimizeText`).

4. **A security deposit is a liability until it's forfeited** (RNT-10). Receiving one posts to `security_deposits_held`; returning
   one takes it back out; forfeiting moves it to rental income, with no cash moving. The balance follows from the events.

5. **Some numbers stay out of the ledger.** Depreciation is a helper on Schedule E, like mileage (ADR-0017 §5), with a disclaimer:
   posting it would put a non-cash figure into every property's P&L and make NOI harder to read. The mortgage schedule is computed
   from its terms and not stored.

6. **A mortgage payment posts its parts** (RNT-08). Principal reduces the loan account, interest goes to Mortgage interest, and
   escrow goes straight to Taxes and Insurance, as RNT-08 asks. Strictly, escrow is deductible when the lender pays it out, not when
   it's paid in, so annual totals can differ from the Form 1098. A real escrow account would be more exact, and is a later change.

7. **Capital improvements are flagged, and the owner decides** (RNT-09). Items of $2,500 or more in repair-like categories are
   flagged in code (the IRS de minimis safe harbor figure), and AI is asked about smaller ones from $500. Payee and category go to
   the provider, and no tenant data. Accepting moves the item to the property's improvements account and adds a depreciation row.

8. **Ownership share applies only to the tax summary.** Reports show the whole property. Schedule E also shows "your share" using
   `ownership_bps`, so a part owner sees both. Partnerships file differently, and that's for their accountant.

9. **One owner check.** `ownerOf` gains `lease`, `securityDeposit` and `loan`: edits, deletes and import undo treat these
   transactions like a payslip's.

## Consequences

- A charge's status can change when an older payment is removed, because payments re-apply. That's correct, and it can surprise.
- Rent isn't prorated: a mid-month move-in gets a full charge, which the landlord edits. Common practice varies by lease.
- Extra principal payments and rate changes aren't modeled: the schedule is what the terms say, and the account balance is what
  was actually paid.
- A property's budget is its own small model (expected rent, planned costs, capex reserve) and doesn't use the household budget engine,
  whose carry-over and assign-every-dollar rules don't fit.

## Alternatives considered

- **Allocation rows linking each payment to charges**: more to keep consistent, and removing one payment means reworking later ones.
- **Sending tenant names to AI for matching**: rejected in §3.
- **Posting rent as a receivable when charged**: accrual, rejected in ADR-0017.
- **Posting depreciation monthly**: rejected in §5; a tax figure, not a cash one.
