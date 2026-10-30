# Requirements: AI-Assisted Personal & Small Business Finance App

Oct 29, 2026 · @Mansoor

## 1. Overview

Release 1 (R1) gives one person a single place to see where money comes from and goes. It covers household spending, a small business and rental properties. AI handles categorization and suggestions so manual entry is kept to a minimum. In R1, data comes from manual entry and CSV/Excel import. Live bank connections come in R2 or later.

### 1.1 Product vision

The user should feel in control: every dollar has a job, every transaction lands in the right bucket without retyping, and the app says plainly whether this month's plan fits this month's income.

### 1.2 Goals

1. **Minimize manual work.** After the first month, 90% or more of imported transactions are categorized automatically, and the user only confirms exceptions.
2. **Clarity and control.** One dashboard answers: what came in, what went out, what is left to spend, and what is coming up.
3. **Budget alignment.** The budget is always balanced against expected income, and AI recommends adjustments when spending drifts.
4. **Separate but unified.** Personal, business and each rental property are tracked separately (for taxes) but can be viewed together (net worth, total cash flow).
5. **Privacy first.** AI can run locally or through a cloud provider the user chooses, and data is never sold.

### 1.3 Scope summary

| Area | Release 1 | Later releases |
| --- | --- | --- |
| Data capture | Manual entry, camera capture (mobile), statement import (CSV/XLS/XLSX/PDF) and receipt import on web and mobile, recurring templates | Bank aggregation (Plaid, MX, Finicity, GoCardless), email receipt forwarding, OFX/QFX |
| Categorization | Receipt line-item AI, rules + AI (local or cloud), learning from corrections; double-entry ledger underneath | Cross-user anonymized models (opt-in) |
| Budgeting | Zero-based and category budgets, rollover, goals, sinking funds | Scenario planning, multi-year forecasts |
| Money flow | Cash-flow view, Sankey flow, 30/60/90-day forecast | Live balance forecasts from bank data |
| AI recommendations | Budget alignment, overspend alerts, monthly review | Conversational assistant over all data, proactive negotiation tips |
| Small business | Income/expense, invoices (basic), mileage, tax categories, P&L | Payroll export, sales tax, accountant portal, bank feeds |
| Rental properties | Properties, units, leases, rent roll, expenses, Schedule E report | Tenant portal, online rent collection, maintenance requests |
| Platforms | Responsive web app + iOS and Android apps | Desktop app, wearable glance widgets |

### 1.4 Success metrics

| Metric | R1 target |
| --- | --- |
| Auto-categorization accuracy (accepted without edit) | ≥ 85% in month 1, ≥ 92% by month 3 |
| Time to import and review a month of statements | < 10 minutes |
| Users with a balanced budget each month | ≥ 70% of active users |
| 30-day retention | ≥ 50% |
| CSV imports that need manual column mapping after the first time | < 5% |

## 2. Users and what they ask for

Forums keep raising the same few needs. Users want data they own and can export, rules that learn from them, and no ads. They want separate books for business and rentals, and a mobile app that is as complete as the web app. Shaky bank sync is the top complaint about paid apps, which supports starting with reliable CSV import in R1.

### 2.1 Personas

| Persona | Situation | Primary need |
| --- | --- | --- |
| Household budgeter | Salaried, 1–2 earners, 4–10 accounts | Know where money goes; stop overspending; shared view with a partner |
| Solo business owner / freelancer | Mixes personal and business on some cards | Separate business from personal fast; tax-ready P\&L; quarterly estimate |
| Small landlord (1–20 units) | Self-manages, often uses spreadsheets | Per-property income and expenses, rent roll, Schedule E at tax time |
| Hybrid (primary target) | All three of the above | One app, separate books, one consolidated cash-flow and net-worth picture |
| Accountant / partner (guest) | Invited by the owner | Read-only or limited access to review and export |

### 2.2 Forum-derived requirements

Sources reviewed: r/personalfinance, r/ynab, r/MonarchMoney, r/budgeting, r/selfhosted, BiggerPockets, Capterra/App Store reviews (see Sources).

| ID | What users say | Requirement |
| --- | --- | --- |
| UP-01 | Bank sync breaks with specific banks; users lose trust when transactions go missing | R1 import must be loss-proof: duplicate detection, import summary (rows read / added / skipped), balance reconciliation against the statement ending balance |
| UP-02 | Rules engine is the most-praised feature; rules must apply to past transactions too | Rules with contains / equals / regex / amount range / account conditions; "apply to existing" option; AI suggests rules from corrections |
| UP-03 | Setup is overwhelming (categories, rules, dashboard) | Guided onboarding with templates (household, freelancer, landlord); AI proposes categories from the first import |
| UP-04 | Couples want a shared, real-time view | Household sharing with roles (owner, partner, viewer, accountant); per-account visibility |
| UP-05 | Spreadsheet fans cite opaque calculations and lock-in | Show how every number is computed (drill down to transactions); full export to CSV/XLSX/JSON at any time |
| UP-06 | Privacy: many budgeting apps share data with third parties | No ads, no selling data; local-AI option; clear data-use disclosure per AI provider |
| UP-07 | Mobile apps can be slow or limited | Mobile parity for all daily tasks (review, categorize, budget, receipt capture, rent logging) |
| UP-08 | Freelancers mix personal and business spending on one account | One-tap Business/Personal/Rental tagging per transaction; split one transaction across entities |
| UP-09 | Lost receipts and missed transactions cause missed deductions | Receipts stored reliably with each transaction; "missing receipt" flags for deductible items above a threshold |
| UP-10 | Landlords run on spreadsheets that get messy at tax time | Per-property ledgers with Schedule E-aligned categories; one-click tax package export |
| UP-11 | Not every user wants to track every purchase | Support "light mode": pay-yourself-first savings target and a single "everything else" budget |
| UP-12 | Cost is a frequent complaint; users want a basic tier | Pricing tiers: free/basic personal, paid for business + rentals (product decision; see open questions) |
| UP-13 | Self-hosters use local LLMs (Ollama) to categorize CSV imports | Pluggable AI provider: built-in model, local LLM endpoint, or cloud API key |
| UP-14 | Recurring bills should be detected and tracked automatically | Recurring transaction detection, upcoming-bills calendar, price-change alerts on subscriptions |

## 3. Accounts, transaction capture and AI categorization

Priority key: **M** = must for R1, **S** = should for R1, **C** = could / later.

### 3.1 Entities and accounts

| ID | Requirement | Priority |
| --- | --- | --- |
| ACC-01 | A user workspace holds multiple **entities**: Personal (household), one or more Businesses, and a Rental portfolio. Each entity has its own categories, budgets and reports. | M |
| ACC-02 | Account types: checking, savings, credit card, cash, loan, mortgage, line of credit, investment (balance only), asset (property, vehicle), liability. | M |
| ACC-03 | Each account has a default entity, but individual transactions can be reassigned or split across entities. | M |
| ACC-04 | Multi-currency accounts and foreign-currency spending, with conversion to the home currency (see 13.3). | M |
| ACC-05 | Opening balance and balance adjustments, with an audit trail. | M |
| ACC-06 | Archive closed accounts while keeping history. | M |

