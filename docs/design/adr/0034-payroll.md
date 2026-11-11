# ADR-0034: Payroll for businesses: Montra calculates, the owner files and pays

- Status: accepted (stage 1 built; stages 2–4 follow this ADR)
- Date: 2026-11-10

## Context

R1 listed payroll processing as out of scope (requirements 14.2), and BIZ-15 only imports a provider's CSV. On 2026-11-10
the owner moved payroll into scope for business entities (requirements 5.1, PRL-01..22) and decided:

- **Jurisdictions:** federal and one state, California (the owner chose it on 2026-11-10; others later).
- **Tax engine:** built into Montra behind a port, so a payroll provider (Check, Gusto Embedded and the like) can replace it.
- **Money and filing:** Montra works out what is owed, when to deposit it and what goes on each form. The owner pays through
  EFTPS and the state's portal, and files with the IRS, SSA and the state. Montra never moves money or e-files.
- **Personal data:** Montra keeps the forms and copies of identity documents.

The businesses are the ones R1 serves (ADR-0017): a sole proprietor or small LLC with a handful of people, on the cash
method. Payroll handles the most sensitive data in the product (SSNs, dates of birth, passports, bank details) and some of
its most consequential arithmetic.

## Decision

### 1. Who does what

Montra records people and their forms, runs pay, posts to the ledger, says what to deposit and by when, and fills in
worksheets and year-end forms. It doesn't move money, e-file, run E-Verify, or tell anyone what they owe as advice: every
figure is labelled as an estimate for the owner's records, worded as AI-10's tax hints are ("not tax advice"). The screens
say so where it matters, and the I-9 screen says the employer must examine the original documents.

### 2. People belong to one business, and only its writers see them

`payroll_person` holds employees and contractors (`kind`), scoped to an entity like every business table (ADR-0017 §6).
Contact details stay off the workspace-wide `payee`. A contractor is tied to a vendor in `business_party`, so the existing
bills (BIZ-06) pay them and their totals reach the vendor report.

Personal-data tables (people, W-4, W-9, I-9 and its documents) use `app.can_write_entity` for reading as well as writing.
An accountant with read-only access to the business sees pay runs and totals (stage 2) but no one's SSN or address.

### 3. Personal data is sealed, masked and every look is logged

- SSNs and other TINs, dates of birth, identity document numbers, A-numbers, I-94 and passport numbers, and bank routing
  and account numbers are `_enc` columns, sealed by `FieldCrypto` with the workspace data key. Their column name is bound in
  as associated data, as for every other `_enc` column. The audit trigger already redacts `_enc` columns.
- The last four digits of a TIN or bank account are kept in the clear (`*_last4`), so lists can show `•••-••-1234`
  without decrypting anything.
- Reading a full value takes a separate request (`POST …/reveal`), needs a recent sign-in (AUTH-09), and writes an
  `audit_log` row naming the field. The same applies to downloading a filled form, because it carries the full TIN.
- **Copies of identity documents** are `app.file` rows marked `sealed`. Their bytes are sealed with the same key, bound
  to the file's id, before they reach `StoragePort`, so storage alone (S3, MinIO or the user's own storage) never holds a
  readable ID. `sha256` and `bytes` describe the plain file. Serving one goes through the I-9 it belongs to and is logged.
  A backup decrypts sealed files into the archive, as it does `_enc` columns (ADR-0019 §7), so a restore under a new
  workspace key still opens them; the archive's own passphrase protects them there. Restore seals them again. A flag
  rather than a new file kind keeps the kind list, which other work extends, out of this change.

### 4. Forms are substitute renderings, filled from what was entered

Montra renders its own PDF of each form (pdf-lib, as for invoices), with the official form's fields, wording of the
certifications and order. It doesn't redistribute or overlay the agencies' PDFs.

- Substitute W-9s are allowed outright, and substitute W-4s when they carry the same information and certification.
- An electronically generated I-9 is allowed when it keeps the form's content and sequence (8 CFR 274a.2(e)–(i)).
- A signature is the typed name and date, with an attestation tick and the audit log row of who recorded it. An employer
  that prefers ink prints the PDF and has it signed.
