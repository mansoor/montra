# ADR-0052: Tax forms received, read and reconciled against the books

- Status: proposed
- Date: 2026-11-16
- Builds on: ADR-0048 §3 (a scan is read once; payslips and pseudonym tokens), ADR-0051 (intakes, match memory,
  Review), ADR-0016 / PAY-01..09 (payslips), ADR-0024 (loan tracking), ADR-0025 (retirement and investment accounts),
  ADR-0034 §7b (W-2 boxes, for the employer side), RPT-04 (the year-end tax package)

## Context

The owner asked:

> Does it help for the annual financial reconciliation to upload all the tax documents like W2, 1099-INT, 1099-DIV,
> mortgage statement etc?

It does. Every one of those forms is a total that a third party worked out from the same events the books record:
an employer's W-2 from the pay it ran, a bank's 1099-INT from the interest it paid, a lender's 1098 from the payments
it received. When the books and the form agree, the year is complete. When they don't, something is missing or
misfiled: a payslip never entered, a December interest line not imported, a mortgage payment split wrongly. Finding
that in February is cheap; finding it when the return is being prepared is not.

What Montra has today:

- **Payslips** (`app.payslip`, `app.payslip_line`): each line has a `section` (`earning`, `pre_tax`, `tax`, `post_tax`,
  `employer`) and a `code` (`salary`, `401k`, `hsa`, `fed_tax`, `social_security`, `medicare`, `state_tax`, `match`,
  …), the amount and the printed year-to-date. Payslips belong to an `app.employer`, which belongs to a family member
  and is `restricted` (PAY-09: owners, admins and the member's own login).
- **Loans** (ADR-0024): `app.loan_payment` keeps each payment's `interest_minor`, `principal_minor` and `escrow_minor`;
  `app.loan_schedule` keeps the fixed escrow parts (`escrow_taxes_minor`, `escrow_insurance_minor`). The principal
  outstanding on a date is the loan account's ledger balance (`GET accounts/:id/balance-history`). There is no PMI or
  points field.
- **Interest and dividends**: the personal chart's `Interest income` and `Dividends` income categories, with no tax
  line. `AccountsService.interestEarned()` finds an account's interest by income categories named like "interest".
  Investment accounts (ADR-0025) carry a `plan_type` (brokerage, 401k, ira, …) and are valued, not held: no lots, no
  cost basis, no qualified/ordinary split. Reinvested dividends may never have been booked as income at all.
- **The scan pipeline** (ADR-0048): `doc.extract` and `receipt.ocr` in the doc-worker, then an AI task
  (`extract_payslip`, `extract_bill`) that reads masked text and, when the workspace allows documents to the AI,
  the page images. Payslip text has SSNs masked and member names replaced by `MEMBER_n` tokens.
- **Matching** (ADR-0051): `app.match_memory` per kind and signal, learned after `LEARN_AFTER` (3) confirmations;
  `app.document_intake` and Review's "Statements and bills to file".
- **The tax package** (RPT-04): `POST tax-package` → `data.tax_package` builds one entity's year as a zip of reports,
  Schedule C or E, and the year's receipts with `receipts.csv`.
- **The employer side** (ADR-0034 §7b): a business's payroll *produces* W-2s and 1099-NECs (`W2Boxes` in
  `@montra/domain/payroll-year-end.ts`, `necThreshold(year)`). That's the opposite direction from this ADR: here the
  household *receives* forms. The box names are reused where they fit (§2), nothing else.

No requirement covers received tax forms; this ADR proposes `TAX-01..TAX-09` (§12).

**Montra does not prepare or file returns**, and doesn't calculate tax. It keeps the forms, checks them against the
books, and hands both to whoever prepares the return.

## Decision

### 1. Form kinds and phases

