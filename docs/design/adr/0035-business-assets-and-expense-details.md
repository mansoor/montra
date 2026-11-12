# ADR-0035: Business assets, who spent, meal details and mileage by driver

- Status: accepted
- Date: 2026-11-11

## Context

The owner asked how Montra handles equipment purchases, equipment handed to staff, client meals, who spent the money and
whose trip it was. Before this change:

- the only depreciation was the Schedule E helper for rentals (`app.depreciation_schedule`, RNT-09). It stays out of the
  ledger, and Schedule C had no line 13;
- nothing tied equipment to a person;
- a meal had no attendees or business purpose, though the IRS expects both on the record;
- `memberId` on a posting is a household family member, not an employee, so "who spent" didn't exist for a business;
- a trip had a free-text vehicle and no driver. Every trip was the owner's standard-mileage deduction, so an employee's
  trip reimbursed through payroll would have been deducted twice.

The scope is US federal tax plus California, as for payroll (ADR-0034). Montra works the figures out and records them. It
doesn't give tax advice, move money or file anything.

## Decision

### 1. An asset register per business, in the ledger

`app.business_asset` holds each asset with its name, category, serial or tag, cost, the date it was placed in service,
its method and recovery period, an optional Section 179 amount the owner typed, and an optional link to the purchase. An
asset belongs to one business, like every business table (ADR-0017 §6).

Four accounts are made the first time a business needs them, and found again by subtype, as payroll does (ADR-0034 §6):

| Subtype                                   | Type    | Name                         | Tax line                 |
| ----------------------------------------- | ------- | ---------------------------- | ------------------------ |
| `business_asset:fixed_assets`             | asset   | Equipment and fixed assets   | none                     |
| `business_asset:accumulated_depreciation` | asset   | Accumulated depreciation     | none (a credit balance)  |
| `business_asset:depreciation`             | expense | Depreciation                 | Schedule C line 13 (new) |
| `business_asset:gain_loss`                | income  | Gain or loss on assets sold  | none (Form 4797)         |

### 2. Capitalizing a purchase reuses the payment take-over

When the asset is linked to a purchase, recording it moves its cost out of the purchase's expense category into
`fixed_assets`. This is the same path as linking a bank line to a bill (ADR-0017 §3), `PaymentLinks.takeOver`:

- the transaction keeps its date, amount and account;
- its splits are rewritten, with the cost taken from its business expense splits (largest first) and added as a split to
  `fixed_assets`;
- it's re-posted through `TransactionPoster`, so the DE-08..10 rules for reconciled entries and closed periods apply
  unchanged. A reconciled line gets an adjustment, and a line in a closed period is reversed in the first open one;
- the spec gets `assetId`, so the asset owns the transaction (`managedBy: 'asset'`) and its category can't be changed
  under the register. The spec as it was before is kept on the asset, and deleting the asset restores it.

One purchase makes one asset. A purchase that is already owned by something else (a bill, a paycheck) can't be
capitalized.

An asset with no purchase, such as equipment the owner already had and brought into the business, is posted as an owner
contribution on its in-service date: debit `fixed_assets`, credit Owner contribution.

The **expense now** method doesn't move anything: the purchase stays an expense in the year it was paid, and the register
keeps the item only so it can be assigned and tracked. It's allowed up to the de minimis safe harbor of $2,500 per item
(Treas. Reg. §1.263(a)-1(f), for a business without audited financial statements). Above that, the owner chooses a
depreciation method.

### 3. Depreciation methods and amounts

These live in `@montra/domain` (`assetDepreciationForYear`), as bigint minor units, worked out from the running total,
so the years add up to the cost exactly:

- **Straight line**, over the recovery period with the half-year convention: half a year in the first year and half in
  the year after the last. Software is the exception: it's straight line over 36 months from the month it was placed in
  service (IRC §167(f)(1)).
- **MACRS half-year**, from the percentages in IRS Publication 946, Table A-1, for 3-, 5-, 7- and 10-year property. Not
  offered for software.
- The default recovery periods follow Publication 946's classes: 5 years for computers and vehicles, 7 for furniture,
  equipment and anything else, 3 for software. The owner can choose another (3, 5, 7 or 10).
- **Section 179:** Montra doesn't hold the yearly limits or the phase-out, because it can't source and keep them current.
  The owner types the amount they elect, up to the cost, and it's deducted in the first year. The rest of the cost is
  depreciated by the chosen method.