- Only the 2020-and-later W-4 is supported. An employee still on a pre-2020 W-4 is recorded with a new one; the
  pre-2020 computation in Pub 15-T (Worksheet 1B) is not built.
- Forms are kept as history: a new W-4 supersedes the last from its effective date, and pay runs use the one in force on
  the pay date.

### 5. I-9 retention is worked out, not stored

The employer keeps an I-9 and its copies until the later of 3 years after the hire date and 1 year after employment ends.
Montra works that date out on read from `hire_date` and `end_date`, so correcting either moves it. Until the date has
passed, deleting the I-9 or its copies is refused; afterwards, the I-9 is listed as one that may be destroyed, and the
owner chooses. While someone is still employed, there is no destroy date.

### 6. Pay goes to the ledger on the cash method (stage 2)

Each employee's paycheck in an approved pay run posts as one transaction in the business, by ADR-0005:

- debit wages (gross) and any reimbursement's expense category;
- credit the bank account chosen for the run with the net pay;
- credit liability accounts with what was withheld from the employee (federal and state income tax, the employee's
  Social Security and Medicare, and other deductions owed to someone else).

The employer's own taxes (its Social Security and Medicare share, FUTA and SUI) are not posted at pay time. They are owed
and shown on the deposit schedule, and they post as an expense when the owner records the deposit, together with the
withheld amounts it clears. That keeps Schedule C on the cash method (ADR-0017 §1): expenses are deducted when paid. One
paycheck per transaction lets a bank line for each paycheck match its transaction, as payslips do (ADR-0016).

A pay run is a draft until it's approved. Approving posts it, and a posted paycheck is owned by the pay run
(`payroll.managed`), as a paid invoice owns its deposit.

### 7. The tax engine is a port (stages 2–3)

`PayrollTaxEngine` takes the employee's W-4 and DE 4, the business's settings, the pay frequency, this paycheck's wages
and before-tax deductions, and the same for the year to date. It returns each tax with its base and amount, and notes
for the owner. A provider adapter would implement the same port, and pay runs store only the results, so changing
engines changes no stored data.

The built-in engine (`montra`, stage 3) is pure functions in `@montra/domain` (`payroll-tax.ts`):

- federal income tax by Pub 15-T Worksheet 1A, the percentage method for automated systems, on the annual tables;
- Social Security to the yearly wage base, Medicare, and Additional Medicare over $200,000 (employee only);
- FUTA at the net 0.6% on the first $7,000;
- California income tax by the EDD's Method B on the table for the pay frequency, SDI with no wage limit, and UI at the
  business's own rate and ETT on the first $7,000.

**The tables are code, not reference data.** Each year's tables are a TypeScript module (`payroll-tax-tables.ts`)
transcribed from Pub 15-T and the EDD's schedules, with money as strings parsed to cents and rates in parts per million.
The tests run the agencies' worked examples against them (EDD Method B examples A, B, C, E and F), and Pub 15-T, which
gives no worked example for Worksheet 1A, is checked line by line in the test comments. A table in the database would
let a year be loaded without a release, but the engine would then need the database to be tested, and a wrong
transcription would arrive unreviewed. A new year is a pull request with its tests. A pay date in a year with no tables
gets no computed taxes and a note on the paycheck saying to enter them.

Decisions inside the engine:

