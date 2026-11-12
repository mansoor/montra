# ADR-0037: A business's legal and tax setup, and its registrations

- Status: accepted
- Date: 2026-11-11

## Context

BIZ-01 asks for a business's type, tax year and currency. The entity already had `business_type` (sole proprietor,
"LLC", single-member LLC, S-corp, partnership, other) and `fiscal_year_start_month`, and the business DTO returned both,
but no screen set them: creating a business sent only its kind and name. Montra assumed a calendar tax year everywhere,
and assumed every business files Schedule C.

Payroll (ADR-0034) kept its own copy of the business's registration data: the EIN and the EDD employer account number
under Payroll taxes → Employer details (migration 0033), and the filing address in parts under Year-end forms → Filing
details (migration 0034). Nothing held the business's other registrations: its state filing, its seller's permit, its
fictitious business name or its city licence, several of which expire.

The owner asked for the entity type and fiscal year in Business → Settings, for the EIN and the other federal and state
registrations to live there, and for the entity type to inform payroll: a sole proprietor can't be their own W-2
employee; an S-corp owner who works in the business must be on payroll; partners take guaranteed payments. The scope is
US federal plus California, as for payroll and assets (ADR-0034, ADR-0035). Montra keeps the facts and reminds; it
doesn't give tax advice, prepare Forms 1065, 1120-S or 1120, or file anything.

## Decision

### 1. Entity types, with the LLC's tax treatment as part of the type

An LLC is taxed by election, not by its legal form, so a single list carries both:

| `business_type`            | Shown as                                         | Taxed as        | Federal return |
| -------------------------- | ------------------------------------------------ | --------------- | -------------- |
| `sole_prop`                | Sole proprietor                                  | sole proprietor | Schedule C     |
| `single_member_llc`        | Single-member LLC, taxed as a sole proprietor    | sole proprietor | Schedule C     |
| `single_member_llc_s_corp` | Single-member LLC, taxed as an S-corp            | S-corp          | Form 1120-S    |
| `multi_member_llc`         | Multi-member LLC, taxed as a partnership         | partnership     | Form 1065      |
| `multi_member_llc_s_corp`  | Multi-member LLC, taxed as an S-corp             | S-corp          | Form 1120-S    |
| `partnership`              | Partnership                                      | partnership     | Form 1065      |
| `s_corp`                   | S-corporation                                    | S-corp          | Form 1120-S    |
| `c_corp`                   | C-corporation                                    | C-corp          | Form 1120      |

