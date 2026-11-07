# ADR-0026: Card and line-of-credit statements, and paying them

- Status: accepted
- Date: 2026-11-07

## Context

The account-type plan, which the owner accepted, gives credit cards:

- a statement day and a due day;
- the statement balance and what's still due;
- utilization;
- due-date reminders;
- a forecast payment from a chosen account.

Lines of credit get the same handling, because they're revolving rather than repaid on a schedule.

Parts were already in place but unused. `statement_day` had been on the account since migration 0001. The calendar had a
`card_due` kind and the forecast a `card_payment` kind. Notifications already reminded about `card_due` items. Nothing produced
any of them.

## Decision

1. **A cycle is two days on the account:** the statement day, already there, and a new due day. A day past the end of a month
   means its last day. The latest statement is the last close on or before today. Its balance is due on the first due day after
   it.
2. **What's due is read from the ledger.** It's the balance at the close, less everything that reduced the balance since:
   payments, and refunds too, as cards count them. Never below zero. The minimum is the account's minimum payment, or all of
   what's due if that's less. Nothing about a statement is stored.
3. **Interest isn't calculated.** It arrives as a charge on the statement the user imports or enters. A card's daily interest
   and grace period are rules of each card, and guessing them would mislead.
4. **A payment rule plans the payment; it doesn't make it.** The rule pays the statement balance, the minimum, or a set amount,
   from a bank account in the same books and currency. It feeds the forecast and calendar only. The payment itself is a transfer:
   one click on the card's page, the bank's autopay seen on an imported statement, or entered by hand. This matches the owner's
   decision for loans (ADR-0024).
5. **Two payments ahead.** The calendar and forecast show this statement's payment, and the next one estimated from what's been
   charged since the close. Charges further ahead aren't known, so there's nothing honest to show.
6. **A line of credit is forecast like a card,** down to its limit. Before this it wasn't forecast at all.
7. **The profile gains `statement`** for both kinds (ADR-0023).

## Consequences

- Reminders already sent for `bill` items now come for cards too, through the existing `card_due` path, once the days are set.
- Utilization over 30% is shown in the warning color. That's a common guide, not advice.
- The phone doesn't show statements yet.
- A card in another currency than its books can still have days and a statement, but its rule can only pay from an account in
  the same currency.

## Alternatives

- **Storing each statement.** It would mean importing or entering statements as objects, and the ledger already has the
  figures.
- **Recording the payment by itself on the due date.** The owner chose against posting by itself for loans, and the same double-count
  risk applies here.
