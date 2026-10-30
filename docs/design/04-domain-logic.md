# 04 — Domain Logic

Everything in this document is implemented in `packages/domain` as pure functions,
except where it says *service*. That way web, mobile, API and workers compute identical
results, and property-based tests cover every invariant.

## 1. Money and currency

- `Money = { amount: bigint /* minor units */, currency: CurrencyCode }`. Operations
  (`add`, `sub`, `negate`, `compare`, `sum`) throw on currency mismatch.
- Minor-unit exponents come from ISO 4217 (`JPY`=0, `USD`=2, `KWD`=3) (CUR-02).
- Parsing user or file input: `parseDecimal("1.234,56", { decimal: ',', group: '.' })`
  produces a bigint using string arithmetic, never `Number`.
- Multiplying by rates, percentages and quantities uses scaled-integer arithmetic with
  an explicit rounding mode (`half_even` by default for FX, `half_up` for tax) and returns
  the rounded value plus the remainder, so callers can allocate it.
- **Allocation** (`allocate(total, weights)`) splits an amount across weights so the
  parts sum *exactly* to the total. Two remainder policies:
  - `largest` — each part is rounded half-up on its own, then the residual (positive
    or negative, a few minor units at most) goes to the part with the largest weight
    (RCP-04: "any rounding remainder goes to the largest split").
  - `largest_remainder` — Hamilton method, for even spreading (shared expense
    allocation, RNT-07).

## 2. Posting rules (transaction → journal entries)

The user enters a *transaction*: account, amount, date, payee and one or more *splits*.
Each split has a category, entity, member, property/unit, amount and memo. The
`PostingBuilder` turns it into balanced journal entries. Sign convention: **debit = +,
credit = −**.

| Case | Postings (entity E) |
| --- | --- |
| Expense of 50 from checking | Expense:cat **+50**; Checking **−50** |
| Expense of 50 on credit card | Expense:cat **+50**; Card (liability) **−50** |
| Income of 1,800 into checking | Checking **+1,800**; Income:cat **−1,800** |
| Refund of 20 to card | Card **+20**; Expense:cat **−20** (reverses the category, RCP-08) |
| Split (Costco 120 = 80 groceries + 40 office) | Groceries +80; Office +40; Card −120 |
| Transfer checking → savings 500 (DE-03) | Savings **+500**; Checking **−500**, `kind=transfer`, never income/expense |
| Card payment 1,200 | Card (liability) **+1,200**; Checking **−1,200** |
| Mortgage payment 2,000 (DE-04) | Mortgage principal (liability) +610; Interest (expense) +940; Escrow (asset) +450; Checking −2,000 |
| Uncategorized import of −42.10 | `uncategorized_expense` +42.10; Account −42.10, plus a review-queue flag |
| Opening balance 1,000 | Account +1,000; `opening_balance_equity` −1,000 (`kind=opening_balance`) |
| Security deposit received 1,500 (RNT-10) | Checking +1,500; `security_deposits_held` (liability) −1,500 |
| Deposit returned 1,200, 300 forfeited for damage (RNT-10) | `security_deposits_held` +1,500; Checking −1,200; Rental income: forfeited deposits (or Repairs reimbursement) −300 |
| Transfer to savings tracked by a budget category (BUD-04, BUD-08) | Same postings as a transfer; the savings account is linked to a *tracking category*, so budget activity counts the transfer (see §8) |

### 2.1 Splits across entities (DE-05, ACC-03, UP-08)

The paying account belongs to entity **P** (personal) and a split belongs to entity
**B** (business). The workspace setting `inter_entity_mode` decides the treatment:

| Mode | Entity P entry | Entity B entry |
| --- | --- | --- |
| `equity` (default) | **Contribution to B** (`inter_entity_clearing`, a transfer account excluded from spending) +amt; Card −amt | Expense:cat +amt; **Owner contribution** (equity) −amt |
| `due_to_from` | **Due from B** (asset) +amt; Card −amt | Expense:cat +amt; **Due to P** (liability) −amt |

