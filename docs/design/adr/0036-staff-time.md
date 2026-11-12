# ADR-0036: Staff time: vacation and sick leave, California daily overtime, contractor timesheets

- Status: accepted
- Date: 2026-11-11

## Context

Payroll (ADR-0034, PRL-01..22) pays hourly employees from the hours the owner types in, with overtime at 1.5× only on
hours typed in as overtime. The owner asked how to track employee vacation and contractor hours "so they are fairly
paid". Three things were missing:

- vacation and paid sick leave balances, which California requires for sick leave and treats as wages for vacation;
- California's daily overtime and double time, which a weekly total can't produce;
- contractor timesheets, so hours become a bill instead of a figure worked out elsewhere.

The owner enters everything; employees don't sign in. Montra calculates and records; it never moves money or files.
The business is on the cash method (ADR-0017 §1). The work state for state rules is California (ADR-0034).

## Decision

### 1. Leave is a ledger of hours, written when a pay run is approved

`leave_entry` holds signed hours per person and kind (`vacation`, `sick`). A balance is the sum. Entries come from:

- **the owner**: one opening balance per kind, for someone hired before Montra, and adjustments;
- **an approved paycheck**: the year's carry-over cut and grant, hours used, the accrual, and a final payout.

A paycheck's entries are written when its run is approved and deleted when the run is reopened, so reopening puts the
balance back exactly. A draft paycheck shows the same plan without writing it (`planLeave` in `@montra/domain`, one
pure function for both). Reopening an earlier run while a later one stays approved doesn't redo the later run's cap
check: re-approving the later run does.

Hours are thousandths of an hour, like `paycheck_line.hours_milli`. A year is the calendar year.

### 2. Policies per business, with California's sick leave minimum pinned in code

`leave_policy` has one row per business and kind:

- **method**: `none` (only entered hours and use move the balance), `accrual` (hours earned per hours worked, such as 1
  per 30) or `grant` (a yearly amount on 1 January, which is how a front-loaded sick policy is expressed);
- **max balance**: nothing more accrues or is granted above it;
- **carry-over limit**: on 1 January the balance above it is forfeited (applied on the year's first paycheck, to the
  balance dated before 1 January, and recorded even when zero so it happens once);
- **yearly use limit**: using more warns.