- One column, not a type plus an election flag: every combination is a valid row, and there's nothing to keep in step.
  Migration 0037 widens the check constraint. The old `llc` (members unknown) and `other` stay valid, so a business saved
  before this keeps its type until the owner picks one; the Settings list offers only the eight above (and the old value
  while it's current), and `PATCH /businesses/:id` accepts only those eight.
- The return form is derived (`returnFormOf` in `@montra/domain`) and returned as `BusinessProfileDto.returnForm`. Without
  a type, or with a legacy one, it's null and Montra keeps assuming Schedule C, as before.
- Where it isn't Schedule C, Settings and Taxes say the Schedule C summary and tax lines are a guide only. Montra builds
  no other return.
- The S-corp election's effective date (Form 2553) is kept for the three S-corp types (`s_corp_election_date`).
- The type and fiscal year are on `app.entity`, whose RLS lets only a workspace owner write it (as Settings → Books
  already did). The business PATCH writes them in the same transaction as the profile and answers 403
  `business.owner_only` to anyone else; the web form sends them only when they changed, so a partner with write access
  can still save the rest.

### 2. Fiscal year

`fiscal_year_start_month` (1 = January) now sets:

- the P&L's "Year to date" and "Last year" on Business → Overview (web `rangeOf`), and the API's default `from` for
  `reports/pnl`;
- the Schedule C summary's year on Business → Taxes. A fiscal year is named by the year it begins in, as Forms 1065,
  1120-S and 1120 name it ("tax year beginning …"): `fiscalYearRange(2025, 7)` is 2025-07-01 to 2026-06-30. Without a
  year, the API picks the fiscal year today is in. `ScheduleCDto` gains `from` and `to`, and Taxes shows them and feeds
  them to "Expenses by person" and the drill-downs.

Unchanged, on purpose:

- **Estimated-tax due dates stay federal and calendar-based.** They're the owner's individual payments (Form 1040-ES),
  due April 15, June 15, September 15 and January 15 whatever the business's fiscal year; a business's own fiscal-year
  estimates (Form 1120-W for a C-corp) aren't built. The estimate on Taxes and its year selector stay calendar years.
- **The payroll year stays the calendar year.** W-2s, the W-3, 941s, 940s and the DE 9 are calendar-year forms.
- The tax package export and the dashboard's months are by date and don't change.

A sole proprietor files on the owner's calendar year in practice, so the fiscal year matters mostly for the
partnership and corporation types.

### 3. One source of truth for the employer's numbers

The EIN, the EDD employer account number and the structured filing address move from `app.payroll_settings` to
`app.business_profile` (migration 0037), with the business's other registrations:

- **Backfill.** The migration copies each `payroll_settings` row's EIN, EDD account and filing address into the
  business's profile, creating the profile row where there isn't one. A value already on the business wins; the address
  moves as a whole, and only when the business has none.
- **Readers.** `employerIdentity()` (`apps/api/src/business/registrations.ts`) is the one read. Payroll settings
  (`PayrollSettingsDto.einMasked`, `caEmployerAccountMasked`, `filingAddress`), the 941/940/DE 9/DE 9C worksheets, the
  W-4 and I-9 PDFs, the W-2s, 1099-NECs, W-3, 1096 and the EFW2 file all read it.
- **Writers.** `PATCH /businesses/:id` only. `UpdatePayrollSettingsRequest` no longer has `ein`, `caEmployerAccount` or
  `filingAddress` (unknown keys are dropped, so an old client's save of them changes nothing). Payroll's Employer details
  and Year-end → Filing details show them read-only with a link to Business → Settings.
- **Payroll keeps** what is payroll's: the UI, CA UI and ETT rates, the deposit schedules, the SSA BSO user ID and the
  SSA contact.
- **The old columns stay.** `check-migrations` refuses drops without a contract step, and a blue/green deploy's old tasks
  still read them. They're commented as unused in the migration; a later migration can drop them with
  `-- contract: nothing reads app.payroll_settings.ein since 0037` once no running version reads them. Nothing writes them
  after 0037, so they go stale.

### 4. The entity type and the owner on payroll

A payroll person gains `is_owner`. `PayrollPersonDto.ownerNote` says what the entity type means for an owner who is an
employee (`ownerEmployeeNote` in `@montra/domain`):

| Taxed as        | Note                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| sole proprietor | `not_an_employee_draws`: you can't be your own W-2 employee; pay yourself with draws   |
| partnership     | `not_an_employee_partner`: partners take guaranteed payments or draws, not wages       |
| S-corp          | `reasonable_salary`: an owner who works in the business needs a reasonable salary      |
| C-corp, unknown | none: an owner-employee of a C-corp is an ordinary employee                            |

The add-employee form shows it when "This person is an owner" is ticked, and the person's page shows it after. It's a
warning, not a refusal: the owner may have a reason (a type not yet changed in Montra, a spouse who is also an owner),
and Montra doesn't give tax advice. Guaranteed payments and draws aren't built as payroll items; draws remain owner's
equity transactions (ADR-0017).

### 5. Registrations, and how sensitive numbers are shown

On `business_profile`: the IRS business name, NAICS code, state of formation, Secretary of State entity number,
formation date, FTB entity ID, CDTFA seller's permit, registered agent name and address, the DBA with its county and
expiry date, and the city business licence with its expiry date. Anything else is a row of `app.business_registration`
(label, number, issuer, expiry), with RLS like the business's other records: readers see them, writers change them.

- **Stored in plain text.** Payroll never sealed the EIN (migration 0033: "An EIN is on every form it sends, so it isn't
  sealed"), and these are business, not personal, identifiers printed on returns, permits and invoices. So they're not
  encrypted with `FieldCrypto`, and they're in backups as text.
- **Shown masked, like payroll's personal data.** The tax account numbers (EIN, EDD account, FTB ID, CDTFA permit) come
  back masked to their last four (`einMasked` and so on). `POST /businesses/:id/reveal` returns one in full after a
  recent sign-in and writes `business.revealed` to the audit log, the same pattern as a payroll person's reveal (PRL-05).
  Public-record numbers (the SOS file number, a city licence, a DBA) are shown as they are.
- The forms that must carry the full EIN (worksheets, W-2s, 1099s, EFW2) still do, as before.

### 6. Renewals

The DBA's and city licence's expiry dates, and any other registration's, feed the nightly notification job: from 30 days
before the date (`RENEW_REMINDER_DAYS`) each one is a `reminder` notification to members who can read the business,
"Harbor Kites: renew City business licence by 2026-12-31", linking to Settings. The dedupe key holds the expiry date, so
it's sent once per date and again after a renewal changes it. No new notification type.

### 7. The phone

The phone's Business settings section (the collapsible one at the foot of the Business screen) shows the entity type,
the return form and the masked EIN, read-only. Editing is on the web.

## Consequences

- A business's return form, fiscal year and registrations are in one place, and payroll can't drift from them.
- Choosing a type other than Schedule C's doesn't hide the Schedule C summary; it labels it a guide.
- `payroll_settings.ein`, `ca_employer_account` and `filing_*` are dead weight until a contract migration drops them.
- An existing `llc` business shows "LLC (choose single- or multi-member)" until its owner picks a type.
- The registered agent's address and the DBA owner aren't structured; only the employer filing address is.
- No other states: an LLC formed in Delaware has its formation state and SOS number recorded, but California's FTB and
  EDD fields are the only state tax accounts with their own fields; others go in Other registrations.

## Alternatives considered

- **A separate election column** (`taxed_as` beside a legal form). Cleaner in theory, but it allows nonsense pairs
  (a sole proprietor taxed as a partnership), and every screen would combine the two. Rejected.
- **Seal the EIN with `FieldCrypto`.** Nothing else about a business is sealed, the EIN is on every form the business
  sends, and payroll never sealed it. Masking plus a logged reveal gives the screen behaviour the owner asked for.
- **Keep the EIN in payroll and copy it to the business.** Two writable copies drift; one owner, one reader.
- **A new `registration_renewal` notification type.** `reminder` already means "something to do by a date" (rentals use
  it), so preferences and delivery need nothing new.
