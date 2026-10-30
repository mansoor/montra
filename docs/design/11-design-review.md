# 11 — Design Review Record (R1, round 1)

An independent review of documents 01–10 and the ADRs was carried out on 2026-10-30.
The review checked the worked examples against the requirements (Walmart receipt,
payslip, FX purchase, mortgage), and all of them add up. Its findings and the changes
made in response:

| # | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | Critical | Dedupe could silently skip real transactions (amount-only scoring, in-file dedupe, weak manual matches) | 04 §3.5 rewritten: duplicates only inside earlier batches' date ranges; auto-skip only for exact duplicates with matching ordinals; probable duplicates flagged, never skipped; one-to-one matching with a minimum description similarity; no in-file dedupe |
| 2 | Critical | Transfer detection auto-applied on amount alone | 04 §5: amount-only pairs capped at 0.60 (always reviewed) |
| 3 | Critical | Entity grants and payslip privacy enforced only in app code; sync feed unfiltered | 03 §11: entity-level RLS (`can_read_entity`), `journal_entry.restricted`; `change_log.entity_id/restricted`; 05 §3 feed filtered |
| 4 | Critical | Locks didn't block inserts; reconciliation didn't lock; void, trash and undo undefined; reversals moved P&L | 03 §4.2 and 04 §2.3: insert blocking, `locked` set on reconciliation, status-only edits allowed, void/trash/undo defined, reclassification on the original date when the period is open |
| 5 | Major | FX policy undefined (realized gains, cross-currency transfers, functional vs home) | ADR-0010; 04 §2.2 |
| 6 | Major | Schema: posting lacked `entry_date`/`entity_id`; keys not partition-ready; child tables lacked `workspace_id` | 03 conventions and §4: denormalized columns, composite FK, `(workspace_id, id)` keys on ledger tables, `workspace_id` everywhere |
| 7 | Major | Inter-entity accounts unique per entity broke with two businesses | `ledger_account.counterparty_entity_id`; account types stated (04 §2.1) |
| 8 | Major | Two imported legs of a transfer and match undo undefined | `transaction_source` table with before-images; 04 §3 |
| 9 | Major | Receipt apply could leave the transaction unbalanced (tips, FX) | 04 §7.7: allocation to the transaction amount |
| 10 | Major | RNT-10 returns and forfeits missing; a deposit could match rent | Posting templates (04 §2) and the `security_deposit` expected kind matched first (04 §9) |
| 11 | Major | Savings and debt budget groups had no activity; gross vs net income undefined | Tracking categories (`tracks_account_id`); budgets use take-home income (04 §8) |
| 12 | Major | Offline field-level merge could unbalance a transaction; 24 h idempotency too short | Atomic field group for amount and splits; client UUIDs make creates permanently idempotent (05 §3) |
| 13 | Major | Phase prerequisites (AI used before Phase 3) | 01: Phase 2 heuristic-only and digital-PDF-only; scanned PDFs and AI payee fallback in Phase 3; TXN-01 rules/history in Phase 1 |
| 14 | Major | Statement PDFs sent unredacted; local mode can't serve async jobs | 06 §4: opt-in for raw statements, redacted text by default; 06 §2: `pending_local` task relay |
| 15–23 | Minor | Phase mapping mismatches, naming inconsistencies, `/members` ambiguity, payslip encryption claim, `carry_deficit`, `ssn` code, session cache on revoke, support read-only, `period_lock` key and history | All fixed in 01/02/03/04/05/07 and the traceability generator |

Open items for the product owner remain in [10-assumptions.md](10-assumptions.md).