### 3.2 Manual entry and camera capture

| ID | Requirement | Priority |
| --- | --- | --- |
| TXN-01 | Quick-add in 3 taps or fewer on mobile (and a quick-add bar on web): amount, payee, and AI-suggested category (prefilled). | M |
| TXN-02 | Fields: date, amount, payee, account, category, entity, property/unit (optional), family member (optional; blank = Household), tags, memo, attachments, cleared/reconciled status. | M |
| TXN-03 | Split transactions across categories and entities (e.g., Costco: groceries + office supplies). | M |
| TXN-04 | Transfers between accounts post as **one double-entry journal entry**: debit the receiving account, credit the sending account. They are excluded from income/expense (see 3.6). | M |
| TXN-05 | Recurring templates (rent, salary, subscriptions) that auto-create scheduled transactions to confirm. | M |
| TXN-06 | Natural-language entry: "lunch 18.50 amex client meeting" is parsed into fields by AI. | S |
| TXN-07 | Voice entry on mobile, using the same parser. | C |
| TXN-08 | **Camera capture on mobile:** photograph a receipt (single shot, or multi-shot for long receipts) with auto edge detection and a blur/glare check. AI reads merchant, date, line items, tax, total and card last-4 digits, picks the account, and creates or matches the transaction. | M |
| TXN-09 | Camera capture works offline; images queue and process when the device reconnects. | S |
| TXN-10 | Bulk edit (category, entity, tags) on multi-select. | M |

### 3.3 Statement and receipt import (web and mobile)

| ID | Requirement | Priority |
| --- | --- | --- |
| IMP-01 | **Web:** upload bank and card statements (CSV, XLS, XLSX, PDF) and receipts (JPG, PNG, HEIC, PDF) by drag-and-drop or file picker, several files at once. | M |
| IMP-02 | **Mobile:** import the same file types from Files, the photo library, email attachments or the share sheet. Paper statements can be scanned with the camera. | M |
| IMP-03 | AI auto-detects the column mapping (date, description, amount or debit/credit, balance), date format, decimal separator, sign convention and header rows. | M |
| IMP-04 | Mapping is saved as a per-bank **import profile** and reused automatically by matching file shape and account. | M |
| IMP-05 | PDF statements (digital or scanned, multi-page): AI table extraction, verified against the statement's opening and closing balances. | M |
| IMP-06 | Preview screen before commit: parsed rows, proposed categories with confidence, duplicates flagged, rows with errors highlighted. | M |
| IMP-07 | Duplicate detection using date ± 3 days, amount, and normalized description, including overlap with earlier imports and manual entries. Manual entries are **matched**, not duplicated. | M |
| IMP-08 | Import summary: rows read, added, matched, skipped, failed; statement ending balance check. | M |
| IMP-09 | Undo a whole import batch within 30 days. | M |
| IMP-10 | Payee normalization: "SQ \*BLUE BOTTLE 0423 SF" becomes "Blue Bottle Coffee"; the raw text is kept. | M |
| IMP-11 | Receipt import matches each receipt to an existing transaction (amount within tip tolerance, date ± 5 days, merchant) or creates a new one. Unmatched receipts wait in a **receipt inbox**. | M |
| IMP-12 | OFX/QFX/QIF import. | C |
| IMP-13 | Import from other apps: YNAB, Mint export, Monarch, Quicken, Stessa CSV templates. | S |
| IMP-14 | Email-forwarding address for statements and receipts. | C |

### 3.4 AI categorization pipeline

Categorization runs in a fixed order, cheapest and most certain first. Each step only handles what the earlier steps left open:

1. **Receipt line items:** when a receipt is attached, each line item is categorized on its own and the transaction is split by category (see 3.5). This takes priority over the merchant name.
2. **User rules:** exact rules the user created or accepted.
3. **Transfer and match detection:** pairs across accounts (card payment, savings transfer) and matches to scheduled/recurring items.
4. **Personal history:** the same normalized payee previously categorized by this user (with amount-pattern awareness).
5. **AI model:** an LLM or classifier given the payee, description, amount, account, entity, date and the user's category list. It returns category, entity, property, tags and a confidence score.
6. **Review queue:** anything under the confidence threshold (default 0.80, user-adjustable).

| ID | Requirement | Priority |
| --- | --- | --- |
| AI-01 | The pipeline above runs on every import and manual entry. | M |
| AI-02 | Predicts category **and** entity (Personal/Business/Rental) **and** property/unit where applicable. | M |
| AI-03 | Confidence shown per suggestion; high-confidence items auto-apply, low ones go to the review queue. | M |
| AI-04 | Review queue: swipe to accept on mobile, keyboard shortcuts on web, "accept all above X%". | M |
| AI-05 | Learn from corrections: after 2 identical corrections, offer to create a rule; the rule can be applied retroactively. | M |
| AI-06 | Explain each suggestion in one line ("Matched rule 'Shell → Fuel'" or "Similar to 6 past transactions"). | M |
| AI-07 | Merchant enrichment: clean name, logo, merchant category (MCC) when available. | S |
| AI-08 | Detect recurring transactions and subscriptions from history; propose recurring templates. | M |
| AI-09 | Flag anomalies: unusual amount for a payee, possible duplicate charge, new subscription, price increase. | S |
| AI-10 | Tax hints: mark likely-deductible business or rental expenses and map them to tax lines (Schedule C / E). | S |
| AI-11 | Batch categorization of a 1,000-row import completes in under 60 seconds with a cloud provider. | M |

### 3.5 Receipt line-item categorization

A receipt is categorized by what was bought, not where it was bought. A Walmart receipt with milk, a phone charger and a T-shirt becomes one transaction split into Groceries, Electronics and Clothing, with tax spread across the taxable items.

Example (8% tax on non-food items):

| Line on receipt | Read as | Category | Amount incl. tax |
| --- | --- | --- | --- |
| GV 2% MLK GAL | Great Value 2% milk, 1 gal | Groceries | $3.48 |
| BANANAS | Bananas | Groceries | $1.62 |
| ONN USB-C CHRGR | onn. USB-C charger | Electronics | $13.91 |
| TS MENS TEE | Men's T-shirt | Clothing | $9.70 |
| **Total** |  | 3 splits | **$28.71** |