| Phase                      | Forms                                                         | What it reconciles against                                                |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **1 (this ADR's delivery)** | W-2, 1099-INT, 1099-DIV, 1098                                 | Payslips; interest and dividend income on accounts; the loan's split      |
| 2 (a later ADR)            | 1099-R, 1099-NEC, 1099-MISC, 1099-K                           | Retirement withdrawals; a business's income from a client or a processor  |
| 3 (a later ADR, if asked)  | 1099-B, 5498, 1095-A/B/C (and 1099-G, 1099-SA, SSA-1099)      | Kept and packaged; little or nothing in the books to check them against   |

Why this order:

- **The phase 1 forms are what nearly every household gets**, and each has a counterpart the books already hold to
  the cent: payslip lines, interest and dividend postings, the loan's interest split. Their boxes are few and fixed.
- **Phase 2 needs new links.** 1099-R needs withdrawals told apart from transfers on retirement accounts. 1099-NEC,
  MISC and K belong to a business's books and are matched to a client (`business_party`) or a payment processor, and
  their thresholds change by year (`necThreshold` already tracks the NEC one). 1099-K overlaps with card sales.
- **Phase 3 has nothing to reconcile against.** 1099-B needs cost basis and lots, which ADR-0025 chose not to keep;
  5498 arrives in May, after most returns; 1095s have no money in the books. They can still be stored and packaged,
  which is most of their value.
- Consolidated brokerage statements ("Consolidated Form 1099") carry INT, DIV, B and sometimes MISC in one PDF. Phase 1
  reads the INT and DIV sections out of them and keeps the whole file; the B section waits for phase 3.

### 2. The fields read per form

Every form keeps: the **tax year**; the **kind**; a **corrected** flag (the CORRECTED box, or a W-2c); the
**issuer** (the employer, bank, broker or lender that sent it) as its printed name and, when it's an EIN, its EIN;
the **person** it's for, as a household member; and the **boxes**. Money is bigint minor units (cents). Dates are
`CalendarDate`.

Never kept: the person's name, address or full SSN; the issuer's address; control numbers; CUSIPs; the full account
number. The person's SSN and the account number are kept as their last four digits only.

**W-2** (box names as `W2Boxes`, extended):

| Kept                                   | Boxes                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Identification                         | a (SSN → last four), b (EIN), c (employer name; the address isn't kept), e (→ member)       |
| Money                                  | 1 wages, 2 federal tax withheld, 3 Social Security wages, 4 Social Security tax, 5 Medicare wages, 6 Medicare tax, 7 Social Security tips, 8 allocated tips, 10 dependent care benefits, 11 nonqualified plans |
| Box 12                                 | Up to four `{ code, amount }` (D, AA, W, C, DD, E, G, …)                                    |
| Box 13                                 | Statutory employee, retirement plan, third-party sick pay (three flags)                     |
| Box 14                                 | `{ label, amount }` list as printed (e.g. `CASDI`)                                          |
| Boxes 15–20                            | Per state row: state, employer's state ID, 16 state wages, 17 state tax; 18–20 local wages, tax, locality |

Not kept: d (control number), f (address), 9 (unused).

**1099-INT:**

| Kept           | Boxes                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Identification | Payer's TIN (EIN), recipient's TIN (last four), account number (last four)                                    |
| Money          | 1 interest income, 2 early withdrawal penalty, 3 interest on US savings bonds and Treasury obligations, 4 federal tax withheld, 5 investment expenses, 6 foreign tax paid, 8 tax-exempt interest, 9 specified private activity bond interest, 10 market discount, 11 bond premium, 12 bond premium on Treasury obligations, 13 bond premium on tax-exempt bonds |
| Other          | 7 foreign country; 15–17 state rows (state, state ID, state tax withheld)                                     |

Not kept: payer's RTN, box 14 (CUSIP), the FATCA box.

**1099-DIV:**

| Kept           | Boxes                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Identification | Payer's TIN (EIN), recipient's TIN (last four), account number (last four)                                    |
| Money          | 1a total ordinary dividends, 1b qualified dividends, 2a total capital gain distributions, 2b unrecaptured §1250 gain, 2c §1202 gain, 2d collectibles (28%) gain, 2e §897 ordinary dividends, 2f §897 capital gain, 3 nondividend distributions, 4 federal tax withheld, 5 §199A dividends, 6 investment expenses, 7 foreign tax paid, 9 cash liquidation distributions, 10 noncash liquidation distributions, 12 exempt-interest dividends, 13 specified private activity bond interest dividends |
| Other          | 8 foreign country; 14–16 state rows                                                                           |

Not kept: the FATCA box.

**1098** (the household is the "payer/borrower" on this form; Montra calls the lender the issuer):

| Kept           | Boxes                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Identification | Lender's TIN (EIN), borrower's TIN (last four), account number (last four)                                    |
| Money          | 1 mortgage interest received, 2 outstanding principal, 4 refund of overpaid interest, 5 mortgage insurance premiums, 6 points paid, 10 other (amount and its printed label, usually property tax paid from escrow) |
| Other          | 3 origination date, 11 acquisition date, 9 number of properties, 7 (the property is the borrower's address)   |

Not kept: box 8 (the property's address). It is masked before the AI anyway (§6), and the loan is matched by the
lender and the account number.

**How the boxes are stored.** As one JSON document per form, validated by a Zod schema per kind
(`TaxFormBoxes`, a discriminated union in `@montra/domain/tax-forms.ts`), the way plan entitlements are
(`parseEntitlements`). Money in that JSON is a string of integer minor units (`"8512034"`), since JSON has no bigint;
`parseTaxFormBoxes(kind, json)` returns typed `bigint`s and refuses anything else. Columns per box were considered
(§Alternatives): four forms now and a dozen later, each with 10–25 boxes, would mean a table per kind or hundreds of
mostly-null columns, and the reconciliation reads every box through the typed parser anyway.

### 3. Storage

Three new tables, all with row-level security enabled and forced, policies, and grants to `montra_app`:

- **`app.tax_form`**: one row per form received.
  - `tax_year` (smallint), `kind` (`w2`, `1099_int`, `1099_div`, `1098` in phase 1; the check is widened by later
    phases), `corrected`, `supersedes_id` (the earlier form a corrected one replaces).
  - `issuer_name`, `issuer_ein` (nine digits, only when the printed TIN is EIN-shaped; an SSN-shaped payer TIN keeps
    its last four in `issuer_tin_last4` only), `person_tin_last4`, `account_last4`.
  - `person_member_id` (→ `app.family_member`), `entity_id` (the books it belongs to: set from what it's matched to,
    personal until then), `restricted` (§8).
  - `boxes` (jsonb, §2), `file_ids` (`app.file`; one file can hold several forms, as a consolidated 1099 does),
    `pages` (which pages of the file this form is on), `sha256` of the file for duplicate refusal.
  - `status`: `reading` → `review` (needs a person: unread, unmatched, or the reading not confirmed and the books
    differ) → `confirmed`; or `dismissed`, or `superseded`. `reason` says why it's in Review.
  - `source` (`upload`, `scan`, `typed`), `reading` (the masked extraction, cleared once confirmed, as a scan's is),
    `detected` (signals and candidates with reasons, as `document_intake.detected`), `accepted` (jsonb, §5.6),
    `job_id`, `created_by`, `confirmed_by`, timestamps.
- **`app.tax_form_target`**: what the form is matched to, one row per target: `employer_id` (→ `app.employer`) or
  `account_id` (→ the bank account, which for a 1098 is the mortgage account carrying the `loan_schedule`), exactly
  one of them. A W-2 has one employer. A bank's 1099-INT often covers every account the person has there, so it can
  have several accounts, and its interest is checked against their sum.
- **`app.tax_form_waiver`**: an expected form the person says won't come or is covered elsewhere (§7.1): `tax_year`,
  `kind`, `employer_id` or `account_id`, `reason` (`not_issued`, `combined`, `other`), `note`, who and when.

And one change: `app.match_memory.kind` gains `tax_issuer` and `tax_person` (§4), with its write policy extended to
the roles of §8.

Files are `app.file` rows, uploaded and served as other documents are; how they are encrypted is §8.3. The tables are
exported in backups and restored with them, like payslips.

### 4. Matching

A form is matched on two sides: its **issuer** to an employer or account(s), and its **person** to a household member.

**Signals** (one per side, the most specific the form has, as ADR-0051 §2):

| Form            | Issuer signal                                     | Candidates                                                                                          |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| W-2             | `w2:ein:<EIN>`, else `w2:name:<payee key>`        | The person's employers of type `employer` with payslips in the tax year, by name (the payee normalization and similarity used for billers) |
| 1099-INT, -DIV  | `<kind>:ein:<EIN>:last4:<1234>`, else `<kind>:ein:<EIN>`, else `<kind>:name:<key>` | Accounts with those last four digits, narrowed by the institution (`bank_account.institution`) the issuer's name matches; else the accounts at that institution that earned interest (or dividends) in the year |
| 1098            | `1098:ein:<EIN>:last4:<1234>`, else by name       | Mortgage accounts with a `loan_schedule`, by last four digits, then by lender name                   |
| Person (any)    | `tin4:<keyed hash of the last four>`              | The `MEMBER_n` token the AI returned (§6); for a W-2, the employer's member                          |

- The EIN is stored in the clear: it's a business identifier, printed for the recipient to use, and the business
  profile already keeps the workspace's own EIN that way. The person's last four digits go into the memory only as a
  keyed hash (HMAC with the workspace data key), because `match_memory` is readable by every member while the form is
  not.
- **When it's automatic.** Tax forms come once a year, so ADR-0051's three confirmations would take three years. Two
  rules replace it for this kind:
  1. **Memory with an EIN.** A signal containing an EIN that was confirmed once before (last year) is matched
     automatically. An EIN names one issuer, so one confirmation is not a one-off guess the way a file name is. A
     name-only signal still needs `LEARN_AFTER` (3).
  2. **One clear candidate this year.** When exactly one candidate fits every detail the form gives (the name, the
     last four digits, the person, and that it had pay, interest, dividends or mortgage interest in the year), it's
     matched automatically and the reason is shown ("Matched: Acme Corp is Sam's only employer with payslips in 2026").
  - Otherwise the best candidates are suggested, and the form waits in Review.
- **The reconciliation is the guard.** A wrong automatic match shows up as a large difference (§5) and puts the form in
  Review, where changing the match is one step. A correction resets the memory as ADR-0051 §3 does.
- A person picking or changing a match confirms the memory (`learnMatch` in `@montra/importers`, unchanged). A form
  matched to several accounts teaches nothing; it's picked by hand, once a year.
- An archived account or employer is still matched when the form is for a year it was active.

**The person.** In order: the W-2's employer's member; the AI's `MEMBER_n` token (§6); the learned `tax_person`
signal; for an account form, the only member with a login when there's one. A conflict between them (the token says
one member, the employer another) is a Review item, never a guess.

### 5. Reconciliation

Each form is checked box by box against the books for its tax year (1 January to 31 December, by the payslip's pay
date and the transaction's date). The rules are pure functions in `@montra/domain/tax-forms.ts`
(`reconcileW2`, `reconcile1099Int`, `reconcile1099Div`, `reconcile1098`), given the form's boxes and the figures the
API gathers; they return one **check** per box: the form's amount, the books' amount, the difference, a status, the
rule in words, and the ids of what was summed (payslips, transactions, loan payments) so every figure drills down
(RPT-03). Nothing is stored: the checks are worked out each time they're shown, like payroll's W-2 (ADR-0034 §7b), so
a payslip added later fixes the form's result with no step in between. Only acceptances are stored (§5.6).

#### 5.1 Tolerance and rounding

- Amounts are compared in exact minor units. No floats; the percentage checks use `@montra/domain` rounding (half up
  to the cent).
- **A box matches when the difference is at most $1.00** (`TAX_FORM_TOLERANCE_MINOR = 100n`). Payers may print whole
  dollars on 1099s and 1098s, and per-paycheck rounding of FICA can drift a few cents over a year. Anything more is a
  difference.
- Each check is either **`check`** (a difference makes the form *differ*, and puts it in Review) or **`info`** (shown,
  never a Review item by itself), as the tables below say.
- **Known explanations.** Before calling a difference, the rule tries a short fixed list of explanations per box (below).
  When the difference equals one of them (within the tolerance), the box *matches* with that explanation shown.
  Notably, the **year boundary**: a posting of the right kind within 5 days on the other side of 1 January whose
  amount equals the difference ("$41.07 of interest was credited on 31 December and posted on 2 January").

#### 5.2 W-2

For the matched employer and person, over payslips paid in the tax year (not voided):
`E` = the `earning` lines; `P` = all `pre_tax` lines; `K` = `pre_tax` lines coded `401k`; `H` = `pre_tax` and
`employer` lines coded `hsa`.

| Box      | Books figure                                                   | Kind  | Known explanations                                              |
| -------- | -------------------------------------------------------------- | ----- | --------------------------------------------------------------- |
| 1        | `E − P`                                                        | check | Box 12 C (group-term life over $50,000) added to wages          |
| 2        | `tax` lines coded `fed_tax`                                    | check | —                                                               |
| 3        | `E − (P − K)` (cafeteria and HSA deductions aren't FICA wages; 401(k) deferrals are), capped at the year's Social Security wage base | check | Box 12 C |
| 4        | `tax` lines coded `social_security`                            | check | —                                                               |
| 5        | `E − (P − K)`                                                  | check | Box 12 C                                                        |
| 6        | `tax` lines coded `medicare`                                   | check | —                                                               |
| 12 D     | `pre_tax` lines coded `401k`                                   | check | —                                                               |
| 12 AA    | `post_tax` lines coded `roth_401k`                             | check | —                                                               |
| 12 W     | `H`                                                            | check | —                                                               |
| 17       | `tax` lines coded `state_tax`, when the form has one state row | check | —                                                               |
| 16, 14   | Shown with the books' `E − P` beside it                        | info  | States differ (California taxes HSA contributions)              |
| Others   | Shown                                                          | info  | —                                                               |

Also:

- **Reading checks**, on the form alone, to catch a misread before blaming the books: box 4 is 6.2% of box 3; box 6 is
  1.45% of box 5 plus 0.9% above $200,000; box 3 is at most the year's wage base; box 5 is at least box 3 (Medicare
  wages have no cap). A failed reading check marks the box as "check the
  reading" rather than a difference. The wage base by year sits beside `necThreshold` in `@montra/domain`.
- **Year-to-date cross-check.** The last payslip of the year carries year-to-date figures. When the sums differ from the
  W-2 but the year-to-date figures match it, the explanation is "a payslip seems to be missing", with the gap's dates.
- Lines coded `other` in `pre_tax` count in box 1's rule and are listed by name under boxes 3 and 5, where they're
  ambiguous.
- No payslips at all for that employer in the year: the form is **not tracked** (`not_tracked`): kept, packaged, not a
  Review item. The pay is still in the books as deposits; Montra can't say which part was wages.

#### 5.3 1099-INT

Over the matched account(s), income postings in the tax year in an interest category (§5.7):

| Box          | Books figure                                    | Kind  | Known explanations           |
| ------------ | ----------------------------------------------- | ----- | ---------------------------- |
| 1 + 3 + 8    | Interest income on the account(s)               | check | The year boundary            |
| 4            | Federal tax postings on the account(s)          | check (only when the box isn't zero) | — |
| 2            | Postings to a penalty or fee category from the account(s) | info | —                 |
| Others       | Shown                                           | info  | —                            |

- The three interest boxes are compared as one total, because the books don't tell taxable, Treasury and tax-exempt
  interest apart. Each box is still shown.
- An account that earned interest but posted none (a brokerage valued, not itemized): **not tracked**, with the action
  of §5.6.

#### 5.4 1099-DIV

| Box     | Books figure                                         | Kind  | Known explanations                                                       |
| ------- | ---------------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| 1a      | Dividend income on the account(s)                    | check | Box 2a (capital gain distributions booked as dividends); the year boundary |
| 4, 7    | Federal tax and foreign tax postings on the account  | check (only when the box isn't zero) | —                                         |
| 1b      | Shown; reading check 1b ≤ 1a                         | info  | —                                                                        |
| Others  | Shown                                                | info  | —                                                                        |

The books have no qualified/ordinary split, no §199A and no foreign-tax detail (ADR-0025), so those boxes are kept for
the package and never reconciled.

#### 5.5 1098

For the matched mortgage account (its `loan_schedule`):

| Box  | Books figure                                                                         | Kind  | Known explanations                                          |
| ---- | ------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------- |
| 1    | Sum of `loan_payment.interest_minor` for payments whose transaction is in the year   | check | Box 4 (refund of overpaid interest); the year boundary (a January payment the lender credited in December, or the reverse); interest paid at closing in the origination year |
| 2    | The loan account's balance on 1 January (or on the origination date, box 3, when later) | check | —                                                        |
| 10   | Property tax posted from this loan's escrow in the year                              | info  | Escrow pays the county on its own schedule; Montra books the tax as it's paid into escrow |
| 5    | Mortgage insurance posted from this loan's payments, if any category holds it        | info  | —                                                           |
| 3    | `loan_schedule.start_date`                                                           | info  | —                                                           |
| 6, 11| Shown                                                                                | info  | —                                                           |

- A 1098 for a rental property's mortgage belongs to that rental's books, and its box 1 is the figure on Schedule E
  line 12 (`US_SCH_E_L12`).
- Box 10 is info, not check: what an escrow account paid out (the form) and what was paid into it (the books) differ
  every year by design.

#### 5.6 What a difference leads to

- A form with any `check` box outside the tolerance **differs**: it's shown amber on the Tax forms screen and is a
  Review item, "Tax forms to check".
- From there the person can:
  - **Fix the books** through the drill-down (add the missing payslip, import December, correct a loan payment's
    split). The check passes on its own the next time it's shown.
  - **Fix the reading** (the boxes are editable beside the image), when the form was misread.
  - **Accept the difference** with a note ("bonus paid as a gift card"). `accepted` keeps the box, both amounts and the
    note. The acceptance holds while the difference stays the same; if the books change it, the form is back in Review.
  - **Change the match.**
- **Not tracked** dividends or interest on an investment account offer **Record from the form**: one journal entry
  dated 31 December that moves the amount from `investment_gains` (where the valuations put it) to `Dividends` (or
  `Interest income`). The account's balance doesn't change; the income is classified correctly. It needs a
  confirmation naming the amount and the categories, and it's an ordinary entry that can be deleted.
- A form whose reading isn't confirmed yet but matches the books on every `check` box is confirmed by that match:
  two independent sources agreeing to the cent is better evidence than a person glancing at it. Any difference keeps
  the reading unconfirmed, so the person looks at the image first.

#### 5.7 Finding interest and dividend income

Today `interestEarned()` matches income categories by name. Phase 1 adds two reference tax lines (Schedule B part I,
interest; part II, ordinary dividends) to `ref.tax_line`, sets them on the personal chart's `Interest income` and
`Dividends` categories (template and existing workspaces, by system name), and finds categories by tax line first,
falling back to the name rule for categories a person made themselves. The same lookup then serves
`interestEarned()`.

### 6. Reading the forms, and what the AI sees

- **One reading** (ADR-0048 §3). Uploading on the web or scanning on the phone stores the file(s), then:
  1. **Doc-worker `taxform.read`** (new job): the PDF's text layer, else OCR (Tesseract, as `doc.extract` does for
     scanned PDFs and photos). In the same process, before any text leaves it:
     - finds the form titles per page ("Form W-2", "1099-INT", "1099-DIV", "1098", "W-2c", "CORRECTED") and drops
       duplicate copies (a W-2 page often carries copies B, C and 2 of the same form);
     - extracts the identifiers locally: SSN-shaped and truncated TINs (`123-45-6789`, `XXX-XX-6789`) → last four;
       EIN-shaped TINs (`12-3456789`) → the EIN; the account number → last four;
     - masks the text as `redact.py` does for statements (digit runs, emails, phones, address lines and the name line
       in the header block), plus every TIN.
     It returns the masked text and the identifiers per page, never the raw text. The full SSN never leaves the
     doc-worker, and isn't stored in a job result.
  2. **AI gateway `extract_tax_form` v1** (new task): the masked text, with family members' names replaced by
     `MEMBER_n` tokens (`maskPayslipText`'s pseudonyms). It returns a list of forms, each with its kind, tax year,
     corrected flag, issuer name, the person as a token only (anything else is dropped, as `extract_payslip` v2 does),
     its pages and its boxes as decimal strings. The validator drops unknown boxes, parses amounts to minor units, and
     the audit event records how many forms and boxes were read, never amounts or names.
  3. **The Node worker** (`tax_form.match`) creates the `tax_form` rows, attaches the identifiers by page, matches
     (§4), and the form is shown with its checks (§5).
- **Images never go to the AI provider for a tax form, whatever the workspace's "allow documents to the AI" setting.**
  Payslip images may go when that's on; a W-2's image always shows the person's full name and usually the full SSN,
  which this feature promised never to send. The cost is weaker reading of bad photos, which the reading checks and
  the reconciliation catch.
- **AI off, unavailable, over budget, or local mode**: the form waits in Review with its image, to type the boxes in.
  Typing a form in (no file) is always possible. Local-mode AI results aren't applied to rows yet (STATUS backlog #2),
  so local mode is "type it in" until they are.
- **Duplicates.** The same file (`sha256`) is refused with a link to the form already made from it. A form with the same
  kind, year, issuer, person and boxes as an existing one is put in Review as a probable copy.
- **Corrected forms** (CORRECTED, W-2c) replace the form they correct when the kind, year, issuer and person agree: the
  old one becomes `superseded`, stays visible, and leaves the expected count and the package's main list.

### 7. What the person sees

#### 7.1 Web: the Tax forms screen (`/tax-forms`)

- In the Reports group of the nav, and linked from Settings → Your data's tax package panel. For workspaces whose home
  currency is USD (these are US forms). Not for viewers.
- **A year picker**, defaulting to last year from January to April and this year otherwise.
- **Expected against received**, grouped by person (and the business or rental books, when a form belongs there):
  - **Expected** forms are inferred, never stored:
    - a W-2 for each employer of type `employer` that has payslips paid in the year, per person;
    - a 1099-INT for each account outside a retirement plan (`plan_type` not 401k, roth_401k, 403b, ira, roth_ira, hsa,
      529, pension) with at least $10 of interest in the year;
    - a 1099-DIV for each such account with at least $10 of dividends;
    - a 1098 for each mortgage account with at least $600 of interest in the year.

    The thresholds are the IRS's reporting thresholds, kept by year in `@montra/domain` beside `necThreshold`.
  - Each expected form shows **Received** (and its result), **Not yet**, or **Won't come** (a waiver, with its reason:
    not issued, combined with another form, other).
  - Received forms that match nothing expected are listed too ("Received, not expected": an account Montra doesn't
    track, a one-off employer).
- **A drop zone** takes several PDFs or photos at once, and **Type a form in** opens an empty form of a chosen kind.
- **Each form** opens a detail view: the file's pages beside the boxes (editable while unconfirmed, and on request
  after), the issuer and person with Change, and the **checks**: box, form, books, difference, status, and "How this
  was worked out" with the rule and a drill-down to what was summed. Actions: Confirm reading, Accept the difference,
  Record from the form (§5.6), Mark as corrected, Delete (to Trash, 30 days).
- **Results** in words and colour: Matches the books · Differs by $412.50 · Difference accepted · Not tracked in the
  books · Needs a match · Reading.
- **Review** (`/review`) gains **Tax forms to check** below "Statements and bills to file": forms that differ (and
  aren't accepted), aren't matched, or couldn't be read, each with its reason and an Open action.

#### 7.2 Phone: capture and review

- **More → Tax forms**: the same year list (expected, received, results), read live and cached for offline viewing like
  account details (`useCached`).
- **Scan a form** uses `DocumentCapture` (the platform scanner, the camera fallback, or a picked PDF); pages are
  combined into one PDF, as statements are, and uploaded to the same endpoint as the web. Not on the Add wheel: it's
  a once-a-year task, and the wheel's five choices are the everyday ones.
- **A form on the phone** shows its result and checks, and can change the match, accept a difference with a note,
  confirm the reading, and Record from the form. Editing boxes is on the web.
- **Review** on the phone shows "Tax forms to check" with the same actions.
- Tax forms aren't synced entities (ADR-0013), like intakes: the phone reads and acts on them online.

#### 7.3 The tax package

The year-end package (RPT-04) gains, for the books it's made for:

- `tax-forms/`: each received form's file, named `<kind>-<issuer>-<person's first name>.pdf` (a file holding several
  forms appears once);
- `tax-forms.csv`: one row per form: kind, issuer, EIN, person, account last four, the main boxes, the result, and any
  accepted difference with its note; plus one row per expected form not received or waived;
- `tax-forms-check.pdf`: the reconciliation per form, as on the screen;
- a line in `README.txt` that Montra checked the forms against the books and didn't prepare a return.

W-2s, 1099-INT/DIV and personal mortgages' 1098s go in the personal package; a rental mortgage's 1098 in that rental's.
A form the package's maker can't read (§8) is left out, and the README says how many were. Before making the package,
the panel warns when forms for that year differ or are missing.

### 8. Privacy and security

#### 8.1 SSN, EIN and account numbers

- The person's SSN is kept as its **last four digits only** (`person_tin_last4`); the full number is never stored,
  never in a job result, never in a log. The doc-worker reduces it before anything leaves the process (§6).
- An issuer's EIN is kept in full (§4). An issuer TIN that is SSN-shaped (a sole proprietor paying a 1099) is kept as
  its last four digits, like the person's.
- Account numbers are kept as their last four digits, as accounts and billers already are.
- The original file still shows whatever the issuer printed, which is why §8.2 and §8.4 restrict and protect it.

#### 8.2 AI minimization

- Text only, never images (§6). The text is masked by the doc-worker (TINs, digit runs, emails, phones, addresses,
  the header's name line), then member names are replaced with `MEMBER_n` tokens by the gateway.
- The AI returns no identifiers: the person only as a token, the issuer's name, the boxes. Identifiers come from the
  doc-worker's local extraction.
- The gateway's audit event for `extract_tax_form` holds counts, not amounts or names.

#### 8.3 Files at rest

Tax form files are stored like other documents (receipts, payslips): through `StoragePort`, encrypted at rest by the
storage (S3 with KMS, or the host's disk and bucket encryption on the self-hosted path, ADR-0050), and served only
through the form, which applies its row-level security. Viewing or downloading the original writes an audit row
(`tax_form.file_viewed`). Whether to go further and seal them with the workspace key, as payroll's identity documents
are, is an open question (Q4).

#### 8.4 Who sees a form (row-level security)

- **Read**: the person's own login and owners and admins: `app.can_read_restricted(person_member_id)`, the payslip
  rule (PAY-09), for every kind. While the person isn't known yet, the uploader and owners and admins. Also bounded by
  the books: `app.can_read_entity(entity_id)`.
- **Write**: the same people, except viewers. A member can upload and handle their own forms; partners and accountants
  handle the forms they can read.
- `tax_form_target` and `tax_form_waiver` follow their form's (and, for a waiver, the target's) rule.
- The checks read payslips and postings under the reader's own row-level security. Someone who can read a W-2 can
  already read that member's payslips, so a check never reveals more than the form.
- Expected forms are listed only for employers and accounts the reader can see: a member doesn't learn that another
  member is expecting a W-2.
- These defaults are the narrowest; the owner may want account forms (1099-INT/DIV, 1098) visible to everyone who can
  see the account, and accountants given read access (Q2, Q3).

#### 8.5 Retention

- Form files: `app.file.retain_until` = 31 December of the tax year + 7, the receipt images' default (RCP-10), purged by
  the existing `data.retention` job. The IRS's general limit is 3 years and 7 for some claims; 7 covers both.
- The form row and its boxes stay until deleted. Deleting goes to Trash (30 days), then is purged with its files.
- The masked reading is cleared when the form is confirmed.
- Account deletion and workspace purge remove them like any other data.

### 9. Out of scope

- Preparing or filing returns, and any tax calculation (what's owed, deductions, credits, estimated tax).
- State forms, and state boxes beyond those printed on the federal form (W-2 boxes 15–20, 1099 state rows).
- Foreign forms (T4, P60, …) and non-US workspaces.
- Phase 2 and 3 forms (§1), each in its own ADR.
- Cost basis, lots and capital gains (1099-B).
- Sending forms to anyone: they leave Montra only in the tax package or a download.
- Reading forms from issuer portals or by email forwarding.

### 10. Sync

Not synced (ADR-0013). The phone reads and acts online, like intakes and imports.

### 11. Notifications

None in this ADR's delivery until the owner decides (Q1). The screen and the package panel show what's missing.

### 12. Requirements (proposed)

A new section, **3.8 Tax forms received**, in `docs/requirements/R1-requirements.md`, added by the first PR:

| ID     | Requirement                                                                                                                   | Priority |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | -------- |
| TAX-01 | Upload or scan the tax forms a household receives (W-2, 1099-INT, 1099-DIV, 1098), several at once, or type one in.           | M        |
| TAX-02 | Each form is read once; its boxes are kept as amounts; corrected forms replace the ones they correct; duplicates are refused. | M        |
| TAX-03 | Each form is matched to its employer or account(s) and to a household member, automatically when the evidence is clear, and learned. | M  |
| TAX-04 | Each form is checked against the books for its tax year, box by box, with the rule and the figures behind each check.         | M        |
| TAX-05 | Differences, unmatched and unread forms are Review items; a difference can be fixed, re-read or accepted with a note.         | M        |
| TAX-06 | A Tax forms screen per year lists the forms expected (from payslips, interest, dividends and mortgages) against those received. | M      |
| TAX-07 | The year-end tax package includes the forms, an index and the reconciliation.                                                 | M        |
| TAX-08 | Names and SSNs never reach the AI provider; only the last four digits of an SSN are kept; a member's forms are visible only to them and owners. | M |
| TAX-09 | The phone scans forms and shows and acts on their results.                                                                    | S        |

## Delivery

Five PRs, in order, each reviewable alone and green on `pnpm verify`. Migration numbers are the next free ones when
each lands (0059 today).

1. **Contracts, storage and typed forms** (TAX-01 typing only, TAX-02 partly, TAX-08 storage and RLS).
   - Migration `0059_tax_forms.sql`: `app.tax_form`, `app.tax_form_target`, `app.tax_form_waiver`, RLS (§8.4),
     grants; `match_memory.kind` widened with its write policy; the two `ref.tax_line` rows and the categories' tax
     lines (§5.7) as reference data and a data update.
   - Kysely types, `packages/schemas` DTOs (`TaxFormDto`, `TaxFormBoxesDto` per kind, `TaxFormCheckDto`,
     `TaxYearDto`), `@montra/domain/tax-forms.ts` (box schemas, `parseTaxFormBoxes`, thresholds, the wage base).
   - API: `GET tax-forms?year=`, `POST tax-forms` (typed in), `PATCH`, `DELETE` (to Trash), waivers. No reading yet.
   - R1 section 3.8 and `status.json` entries; traceability regenerated.
   - Tests: `packages/db` RLS tests (a member can't see another member's W-2; the uploader sees an unmatched one;
     viewers can't write; staff roles' grants unchanged); schema and box-parser tests; API tests for typing a form in.
   - Phone: no.
2. **Reconciliation, expected forms, Review and the web screen** (TAX-04, TAX-05, TAX-06; TAX-03 by hand).
   - `reconcileW2`, `reconcile1099Int`, `reconcile1099Div`, `reconcile1098`, the reading checks, the known
     explanations and the expected-forms inference, all pure in `@montra/domain`, with table-driven tests per box,
     tolerance edge ($1.00 vs $1.01), the year boundary, YTD cross-check and `not_tracked`.
   - API: the figures gathered under RLS; checks on `GET tax-forms/:id`; Review's "Tax forms to check"; matching by
     hand with `learnMatch`; accept a difference; Record from the form.
   - Web: `/tax-forms` (year, expected vs received, detail with checks and drill-downs, typing a form in, waivers),
     Review section. e2e `e2e/tax-forms.spec.ts` with typed-in forms against seeded payslips, interest and a loan.
   - Migration: none.
   - Phone: no.
3. **Reading and automatic matching** (TAX-01 upload, TAX-02, TAX-03, TAX-08 minimization).
   - Doc-worker `taxform.read`: text layer or OCR, form titles and copies, local TIN, EIN and account extraction,
     masking. pytest with synthetic forms (text PDFs and rendered images), including that no SSN-shaped string
     survives in the output. `pnpm verify:py`.
   - Gateway `extract_tax_form` v1, a fake provider (`fake-tax-form.ts`) for tests and e2e, and an eval corpus of
     synthetic W-2, 1099-INT, 1099-DIV, 1098 and consolidated 1099 texts. Tests that images are never passed and that a
     returned name is dropped.
   - API: `POST tax-forms/files` (several files), the job chain, signals and the automatic rules of §4, duplicates and
     corrected forms. A round trip: a W-2 rendered by payroll's `year-end-pdf.ts` is read back to the same boxes.
   - Web: the drop zone and the reading states.
   - Migration: none.
   - Phone: no.
4. **The phone** (TAX-09).
   - More → Tax forms (year list, results, cached), Scan a form through `DocumentCapture`, a form's checks and actions,
     Review's "Tax forms to check". Pure modules in `src/features/tax-forms.ts` with unit tests.
   - Migration: none.
   - Phone: yes. Not run on a device until the owner tries it on the LAN build.
5. **The tax package and retention** (TAX-07, TAX-08 retention).
   - `runTaxPackage` gains `tax-forms/`, `tax-forms.csv`, `tax-forms-check.pdf` and the README line; the package panel's
     warning on web and phone; `retain_until` on form files; backups and restore cover the three tables.
   - Tests: the package's contents for a personal and a rental book, a restricted form left out for a maker who can't
     read it, retention dates, a backup round trip.
   - Migration: none, unless the owner says yes to reminders (Q1), which adds a notification type (`0060`).
   - Phone: the package panel's warning only.

`docs/STATUS.md` and `status.json` are updated in each PR; `CHANGELOG.md` when the chain is done.

## Consequences

- The year's books get an outside check: every phase 1 form either agrees with them, is explained, or lands in Review
  with the exact gap and what's behind it.
- Payslips, interest imports and loan splits gain a reason to be complete: a missing December payslip now shows.
- Three tables and a widened `match_memory`; one new doc-worker job and one new AI task. Reading costs one AI call per
  file (a consolidated 1099 is one call).
- Tax forms are read from text only, so a poor photo reads worse than a payslip would. Digital PDFs, which most issuers
  provide, have a text layer and read well.
- Dividend and interest income on valued investment accounts can now be classified correctly from the form, without
  changing the account's value.
- The forms add US-specific logic (thresholds, the wage base) that changes yearly; it lives in `@montra/domain` by
  year, flagged when a year is unknown, as `necThreshold` does.

## Alternatives considered

- **Columns per box.** Clear in SQL, but four kinds now and a dozen later, with 10–25 boxes each, means a table per kind
  or hundreds of mostly-null columns, and a migration per new box. Typed JSON parsed by one Zod schema per kind keeps
  the tables stable and the types strict.
- **Reuse `app.document_intake` for forms.** An intake is a transient step towards an import or a bill; a tax form is a
  record kept for years, with its own reconciliation and package role. The form row does the intake's job (reading,
  detected, Review) itself.
- **Reuse `app.document_scan` on the phone.** A scan exists to pick a destination before filing; a tax form needs none
  at capture. The phone uploads to the same endpoint as the web.
- **Send images to the AI, as payslips may.** Better reading of photos, but the images carry the full name and often
  the full SSN, which this feature promised never to send.
- **Parse the forms with rules in the doc-worker, no AI.** Standard forms, but every issuer lays them out differently
  and OCR breaks the labels. Rules may come later for the common digital layouts; the reading checks and the
  reconciliation guard the AI's reading meanwhile.
- **Store the reconciliation result.** It goes stale as soon as a payslip is added. Working it out on read, as
  payroll's W-2 is, costs a few aggregate queries per form, and a household has about ten forms a year.
- **ADR-0051's three confirmations for issuers.** One form per issuer per year would take three years to learn. An EIN
  is unambiguous, and the reconciliation catches a wrong match.
- **A relative tolerance (a percentage).** Easier on large amounts, but a W-2 should agree to the cent with complete
  payslips, and a percentage would hide a missing payslip on a large salary. One dollar absorbs whole-dollar rounding
  and nothing else.
- **Calculate the return's figures (Schedule B totals, the 1040 lines).** That's tax preparation, which Montra doesn't
  do.

## Open questions for the owner

1. **Reminders:** should Montra remind about expected forms that haven't arrived? Proposed: one notification on
   16 February (after the 31 January and 15 February issue dates) listing what's missing, and nothing else. Yes or no?
2. **Who sees a form:** only the person it's for and owners/admins, for every kind (proposed), or should a 1099-INT,
   1099-DIV or 1098 be visible to everyone who can see that account?
3. **Accountants:** may the accountant role see members' W-2s and other forms, and include them in a tax package?
   Today the accountant can't see members' payslips. Proposed: no, unless you say yes.
4. **Sealing the files:** keep tax form files encrypted the way receipts and payslips are (storage encryption,
   proposed), or also seal them with the workspace key like payroll's ID copies, so that your own storage bucket never
   holds a readable SSN? Sealing needs a short-lived unsealed copy for reading each form.
5. **Never images to the AI:** tax forms are read from masked text only, even when "allow documents to the AI" is on.
   Accept weaker reading of poor photos for that (proposed), or allow images for 1099s and 1098s, which often print a
   truncated SSN?
6. **Record from the form:** offer the one-step entry that reclassifies a valued investment account's growth as
   dividend or interest income from its 1099 (proposed), or only report "not tracked"?
7. **The 1098's escrow box (10):** show a property-tax difference as information only (proposed), or make it a Review
   item like the interest?
