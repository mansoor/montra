# ADR-0025: Retirement accounts, market value and gain over time

- Status: accepted
- Date: 2026-11-07

## Context

The owner asked for:

- a 401(k) account that payslips feed;
- the employer's contributions counted in it;
- statements for the rest of what happens to it;
- gain over time as a chart and a table.

Some of this existed. Payslip savings lines already posted to one auto-created "<employer> retirement" account, but every
savings code went there, HSA included. Employer contributions were memo lines only (ADR-0016). A balance update went to
opening-balance equity, so growth couldn't be told apart from a correction.

R1 §14.2 put "investment performance analysis" out of scope. The owner moved it into scope on 2026-11-06, at account level, with
no holdings, no prices and no advice (NFR-14).

## Decision

1. **A plan is a field on `investment`, not a new kind (ADR-0023 §3).** The plan types are brokerage, 401(k), Roth 401(k), 403(b),
   IRA, Roth IRA, HSA, 529, pension and other. A workplace plan can name the employer whose payslips pay into it.
2. **Payslip savings lines go to the best-fitting linked plan.** A 401(k) line goes to a 401(k), then a 403(b), then a Roth 401(k),
   and an HSA line goes to an HSA (`PAYSLIP_PLAN_ROUTES`). Without a fitting plan, a line goes where it went before. Payslips already
   posted don't move.
3. **The employer's contributions post when an account says so.** A match posts into a fitting plan that has
   `employer_contributions`, against an "Employer contributions" income category. The payslip records what it posted, and budgets
   add that to what was withheld. So the match counts as income, which it is, but not as take-home pay to budget with.
4. **Market value is a separate entry kind, against equity.** `valuation` entries post to a new system account, "Investment gains
   and losses", on every entity. A change in value moves net worth and never income or budgets, as the owner decided. The
   cash-flow chart leaves it out of money moved into savings.
5. **Each statement value is kept** (`account_valuation`), with the change it posted. The change is what the ledger lacked that day,
   so contributions already recorded aren't counted twice, and anything unrecorded counts as gain. Values must be in date order,
   none in the future: an earlier one would change what a later one meant. Only the latest can be taken back, by posting its change
   the other way.
6. **Gain is worked out on request from those entries.** Money in and out is every other change. The return weighs money by how
   long it was in (modified Dietz), and periods over a year also show a yearly rate. These are figures, labelled as such.
7. **Privacy.** A partner can't read a member's payslip postings (PAY-09). A value or gain worked out from what they can see would
   be wrong, and could reveal private pay. If an account has postings this user can't read, the gain view shows nothing and value
   updates are refused. `app.account_has_hidden_postings` answers this as a definer function, executable by `montra_app` only.

## Consequences

- An HSA line reaches an HSA only once one is linked. Until then it goes to the employer's retirement account as before.
- Money put into an IRA or brokerage account by transfer counts as money in. Money that was never recorded counts as gain until it
  is. The account page explains this.
- The phone shows the gain, return and money in (or the hidden message) but not plans or value updates; those are set on the web.
- PDF statements aren't read. Values are entered or pasted as date and value lines.
- **A bug in posting payslips is fixed here:** one payslip builds its entries more than once, and the employer's retirement account,
  made on first use, could be made twice. It was reachable from split pay (ADR-0022) and became certain with recording employer
  contributions.

## Alternatives

- **Holdings and prices.** These are out of the owner's scope, and would need data the app doesn't have.
- **Valuation to opening-balance equity.** Growth would be indistinguishable from a correction, so a gain couldn't be found.
- **Valuation as income.** Budgets and income reports would swing with markets. The owner chose not to count it as income.