- **Before-tax deductions have two codes.** `retirement` (401(k), 403(b)) comes out of income-tax wages only;
  `section125` (a cafeteria plan's health, dental, FSA or HSA) comes out of every wage base here, California's included.
- **Each division is rounded to the cent, half up.** Pub 15-T allows rounding to the dollar; cents keep the payslip exact.
- **Supplemental pay is taxed with regular pay** (the aggregate method). The 22% flat rate isn't offered yet.
- **No W-4:** single, standard schedule, no adjustments. **No DE 4:** single with no allowances, as the DE 4's
  instructions say. Both are noted on the paycheck.
- **Another work state:** federal taxes are worked out and a note says to enter that state's.
- **FUTA credit reduction** is a state's extra FUTA on Form 940 Schedule A, owed with the fourth quarter. California's
  2026 figure (1.5%) is the Department of Labor's provisional list until it publishes the final one after November 10,
  so the table marks it provisional and the 940 worksheet says to check it.

### 7a. Deposits and worksheets (stage 3)

What's owed is never stored: it's worked out from approved paychecks each time, so reopening a run moves it.

- **Federal 941 taxes** (income tax withheld, both shares of Social Security and Medicare) follow the business's schedule:
  monthly, due the 15th of the next month, or semiweekly, Wednesday-to-Friday paydays due the next Wednesday and
  Saturday-to-Tuesday paydays the next Friday, with at least three banking days and never across a quarter (Pub 15
  §11). A single day's $100,000 is flagged for the next-day rule.
- **FUTA** is due by the end of the month after a quarter once more than $500 is owed, else carried forward; the fourth
  quarter, with any credit reduction, is due with Form 940.
- **California PIT and SDI** follow the schedule set for them (quarterly, monthly or semiweekly, which the EDD ties to the
  federal schedule and the amounts withheld). **UI and ETT** are quarterly.
- Due dates move to the next banking day past weekends and federal holidays (and DC's Emancipation Day).

The owner records a deposit after paying it in EFTPS or the EDD's e-Services. That stores the amount by tax code and
posts one transaction: the bank pays, what was withheld leaves its liability, and the employer's share is expensed to
*Payroll taxes* (Schedule C line 23). The transaction is owned by the deposit (`payroll_deposit.managed`), and removing the
deposit voids it unless it's reconciled or in a closed period. One deposit per tax and period: a change after paying
shows as a difference to settle.

The 941, 940, DE 9 and DE 9C worksheets are filled from the same paychecks. Wage bases on them (Social Security up to
the wage base, Additional Medicare, FUTA and UI up to $7,000) are worked out again from each person's paychecks in pay-date
order, so a tax typed in by hand doesn't change what wages are reported; 941 line 7 shows the cents that differ. The
worksheets are for copying into the agencies' own filing; Montra doesn't file them.

A deposit due within three days, or overdue, is a `bill_due` notification to members who can read the business.

### 7b. Year-end forms (stage 4)

W-2s, the W-3, 1099-NECs and the 1096 are worked out from the year's records each time they're asked for, like the
worksheets, so a reopened pay run or a late bill changes them and nothing goes stale. Nothing about them is stored
except what the forms need that Montra didn't have: the employer's address in parts (the business profile keeps free
text) and the SSA submitter's BSO User ID and contact, on `payroll_settings` (migration 0034).

- **W-2 boxes** come from approved paychecks by pay date in the calendar year: box 1 is wages less both kinds of
  before-tax deduction, boxes 3 and 5 are the wage bases worked out per person in pay-date order (Social Security
  capped at the wage base), boxes 2, 4 and 6 are what was withheld (box 6 includes Additional Medicare), box 12 code D
  is the `retirement` deductions, read as 401(k), and box 13's retirement plan box is ticked when there were any. For
  California: box 14 `CASDI`, box 15 the EDD account, and boxes 16 and 17. Reimbursements aren't wages (§8), so
  they're on no W-2.
- **Copies.** Each employee's PDF has copies B, C and 2. Their SSN is truncated to the last four digits, as the IRS
  allows on copies furnished to employees. The employer's PDF has copy D for each employee with the full SSN, and the
  W-3. Copy A is not rendered: it must be the IRS's scannable red form or filed electronically, and the EFW2 file is
  the electronic route. Copy 1 for a state isn't made, since California takes wages on the DE 9C instead.
- **1099-NEC** amounts come from paid bills to each contractor's vendor record by payment date. Bills paid from a
  credit card are left out, since the card company reports them on a 1099-K. A 1099-NEC is due when the year's total
  reaches the threshold: $600 through 2025, and $2,000 for payments from 2026 (One Big Beautiful Bill Act §70433),
  indexed from 2027, which Montra flags until it has the figure. The contractor's PDF has copies B and 2 with the TIN
  truncated; the payer's has copy C with the full TIN and a Form 1096 worksheet. Copy A is filed through the IRS's
  IRIS portal or on the red form; Montra doesn't file it.
- **EFW2** (SSA Publication 42-007) is RA, RE, an RW per employee, RT and RF, 512 bytes each, ending CR LF, in upper case
  except the emails. It's built by a pure function and tested byte by byte. Before it's made, the problems SSA would
  reject are listed (an EIN prefix SSA doesn't issue, a missing BSO User ID or contact, an SSN starting with 9, 666 or
  000), and the download is refused until they're fixed. The owner uploads it to Business Services Online; Montra
  doesn't file it.
- Full SSNs and TINs leave Montra only on the employer's copies and the EFW2 file. Both need a recent sign-in, and
  each download is logged (`payroll.form_downloaded`), as stage 1's forms are.

### 8. Reimbursements are not wages

A reimbursement request carries a receipt file and an amount and category, and it's approved or declined by someone who
can write to the business. An approved request is paid either on the next pay run as a separate, untaxed line, which
increases net pay, or by a bill to the person's vendor record. It never enters gross pay or any tax base, so it isn't
reported on a W-2 (an accountable plan).

### 9. Stages

Each stage is its own PR into `develop`: (1) people and onboarding forms; (2) pay schedules, pay runs, payslips, ledger
posting, contractors through bills, reimbursements; (3) employer tax for federal and the chosen state, with the deposit
schedule and the 941, 940 and state worksheets; (4) W-2, W-3, 1099-NEC, 1096, state copies and an EFW2 file where it's
practical.

## Consequences

- The owner stays responsible for filing and paying on time, and for checking Montra's figures. Montra reminds them and
  prepares the numbers, but a missed EFTPS deposit is theirs to correct.
- Read-only accountants can't see who is employed beyond names on pay runs. Granting write access to the business is the
  way to show them the records.
- A sealed ID copy can't be read straight from storage, so a mirror of files to the owner's own storage (ADR-0030) would
  copy ciphertext. Sealed files should be left out of the mirror.
- A backup holds decrypted ID copies and TINs. Backups already hold decrypted `_enc` columns, so the advice to set an
  archive passphrase covers both.
- Each tax year needs its tables in a release before the first pay date of the year. A pay run in a year with no
  tables isn't computed from last year's: its paychecks say to enter the taxes.
- Only one state, and only the 2020+ W-4. Supporting a second state means another table set and form renderings, not a
  new design.

## Alternatives considered

- **Tax tables in `ref` reference data.** See §7: reviewability and pure tests won over loading without a release.
- **Store what's owed as deposit rows when a run is approved.** Simpler to list, but a reopened run or a changed
  schedule would leave them wrong; working it out each time can't drift.
- **Integrate a payroll provider now.** Check or Gusto Embedded would file and pay, but they need a commercial agreement,
  KYB for every business, and money movement, which the owner ruled out for now. The port keeps that path open.
- **Overlay the official PDFs.** Accurate to the pixel, but the agencies' PDFs change layout every year and some are
  protected against filling. The substitute rendering is allowed and easier to keep current.
- **Post employer taxes at pay time (accrual).** Matches what payroll providers' GL exports do, but deducts the expense
  before it's paid, which disagrees with the cash-method Schedule C the rest of the business reports produce.
- **Store ID copies unencrypted and rely on bucket encryption.** S3 SSE protects against a lost disk, not against a
  leaked storage credential or the owner's own mirrored storage, and local and MinIO setups have none.
- **People as `business_party` rows.** Contractors are vendors, but employees need forms, pay and tax history, and they
  must not appear in the customer and vendor directory.