| ID | Requirement | Priority |
| --- | --- | --- |
| RCP-01 | Extract every line item (description, quantity, unit price, line total, discounts/coupons, taxable flag) plus subtotal, tax, fees, tip and total. | M |
| RCP-02 | Expand abbreviated item names with AI and retailer product knowledge ("GV 2% MLK GAL" becomes Great Value 2% milk). | M |
| RCP-03 | Categorize each line into the user's categories and entity; lines in the same category are grouped into one split. | M |
| RCP-04 | Allocate tax, discounts and fees across splits in proportion to each split's taxable subtotal. Any rounding remainder goes to the largest split, so splits sum exactly to the total. | M |
| RCP-05 | Validate: lines + tax − discounts must equal the receipt total (± $0.02). Otherwise the receipt is flagged for review with the gap shown. | M |
| RCP-06 | Review screen shows the receipt image beside the extracted lines. Editing a line's category teaches an item-level rule (e.g., item contains "charger" → Electronics). | M |
| RCP-07 | Mixed business/personal: lines can go to different entities (printer paper → Business: Office supplies). | M |
| RCP-08 | Returns and refunds: negative lines reverse the original line's category. | S |
| RCP-09 | Item-level reports: spending by item or category across stores (e.g., all electronics bought at Walmart, Target and Amazon). | S |
| RCP-10 | Receipt images and extracted data kept 7 years by default and searchable by OCR text. | M |
| RCP-11 | With no receipt, merchant-based categorization applies. Multi-department stores (Walmart, Target, Costco, Amazon) above a threshold (default $50) are flagged "receipt recommended". | S |
| RCP-12 | Online orders: import order-history files or invoice PDFs (e.g., Amazon) and categorize them line by line the same way. | S |

### 3.6 Double-entry ledger

Every money movement posts as a balanced journal entry: total debits always equal total credits. Users still enter simple transactions. The ledger is generated underneath and can be viewed at any time.

| Event | Debit | Credit | Amount |
| --- | --- | --- | --- |
| Move money from checking to savings | Savings (asset) | Checking (asset) | $500.00 |
| Pay the credit card bill | Credit card (liability) | Checking (asset) | $1,200.00 |
| Walmart receipt above, paid by card | Groceries $5.10, Electronics $13.91, Clothing $9.70 | Credit card (liability) | $28.71 |
| Tenant pays rent | Checking (asset) | Rental income: 12 Oak St | $1,800.00 |
| Mortgage payment | Mortgage principal $610, Mortgage interest $940, Escrow $450 | Checking (asset) | $2,000.00 |

| ID | Requirement | Priority |
| --- | --- | --- |
| DE-01 | Every transaction creates a journal entry with 2 or more postings. Debits must equal credits; an unbalanced entry cannot be saved. | M |
| DE-02 | Chart of accounts with five types: asset, liability, equity, income, expense. Each bank/card account and each category is a ledger account. | M |
| DE-03 | Transfers between accounts are one entry that appears in both registers, linked, and never counts as income or expense. | M |
| DE-04 | Card payments, loan and mortgage payments post to liability accounts (principal), expense (interest) and escrow as shown above. | M |
| DE-05 | Between entities (personal card pays a business expense): an owner contribution in the business and an owner draw in personal, or due-to/due-from accounts if the user prefers. | M |
| DE-06 | Account register columns: Date, Description, Debit, Credit, Running balance. A toggle switches to a simple +/− view. | M |
| DE-07 | Journal view for any transaction, plus manual journal entries (opening balances, adjustments, depreciation) for advanced users and accountants. | M |
| DE-08 | Reconciliation against statements: postings marked cleared, reconciled entries locked unless unlocked with an audit note. | M |
| DE-09 | Period close: lock a month or year per entity. | S |
| DE-10 | Changes to a closed or reconciled period create reversing entries instead of silent edits. | S |

### 3.7 Family members and payslips

Any income or expense can be tagged to a family member. Anything left untagged counts as **Household**. This lets the user see, for example, the full cost of a son's college year next to the household's shared costs, even though he has no income.

| Example | Tagged to | Shows in |
| --- | --- | --- |
| Your salary deposit (from payslip) | You | Income by member: You |
| Spouse's salary | Spouse | Income by member: Spouse |
| Tuition, dorm, textbooks, meal plan | Son | Spending by member: Son (Education, Housing, Food) |
| Weekly groceries, utilities, mortgage | (none) | Household |
| Walmart receipt: groceries + son's dorm supplies | Line-level: Household + Son | Split across both |

#### Members