The reverse case (a business account pays a personal expense) mirrors it: B posts an
owner draw (equity, debit) and P posts the expense against `inter_entity_clearing`. In
consolidated views, `inter_entity_clearing`, `due_to/from`, `owner_contribution` and
`owner_draw` between entities of the same workspace show as transfers, not spending
(FLOW-06).

**Account types and counterparties**: inter-entity accounts exist **per counterparty
entity** (`ledger_account.counterparty_entity_id`), so a workspace with two businesses
has separate balances that eliminate pairwise. Types: `inter_entity_clearing` is
**equity** ("Transfers to/from ⟨entity⟩", net investment in that entity from the
personal books); `owner_contribution` and `owner_draw` are **equity** in the business;
`due_from_entity` is an **asset**; `due_to_entity` is a **liability**. When neither side
is the personal entity (business A pays for business B), only `due_to_from` is allowed.

### 2.2 Multi-currency (CUR-03, CUR-07)

- Every posting keeps `amount_minor` in its account's currency and
  `functional_amount_minor` in the entity's functional currency. **Entries balance on
  functional amounts.**
- A foreign purchase on a home-currency card (receipt €40.00, statement $43.60, foreign
  transaction fee $1.31 on the same line): Expense +43.60 USD (original EUR 40.00 and
  rate 1.09 stored on the transaction); Bank fees +1.31; Card −44.91. The implied rate is
  saved as the actual rate.
- A foreign-currency account (EUR account, USD entity): the posting's `amount_minor` is
  EUR, `functional_amount_minor` = EUR × rate, rounded half-even. If the rounded
  functional amounts don't sum to zero, the difference (at most a few minor units) posts
  to `fx_rounding`.
- A transfer between currencies (CUR-08) stores both amounts. Each leg's functional
  amount uses that leg's rate (the receiving leg at the rate actually achieved). The
  difference between the two functional amounts posts to `fx_gain_loss`, so the entry
  balances. The UI shows this amount, compared with the market rate for that day, as FX
  cost.
- **Carrying value and realized FX** ([ADR-0010](adr/0010-fx-accounting-policy.md)): a
  foreign-currency account carries its functional value at the historical rates of its
  postings. When foreign money leaves the account (a spend or a transfer out), the
  functional amount is the *carrying* value (average rate), and any gap to the
  transaction's rate is **realized** FX gain or loss. So an account at €0 always has a
  functional balance of 0.
- Unrealized revaluation for net worth (CUR-06) is computed in reports, not posted:
  foreign balances × latest rate − carrying value. An optional `fx_revaluation` entry
  can be posted at period close.
- **Functional vs home currency**: entries balance in the *entity's* functional currency
  (CUR-01 allows a business in CAD). Consolidated and workspace-level reports translate
  each entity to the workspace home currency: balance-sheet items at the closing rate,
  income and expense at the transaction-date rate, with the difference shown as a
  translation adjustment line. For the common case (every entity uses the home
  currency), functional = home and CUR-07 holds literally.

### 2.3 Edits, locks, voids and reversals (DE-08..10, IMP-09, BAK-06)

An entry is **protected** when `journal_entry.locked` is true (set when a
reconciliation that includes any of its postings is completed, DE-08) or when its
`entry_date ≤ period_lock.locked_through` for its entity (DE-09).

```
edit(txn):
  for each entry of txn:
    if not protected(entry):
       replace postings in place (same entry id)                          → audit diff
    elif entry.entry_date is in an open period (protected only by reconciliation):
       keep the reconciled cash leg; re-post only the non-cash legs on the ORIGINAL date
       (reverse old category lines + add new ones in one adjustment entry)  → audit "reclassified"
    else (closed period):
       reversal(entry) + new entry, both dated the first open date         → audit "reversed"
```

- **Void** = mark `transaction.status = void` and remove its postings if no entry is
  protected. Otherwise post reversals as above. **Delete to trash** = void + `deleted_at`
  (restore re-posts from the stored snapshot). Import **undo** voids the batch's
  transactions with the same rules. Protected rows can't be undone silently: the undo
  result lists them as `kept` with the reason, and the summary reports a *partial undo*.
- Status-only changes (`cleared`, `reconciliation_id`, memo-free metadata such as tags)
  are allowed on protected postings. Amount, account, date and dimension changes are not.
