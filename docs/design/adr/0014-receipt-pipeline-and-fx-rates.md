# ADR-0014: Receipt pipeline and FX rates service

- Status: proposed
- Date: 2026-11-02
- Phase: 5

## Context

Phase 5 adds receipts (TXN-08/09, IMP-11, RCP-01..12) and multi-currency spending (ACC-04, CUR-03..09,
TZ-03). 04 §7 describes the receipt pipeline in eight steps, and ADR-0010 fixes the FX accounting policy.
Several things were still open:

- where the receipt arithmetic lives, and how it stays exact;
- how a receipt is stored relative to its transaction, and who can see it;
- where FX rates come from, how they are stored, and what happens when a source is down;
- how the four values of a foreign purchase (CUR-03) and a rate override (CUR-05) are recorded.

## Decision

1. **Receipts are their own records, linked to at most one transaction.**
   - `app.receipt` and `app.receipt_line` (migration 0012) hold the extracted data in the *receipt*
     currency. A receipt lives in the inbox until it is matched; matching sets `transaction_id`.
   - `receipt.entity_id` is the receipt's primary entity. RLS and the change feed use it, as
     `transaction.primary_entity_id` does. A line may go to another entity (RCP-07), and reading or
     writing that line also needs access to its entity.
   - Postings created from a receipt keep `posting.receipt_line_id`, which makes item-level reports
     (RCP-09) a join rather than a copy.
   - `attachment_ids` is ordered, so multi-shot pages and PDF invoices keep their page order.
2. **The arithmetic is pure and lives in `@montra/domain` (`receipts/`).**
   - Validation (RCP-05), grouping by (category, entity, member) (RCP-03/07), tax/discount/fee/tip
     allocation (RCP-04), returns (RCP-08), conversion at the implied rate, and fitting the groups to the
     *transaction* amount are bigint functions with no I/O.
   - Every allocation uses `allocate(…, 'largest')`, so splits sum exactly. The Walmart example
     (requirements §3.5) is a unit test, and property tests (fast-check) check that splits always sum to
     the target.
   - The matching score (IMP-11) is also pure: `matchReceipts` in `@montra/importers`, next to the
     import matcher, because it reuses the payee normalizer and trigram similarity. The API supplies the
     candidates and a rate lookup.
     - Hard limits: ±5 days; same direction (purchase ↔ money out, refund ↔ money in); amount within
       ±2 minor units, or up to +30% for tip merchants (MCC 5812–5814); across currencies, the day's
       rate ±3% (plus the tip range); card last-4 must agree when both sides know it.
     - Score = 0.45 × amount + 0.20 × date + 0.35 × merchant. The merchant term is 1 for the same
       reference merchant, at least 0.9 when one key is a whole-word prefix of the other ("SHELL" /
       "SHELL OIL"), else trigram similarity. An unreadable merchant can't reach 0.8 on amount and date
       alone.
     - Assignment is one-to-one, best score first. A receipt links automatically at ≥ 0.8 only when no
       other candidate is within 0.05 of it, so two identical coffees are left for the user.
     - Across currencies the stored rate is the implied one, except when the gap is a tip; then it is
       the day's rate.
3. **Extraction goes through the gateway's `extract_receipt` task.**
   - Builtin and BYOK modes send the image to the vision model group. Local mode runs Tesseract in the
     doc-worker and gives the OCR text to the local model for structure. Off mode keeps the OCR text and
     leaves the receipt in review with no lines.
   - **Implemented:**
     - `CompletionRequest.images` carries the pages. The Anthropic adapter sends them as image or
       document blocks before the text; OpenAI-compatible servers get image data URLs (no PDFs).
     - The audit hash covers the image bytes.
     - The doc-worker's `receipt.ocr` job supplies local mode's text.
   - **Prices that include tax.** The extraction has `taxIncluded`, because VAT, TVA, MwSt and Japanese
     consumption-tax receipts print prices that already include the tax. Validation and allocation then
     report the tax but don't add it on top (`ReceiptTotals.taxIncluded` in `@montra/domain`).
   - **Fake provider.** A fake receipt image is a real 1×1 PNG whose `tEXt` chunk carries the receipt
     text (`encodeFakeReceiptImage`), so uploads pass content sniffing. `parseReceiptText` reads it
     deterministically, including a small abbreviation table for RCP-02.
   - **Corpus.** The text receipts in `packages/ai-gateway/test/receipts` hold the expected
     extraction, and each must add up under the domain rules.