| ID | Requirement | Priority |
| --- | --- | --- |
| FAM-01 | Declare family members: name, relationship (self, spouse/partner, child, parent, other), date of birth (optional), avatar/colour, status (active/inactive). **Household** is a built-in group, not a person. | M |
| FAM-02 | Members are profiles, not logins. A member can optionally be linked to an app user (e.g., a spouse sharing the workspace) with that user's own permissions. | M |
| FAM-03 | Each income or expense split has an optional **member** field. Blank means Household. Splits let one transaction or receipt be shared across members and Household. | M |
| FAM-04 | Default member per account or card (e.g., the son's debit card → Son), applied automatically to its transactions. | M |
| FAM-05 | AI suggests the member from the account, card last-4, payee and receipt items (a college bookstore, tuition portal or dorm fee → Son), with the same confidence and review-queue rules as categories. Corrections become member rules. | M |
| FAM-06 | Optional per-member budgets (e.g., Son: college $X per semester) alongside the household budget. A member's spending counts against both their own budget and the matching household category. | S |
| FAM-07 | Member goals and sinking funds (e.g., college fund, spring tuition due Jan 15). | S |
| FAM-08 | Reports group by member: income by earner, spending by member and category, Household vs member share, cost per member over time (e.g., total college cost per year). | M |
| FAM-09 | Dashboard filter by member; drill-down from any member total to its transactions. | M |
| FAM-10 | Tax helpers: mark dependents and education expenses that may matter for education credits or 529 withdrawals (informational only). | C |
| FAM-11 | Archive a member (e.g., an adult child who moves out) without losing history. | M |

#### Payslips (inflow by individual)

Not every member has a salary. Members with income can have payslips, which record gross-to-net detail instead of only the net deposit seen in the bank statement.

| ID | Requirement | Priority |
| --- | --- | --- |
| PAY-01 | Add employers (or other income sources such as freelance, pension, benefits) per member, with pay frequency and the bank account the pay lands in. | M |
| PAY-02 | Payslip fields: pay date, pay period, employer, gross pay (salary, overtime, bonus, commission), pre-tax deductions (401(k), HSA/FSA, health/dental/vision premiums), taxes (federal, state, local, Social Security, Medicare), post-tax deductions (Roth 401(k), loan repayment, union dues), employer contributions (match, HSA), net pay, and YTD figures. | M |
| PAY-03 | Capture payslips by PDF upload (web and mobile) or camera photo. AI extracts the fields and the user confirms them; recurring payslips prefill from the last one. | M |
| PAY-04 | Match each payslip's net pay to the salary deposit in the imported bank statement, so the deposit is not counted twice. | M |
| PAY-05 | Each payslip posts as one double-entry journal entry, tagged to the member. Example: credit Salary income (gross); debit Checking (net), Federal and state tax, Social Security/Medicare, 401(k) (asset), Health insurance (expense). | M |
| PAY-06 | Reports per member: gross vs net income, total taxes withheld, retirement contributions, effective withholding rate, YTD vs prior year. | M |
| PAY-07 | Expected income in the budget (BUD-03) comes from each earner's payslip pattern; a missing or lower payslip triggers REC-04. | S |
| PAY-08 | Members without payslips can still record other income (gifts, part-time cash work, scholarships, stipends) tagged to them. | M |
| PAY-09 | Payslip images and data are protected like receipts and visible only to workspace owners and the member's linked user. | M |

## 4. Budgeting, planning and money flow

The budget is the core of R1. Its job is to match planned spending to expected income, so the user always sees one number: **left to assign** (income not yet given a job) or **over-assigned** (plan exceeds income).

### 4.1 Budget setup

| ID | Requirement | Priority |
| --- | --- | --- |
| BUD-01 | Budget methods selectable per entity: zero-based (every dollar assigned), category limits with rollover, and 50/30/20 "light" mode. | M |
| BUD-02 | AI drafts the first budget from 1–3 months of imported history: average spend per category, fixed vs variable, and detected recurring bills. | M |
| BUD-03 | Expected income: salary, business revenue forecast, rent roll. These are entered or detected, and the budget is checked against them. | M |
| BUD-04 | Category groups (Fixed bills, Daily living, Fun, Savings goals, Debt, Business, Rental). | M |
| BUD-05 | Monthly periods by default; weekly or bi-weekly pay-period budgets as an option. | S |
| BUD-06 | Rollover rules per category: carry surplus, carry deficit, or reset. | M |
| BUD-07 | Sinking funds for irregular costs (insurance, property tax, car repair) with a monthly contribution auto-calculated from target and due date. | M |
| BUD-08 | Goals: emergency fund, debt payoff (snowball/avalanche), savings target, with progress and projected completion date. | M |
| BUD-09 | Copy last month, or the 3-month average, into a new month in one action. | M |
| BUD-10 | Move money between categories, with a history of moves. | M |

### 4.2 Money flow and control

| ID | Requirement | Priority |
| --- | --- | --- |
| FLOW-01 | Home dashboard: income this month, spent, left to spend, left to assign, upcoming bills (next 14 days), and net worth trend. | M |
| FLOW-02 | Flow diagram (Sankey): income sources, then entity, then category groups, then categories, plus savings/debt. Each node is clickable to its transactions. | M |
| FLOW-03 | Cash-flow forecast for 30/60/90 days using recurring items, scheduled bills, budget and expected income; warns about low-balance dates per account. | M |
| FLOW-04 | Spending pace: a per-category bar showing spent vs budget vs where you "should" be today. | M |
| FLOW-05 | Calendar view of bills and paydays. | S |
| FLOW-06 | Consolidated view across entities, with owner draws and contributions between entities shown as transfers, not spending. | M |
| FLOW-07 | Net worth: assets (accounts, property values) minus liabilities (cards, loans, mortgages). | S |

### 4.3 AI budget recommendations (basic, R1)

Recommendations are suggestions only. Each one shows its reasoning and the numbers behind it, and the user can accept with one tap, edit, or dismiss.

| ID | Trigger | Recommendation | Priority |
| --- | --- | --- | --- |
| REC-01 | Planned spending > expected income | Proposes specific cuts across flexible categories, ranked by past overspend and user priority, until the budget balances | M |
| REC-02 | Category on pace to overspend by ≥ 10% | Alert + options: move money from named categories with surplus, or reduce discretionary spending by $X/day for the rest of the period | M |
| REC-03 | Income arrives higher than expected | Suggests allocating the surplus by the user's priority order (emergency fund → high-interest debt → goals → fun) | M |
| REC-04 | Income arrives lower or late | Shows which upcoming bills are at risk and proposes a reduced "bare-bones" budget | M |
| REC-05 | Budget consistently under- or over-set for 3 months | Suggests a realistic amount for that category | M |
| REC-06 | Subscription unused or price increased | Flags it for review or cancellation | S |
| REC-07 | Month end | Monthly review: 5-line plain-language summary, what went well, top 3 leaks, and next month's suggested budget | M |
| REC-08 | Irregular income (business, rent) | Recommends a "buffer" approach: budget from last month's income, with a target buffer of 1 month of expenses | S |
| REC-09 | Business or rental income received | Suggests a tax set-aside amount (user-set % or estimate) transferred to a tax savings category | S |

Rules for all recommendations:

- The user sets **priorities** once (needs, goals, debt, wants ranking), and recommendations follow them.
- Never moves money or changes the budget without user confirmation (unless the user enables auto-apply for a specific rule).
- Tone: neutral and non-judgmental. No shaming language.
- Frequency cap: at most 1 push notification per day for recommendations (user-adjustable).

## 5. Small business management

R1 targets sole proprietors, freelancers and single-member LLCs with up to about 5 people. They need clean books, tax readiness and simple invoicing, without accounting jargon. The double-entry ledger (3.6) runs underneath, so the books balance and an accountant can review journals and a trial balance.

| ID | Requirement | Priority |
| --- | --- | --- |
| BIZ-01 | Create one or more businesses, each with name, type (sole prop, LLC, S-corp), tax year, currency and default accounts. | M |
| BIZ-02 | Business chart of categories pre-mapped to IRS Schedule C lines (configurable for other countries). | M |
| BIZ-03 | Business/personal separation: AI flags business-looking expenses on personal accounts and vice versa; one-tap reclassify. Owner draws and contributions are recorded as equity transfers. | M |
| BIZ-04 | Customers and vendors directory, auto-built from payees. | M |
| BIZ-05 | Simple invoices: line items, tax, due date, PDF and email; status Draft / Sent / Paid / Overdue. Payments imported later are auto-matched to open invoices. | S |
| BIZ-06 | Bills/payables: record vendor bills with due dates; they appear in the cash-flow forecast. | S |
| BIZ-07 | Mileage log: manual trips in R1 with the IRS standard rate (rate table maintained by admin); GPS auto-tracking later. | S |
| BIZ-08 | Home-office deduction helper (simplified and actual-expense methods). | C |
| BIZ-09 | Estimated quarterly tax: set-aside calculator based on YTD net profit and user-entered effective rate; due-date reminders. | S |
| BIZ-10 | Reports: Profit & Loss (month, quarter, YTD, custom), expenses by category/vendor, income by customer, Schedule C summary. | M |
| BIZ-11 | Business budget: revenue targets and expense limits, plus a monthly AI note on margin trends. | S |
| BIZ-12 | Receipt vault: every business expense can carry an image or PDF; missing-receipt list for items over a threshold (default $75). | M |
| BIZ-13 | Accountant access: an invited user with read-only or edit access to selected entities only; export to CSV/XLSX and QuickBooks/Xero-compatible formats. | S |
| BIZ-14 | Sales tax/VAT tracking per transaction. | C |
| BIZ-15 | Payroll summary import (from a payroll provider CSV). | C |

## 6. Rental property management

R1 serves self-managing landlords with 1–20 units. It covers per-property books, leases, the rent roll, expected vs received rent, and tax-ready reports. Tenant-facing features (portal, online rent collection) are deferred.

| ID | Requirement | Priority |
| --- | --- | --- |
| RNT-01 | Properties: address, type (SFH, multi-family, condo, short-term rental), purchase date and price, ownership % (for partnerships), current estimated value. | M |
| RNT-02 | Units within a property, each with beds/baths, market rent and status (occupied, vacant, under repair). | M |
| RNT-03 | Tenants and leases: tenant contacts, lease start/end, rent amount, due day, late-fee rule, security deposit held, lease document attachment. | M |
| RNT-04 | Rent roll: auto-generated expected-rent schedule per lease. Imported deposits are AI-matched to the tenant/unit by amount, payer name and date. | M |
| RNT-05 | Arrears tracking: unpaid or partial rent, days late, late fees accrued; reminder list for the landlord. | M |
| RNT-06 | Property expenses with Schedule E-aligned categories (advertising, cleaning/maintenance, insurance, legal/professional, management fees, mortgage interest, repairs, supplies, taxes, utilities, depreciation, other). | M |
| RNT-07 | Allocate shared expenses across properties/units (e.g., one insurance policy, one handyman invoice) by %, units or square footage. | M |
| RNT-08 | Mortgage tracking: split each payment into principal, interest and escrow from an amortization schedule; escrow taxes and insurance flow to the right categories. | S |
| RNT-09 | Capital improvements vs repairs: AI flags large items that may need to be capitalized; a depreciation schedule (27.5-year residential, straight-line) as a helper with a disclaimer. | S |
| RNT-10 | Security deposits held as liabilities, not income; returned/forfeited handling. | M |
| RNT-11 | Reports per property and portfolio: income statement, cash flow, NOI, cash-on-cash return, cap rate (using user-entered value), occupancy/vacancy, Schedule E summary. | M |
| RNT-12 | Reminders: lease expirations (60/30 days), insurance renewals, property tax due dates, inspection dates. | S |
| RNT-13 | Maintenance log: issue, vendor, cost, photos, linked transactions. | S |
| RNT-14 | Rental budget per property (expected rent minus planned expenses and reserves), with a capex reserve per unit per month. | M |
| RNT-15 | Short-term rental support: import payout CSVs from Airbnb/VRBO, split into gross booking, platform fees and cleaning fees. | C |
| RNT-16 | Tenant portal, online rent collection, applications/screening, e-signature. | C (future) |

## 7. Reports, search and notifications

| ID | Requirement | Priority |
| --- | --- | --- |
| RPT-01 | Standard reports: spending by category/payee/tag, income vs expense trend, budget vs actual, cash flow, net worth, P&L per entity, Schedule C and E summaries, general ledger, trial balance, balance sheet, and income and spending by family member (Household as its own group). | M |
| RPT-02 | Filters on every report: date range, entity, account, category, tag, property; save as a custom report. | M |
| RPT-03 | Every chart value drills down to the underlying transactions. | M |
| RPT-04 | Export any report to PDF, CSV and XLSX. Year-end **tax package** (ZIP of reports + receipts) per entity. | M |
| RPT-05 | Global search across transactions, payees, notes, amounts ("> 500"), and receipt text (OCR). | M |
| RPT-06 | Ask-your-data: natural-language questions ("How much did I spend on dining in Q3 vs Q2?") answered with a number, a small chart and the transactions behind it. | S |
| NOT-01 | Notifications (push, email, in-app), each type toggled separately: bill due, low balance forecast, overspend pace, large transaction, rent overdue, lease expiring, import reminder ("last import was 9 days ago"), monthly review ready. | M |
| NOT-02 | Weekly digest email or push: last week's spending, budget status, items to review. | S |
| NOT-03 | Quiet hours and a daily notification cap. | M |

## 8. AI architecture and provider choice

AI sits behind one internal **AI gateway** so the provider can be swapped without changing features. The user picks a privacy mode, and every AI feature degrades gracefully when AI is off: rules and history still categorize, and the rest goes to the review queue.

### 8.1 Provider modes

| Mode | Where it runs | Data leaving the user's control | Best for |
| --- | --- | --- | --- |
| Built-in (default) | App's own hosted models in the app's cloud region | Transaction text to the app's servers only; never used for training without opt-in | Most users |
| Bring-your-own cloud key | OpenAI, Anthropic, Google, Azure OpenAI, etc. via the user's API key | Minimized prompts sent to the chosen provider under its terms | Power users wanting a specific model |
| Local / self-hosted | On-device model (mobile), or a local endpoint (Ollama, LM Studio, OpenAI-compatible URL) | None | Privacy-first users, self-hosters |
| Off | — | None | Users who want rules only |

### 8.2 AI requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| AIA-01 | AI gateway abstracts providers behind task-level functions: categorize, extract receipt, map CSV columns, parse natural language, summarize month, recommend budget, answer question. | M |
| AIA-02 | Per-task model routing: a small/cheap model for categorization and column mapping, a larger model for summaries and Q&A. | M |
| AIA-03 | Data minimization: send only the fields needed; mask account numbers and personal names; never send credentials. | M |
| AIA-04 | Structured outputs (JSON schema) with validation; invalid output falls back to the review queue. | M |
| AIA-05 | Deterministic numbers: all arithmetic (totals, forecasts, budget math) is computed in code, never by the model. The model only explains and suggests. | M |
| AIA-06 | Per-user learning stored as rules and payee history (explainable, editable, deletable), not as opaque fine-tunes, in R1. | M |
| AIA-07 | Caching: the same normalized payee + amount band is not re-sent to the model. | M |
| AIA-08 | Cost and usage controls: monthly AI budget per user and graceful downgrade when exceeded. | S |
| AIA-09 | Evaluation: a labelled benchmark set of 5,000+ transactions, with accuracy tracked per release and per provider. | M |
| AIA-10 | Audit log of every AI action (input hash, model, output, confidence, accepted/edited). The user can view and delete it. | S |
| AIA-11 | Opt-in anonymized sharing of corrections to improve shared merchant mappings. | C |
| AIA-12 | Disclaimers: tax and financial outputs are informational, not professional advice. | M |

## 9. Platforms: web and mobile

Web and mobile share one backend API and have functional parity. The web app is optimized for setup, imports, bulk review and reports. Mobile is optimized for quick capture, review and checking status.

| ID | Requirement | Priority |
| --- | --- | --- |
| PLT-01 | Responsive web app (latest 2 versions of Chrome, Edge, Safari, Firefox), usable from 360 px to 4K. | M |
| PLT-02 | Native or cross-platform mobile apps for iOS 17+ and Android 11+ (e.g., React Native or Flutter), sharing one API. | M |
| PLT-03 | Feature parity: every R1 function is available on mobile. Bulk-heavy tasks (mapping a new CSV format, custom reports) are supported but may be simplified. | M |
| PLT-04 | Mobile import: open a CSV/XLSX from Files, email or the share sheet straight into the import flow. | M |
| PLT-05 | Offline mode on mobile: view recent data, add transactions and capture receipts offline; sync with conflict resolution (last-write-wins per field, with a conflict notice). | S |
| PLT-06 | Real-time sync across devices and household members (< 5 s propagation). | M |
| PLT-07 | Biometric unlock (Face ID / fingerprint) and an app-lock timeout. | M |
| PLT-08 | Home-screen widgets: left to spend, upcoming bills; quick-add shortcut. | S |
| PLT-09 | Installable PWA as a fallback for unsupported devices. | C |
| PLT-10 | Keyboard shortcuts on web for review and categorization. | S |
| PLT-11 | Localization-ready: currency, date and number formats; English first. | M |

## 10. Non-functional requirements

| ID | Area | Requirement |
| --- | --- | --- |
| NFR-01 | Security | Encryption in transit (TLS 1.2+) and at rest (AES-256); field-level encryption for account numbers and notes. |
| NFR-02 | Security | MFA (TOTP, passkeys); session management with device list and remote sign-out. |
| NFR-03 | Security | Role-based access per entity (owner, partner, viewer, accountant); full audit log of changes. |
| NFR-04 | Security | Annual penetration test; SOC 2 Type II readiness before bank aggregation (R2), which aggregators require. |
| NFR-05 | Privacy | No ads; no sale of data; GDPR/CCPA rights (export, delete) self-service; a plain-language privacy page per AI mode. |
| NFR-06 | Data ownership | Full export (CSV/XLSX/JSON + receipts) any time; account deletion purges data within 30 days. |
| NFR-07 | Performance | Dashboard loads in < 2 s (p95) with 50,000 transactions; import of 5,000 rows parses in < 10 s before AI. |
| NFR-08 | Availability | 99.9% monthly uptime; daily backups, 35-day point-in-time recovery. |
| NFR-09 | Accuracy | Money stored as integer minor units (cents) or decimal; no floating-point math; every balance reconcilable to transactions. |
| NFR-10 | Accessibility | WCAG 2.2 AA on web; platform accessibility (VoiceOver/TalkBack, dynamic type) on mobile; charts have table alternatives. |
| NFR-11 | Usability | First import to first categorized dashboard in under 10 minutes for a new user. |
| NFR-12 | Scalability | Multi-tenant architecture supporting 100k users in year 1 without redesign. |
| NFR-13 | Observability | Error tracking, import failure analytics by bank format, AI accuracy dashboards. |
| NFR-14 | Compliance | Tax helpers carry disclaimers; no investment advice in R1. |

## 11. Core data model

| Entity | Key fields | Relationships |
| --- | --- | --- |
| Workspace | base currency, members, AI mode, priorities | has many Entities, Users, Family members |
| Family member | name, relationship, birth date, status, linked user (optional) | tagged on Postings and Receipt lines; has Employers, Payslips, member budgets |
| Entity | type (Personal / Business / Rental portfolio), name, tax profile | has Ledger accounts, Budgets |
| Ledger account | type (asset, liability, equity, income, expense), name, parent, tax line mapping (Schedule C/E), currency | bank/card accounts and categories are both ledger accounts |
| Bank account (detail) | institution, last-4, opening balance, import profile, default member | extends a Ledger account; has Import batches |
| Transaction | date, payee (raw + normalized), memo, status, source (manual / camera / import / receipt / payslip), import batch id | owns one Journal entry; has Attachments, Tags |
| Journal entry | date, description, entity, locked flag | has 2+ Postings; debits = credits enforced |
| Posting | ledger account, debit or credit (minor units), family member (blank = Household), property/unit, cleared/reconciled | belongs to Journal entry |
| Receipt | image(s), merchant, date, subtotal, tax, discounts, total, OCR text, match status | linked to a Transaction; has Receipt lines |
| Receipt line | raw text, expanded name, qty, unit price, line total, taxable, category, entity, family member | drives the Postings of the linked Transaction |
| Employer / income source | name, member, type, pay frequency, deposit account | has Payslips |
| Payslip | pay date, period, gross, deductions, taxes, employer contributions, net, YTD, image | posts one Journal entry; matched to the net-pay deposit |
| Rule | conditions (payee or item text), actions (category, entity, member), origin (user / AI-suggested), hit count | applied to Transactions and Receipt lines |
| Import batch | file name, file type, profile, row counts, created at | has Transactions; can be undone |
| Budget | entity, period, method, member (optional) | has Budget lines (category, assigned, rollover) |
| Goal | type, target, due date, linked category, member (optional) | — |
| Recurring item | payee, amount pattern, cadence, next date | generates scheduled Transactions |
| Property / Unit | address, value, ownership %, beds/baths, market rent | has Leases; tagged on Postings |
| Tenant / Lease | dates, rent, due day, deposit, late fee | generates Rent charges; payments match Transactions |
| Customer / Vendor / Invoice | contact, terms, lines, status | Invoice payments match Transactions |
| AI event | task, model, input hash, output, confidence, user action | audit trail |

Design note: rent charges, invoices and scheduled bills are **expected** items. Imported bank transactions are **actual** items. Matching expected to actual drives arrears, invoice status and forecast accuracy, and it will plug directly into live bank feeds in R2.

## 12. Recommended tech stack

The recommendation is a TypeScript monorepo: Next.js on web, React Native (Expo) on mobile, a Node.js API and a PostgreSQL ledger. A small team can then share domain logic, validation and the API client across web and mobile. All AI and OCR calls go through one gateway, so providers can be swapped.

| Layer | Recommendation | Why | Alternatives |
| --- | --- | --- | --- |
| Web app | Next.js (React) + TypeScript, Tailwind + shadcn/ui, TanStack Query; charts with ECharts (has Sankey) | Large ecosystem, server rendering for fast dashboards | SvelteKit, Angular |
| Mobile apps | React Native with Expo; VisionCamera + ML Kit / Apple Vision for receipt edge detection; SQLite or WatermelonDB for offline | One codebase for iOS and Android; shares TypeScript packages with web | Flutter; native Swift/Kotlin |
| Shared code | Monorepo (Turborepo/Nx): domain models, ledger rules, Zod schemas, API client, formatting | Same money math and validation everywhere | — |
| API | Node.js + NestJS, REST with OpenAPI spec; WebSockets for live sync | Typed end to end; easy to document for partners | Python FastAPI, .NET, Go |
| Database | PostgreSQL 16+ (managed: AWS RDS/Aurora, Neon or Supabase); amounts in bigint minor units; row-level security per workspace; constraint trigger enforcing debits = credits | ACID transactions suit a ledger; mature backups and point-in-time recovery | — |
| Jobs and queue | BullMQ on Redis, or AWS SQS; workers for imports, OCR, AI, reports, backups, reminders | Imports and AI run async without blocking the app | Temporal for complex workflows |
| Cache / sessions | Redis | Rate limits, sessions, AI result cache | — |
| File storage | S3-compatible object storage (AWS S3 or Cloudflare R2), encrypted, versioned, presigned uploads | Cheap, durable storage for receipts, payslips and statements | Azure Blob, GCS |
| OCR / document AI | Vision-capable LLM for receipts and payslips; AWS Textract, Google Document AI or Azure Document Intelligence for statements; local option: PaddleOCR/Tesseract + local vision model | Line-item accuracy; local option for privacy mode | — |
| LLM gateway | LiteLLM (or similar) routing to Anthropic Claude, OpenAI, Google Gemini, or local Ollama/vLLM | One interface; per-task routing, cost caps and failover | Custom gateway |
| File parsing | SheetJS/ExcelJS (XLS/XLSX), Papa Parse (CSV), pdfplumber in a Python worker (PDF) | Handles messy real-world bank files | — |
| Search | PostgreSQL full-text + pg\_trgm (fuzzy payee match) | No extra service in R1 | OpenSearch later |
| Authentication | Managed identity provider (Auth0, Clerk or AWS Cognito) with passkeys/WebAuthn and TOTP | Proven MFA, recovery and breach protection | Self-hosted Keycloak or Ory |
| FX rates | ECB reference rates (free, daily) + Open Exchange Rates for wider coverage | Historical and daily rates | exchangerate.host |
| Notifications | Expo Push (APNs/FCM); email via Postmark or Amazon SES | Reliable delivery on both platforms | OneSignal |
| Payments | Stripe (web), App Store / Google Play billing (mobile) | Store rules require in-app billing on mobile | Paddle |
| Hosting | Docker containers on AWS (ECS Fargate) or GCP Cloud Run; Terraform; Cloudflare CDN/WAF | Managed scaling and security | Azure, Fly.io |
| Observability | OpenTelemetry, Sentry, Grafana or Datadog | Errors, traces, queue lag, AI accuracy dashboards | — |
| CI/CD and quality | GitHub Actions, Expo EAS Build, feature flags (Unleash); Vitest, Playwright (web), Maestro (mobile), property tests on ledger balancing | Safe, frequent releases | — |
| Self-hosted edition | Docker Compose bundle (app + Postgres + MinIO + Ollama) | Serves privacy-first users | C (later) |

## 13. Operations, security and settings

### 13.1 Authentication and account security

| ID | Requirement | Priority |
| --- | --- | --- |
| AUTH-01 | Sign up and sign in with email + password, passkeys (WebAuthn), Sign in with Apple and Google. | M |
| AUTH-02 | Passwords: minimum 12 characters, checked against known-breached lists, no forced periodic resets (NIST SP 800-63B), stored with Argon2id. | M |
| AUTH-03 | Email verification before any financial data is added. | M |
| AUTH-04 | MFA: authenticator app (TOTP) and passkeys; SMS only as a fallback; 10 single-use recovery codes. MFA on by default for workspace owners and required for accountant access. | M |
| AUTH-05 | Forgot password: single-use emailed link valid 30 minutes; the same message is shown whether or not the email exists; MFA still required after reset; all other sessions signed out; a confirmation email sent. | M |
| AUTH-06 | Lost MFA device: sign in with a recovery code; otherwise an identity check with a 72-hour waiting period and alerts to the account email. | M |
| AUTH-07 | Sessions: rotating refresh tokens, idle timeout (web default 30 minutes, adjustable), device list with remote sign-out, biometric unlock on mobile. | M |
| AUTH-08 | Brute-force protection: rate limits, progressive delays after 5 failed attempts, CAPTCHA after repeated failures, new-device sign-in alerts. | M |
| AUTH-09 | Re-authentication for sensitive actions: export all data, delete account, change email or MFA, invite an accountant, view full account numbers. | M |
| AUTH-10 | Household and accountant invites by email with a role; invites expire after 7 days. | M |
| AUTH-11 | Changing the account email requires confirmation from both old and new addresses. | M |
| AUTH-12 | Security activity log visible to the user (sign-ins, MFA changes, exports, support access). | S |
| AUTH-13 | SSO (SAML/OIDC) for accounting firms. | C |

### 13.2 Backup, restore and storage

| ID | Requirement | Priority |
| --- | --- | --- |
| BAK-01 | Automatic database backups: continuous point-in-time recovery for 35 days, daily snapshots kept 35 days, monthly snapshots kept 12 months. | M |
| BAK-02 | Backups encrypted (AES-256, keys in a KMS) and copied to a second region and a separate cloud account with object lock, so they cannot be altered or deleted by ransomware or mistakes. | M |
| BAK-03 | Files (receipts, payslips, statements) in versioned object storage with cross-region replication; deleted files recoverable for 30 days. | M |
| BAK-04 | **Manual backup:** "Back up now" in settings creates a downloadable archive (JSON + CSV + attachments) of the whole workspace or one entity, optionally password-encrypted. Available on web and mobile. | M |
| BAK-05 | **Scheduled personal backup:** weekly or monthly export to the user's own Google Drive, OneDrive, Dropbox or iCloud, or as an emailed download link. | S |
| BAK-06 | Restore: from a manual backup into a new or existing workspace, with a preview before confirming. Deleted records go to a trash bin and can be restored for 30 days. | M |
| BAK-07 | Service targets: recovery point objective ≤ 5 minutes, recovery time objective ≤ 4 hours; full restore tested quarterly. | M |
| BAK-08 | Storage quotas per plan (e.g., 5 GB basic, 50 GB paid) with a usage meter; receipt photos compressed to about 1 MB with the original optionally kept. | S |
| BAK-09 | Retention: records kept until the user deletes them; receipts default 7 years; a deleted account is purged within 30 days, and its data ages out of backups within 35 days. | M |
| BAK-10 | On-device data encrypted with keys in the iOS Keychain / Android Keystore and wiped on sign-out. | M |

### 13.3 Currency, foreign spending and conversion

| ID | Requirement | Priority |
| --- | --- | --- |
| CUR-01 | Home (base) currency per workspace, with an override per entity (e.g., a business run in CAD). | M |
| CUR-02 | Every account has a currency (ISO 4217) with the correct number of decimals (JPY 0, USD 2, KWD 3). | M |
| CUR-03 | Spending abroad on a home-currency card stores four values: original amount and currency, amount charged in home currency, the implied exchange rate, and any foreign transaction fee (posted to Bank fees). | M |
| CUR-04 | When a receipt shows a foreign amount and the statement shows the home amount, they are matched by converting at that day's rate within a ±3% tolerance. The actual rate is then saved. | M |
| CUR-05 | Daily and historical exchange rates from a rates provider; the user can override the rate on any transaction. | M |
| CUR-06 | Reports convert to home currency at the actual charged rate when known, otherwise at the transaction-date rate. Foreign-currency account balances are revalued at the latest rate for net worth, with unrealized FX gain/loss shown. | M |
| CUR-07 | Double-entry with FX: each posting keeps the original and home amounts; entries balance in home currency; rounding differences post to an FX rounding account. | M |
| CUR-08 | Transfers between accounts in different currencies record both amounts and the rate; the gap from the market rate is shown as FX cost. | S |
| CUR-09 | Travel mode: set trip dates and currency; transactions in that window are tagged with the trip, and AI expects that currency on receipts. | S |
| CUR-10 | Money formatting follows the user's locale (symbol position, 1,234.56 vs 1.234,56, negatives as −$5.00 or ($5.00) in accounting views), with a manual override. | M |

### 13.4 Time zone, dates and locale

| ID | Requirement | Priority |
| --- | --- | --- |
| TZ-01 | Each user has a time zone (auto-detected, editable). The workspace time zone sets period boundaries such as month end. | M |
| TZ-02 | Transaction dates are stored as plain calendar dates, as shown on the statement, so they never shift a day when viewed from another time zone. System timestamps are stored in UTC and shown in local time. | M |
| TZ-03 | Transactions made abroad keep the statement date; the receipt's local time is kept when present. | M |
| TZ-04 | Reminders, digests and recurring items run in the user's time zone and handle daylight saving changes. | M |
| TZ-05 | Configurable date format, first day of week, and fiscal year start per entity. | M |
| TZ-06 | All interface text externalized for translation; English at launch. | M |

### 13.5 Administration, support and maintenance

| ID | Requirement | Priority |
| --- | --- | --- |
| OPS-01 | Staff admin console: account lookup, plan and billing, feature flags, import-failure analytics. Staff cannot see financial data unless the user grants access. | M |
| OPS-02 | Support access is granted by the user from settings, limited in time (default 72 hours), read-only by default, and logged. | M |
| OPS-03 | Zero-downtime deployments; any planned maintenance announced in-app 48 hours ahead; public status page. | M |
| OPS-04 | Backward-compatible database migrations; minimum mobile app version enforced with an update prompt. | M |
| OPS-05 | Reference data (tax categories, IRS mileage rates, bank import profiles, merchant name lists, currency list) updated without an app release. | M |
| OPS-06 | Security patching: automated dependency scanning; critical vulnerabilities fixed within 72 hours, others monthly. | M |
| OPS-07 | Monitoring and alerts on uptime, error rates, queue lag and AI provider failures, with automatic failover to a second provider or to the review queue. | M |
| OPS-08 | Subscriptions and billing: trials, upgrades, invoices, failed-payment grace period; data stays exportable after a subscription lapses. | S |
| OPS-09 | In-app help center, guided tours, contact support, and bug reports with an optional screenshot and logs. | M |
| OPS-10 | Email deliverability: SPF, DKIM and DMARC on sending domains; transactional and marketing email separated; unsubscribe for non-essential email. | M |
| OPS-11 | Legal: terms of service, privacy policy, cookie consent where required, data processing agreements with every AI and OCR provider. | M |
| OPS-12 | Documented disaster recovery and incident response plans; affected users notified within 72 hours of a confirmed breach. | M |
| OPS-13 | Settings page covering profile, security, family members, entities, currencies, time zone, AI mode, notifications, backups, data export and account deletion, on web and mobile. | M |

## 14. Roadmap, out of scope and open questions

&#91;embedded content: release roadmap · 4 phases, 3 gates (not to scale)\]

R1 ships every **M** requirement. **S** items that slip move to R1.x. R2 adds live bank connections only after R1 shows that imports and AI categorization are reliable.

### 14.1 Bank connection readiness (designed in R1, built in R2)

- The data model already separates *expected* from *actual* transactions, and import batches carry a source type, so bank feeds become another source.
- Duplicate detection (IMP-05) must also handle feed vs CSV overlap during the switchover.
- Aggregator options to evaluate: Plaid, MX, Finicity (US); GoCardless/Nordigen, TrueLayer (EU/UK); SimpleFIN (low-cost US option). Users will be able to keep any account on CSV only.

### 14.2 Out of scope for R1

- Live bank or brokerage connections; investment performance analysis.
- Tax filing, payroll processing, sales tax filing.
- Tenant-facing portal, online rent collection, tenant screening.
- Bill pay or moving real money.

### 14.3 Open questions

- [ ] Target markets for R1: US only (Schedule C/E) or also Canada/UK/EU tax categories?
- [ ] Pricing: free personal tier plus paid Business/Rental add-ons, or a single subscription?
- [ ] Default AI mode at launch: built-in hosted model or bring-your-own key? Is an on-device model required for R1 mobile?
- [ ] Maximum supported scale for R1 (number of businesses, properties, units)?
- [ ] Should household partners see business and rental entities by default?
- [ ] Confirm React Native (Expo) over native Swift/Kotlin after a camera and OCR performance spike.

### Sources

- [Monarch Money reviews: praise and complaints (Gerald)](https://joingerald.com/learn/financial-wellness/monarch-money-app-reviews-2026)
- [Monarch reviews: what users think (checkthat.ai)](https://checkthat.ai/brands/monarch/reviews)
- [Best free budget app: what Reddit recommends (Wild & Free Tools)](https://wildandfreetools.com/blog/best-budget-app-free-reddit-2026)
- [r/personalfinance thread: spreadsheets vs budgeting apps (snapshot)](https://reddit.sentinel-team.org/posts/1s2r1pn/snapshots/2026-03-25T17%3A58%3A43.212524Z)
- [BiggerPockets: what accounting software self-managing landlords use](https://www.biggerpockets.com/forums/52/topics/1010724-for-self-managing-landlords-what-accounting-software-do-you-use)
- [Landlord Studio reviews (Capterra)](https://www.capterra.com/p/182473/Landlord-Studio/reviews/?page=2)
- [QuickBooks Self-Employed user complaints (All About Circuits forum)](https://forum.allaboutcircuits.com/threads/who-uses-quickbooks-self-employed-who-hates-it-what-is-better.168549/)
- [QuickBooks Solopreneur features (GetApp)](https://www.getapp.com/communication-software/a/quickbooks-self-employed/)
- [Firefly III vs Actual Budget: self-hosted budgeting and CSV import (beancount.io)](https://beancount.io/fr/blog/2026/07/26/firefly-iii-vs-actual-budget-self-hosted-open-source-budgeting-guide)
- [Actual Budget categorizer using a local LLM (GitHub)](https://github.com/annis-souames/actual-categorizer)
- [Firefly III LLM categorizer with self-learning rules (GitHub mirror)](https://1clonegithubbyxjn.1934672944.workers.dev/constLiakos/Firefly-III-LLM-Categorizer)