- The database blocks **INSERT** of entries or postings dated inside a locked period,
  and any change to amounts or accounts on protected rows. The only bypass is the audited
  unlock path, which sets `app.allow_locked_edit` for one transaction and requires an
  audit note.

## 3. Import pipeline (IMP-01..11, UP-01)

```
upload ──▶ store file (S3, sha256) ──▶ detect type ──▶ parse ──▶ map columns ──▶ normalize ──▶
dedupe/match ──▶ categorize (pipeline §5) ──▶ PREVIEW ──(user commits)──▶ post ──▶ summary
```

1. **Detect**: by magic bytes and extension:
   - CSV/TSV: encoding sniffed (UTF-8, UTF-16, Windows-1252); parsed in the Node worker.
   - XLSX: `exceljs` in the Node worker.
   - Legacy XLS: `xlrd` in the Python doc worker.
   - PDF: digital text layer → pdfplumber in the doc worker; scanned → OCR → table extraction (Phase 3).
   - Images: receipts, §7. A file with the same sha256
   as an earlier import triggers a warning.
2. **Parse to a grid**: header-row detection scores the first 30 rows for "header-ness"
   (mostly text, the next rows typed); preamble and footer rows are skipped.
3. **Map columns** (IMP-03/04):
   1. Compute the **fingerprint** = hash(file type, normalized header tokens, column
      count). An exact match with a user or system `import_profile` reuses its mapping
      (goal: under 5% manual mapping after the first time).
   2. Otherwise, run **heuristics**. Each column gets a type score: date (tries the
      candidate formats `YYYY-MM-DD`, `MM/DD/YYYY`, `DD/MM/YYYY`, `DD.MM.YYYY`,
      `D MMM YYYY`; disambiguates by any day > 12 and by monotonic order), amount
      (numeric with a decimal separator; detects `,` vs `.` by the last separator
      position), debit/credit pairs (mutually exclusive non-empty), balance (running
      sum check: `bal[i] = bal[i-1] ± amt[i]`), description (longest text, high
      cardinality).
   3. If confidence is low, call the AI task `map_columns` with headers and 5 masked
      sample rows. Its JSON output is validated, and the user confirms in the mapping UI.
   4. **Sign convention**: inferred from account type and a balance-column check
      (credit-card exports often show purchases as positive). It is stored in the
      profile.
4. **Normalize**: `CalendarDate`, `Money`, trimmed description, `payee_raw`;
   `normalized_desc` = upper-case with digits, store numbers, dates and card fragments
   removed (e.g. `SQ *BLUE BOTTLE 0423 SF` → `BLUE BOTTLE`). Payee resolution (IMP-10):
   exact alias → workspace payee by `normalized_key` → reference merchant list
   (`ref.merchant`, trigram ≥ 0.6) → AI `normalize_payee` (batched, cached) → new payee.
   The raw text is always kept.
5. **Dedupe and match** (IMP-07). Silently dropping a real transaction is the worst
   failure, so the rules are conservative:
   - **Duplicates are only searched where an overlap is possible**: among earlier
     *imported* transactions on the same account whose import batch covered that date
     (batch `[min_date, max_date]` range). A row outside every earlier batch's range is
     never a duplicate.
   - **Exact duplicate** (auto-skip): same account, same date, same amount, same
     normalized description, and the same *ordinal* (the n-th identical row of that day
     in each file). This makes two real identical coffees on one day two rows in both
     files, and re-importing the same file adds 0 rows.
   - **Probable duplicate** (flagged, *not* skipped): same amount, |Δdays| ≤ 3,
     description similarity ≥ 0.6, inside an earlier batch's range. Shown in the preview
     for one-click "skip" or "keep".
   - **Match to manual/camera/scheduled entries**: same account (or account unknown for
     camera captures), same amount (± tip tolerance for receipts), |Δdays| ≤ 3, and
     description/payee similarity ≥ 0.5 *or* an exact payee link. Candidates are
     assigned **one-to-one** (Hungarian assignment on score), so one manual entry can't
     absorb two imported rows. A match *confirms* the existing transaction instead of
     creating a new one (statement date and raw description recorded, marked cleared).
     The before-image is stored in `transaction_source` so undo can restore it.
   - Rows inside the same file are **never** deduped against each other.
   - `dedupe_key = hash(account, date, amount, normalized_desc, ordinal)` is stored to
     make re-imports cheap.
