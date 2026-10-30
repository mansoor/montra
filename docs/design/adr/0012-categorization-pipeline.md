# ADR-0012: Categorization pipeline, rules engine and AI gateway packaging

- Status: accepted
- Date: 2026-10-30
- Phase: 3

## Context

Phase 3 delivers the AI gateway (06) and the six-step categorization pipeline (04 §5). Both run in the API
process and the Node worker (ADR-0007). We need to decide how the pieces are packaged, how rules evaluate
regexes safely, how learning is stored, and how the gateway is tested without a paid provider.

## Decision

1. **Two pure packages.**
   - `packages/ai-gateway` — task functions, provider adapters, routing, minimizer, cache keys,
     calibration, budget and failover. It has no database access: the caller passes a `GatewayStore`
     (cache, audit events, usage) in the `AiContext`. Contract: `packages/ai-gateway/src/types.ts`.
   - `packages/categorize` — rules engine, amount bands, history scoring, transfer detection, the
     pipeline runner, learning (rule proposals from corrections), recurring detection, anomaly flags and
     the heuristic quick-add parser. No I/O. Contract: `packages/categorize/src/types.ts`.
   The API's `categorization` module loads data, calls both, and persists decisions.
2. **Adapters.**
   - `AnthropicAdapter` uses the official `@anthropic-ai/sdk`, with structured outputs
     (`output_config.format`) and `output_config.effort`. It checks `stop_reason`, and caches the system
     prompt plus the category list.
   - `OpenAiCompatibleAdapter` speaks `/v1/chat/completions` with `response_format: json_schema`, for
     Ollama, LM Studio and vLLM.
   - `NullAdapter` returns `off`.
   - `FakeAdapter` is deterministic: it matches keywords against category names. Tests, end-to-end runs
     and the evaluation self-check use it (`AI_PROVIDER=fake`).
   - OpenAI, Gemini and Azure BYOK adapters are follow-ups.
3. **Routing, prices and calibration are versioned TypeScript modules.** They live in
   `packages/ai-gateway/src/reference/` (routing, price table, calibration points), not YAML or a
   database table. Changing them is a reviewed code change, and the prompt version is part of every
   cache key and `ai_event`. Environment variables can override the model per group (`AI_MODEL_SMALL`, …),
   and so can each workspace's `ai_settings.models`.
4. **Rules regexes use `re2js`.** It is a pure-JavaScript port of RE2 with linear-time matching, so a
   user-written regex can't cause ReDoS. It needs no native build step, so it also runs in the web and
   mobile clients for a live "test this rule" preview. Patterns are limited to 100 characters.
5. **Learning is data, not model weights (AIA-06).**
   - `payee_history` counts by `(payee_key, amount_band, category, member)`.
   - `correction` records each user change.
   - `rule_suggestion` is created after 2 identical corrections. Every row can be viewed and deleted.
6. **The amount band is half-octave log scale:**
   `band = sign × (1 + floor(2·log2(max(1, |major units|))))`, or 0 for zero. It is stable, stored in
   `payee_history`, and part of the AI cache key.
7. **Review state.**
   - A decision at or above the workspace threshold (default 0.80) is posted with
     `review_state='auto_applied'`.
   - Anything below it is posted to the entity's uncategorized account with `needs_review`, and the
     suggestion is kept in `transaction.categorization.suggested`.
   - Accepting or correcting a transaction sets `reviewed`.
8. **The budget counter is separate from the audit log.** `ai_usage` is per month, so deleting
   `ai_event` rows (AIA-10) never resets spend (AIA-08).
9. **Scanned PDFs.**
   - The doc-worker runs Tesseract OCR and redacts account numbers, names and addresses. It returns
     `{kind: 'ocr_text', pages}`.
   - The Node parse job then calls `extractStatementTable` on that text, turns the rows into a grid, and
     continues as usual, including the opening/closing balance check.
   - With AI off, a scanned PDF fails with `pdf.needs_ai`, and the user is told to turn AI on or
     upload a CSV.

## API surface (all under `/v1/workspaces/:workspaceId`)

| Method & path | Purpose |
| --- | --- |
| `GET/PATCH /ai/settings` | AI mode, provider, endpoint, models, BYOK key (write-only), threshold, budget, document opt-in, failover; usage and per-mode disclosures |
| `POST /ai/settings/test` | Test the configured provider |
| `GET /ai/events?cursor` · `DELETE /ai/events/:id` · `DELETE /ai/events` | Audit log (AIA-10) |
| `GET /ai/tasks` · `POST /ai/tasks/:id/result` | Local-mode tasks parked for a client on the user's network |
| `GET/POST /rules` · `PATCH/DELETE /rules/:id` | Rules CRUD |
| `POST /rules/preview` · `POST /rules/:id/preview` | Match count and sample on existing transactions |
| `POST /rules/:id/apply` | "Apply to existing" job → `JobDto` |
| `GET /rule-suggestions` · `POST /rule-suggestions/:id/accept` · `POST /rule-suggestions/:id/dismiss` | Rules offered after corrections |
| `GET /review?entityId&minConfidence&cursor` | Review queue |
| `POST /review/accept` | Accept listed or all ≥ X% |
| `POST /review/:transactionId/resolve` | Pick a different category (a correction) |
| `POST /categorize/suggest` | Suggestion for the transaction editor |
| `POST /transactions/parse` | Natural-language quick add → draft (TXN-06) |
| `GET /imports/:id/category-proposals` · `POST /imports/:id/category-proposals/accept` | Categories proposed from the first import (UP-03) |
| `GET /insights?status` · `POST /insights/:id/accept` · `POST /insights/:id/dismiss` | Recurring proposals and anomaly flags |

DTOs are in `packages/schemas/src/ai.ts`.

## Consequences

- The gateway and the pipeline can be unit-tested without a database or network.
- The benchmark runs offline against `FakeAdapter`. The real-provider benchmark needs an API key and runs
  nightly.
- `re2js` is slower than native RE2 per match, but rules are matched against short strings. It costs
  well under 1 ms per row at 100 rules.
