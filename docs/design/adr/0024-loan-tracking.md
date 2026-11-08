# ADR-0024: Tracking loan payments from the real balance

- Status: accepted
- Date: 2026-11-07

## Context

Rental mortgages already had schedules, split payments and matching (ADR-0018 §6), but only on a rental property. A personal
mortgage or a car loan was just a balance.

That engine also computed everything from the original terms. It worked out "the balance after payment 5" rather than reading
what was owed, so it couldn't handle extra payments, a changed rate, or a loan already years in. Real loans have all of these.

The owner decided that adding a mortgage or loan offers a choice of tracking only the balance or tracking payments too, and
that payments shouldn't post by themselves by default.

## Decision

1. **One engine for every loan.** `loan_schedule` loses its required property, and rental loans keep working as they did.
2. **What's owed comes from the ledger.** `projectLoan` starts from the loan account's balance. Interest is that balance times
   the monthly rate, and principal is the payment less the interest. So any money reaching the loan, whether an extra payment
   or a transfer, changes every later row by itself, and the loan ends early.
3. **Nothing upcoming is stored.** It's recomputed on request (ADR-0015 §6, ADR-0018 §5).
4. **Each recorded payment keeps its parts.** Interest, principal and escrow are stored on `loan_payment`, so a later rate
   change can't rewrite history. Payments recorded before this change have none and are read from the terms.
5. **A loan already under way starts from today's balance.** Nothing is back-posted. `payments_before` counts the payments
   already in that balance, so years of them don't show up as overdue. Leaving the balance blank estimates it from the terms.
6. **A new rate applies from the next payment.** The payment is re-levelled over the months left, unless the lender's figure
   comes with it. The original term stays, and the last payment clears what's left. Rate history is in the audit log; there's
   no table of rate periods, because recorded payments already hold what was charged.
7. **The payment can be overridden.** Lenders round differently, so `payment_minor` holds their figure. Null means calculated.
8. **Payments don't post by themselves unless asked (owner's decision).** A payment links to a statement line of the exact
   amount, within 5 days, on the paying account if one is set, or takes one click to record. Auto-record is a per-loan option,
   runs after matching, and warns that importing that account as well could count a payment twice. A line for a different amount
   needs an explicit `adjustPrincipal`, and principal takes the difference.
9. **Upcoming payments aren't recurring templates.** A template holds a fixed amount, and this one changes with the balance.
   They reach the calendar and forecast the way rent and invoices do, and Recurring and Upcoming list them read-only with a link
   to the loan. A loan's lines aren't proposed as a new recurring bill.
10. **The rate and minimum payment live on the loan while it's tracked.** They're copied to the account for debt payoff, and
    changing them on the account is refused with a pointer to the loan.
11. **It pays from a bank account in the same books and currency.** A payment is one journal entry for one entity (ADR-0005). A
    loan in a foreign currency, or paid from another entity, stays balance-only for now.
12. **Categories.** A rental portfolio's are found by Schedule E line, as before. Elsewhere they're found by name, then by what
    the name contains ("interest", "tax", "insurance"). If nothing fits, recording says which category to add.

## Consequences

- `scheduledBalance` on `LoanDto` keeps its name but now means what's owed in the ledger.
- A rental loan whose account balance differs from its terms now follows the account. An account with no balance and no payments
  still follows the terms.
- **Budgets:** interest and escrow show as spending, as they do for rentals. Principal isn't a category, so a budget doesn't
  count it as money going out. The forecast does.
- **A recurring template for the same payment still doubles** on the calendar and forecast. Nothing removes one the user made.
- Line-of-credit accounts can still hold a schedule through the rental screen (ADR-0023), but aren't offered it: they're
  revolving, and get their own handling with cards.
- Loans aren't in the phone's offline store. The phone reads a tracked loan live (kept for offline viewing) and records a payment only when online.

## Alternatives

- **A stored schedule, rewritten on each change.** It would be easy to read and easy to get out of step with the ledger.
- **Recurring templates with a computed amount.** It would add a special case to everything that reads a template's fixed
  amount, including materializing and editing.
- **A table of rate periods.** It would only be needed to recompute history, which recorded parts make unnecessary.
