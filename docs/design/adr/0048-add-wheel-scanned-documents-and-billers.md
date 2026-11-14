# ADR-0048: The Add wheel, scanned documents, and billers

- Status: accepted (extends ADR-0047 to every paper document; builds on ADR-0017 for business bills)
- Date: 2026-11-14

## Context

The phone's centre + opened quick add, with receipt scanning one tap further. The owner asked for:

- one place to add any document: transactions, receipts, statements, bills and payslips;
- the phone's document scanner (ADR-0047) for every paper document, not just receipts;
- the account found from a scanned statement, the person from a payslip, and the amount and due date from a bill;
- utility and insurance bills that match the providers the owner names in the budget, so upcoming expenses and the
  forecast know what's coming.

Before this, statements and payslips used the app's camera:

- A statement's account was picked by hand. The doc-worker already read the account's last four digits from the
  statement, but the API dropped them.
- A payslip's person came only from the employer picked before capture.

Utilities were a budget category with no idea of who sends the bill or when, so a fixed-bills line fed nothing into the
forecast unless a recurring item had been set up. Business books already had vendor bills with due dates and payment
matching (ADR-0017, BIZ-06).

## Decision

### 1. The Add wheel

- Tapping the centre + opens a wheel instead of a screen. Five round choices fan out on an arc above the button:
  **Transaction** (quick add), **Receipt**, **Statement**, **Bill** and **Payslip**.
- The + turns into a ×. Tapping it, the dimmed screen or Android's back closes the wheel.
- Choices the login can't use are left out (AUTH-18), and the rest spread over the same arc:
  - Statement needs `importFiles`.
  - Payslip needs `setUp`.
  - The other choices need `record`.
- The pure parts are in `src/features/add-wheel.ts`: the choices, their routes and the arc layout. The overlay is
  `src/ui/AddWheel.tsx`, built on React Native's `Animated` and `Modal` like `SidePanel`.

### 2. The scanner for every paper document

- `src/ui/DocumentCapture.tsx` is the shared capture used by statements, payslips, bills and reimbursement photos:
  - It opens the platform scanner first (`scanPages`, the former `scanReceipt`).
  - It falls back to the app's camera where the scanner can't run, or when chosen.
  - It can pick a photo or PDF.
- Receipts keep their own screen because they queue offline.
- Scanned statement pages are still combined into one PDF on the phone, which the server reads with OCR.
- Pages the app made (scans and shots) are removed from the phone after upload.

### 3. Detecting the account, the person and the employer

- **Statements:**
  - The account becomes optional when an import is created.
  - The account's last four digits and the bank's name come from the doc-worker's statement facts (already
    extracted) and from `extract_statement_table` v2. They pick the account:
    1. a unique `last4` match;
    2. otherwise a unique institution and type match.
  - With no confident match, the import waits in `needs_account` with the candidates, and the person chooses.
  - The phone scans first and asks for the account only when it wasn't found.
- **Payslips:**
  - The employer becomes optional.
  - `extract_payslip` v2 returns the employer's name and the employee as one of the pseudonym tokens the gateway already
    uses for family members (`MEMBER_n`). Real names still never reach the provider (AIA-03).
  - The employer is found by name among the workspace's employers, and the person from the token.
  - Without an employer, the payslip waits with the detected employer name and person, so one tap creates the employer
    for that person.

### 4. Billers and bills

- **A biller** is a provider the owner names on a budget category: "SDG&E" on Utilities, "GEICO" on Auto insurance. It
  belongs to the category, and therefore to its books (entity). Optional fields:
  - the person it's for;
  - the account number's last four digits;
  - the usual due day;
  - a cadence (monthly by default).

  Billers are stable, unlike budget lines, which are recreated each period. They live in their own table
  (`app.biller`) and show under their category on the budget screens (web and phone).
- **A scanned bill:**
  - `extract_bill`, a new AI task, reads the provider's name, account number's last four digits, amount due, due date,
    bill date, service period and currency. Images go to the provider only in modes that allow documents; local mode
    reads the doc-worker's OCR text.
  - The bill is matched to a biller:
    1. by the account's last four digits;
    2. otherwise by name, with the same payee normalization and similarity used for merchants.
  - The match gives the bill its category, books and person. With no match, the scan offers to add the biller to a
    chosen category.
- **Where a bill goes:**
  - A biller on personal books keeps its bills in `app.household_bill`.
  - A biller on a business's books is linked to a vendor (`business_party`), and its scanned bill becomes that
    business's vendor bill (`app.bill`, ADR-0017), with the category as the expense account. Due dates, the forecast
    and payment matching are then the business's own.
- **Upcoming and forecast:**
  - Every active biller adds its next bill to the calendar, Upcoming, the bill-due alerts (NOT-01) and the cash-flow
    forecast:
    - a scanned bill gives the exact amount and due date;
    - otherwise the next bill is estimated from the biller's recent payments: the average of the last three, on the
      usual due day. Estimates are marked variable.
  - The budget screen shows each biller's expected amount beside its category's assignment.
- **Paid:**
  - A household bill is matched to its payment like expected income is: a payment from any account whose payee matches
    the biller, from 5 days before to 10 days after the due date, with the amount matching. The nearest one wins.
  - The match is stored, and the bill shows as paid.
  - Business bills keep ADR-0017's matching.

### Order of work

1. The wheel and the scanner everywhere (phone only).
2. Detecting statements' accounts and payslips' people.
3. Billers on the budget and their estimates in upcoming and the forecast.
4. Bill scanning, matching and paid bills, which adds Bill to the wheel.

## Consequences

- Quick add is two taps instead of one, and every other kind of document is now two taps from anywhere.
- Statement and payslip capture need the scanner's native module. Without it, the camera fallback works as before.
- `app.biller` and `app.household_bill` are new tables with row-level security. Business bills reuse `app.bill`, so
  there's one place for a business's payables.
- The forecast gains utility bills before any is scanned, from the biller's payment history. The estimate is only as
  good as that history: a new biller with no payments shows no estimate until its first bill or payment.

## Alternatives considered

- **A bottom sheet or a pop-up list instead of a wheel.** The owner asked for a wheel. A fan keeps every choice one
  thumb's reach from the +.
- **Providers stored on budget lines.** Lines are recreated each period, keyed by category and period. A provider is
  stable across periods, so it belongs to the category.
- **One generic expected-item table** (design 03's `expected_item`). ADR-0017 already chose a table per kind, read
  through one forecast function. Household bills follow it.
- **Household bills as scheduled transactions.** A scheduled transaction has to name the account paid from and
  becomes a transaction when confirmed. A bill is a request to pay, which may be paid from any account or in parts.
  Keeping bills apart lets the payment match the bill instead.
