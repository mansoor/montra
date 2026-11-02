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
   - The matching score (IMP-11) is also pure; the API supplies the candidates.
3. **Extraction goes through the gateway's `extract_receipt` task.**
   - Builtin and BYOK modes send the image to the vision model group. Local mode runs Tesseract in the
     doc-worker and gives the OCR text to the local model for structure. Off mode keeps the OCR text and
     leaves the receipt in review with no lines.
   - The FakeAdapter returns fixture JSON keyed by image hash, so tests and e2e are deterministic.
4. **FX rates are reference data, stored as published.**
   - `ref.fx_rate (rate_date, base, quote, rate, source)`. ECB publishes EUR-based rates for about 30
     currencies, with no key. Open Exchange Rates is used as a second source only when `OXR_APP_ID` is set.
   - A daily `fx.daily` job (queue `schedule`) loads the latest rates; a one-off backfill loads the ECB
     historical file. Writes go through the definer function `app.upsert_fx_rates`.
   - The rates service derives cross rates through EUR (or USD for OXR) with scaled-integer arithmetic.
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
6. **Retention (RCP-10).** Receipts and their files get `retain_until` = upload date + 7 years. A purge
   job deletes them only after that date, and never while the linked transaction is in a locked period.
   OCR text is indexed with a stored `tsvector` (`simple` configuration) plus a trigram index on the
   merchant.

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
