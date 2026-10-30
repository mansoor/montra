# ADR-0002: Modular monolith API + separate worker deployable

- Status: accepted
- Date: 2026-10-30

## Context
About 20 functional modules, strong transactional coupling around the ledger, and a small team.

## Decision
One NestJS application with strict module boundaries (public service per module, no
cross-module table access, enforced by lint rules). The same codebase has a second
entrypoint for BullMQ workers. Only the Python doc worker is a separate service.

## Consequences
Ledger writes happen in a single DB transaction across modules. Deploys are simple.
Hot modules (AI, imports) can scale as worker queues without extracting services.

## Alternatives considered
Microservices from day one: distributed transactions around the ledger, higher ops cost.