6. **Balance check** (UP-01, IMP-05, IMP-08): when the file (or PDF statement) has an
   opening and closing balance, verify `opening + Σ amounts = closing`. A mismatch is
   shown before commit with the gap and the likely missing date range.
7. **Commit**: in one database transaction, post every accepted row (through §2), link
   matches, set `import_batch.status = committed` and `undo_until = now + 30 days`. Post
   one change-feed event batch.
8. **Undo** (IMP-09): void every transaction the batch created (rules in §2.3), and
   restore the before-image of every transaction it *matched* from
   `transaction_source`. Rows edited since the import are listed for confirmation
   first. Protected rows are kept and reported, so a partial undo is always explicit.

**Two imported legs of one transfer** (TXN-04): when the checking file shows "AMEX
PAYMENT −1,200" and the card file later shows "PAYMENT THANK YOU +1,200", step 3 of the
pipeline pairs them (keyword + amount ⇒ 0.95). The second leg does not create a
transaction. It attaches to the first through a second `transaction_source` row, and
the transaction is re-posted as one transfer entry. `transaction_source(transaction_id,
import_row_id, ledger_account_id, before_image)` holds one row per contributing import
row, so undoing either batch detaches only its leg (the transaction goes back to an
uncategorized single-leg entry).

**Loss-proof guarantees**: every parsed row ends in exactly one terminal state (`added`,
`matched`, `duplicate-skipped`, `user-skipped`, `failed` with reason). The summary
invariant `read = added + matched + skipped + failed` is checked in code and in tests.

## 4. Payee normalization rules

Strip known processor prefixes (`SQ *`, `TST*`, `PAYPAL *`, `POS `, `ACH `, `DEBIT CARD
PURCHASE`), trailing location and state codes, phone numbers, store numbers (`#1234`,
`0423`), dates (`10/24`) and reference numbers. Collapse whitespace, then title-case for
display. Processor and MCC reference lists live in `packages/reference-data` and can be
updated without a release (OPS-05).

## 5. Categorization pipeline (§3.4, AI-01..06)

Runs on every import row and manual entry. Each step only handles rows that are still
open. Every decision records `{ step, confidence, explanation }` (AI-06).

| Step | Logic | Confidence | Explanation example |
| --- | --- | --- | --- |
| 1 Receipt lines | if a receipt is attached: §7 | per line | "From receipt: 3 lines → Groceries, Electronics, Clothing" |
| 2 User rules | ordered by priority; first match wins per action field | 1.00 | "Matched rule 'Shell → Fuel'" |
| 3 Transfer / match | opposite-sign, equal-amount pair across the workspace's accounts within ±3 days; expected items (§9) | 0.95 when a payment/transfer keyword or the counterparty's last-4 appears **and** the amounts match; amount-only pairs are capped at **0.60** (always reviewed) | "Looks like the payment to Amex ••1005" |
| 4 Personal history | `payee_history` for the payee with the same amount band (bands: log-scale buckets); choose the majority category if its share ≥ 0.8 and count ≥ 2 | `share × min(1, count/5)` capped at 0.97 | "Similar to 6 past transactions" |
| 5 AI model | `categorize` task (06) with the user's category list; returns category, entity, property, member and tags | model confidence, calibrated per provider | "AI: 'Blue Bottle' is a coffee shop → Dining out" |
| 6 Review queue | anything < threshold (default 0.80, per workspace) | — | "Needs review" |

- With AI mode `off`, step 5 is skipped (graceful degradation).
- **Entity, member and property** are predicted by the same steps (AI-02, FAM-05). The
  account's `default_member_id` and default entity seed the prior (FAM-04, ACC-03).
- **Learning** (AI-05): every user correction writes `payee_history` and a
  `correction` record. After 2 identical corrections (same payee → same new category),
  the app offers a rule, and the offer includes "apply to N existing transactions". An
  accepted rule gets `origin=ai_suggested`.