**California paid sick leave** applies by default to employees whose work state is California: with no sick policy
saved, they get the statutory minimum. The minimum is a dated table in `@montra/domain` (`CA_PAID_SICK_LEAVE` in
`leave.ts`), like the tax tables (ADR-0034 §7), so a law change is one reviewed PR with its tests. The figures were read
on 2026-11-11 from the California Labor Commissioner's "California Paid Sick Leave: Frequently Asked Questions"
(https://www.dir.ca.gov/dlse/paid_sick_leave.htm, updated 2025-12-31), which reflects SB 616 (in force 2024-01-01):

| Rule                    | Since 2024-01-01                                              | FAQ        |
| ----------------------- | ------------------------------------------------------------- | ---------- |
| Minimum a year          | 40 hours or 5 days, whichever is more                         | 1, 4       |
| Accrual floor           | 1 hour for every 30 hours worked                              | 13         |
| Other accrual schedules | 24 hours by the 120th day, 40 by the 200th                    | 13, 34     |
| Front-loading           | the full amount at the start of the year; no accrual needed   | 16         |
| Balance cap allowed     | 80 hours or 10 days, whichever is more                        | 13, 24     |
| Use cap allowed         | 40 hours or 5 days a year                                     | 13, 26     |
| Carry-over              | accrued leave carries over, subject to the balance cap        | 24         |
| First use               | from the 90th day of employment                               | 14         |
| At termination          | not paid out (unless policy says so); restored if rehired within a year | 17, 41 |
| Rate of pay             | the regular (non-overtime) rate                               | 30         |
| Notice                  | the balance on the pay stub or a document given the same day  | 36         |

Before 2024 the minimum was 24 hours / 3 days with a 48-hour / 6-day cap; that row is in the table for pay dates in
those years. Statute sections behind the FAQ are Labor Code §§245–249 (§246 for accrual, caps, the notice and payout);
leginfo.legislature.ca.gov refused automated reads, so the section letters weren't re-checked against the statute's
text.

Saving a sick policy that gives less than the minimum (in hours) is refused, with what falls short
(`sickPolicyShortfalls`). "5 days" can be more than 40 hours for someone whose day is longer than 8 hours; Montra checks
hours only, and the screen says to raise the figures for longer days. A front-loaded policy may drop last year's
balance on 1 January (carry-over limit 0); an accrual policy may not have a carry-over limit.

Exempt (salaried) employees are deemed to work 40 hours a week for accrual (2,080 hours a year over the pay periods),
less leave taken in the period. Hourly employees accrue on regular, overtime and double-time hours worked; leave hours
aren't work.

Using sick leave before the 90th day of employment, or past the yearly use limit, warns but doesn't stop the run: an
employer may advance leave (FAQ 15).

**Vacation** policy is the business's own. California vacation is wages once earned and can't be forfeited (Labor
Commissioner, "Vacation" FAQ, https://www.dir.ca.gov/dlse/faq_vacation.htm), so a carry-over limit is never applied to a
California employee's vacation; a balance cap is allowed and is how a California employer limits it.

### 3. Leave on the paycheck

A paycheck takes vacation hours and sick hours beside regular and overtime hours:

- **Hourly**: each is an earning line at the regular rate (`vacation`, `sick`), so it's wages for tax like any other.
- **Salaried**: gross doesn't change; the hours only reduce the balance.

Using more than the balance available before this paycheck's accrual warns, and approving is refused
(`payroll.leave_over_balance`) until the owner allows it on that paycheck (`leave_over_allowed`), which lets the balance
go negative.

The payslip shows each tracked kind: balance before, used, earned, paid out and balance after. That is the sick leave
notice FAQ 36 asks for on the pay stub.

**Ledger**: accrued vacation and sick leave are not posted. A cash-method business deducts pay when it's paid, so
leave reaches the books only as wages on the paycheck that pays it (ADR-0034 §6). The balances are records of hours,
not liabilities.

### 4. California daily overtime from a daily grid

For hourly employees, a paycheck can take hours for each day of the period instead of totals (`paycheck_day`,
`overtime_method = 'daily'`). `splitOvertime` in `@montra/domain` works out regular, overtime and double-time hours:

- **California** (Labor Code §510; Labor Commissioner "Overtime" FAQ, https://www.dir.ca.gov/dlse/faq_overtime.htm):
  over 8 hours in a workday up to 12 at 1.5×; over 12 at 2×; over 40 straight-time hours in a workweek at 1.5×; on the
  seventh consecutive day worked in one workweek, the first 8 hours at 1.5× and the rest at 2×.
- **Elsewhere** (FLSA): over 40 in a workweek at 1.5×.

Weekly overtime counts only straight-time hours toward the 40, so no hour is paid as overtime twice. A workweek starts
on the business's chosen day (`payroll_settings.workweek_starts`, Sunday by default) and can cross pay periods: days
already paid on the person's previous paycheck in the same workweek count toward the 40 hours and the seventh day,
but aren't paid again. Double time is a new earning line (`double_time`, 2× the rate). Vacation, sick and holiday
hours are never hours worked.

The totals path stays for people who enter them. The paycheck says which method it used. Alternative workweek
schedules (four 10-hour days by election) aren't supported: such a business enters totals.

### 5. Contractor timesheets become one bill

A contractor's hourly rate is the person's own `rate` with pay type `hourly` (already on `payroll_person`).
`contractor_time` keeps date, hours, a note and, optionally, the customer the hours were for. "Bill these hours" turns
chosen unbilled entries into one bill (BIZ-06) to the contractor's vendor record for hours × rate, to the business's
Contract labor category (Schedule C line 11) unless another is chosen. The entries record the rate billed and the bill.
A trigger refuses changing or deleting them while their bill stands; voiding the bill frees them to bill again.

Contractors reach the 1099-NEC through the bill when it's paid, as before (ADR-0034 §7b); nothing changes there.

Hours with a customer link to New invoice for that customer (the invoice form already takes a customer); the hours
aren't copied onto the invoice, because the contractor's rate isn't the customer's price.

### 6. Final pay

When a person's end date is on or before the period's end, the paycheck is their final one. It shows the vacation
balance after this paycheck's use and accrual and offers to pay it out: hours × the final rate (the hourly rate, or the
salary over 2,080 hours), as a `vacation_payout` earning. For a California employee the screen says unused vacation is
wages that must be paid with the final pay (Labor Code §227.3). Sick leave is never offered (FAQ 41).

## Consequences

- A change in California's sick leave law needs a new row in `CA_PAID_SICK_LEAVE` and a release; the owner should
  check the Labor Commissioner's page each January, as for the tax tables.
- Balances depend on runs being approved in pay-date order. Reopening an older run and approving it again re-plans only
  that run.
- Leave is per calendar year. A business that measures sick leave by hire anniversary sees the yearly use limit and
  front-load grant on 1 January instead.
- No accrued-vacation liability is on the balance sheet. An accrual-basis report would have to work it out from the
  balances times rates.
- Sick leave is paid at the base hourly rate, not the 90-day blended rate an employee with overtime or commissions may
  be owed (FAQ 30); the owner can add the difference as another earning.

## Alternatives considered

- **Balances worked out on read from paychecks**, as deposits and worksheets are (ADR-0034 §7a). Caps and carry-over
  make a balance depend on the order of events, so the result of each paycheck is stored instead and removed on reopen.
- **Sick leave rules as reference data.** As with tax tables, a reviewed TypeScript table with tests won over loading
  without a release.
- **Posting accrued vacation as a liability.** Correct for accrual books, but it would deduct pay before it's paid on
  the cash-method Schedule C.
- **Overtime from daily hours for every state.** Only California has daily overtime among the states payroll supports;
  others use the federal weekly rule from the same grid.
- **Copying contractor hours onto a customer invoice.** The contractor's cost isn't the customer's price, so the hint
  only opens a new invoice for the customer.
