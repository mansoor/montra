# ADR-0005: One journal entry per entity touched by a transaction

- Status: accepted
- Date: 2026-10-30

## Context
Requirements §11 says a transaction "owns one Journal entry", but ACC-03/DE-05 allow one
transaction to be split across entities (personal card pays a business expense), while
each entity must keep self-balancing books for P&L and Schedule C/E.

## Decision
A transaction owns one journal entry **per entity** it touches (almost always exactly one).
Cross-entity flows post through `inter_entity_clearing`/owner equity (or due-to/due-from)
accounts, each entry balanced independently. Consolidated views eliminate those accounts.

## Consequences
Per-entity trial balances always balance; the consolidated view needs elimination logic
(simple, because the clearing accounts are system-role tagged).