What isn't modelled is said on the screen and in the note "Not tax advice; confirm with your accountant": the mid-quarter
convention, bonus depreciation, the Section 280F caps on cars, business-use percentages below 100%, and the yearly
Section 179 limits.

### 4. Yearly depreciation is a journal entry of kind `depreciation`

"Post depreciation through a year" catches every asset up to that year. It writes one journal entry per asset and
year: debit Depreciation, credit Accumulated
depreciation, dated December 31, or the disposal date in the year it's disposed of. It has no transaction, like a manual
journal (DE-07). `app.asset_depreciation` records which years are posted, so a year can't be posted twice. Un-posting a
year deletes its entry, and the period lock refuses that for a closed year.

Because the Depreciation account maps to the new line 13 (`US_SCH_C_L13`), the Schedule C summary, the P&L and the tax
estimate include it with no special code. The landing page's money in and out already leaves `depreciation` entries out.

### 5. Disposal writes off book value and shows the gain or loss

Disposing of an asset records the date, the proceeds and a note:

- the years before it must be posted first, so the book value is right, and none after it may be;
- first, the depreciation for the disposal year (half a year, or the months to the disposal month for software). A full
  year already posted for it is replaced;
- then one entry: debit Accumulated depreciation by what was taken, credit Fixed assets by the cost, and debit Gain or loss
  by the book value written off;
- proceeds, when there are any, are a deposit. Either an existing bank line is taken over, as above, or a new one is made on
  the chosen account. Its split goes to Gain or loss. A gain is proceeds above book value, and a loss is the opposite.

Schedule C leaves Gain or loss out: a sale of business property goes on Form 4797. The summary shows it separately
(`assetSales`), so the owner can see where it went. Undoing a disposal deletes those entries and lets the deposit go.

### 6. Assets are assigned to people, with history

`app.asset_assignment` gives an asset to a payroll person (ADR-0034), employee or contractor, from a date, until it's
returned. One open assignment at a time, enforced by a partial unique index. The person's name is copied onto the row,
as a paycheck does, because readers of the register can't read payroll records.

A person's page lists what they hold. An end date can't be saved on a person while they hold something: the owner marks
it returned first. There are no stock counts, and resale inventory and cost of goods sold are out of scope.

### 7. Expense details belong to the transaction, beside the ledger

`app.expense_detail` keeps one row per transaction, outside the stored spec, so the poster and its lock rules never see
it:

- **Spent by** is the owner or a payroll person. This is separate from the household `memberId`;
- **attendees** are free-text names plus customers and vendors of the business;
- the **business purpose**.

It's a property of the business that the transaction is in, and `TransactionDto.expenseDetail` carries it to the web and
the phone. Its change-feed key starts with the transaction id, as `transaction_tag`'s does, so phones pull the
transaction again when it changes.

A transaction is a meal when one of its business splits maps to line 24b. A meal without attendees or a purpose shows a
gentle hint, "The IRS expects who and why", and nothing is refused.

"Expenses by person" adds up business expense postings by who spent, with the owner, each person and "not set" as rows.
The transaction list filters on it with `spentBy`.

### 8. A trip has a driver, and an employee's trip isn't the owner's deduction

`mileage_trip.driver` is `owner` or `person`, and a person's trip keeps a link to them and their name. Only the owner's
trips are the standard-mileage deduction: Schedule C line 9 and the tax estimate leave the others out. A person's trip
shows what it would be worth at the IRS rate for its date, and **Reimburse this trip** turns that into an approved
payroll reimbursement (ADR-0034 §8). An employee's is paid untaxed on the next pay run, and a contractor's becomes a bill.
It posts to a "Mileage reimbursements" category on line 9, made on demand. The "mileage and actual car expenses" warning
ignores that category, because the owner's vehicle isn't involved.

A reimbursed trip's date, miles and driver are fixed until the reimbursement is declined, so the two can't disagree.

## Consequences

- Line 13 is new reference data. `loadReferenceData` inserts it on the next migrate.
- `TransactionOwner` gains `asset`. `ownerOf`, `NOT_OWNED` and the import undo's kept reasons pick it up from
  `OWNER_FIELDS`.
- `TransactionDto` gains `expenseDetail`, and `ScheduleCDto` gains `assetSales`. Web fixtures and phone types change with
  them.
- Rentals keep their own off-ledger depreciation helper (RNT-09). The two don't share tables: Schedule E's mid-month
  27.5/39-year rules aren't these.
- Not built: bonus depreciation, mid-quarter convention, listed-property limits, partial business use, several assets from
  one purchase, inventory, Form 4562 and Form 4797 themselves.