4. **FX rates are reference data, stored as published.**
   - `ref.fx_rate (rate_date, base, quote, rate, source)`. ECB publishes EUR-based rates for about 30
     currencies, with no key. Open Exchange Rates is used as a second source only when `OXR_APP_ID` is set.
   - A daily `fx.daily` job (queue `schedule`) loads ECB's last 90 days, so missed days fill themselves
     in, plus OXR's latest. `fx.backfill` (or `pnpm --filter @montra/api fx:load -- --full`) loads ECB's
     history since 1999. Writes go through the definer function `app.upsert_fx_rates`, which skips
     unchanged rows.
   - **Scheduling without a scheduler.** The job runs as a *system job* (no workspace) created through
     `app.schedule_system_job` (migration 0013). A partial unique index allows at most one queued run per
     type. Each run queues the next one (16:00 UTC, after ECB publishes) *before* fetching, so a failing
     source can't break the cycle. The worker queues an immediate run at start-up, which also recovers a
     cycle whose job ran out of retries.
   - ECB failing fails the run, and the queue retries it. OXR failing is logged and reported in the job
     result, and the ECB rates are still stored.
   - The rates service derives cross rates through EUR (or USD for OXR) with scaled-integer arithmetic
     (`divideDecimal`, 10 places, half-even). ECB is preferred; OXR fills currencies ECB doesn't publish.
     For a date with no rate (weekends, holidays) it uses the latest earlier rate within 7 days, and
     returns the date used.
   - When no rate is available, conversions return a typed "no rate" result. The UI asks for a manual
     rate rather than guessing.
5. **Foreign purchases record four values on the transaction (CUR-03).**
   - `original_amount_minor` and `original_currency` (the receipt or statement foreign amount), the
     home amount on the postings, and `fx_rate` = the implied rate (home ÷ foreign), with
     `fx_rate_source = 'implied'`.
   - A foreign transaction fee is its own split to the entity's `bank_fees` system account.
   - An override sets `fx_rate_source = 'user'` (CUR-05). A rate from `ref.fx_rate` is `'reference'`.
   - **Implemented:**
     - `foreign: { original, rate?, fee? }` on create and update. The fee must be a positive part of
       money spent. The category or splits cover the charge minus the fee.
     - A foreign-currency account takes `fxRate` (the user's rate) or the day's reference rate.
       Without either, the API answers 422 `fx.no_rate`, and the UI asks for a rate.
     - Its `TransactionDto.foreign` shows the amount in the account currency and the rate to the
       functional currency.
     - Transfers between currencies need `amountIn`. A leg in the functional currency fixes the other
       leg's rate (implied); two foreign legs use reference rates. `fxRateFrom` / `fxRateTo`
       override them.
6. **Retention (RCP-10).** Receipts and their files get `retain_until` = upload date + 7 years. A purge
   job deletes them only after that date, and never while the linked transaction is in a locked period.
   OCR text is indexed with a stored `tsvector` (`simple` configuration) plus a trigram index on the
   merchant.

7. **API decisions made while building it** (`apps/api/src/receipts`):
   - **Line categorization:**
     - Item rules (`scope: 'receipt_line'`, matched on `item_text`) come first, then item history
       (`receipt_line.item_key`, from lines the user or a rule categorized), then AI.
     - AI gets the *item name only*: no store, because a receipt is categorized by what was bought.
     - A line below the threshold keeps the suggestion and stays uncategorized.
   - **Learning (RCP-06).** A category the user picks for a line in review creates or updates an item
     rule on the printed text (`origin: 'correction'`). It is visible and deletable on the rules page
     (AIA-06).
   - **Matching and applying:**
     - A clear match ≥ 0.8 is applied automatically, but only when the receipt adds up (status `inbox`).
       Receipts in `needs_review` keep their candidates.
     - Applying replaces the splits through the normal transaction update (DE-10 rules), with
       `categorization.step = 'receipt'`.
     - Across currencies it records the CUR-03 foreign amount and the implied rate.
     - It copies the receipt's local time (TZ-03) and trip.
     - A gap the tolerances don't cover is a 422 `receipt.gap`.
   - **Re-matching.** Inbox receipts are re-matched by a `receipt.match` job after every import commit
     that adds rows.
   - **Images and the documents setting.** Receipt images go to the model in builtin and BYOK modes
     whatever `allowDocumentsToLlm` says. That setting covers statement scans and payslips
     (PAY-09/UP-06); reading receipts is the feature itself. To revisit if the product owner wants
     receipts behind the same opt-in.
   - **Retention.** Deleting a receipt is a soft delete; files are kept until `retain_until` (7 years).
     There is no purge job yet.
   - **Item-level reports (RCP-09).** `posting.receipt_line_id` stays unset, because a split groups
     several lines. Item-level reports (RCP-09, not in Phase 5) will join through the receipt lines.

## Consequences

- Receipt review is a separate screen and API (`/receipts`). The transaction editor shows the linked
  receipt but doesn't edit its lines.
- Applying a receipt replaces the transaction's splits through the DE-10 rules in `poster.ts`. A locked
  transaction gets a reclassification adjustment, not an in-place rewrite.
- Mobile capture needs an upload op in the offline queue (TXN-09). That is a protocol addition to
  ADR-0013 and is decided with the camera library choice.
- ECB-only deployments cover about 30 currencies; others need OXR or a manual rate.

## Alternatives considered

- **Receipt lines as transaction splits only (no receipt table).** Rejected: inbox receipts have no
  transaction yet, and the receipt's own totals, image and OCR text must survive split edits.
- **Normalizing all rates to one base at load time.** Rejected: storing as published keeps the loader
  simple and auditable, and cross rates are cheap to derive.
- **A paid rates API as the only source.** Rejected: ECB is free and enough for the common currencies.