- **Business/personal flags** (BIZ-03): a separate classifier signal (rules + AI) marks
  business-looking expenses on personal accounts (and the reverse) for one-tap
  reclassify.

## 6. Rules engine

```jsonc
// rule.conditions — all must match (AND); "any" groups give OR
{ "all": [
    { "field": "payee", "op": "contains", "value": "shell", "ci": true },
    { "field": "amount", "op": "between", "value": ["-200.00", "-5.00"] },
    { "field": "account", "op": "in", "value": ["<uuid>"] }
] }
// ops: equals | contains | starts_with | regex (RE2-safe, 100 chars max) | between | gt | lt | in
// fields: payee, description, raw_description, amount, account, entity, date_dow, item_text (receipt_line scope)

// rule.actions
{ "category_id": "<uuid>", "entity_id": "<uuid>", "member_id": null,
  "property_id": null, "tags": ["fuel"], "rename_payee": "Shell", "mark_reviewed": true }
```

- Regex runs through `re2` (linear time) to rule out ReDoS.
- **Apply to existing** (UP-02) runs as a job. It shows a preview count, skips
  locked/reconciled entries, and records an audit entry per change.

## 7. Receipts (§3.5, RCP-01..12)

1. **Capture** (mobile): edge detection and blur/glare scoring on device
   (VisionCamera + ML Kit / Apple Vision); multi-shot frames are stitched server-side
   in order. Offline captures queue in the outbox (TXN-09).
2. **Extract**: the `extract_receipt` AI task (vision model) returns schema-validated
   JSON: merchant, date, local time, currency, lines (raw text, expanded name, qty, unit
   price, line total, discount, taxable flag), subtotal, tax, fees, tip, total,
   card last-4. In local mode: Tesseract/PaddleOCR text plus a local LLM for structure.
3. **Validate** (RCP-05): `Σ line_total − Σ discounts + tax + fees + tip = total`
   within ±2 minor units (±$0.02). Otherwise `status=needs_review`, and the gap is shown.
4. **Categorize lines**: item-level rules (scope `receipt_line`), then item history,
   then AI over the user's categories. Lines with the same (category, entity, member)
   are grouped into one split (RCP-03, RCP-07).
5. **Allocate tax, discounts, fees and tip** (RCP-04): tax is allocated across groups
   in proportion to each group's **taxable** subtotal; order-level discounts and fees
   in proportion to each group's subtotal. Each allocation uses `allocate(…, 'largest')`
   so the splits sum *exactly* to the receipt total.
   *Worked example* (requirements §3.5): taxable subtotal = 12.88 + 8.98 = 21.86; tax
   1.75 → Electronics 1.03, Clothing 0.72 → splits Groceries 5.10, Electronics 13.91,
   Clothing 9.70 = 28.71. ✔ (This example is a unit test.)
6. **Match** (IMP-11): candidates are transactions with `|date − receipt_date| ≤ 5
   days`, amount within the tip tolerance (`total ≤ amount ≤ total × 1.30` for
   restaurants, otherwise exact ±0.02), and similar merchant. If the currencies differ,
   convert at that day's rate with ±3% tolerance (CUR-04) and store the actual rate.
   Best score ≥ 0.8 links automatically; lower scores show candidates. With no match,
   the receipt waits in the **receipt inbox** and is re-tried on every import.
7. **Apply**: the transaction's splits are replaced by the receipt groups (receipt
   lines take priority over merchant categorization, pipeline step 1). The splits must
   sum to the *transaction* amount, not the receipt total. A tip added after the
   receipt was printed goes to the split of the tipped category (dining) or is allocated
   proportionally. For an FX receipt, the receipt amounts are converted at the actual
   implied rate (`charged ÷ receipt total`) and allocated with `allocate(…, 'largest')`.
   A remaining gap larger than the tolerance sends the receipt to review.
8. **Flags**: RCP-11 "receipt recommended" for multi-department merchants above $50
   without a receipt; BIZ-12/UP-09 "missing receipt" for deductible expenses above
   $75.

## 8. Budget engine (§4)

For a budget period *p* and category *c*:

