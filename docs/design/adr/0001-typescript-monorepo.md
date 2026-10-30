# ADR-0001: TypeScript monorepo with pnpm and Turborepo

- Status: accepted
- Date: 2026-10-30

## Context
Web, mobile, API and workers must compute money, ledger postings, budgets and validation
identically (NFR-09, UP-05). The team is small.

## Decision
One repository. pnpm workspaces, Turborepo task graph, TypeScript 5.9 `strict` everywhere.
Shared logic lives in `packages/domain` (pure, no I/O) and `packages/schemas` (Zod).
Python is used only in the isolated `apps/doc-worker` for PDF extraction.

## Consequences
- One PR can change the contract, server and clients together.
- CI must be affected-only (Turbo) to stay fast.
- React Native needs Metro configured for workspace packages (supported by Expo SDK).

## Alternatives considered
Nx (heavier, more opinionated); separate repos (contract drift); Flutter + Dart backend (no code sharing with web).
