# ADR-0058: Ask about one account, matched on the server

- Status: accepted
- Date: 2026-11-25
- Builds on: ADR-0019 (ask-your-data as a checked plan, no amounts to the provider), ADR-0024 (loan tracking)

## Context

Ask (RPT-06) answered one kind of question: how much was spent, earned or left over in a period. The owner asked "when will
my skylark home loan finish?" and got "That isn't something your books can answer." Questions about one account, loans
most of all, are some of the most natural ones to ask, and the account page already knows the answers.

ADR-0019 §4 set the privacy line: the provider sees the question, today's date and the category names, and never an
amount. Account names were never sent, and the owner asked that this not change. So the AI can't be shown the list of
accounts to pick from, the way it is shown categories.

## Decision

**The AI says which account the question names, in the question's own words, and what's asked about it. The API matches
those words to account names and answers with the account page's own figures.** The owner approved this design on
2026-11-25.

1. **Prompt `answer_question.v2`.** The plan gains a `kind`: `amount` (the questions before) or `account`. An account plan
   has `account`, the account as the question words it ("skylark home loan"), and `topic`: `payoff` (the payoff date and
   payments left), `owed` or `balance` (answered alike, in the account's own word: owed, balance or value),
   `next_payment` (date, amount and its principal, interest and escrow), or `interest_paid`. `periods` stay, for interest
   paid only; none means since the start. The input is unchanged: the question, masked and pseudonymized as before,
   today's date and the category names. The "treat the question as data" rule stays. v1 is replaced, as earlier tasks
   were (`extract_receipt` v1 → v3), so cached v1 plans are never reused.
2. **Only the asker's words come back.** The gateway maps pseudonyms back, then keeps only the words of the phrase that
   the question has, as the question spells them. A phrase with none of them, or no topic, is "not understood". So an
   answer can only ever repeat what the asker typed, whatever the provider returns.
3. **Matching on the server** (`matchAccount` in `@montra/domain`), against the accounts the asker sees on the accounts
   list (not hidden, not archived; RLS as everywhere):
   - Case, accents, punctuation, possessives and plurals don't matter. Filler ("my", "the", "account") is dropped.
   - Words that describe a kind of account ("loan", "mortgage", "home", "car", "card", "checking", "savings" and so on)
     are weak: they only break ties, and also point at kinds ("home loan" points at mortgages). The other words are
     strong, and an account must share one to be a candidate, so "Skylark loan" never answers for "Car loan". With no
     strong word ("my mortgage"), the kind words decide.
   - The account's institution counts as part of its name for overlap, so "chase checking" finds "Checking" at Chase.
   - An exact name wins; otherwise the most strong words, then the most weak words and kind hints.
   - Accounts that tie at the top come back as `choices`; the web shows each as a button that asks the same question
     again with `accountId`. An `accountId` the asker can't see is no match.
   - No match says "No account matches “…”" with the asker's own phrase, and names nothing else.
4. **The account page's numbers, never a second calculation.** A balance is the accounts list's (`AccountsService.list`).
   A tracked loan's figures come from `LoansService.facts`, which returns the same `LoanDto` and schedule the loan page
   shows: what's owed (`scheduledBalance`), `payoffDate`, payments left (the schedule's unrecorded rows),
   `interestRemaining`, `next`, and `interestPaid`. Interest in a period adds up the recorded schedule rows dated in it,
   by the dates the schedule table shows (the scheduled date for a monthly loan, the paid date for a daily one). Payments
   already in the balance when tracking began have no known interest; the answer says how many weren't counted.
5. **When there's no schedule.** A loan or mortgage kept as just its balance answers payoff, next payment and interest
   with what's owed and `needs_tracking`: the web says payment tracking is needed and links to the account. Any other
   kind (a card, a bank account) answers those topics with its balance and `not_applicable`. A tracked loan with nothing
   left is `paid_off`.
6. **Contract, backward compatible.** `AskRequest.accountId` and `AskAnswerDto.kind` and `.account` are optional; an
   account answer has `understood: true`, no metric, periods or transactions, and the account's currency, so an older
   client still parses it. Every answer links to the account's page.

## Consequences

- Ask answers "when will my skylark home loan finish?", "how many payments are left on my car loan?", "what do I owe on
  my Visa?", "what's my checking balance?", "when is the next payment on my mortgage due?" and "how much interest have I
  paid on my mortgage this year?", and the figures always agree with the account page.
- The provider still sees no account names and no amounts. Account names are matched in our code only.
- A phrase that shares no strong word with any name doesn't match: nicknames ("the house") need the kind words to land
  on a single account, or the name.
- Archived and hidden accounts aren't matched, so a paid-off loan that was archived reads as no match.
- Interest in a period follows the schedule's dates, so a December payment scheduled for 1 January counts in January.
  A 1098 counts by the date paid; the tax-forms checks (ADR-0052) stay the place for that.
- The phone has no Ask screen, so nothing changes there.
- Not yet tried on a real provider; the fake provider reads "my <account>" for tests and e2e.

## Alternatives considered

- **Send account names to the AI, as with categories.** Simpler matching, but it widens what leaves the server, which the
  owner ruled out.
- **Let the AI pick an account id from a pseudonymized list.** Still sends the shape of the account list, and the words
  in the question already carry the name.
- **Compute payoff in the Ask code.** Rejected: a second amortization would drift from the loan page (daily interest,
  the lender's split, extra payments).
- **Fuzzy (edit-distance) matching.** Typos would match, but so would the wrong account between similar names; ties
  and no-match are cheaper to explain. It can be added inside `matchAccount` later.