```
activity(c,p)   = Σ functional postings to c in p (expense positive; refunds reduce it)
                  + for a tracking category: Σ inflows to its linked asset/liability accounts
                    (savings contributions, loan/mortgage principal), so the Savings and
                    Debt groups show real activity
available(c,p)  = carried_in(c,p) + assigned(c,p) − activity(c,p) ± moves(c,p)
carried_in(c,p) = rollover_mode(c) = carry_surplus → max(available(c,p−1), 0)
                                   = carry_deficit → min(available(c,p−1), 0)
                                   = carry_both    → available(c,p−1)
                                   = reset         → 0
left_to_assign(p) = budgeted_income(p) + carried_unassigned(p−1) − Σ_c assigned(c,p)
                    (< 0 ⇒ "over-assigned", which triggers REC-01)
budgeted_income(p) = expected **take-home** income: net pay per payslip pattern (PAY-07),
                    rent roll, business forecast. Once income arrives, the actual net
                    deposit replaces the expectation for that item.
```

- **Light mode** (UP-11, BUD-01): two lines: "pay yourself first" savings target and
  "everything else", plus the 50/30/20 view by category-group kind.
- **Draft budget** (BUD-02): per category, the median of the last 1–3 months' activity;
  fixed vs variable comes from the coefficient of variation (< 0.1 means fixed); detected
  recurring bills are added for months without history. AI only writes the explanation.
- **Sinking fund** (BUD-07): `monthly = ceil_to_minor((target − saved) /
  months_remaining(due_date))`, recomputed each period.
- **Goals** (BUD-08): projected completion by linear projection of the average
  contribution over the last 3 months. Debt payoff simulates snowball (smallest balance
  first) or avalanche (highest rate first) month by month with an amortization formula.
- **Spending pace** (FLOW-04): `expected_by_today = assigned × elapsed_days /
  period_days` (or weighted by historical day-of-month spend for categories with a
  pattern); the category is "on pace to overspend" when `activity / expected_by_today
  ≥ 1.10` and the projected end ≥ 1.10 × assigned (REC-02).
- **Gross vs net**: household budgets work on take-home (net) pay. Payslip taxes and
  deductions are real postings (PAY-05) but sit in system categories that are excluded
  from budget activity by default. Gross-to-net detail shows in member and payslip
  reports.
- **Member budgets** (FAM-06): a member budget is a filter (`member_id = m`) over the
  same activity; spending counts against both the member budget and the household
  category.

## 9. Expected vs actual matching

The generic matcher compares each `expected_item` with transactions in its
`ledger_account_id` (or any cash account) within a date window, using amount, payee
similarity and reference numbers.

| Expected kind | Window | Amount rule | On match |
| --- | --- | --- | --- |
| `security_deposit` (RNT-10) | due −10 / +30 days | exact | posts to `security_deposits_held` (liability), never to income; matched **before** rent charges, so a deposit equal to one month's rent isn't taken as rent |
| `rent_charge` (RNT-04) | due −5 / +30 days | exact or partial; several payments allowed | `paid_minor += amount`; status `partial`/`paid`; arrears = open charges past grace (RNT-05) |
| `invoice` (BIZ-05) | issue date … +90 days | exact or partial | invoice `paid`/`partial` |
| `bill` (BIZ-06) | due −10 / +10 | exact | `paid` |
| `payslip_net` (PAY-04) | pay date ±3 | exact net | the deposit **becomes** the payslip's checking posting (no double count): the imported deposit is merged into the payslip entry |
| `scheduled` (TXN-05) | ±3 days | template amount (variable band) | confirms the scheduled transaction |
| `loan_payment` (RNT-08) | ±5 | exact | splits into principal, interest and escrow from the amortization schedule |

Auto-match when the score ≥ 0.85 and there is exactly one candidate; otherwise suggest.

## 10. Recurring detection (AI-08, UP-14)

Group posted transactions by payee (and account). For each group with ≥ 3 occurrences:
compute the intervals between dates and classify the cadence (weekly 7±1, biweekly 14±2,
semimonthly, monthly 28–31, quarterly, yearly) using median interval and MAD. Then check
amount stability (fixed if max/min ≤ 1.02, otherwise variable with a band). Propose a
`recurring_item` with `next_date`. Price-change alert (REC-06/AI-09): the last amount is
more than 5% above the previous stable amount. New subscription: a recurring candidate
first seen within 45 days.

