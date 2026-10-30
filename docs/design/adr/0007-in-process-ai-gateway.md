# ADR-0007: In-process TypeScript AI gateway with task functions

- Status: accepted
- Date: 2026-10-30

## Context
AIA-01..10 require task-level functions, per-task routing, minimization, structured
outputs, caching, budgets and audit, across built-in, BYOK, local and off modes.

## Decision
`packages/ai-gateway`: task functions over provider adapters (official Anthropic SDK for
built-in; OpenAI-compatible adapter for Ollama/LM Studio/vLLM and optionally LiteLLM;
further BYOK adapters). Routing in versioned config. Zod schemas generate the JSON
schema for structured output and validate responses.

## Consequences
No extra proxy service to run; minimization and audit are in our code path. Adding a
provider means adding an adapter.

## Alternatives considered
LiteLLM proxy as the core (Python service; minimization and per-task logic still needed in our code).
