# ADR-0017: Small business: cash basis, invoices and bills beside the ledger

Status: accepted (2026-11-03)

## Context

Phase 8 adds invoices, bills, mileage, Schedule C and estimated tax (BIZ-01..13). The ledger already records what moves
through bank accounts. The question is how much of a receivable or payable belongs in it, and what happens when the bank
statement arrives after the invoice does.

The users are sole proprietors and very small LLCs, who overwhelmingly file Schedule C on the cash method.

## Decision

1. **Cash basis, in the ledger and the reports.** An invoice or bill posts nothing until it's paid. Income is what was
   received and an expense is what was paid, in the period the cash moved. There are no accounts receivable or payable.
   What's owed lives in `invoice` and `bill`, which feed the forecast and calendar.

2. **Status is derived.** `invoice.status` stores only `draft`, `sent` or `void`. Paid, partial and overdue are computed
   from `invoice_payment` and the date, so they can't drift from the payments.

3. **Payment takes over the deposit, like a payslip (ADR-0016).**
   - A deposit that pays an invoice keeps its own date and amount. Its splits are replaced by the invoice's income
     categories, plus sales tax to a liability, and its old spec is kept so unlinking restores it. A bill does the same
     with its expense category.
   - Partial payments are split across the invoice's lines cumulatively (`allocatePayment`), so the parts add up to the
     cent once it's fully paid.
   - While linked, the transaction belongs to the invoice or bill. Ledger edits and deletion are refused (`invoice.managed`,
     `bill.managed`), and undoing an import keeps it. Notes and tags stay editable. The check is shared with payslips.

4. **Matching links only what's unambiguous.** `autoMatch` links the one exact pair, or a statement line that quotes an
   invoice number. Two invoices or two deposits for the same amount, and partial payments with no reference, are offered
   to the user. A wrong automatic link would misstate income, which is worse than asking. A deposit pays one invoice in R1:
   one cheque covering two invoices needs two entries by hand.

5. **Mileage is a deduction, not a transaction.** No cash moves, so it reaches Schedule C line 9 and never the ledger. Each
   trip keeps its rate. Rates apply from a date, not to a year, because they change mid-year (2022 and 2026 both did). The
   Schedule C warns when a business has both a mileage deduction and actual car expenses, as a user can't normally claim
   both on the same vehicle.

6. **Customers and vendors are scoped to the business.** `app.payee` is workspace-wide, so contact details there would
   reach a household partner with no grant on the business. `business_party` is entity-scoped. Payees with activity are
   listed from their postings without a row, so the directory is always current without a background job; a row is created
   when the user adds details or invoices one.

7. **Tax numbers are estimates the user asked for.** The set-aside is `max(0, profit after mileage) × the user's own
   rate`, so it agrees with Schedule C. Deductible
   shares (meals at 50%) are hints shown beside a line, and the report doesn't apply them to the total. AI proposes tax
   lines for categories without one (AI-10), and only the user maps them.

8. **The export is a file, not an integration.** Plain CSV and XLSX of the journal, a QuickBooks Desktop IIF journal and a
   Xero manual-journal CSV. Account names won't match another chart exactly, so the importing tool will ask to map them.

## Consequences

- A cash-basis P&L shows nothing for work invoiced but unpaid, which is correct for the filing and can surprise a user
  reading it as a measure of sales. The overview shows open invoices beside it.
- An accrual-method business can't use the reports as filed. Accrual is a later, larger decision: it would add receivable
  and payable postings at issue.
- Sales tax collected sits in a liability account, out of income. Filing and remitting it is out of scope (BIZ-14 is a
  could-have). A payment to the state is recorded against that account.
- Foreign-currency invoices and bills are refused for now, as with payslips.

## Alternatives considered

- **Accrual entries at invoice date**: correct for accrual filers, but adds receivables that every sole proprietor would
  have to understand, and a second posting path for each payment.
- **An `expected_item` table for all expected money** (design 03): rent, invoices, bills and payslips differ enough in their
  windows, amounts and effects that one table would be mostly nullable columns. Each has its own table; the forecast reads
  them through one function.
- **Customer details on `app.payee`**: simplest, but leaks across entity grants.
- **A nightly job building the directory**: stale between runs, and it would write rows for payees nobody cares about.