## 11. Forecast (FLOW-03)

A day-by-day simulation for 90 days per cash account:

```
balance[d+1] = balance[d] + Σ scheduled/recurring items on d (expected amount; variable → avg)
                          + expected income on d (payslip pattern, rent roll, invoices due)
                          − discretionary burn(d)
discretionary burn = remaining budget for variable categories ÷ remaining days in period
                      (falls back to the 3-month daily average)
```

- Card balances are projected separately, and card payments move cash on their due
  dates.
- A low-balance warning fires when `balance[d] < threshold` (default 0, configurable per
  account), and names the first date and the items driving it.
- The forecast is deterministic and recomputed on change (debounced) and nightly.

## 12. Recommendations (REC-01..09)

The engine is code. AI only writes the wording. Each recommendation stores its inputs,
the computed numbers and the proposed actions, and nothing applies without the user's
confirmation.

| Rec | Computation |
| --- | --- |
| REC-01 | deficit = −left_to_assign. Candidate categories = flexible kinds (`daily`, `fun`), ranked by user priority, then by past overspend ratio. Cut each candidate down to its floor (3-month min) until the deficit is covered. |
| REC-02 | for a category on pace to overspend: list categories with `available > 0` and low pace as move sources; daily reduction = projected overspend ÷ remaining days |
| REC-03 | surplus = actual income − expected; allocate by the priority order (emergency fund to target, then high-interest debt by rate, then goals by due date, then fun) |
| REC-04 | bills at risk = forecast items after the date when the balance falls below 0; "bare-bones" budget = fixed + minimum debt payments + essentials |
| REC-05 | three consecutive periods with `activity/assigned` outside [0.8, 1.2] → suggest the median activity |
| REC-07 | at month end: totals, top 3 leaks (categories with the largest positive variance and subscription increases), next month's draft (§8). AI writes the 5-line summary from these numbers only (AIA-05). |
| REC-08 | budget from last month's income; buffer target = 1 × average monthly expenses |
| REC-09 | on business or rental income: set-aside = income × rate (user %, or effective-rate estimate) → proposed transfer to the tax-savings category |

Frequency cap: at most 1 push per day for recommendations (configurable), and never
during quiet hours (NOT-03).

## 13. Business and rental calculations

- **P&L** (BIZ-10): income and expense postings per entity per period, grouped by
  category or tax line; net profit.
- **Schedule C/E summary**: postings grouped by `tax_line_code` (posting override,
  else account mapping). Schedule E groups by property.
- **Quarterly estimated tax** (BIZ-09): `set_aside = max(0, ytd_net_profit) ×
  effective_rate − set_aside_to_date`; IRS due dates come from reference data.
- **Mileage** (BIZ-07): `deduction = round_half_up(miles × rate_for(trip_date))`.
- **Rental metrics** (RNT-11): NOI = operating income − operating expenses (excluding
  debt service, depreciation and capex); cash flow = NOI − debt service − capex;
  cash-on-cash = annual cash flow ÷ cash invested; cap rate = NOI ÷ current value;
  occupancy = occupied unit-days ÷ total unit-days.
- **Depreciation** (RNT-09): straight-line 27.5 years residential, with the mid-month
  convention in the first year. A helper with a disclaimer (AIA-12, NFR-14).
- **Shared expense allocation** (RNT-07): `allocate(amount, weights,
  'largest_remainder')` with weights by percent, unit count or square footage.

## 14. Payslips (PAY-05)

```
Salary income (gross)                     −5,000.00   (credit)
Checking (net)                            +3,412.50
Federal income tax (expense:taxes)          +620.00
State income tax                            +210.00
Social Security and Medicare (social_security, medicare) +382.50
401(k) (asset: retirement)                  +300.00
Health insurance (expense)                   +75.00
                                    Σ = 0
```

Employer contributions (match, HSA) post as memo-only or as `income:employer_benefit` /
`asset:retirement` pairs when the user opts in. The net-pay posting is matched to the
imported deposit (§9), so the deposit is not counted twice.
