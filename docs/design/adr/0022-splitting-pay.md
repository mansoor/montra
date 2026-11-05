# ADR-0022: Splitting pay across accounts

- Status: proposed
- Date: 2026-11-04

## Context

People often split their pay at the payroll level: a fixed amount to a savings account for college or a vacation, and the rest to checking.
Until now a payslip had one deposit account, posted its whole net there, and matched one bank deposit (PAY-04). That can't describe a split: the
statement shows several deposits, in several accounts.

The ledger has rules this has to fit: one journal entry per entity per transaction (ADR-0005), a transaction states one bank fact on one account
(ADR-0016), and a payslip's details stay private while its deposit line stays visible (PAY-09).

## Decision

1. **Fixed amounts, and the rest to the main account.** This is how payroll systems work. An employer has a plan, each new payslip starts from it, and one
   payslip can differ before it's posted. Percentages aren't supported yet.
2. **Each deposit is its own transaction**, with its own balanced entry: the deposit against the income it takes. Each one is then an ordinary bank line, so
   registers, reconciliation, offline sync and matching work as they do today, and each can take over its own imported statement line.
3. **No clearing account.** The main entry's income is reduced by what the others take, biggest earning first. So income in total is exactly the payslip's gross,
   and taxes and deductions stay on the main entry. The alternatives below needed either a new account or changes through the whole ledger.
4. **PAY-05's "one journal entry" becomes one per deposit.** With no split, the entry is exactly what it was, and there's a test for that.
5. **Something has to go to the main account.** The payslip's main transaction is what it hangs on, and a split of the whole net is refused.
6. **A split can't change after posting.** Each part is a transaction by then, perhaps a taken-over statement line. To change it, delete the payslip and enter it again.
   A corrected net on a posted payslip still works, and changes only the main account's share.
7. **Same books and currency.** The accounts must be bank accounts in the payslip's books and currency, because payslips don't convert.
8. **A goal needs no link.** A goal measures its linked accounts' balances (`goal.linked_account_ids`), so money arriving in one counts by itself.

## Consequences

- A forecast still expects the whole net in the main account (`expected_income`), so per-account forecasts overstate it and understate the others, and a low-balance warning on the main
  account can come late. Total income in the budget stays right.
- Payslip privacy is unchanged: each deposit shows only the bank fact, and the split's rows are behind the same policies as the payslip.
- A journal view shows two or more entries for a split payslip, and income is spread across them.

## Alternatives considered

- **One entry with several deposit lines.** The closest reading of PAY-05, but a transaction names one account throughout: registers, matching, DE-10's edit rules, the sync projection and reconciliation
  would all need changing, and one entry couldn't take over several statement lines.
- **A clearing account ("pay in transit").** Keeps one main entry, but adds a system account that shows up in the books and trial balance, for no benefit to anyone reading them.
- **Post everything to the main account, then transfer out automatically.** Simple, but false: the bank never showed that money there, and the main deposit would no longer match the statement.
