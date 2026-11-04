# ADR-0016: Payslips

- Status: proposed
- Date: 2026-11-03
- Phase: 7

## Context

Phase 7 adds employers and payslips (PAY-01..09) and reports by family member (FAM-08, FAM-09, RPT-01). Design 04 §14
gives the posting and 04 §9 says the deposit "becomes" the payslip's checking posting. Several things were open:

- how a payslip relates to the transaction and to an imported deposit;
- what a partner sees, given that PAY-09 makes payslips private but the pay lands in a possibly shared account;
- where taxes and deductions post, and how take-home budgets (04 §8) stay on net pay;
- how payslip documents reach the AI.

Reading the code raised one more point: the `transaction` table's RLS has no restricted rule, and the DTO exposes its
`spec` (amount and splits) to anyone who can read the entity. So nothing private can live in a transaction row.

## Decision

1. **The payslip is its own record; its entry hangs off an ordinary transaction.**
   - `employer`, `payslip` and `payslip_line` (migration 0017) hold the detail. A payslip is a draft until confirmed,
     and only a payslip that adds up (gross − deductions = net) can be confirmed.
   - Confirming posts one journal entry (PAY-05) to a transaction whose `spec` states only the bank fact: net pay
     into the account, categorized as income, with `payslipId` set. Since the spec keeps type `standard`, deposit
     matching, the forecast and recurring detection all see it as the deposit it is.
   - A transaction with `payslipId` can't be edited as a transaction, because its entry doesn't come from its spec.
     Changes go through the payslip.

2. **The net-pay line is public; everything else is private.**
   - The entry is restricted to the member (owners and the member's linked user), except the deposit line
     (`posting.public_line`). That line is what the statement already shows anyone with access to the account.
   - Hiding it would make a shared checking account's balance and register wrong for the partner: an imported
     deposit they could already see would vanish when the payslip claimed it.
   - Partners therefore see "ACME Payroll +$3,412.50" in the register, as they would without any payslip. They don't
     see gross pay, taxes, deductions, the employer's record, the payslip or its files.
   - Postings now decide visibility from their own columns, and an entry with a public line is readable (date and
     description only), so the line appears in the register.

3. **Matching the deposit (PAY-04).**
   - On confirm, deposits within ±3 days of the pay date, for exactly the net amount, into the employer's account,
     are candidates. One candidate is taken over: its entries are re-posted as the payslip's, and its original spec is
     kept so deleting the payslip restores the plain deposit. So the deposit is never counted twice.
   - Several candidates are shown for the user to choose. None creates a new transaction, which a later import
     matches through the normal duplicate check.
   - Reconciled or closed deposits go through the DE-10 rules like any edit.

4. **Where the lines post.**
   - Earnings credit the income category (Salary by default). Taxes and non-savings deductions debit categories in a
     `system`-kind group, "Payroll taxes and deductions", created on first use. Retirement and health savings debit an
     investment account for that employer, also created on first use, so they count in net worth.
   - Employer contributions stay on the payslip as memo lines. Posting them (04 §14 "when the user opts in") isn't built.
   - Budget income is take-home: income categories minus that system group. Budget activity already excludes system
     groups, so payslip taxes never count as spending (04 §8).

5. **Documents reach the AI only with permission (PAY-09, UP-06).**
   - Images go to the provider only with "Allow documents" on, in builtin or BYOK mode. Otherwise the doc-worker OCRs
     them first, and only masked text goes out: Social Security numbers, account numbers and long digit runs are masked,
     and member names replaced with pseudonyms.
   - The result is always a draft for the user to check. Files have their own payslip-gated route.

6. **Expected income follows the payslips (PAY-07).** Confirming a payslip creates or updates one `expected_income` row
   per employer: anchored on the first pay date, with the median net of the last three payslips. A missing payslip is
   already "late income" for REC-04; a net more than 10% under the pattern now triggers it too.

7. **A payslip owns its transaction.**
   - Edits that reach the ledger are refused with `payslip.managed` and go through the payslip. Notes and tags stay
     editable. The check runs before the spec is merged, because the merged spec loses `payslipId`.
   - Undoing an import keeps a deposit a payslip has taken over and reports it (`kept`, reason `payslip`). Deleting the
     payslip gives the deposit back, and the import can't be undone again for it, so the user deletes it by hand.
   - The spec also carries `employerId`, an opaque id. It lets a partner's view and the owner's agree on which expected
     income a deposit fulfils, without reading the private `payslip` table. A payslip's deposit is its employer's pay
     whatever the statement calls it, and never another income's.

## Consequences

- A partner can work out net pay from a shared account. That's true of any bank statement, and PAY-09 protects the
  payslip's data, not the bank's. A household that wants net pay private needs the pay to land in an account in books
  the partner can't read.
- `expected_income` rows are visible to anyone who can read the entity, and they show expected net pay. Same reasoning.
- Report totals differ by viewer, as RLS intends: a partner's "by member" report has no restricted income.
- Foreign-currency payslips (pay currency differing from the entity's) are refused for now.
- The retirement account a payslip creates is an ordinary account, so its name is visible to a partner, with no balance
  from restricted lines. Its name repeats the employer's, which the deposit's payee usually shows anyway.
- Payslips aren't stored on the phone: no offline list and no capture queue, unlike receipts.

## Alternatives considered

- **Hide the whole entry, including net pay** (the earlier reading of PAY-09): breaks the partner's balance and
  register on shared accounts, so rejected.
- **Two entries** (a public deposit against a clearing account, plus a restricted breakdown): correct balances, but
  PAY-05 asks for one entry, and a clearing account adds a balance users must never see.
- **A new `payslip` spec type**: every consumer of `spec` would need a new case, and each one missed would silently drop
  the deposit from matching or forecasts.
