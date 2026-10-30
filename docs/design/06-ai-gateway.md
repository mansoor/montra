# 06 — AI Gateway

All AI and OCR calls go through `packages/ai-gateway`, used in-process by the API and
the workers. Features call **task functions**, never providers. See
[ADR-0007](adr/0007-in-process-ai-gateway.md).

## 1. Shape

```ts
interface AiGateway {
  categorize(input: CategorizeInput[], ctx: AiContext): Promise<TaskResult<CategorizeOutput[]>>;
  extractReceipt(images: ImageRef[], ctx): Promise<TaskResult<ReceiptExtraction>>;
  extractPayslip(doc: DocRef, ctx): Promise<TaskResult<PayslipExtraction>>;
  extractStatementTable(doc: DocRef, ctx): Promise<TaskResult<StatementTable>>;
  mapColumns(sample: GridSample, ctx): Promise<TaskResult<ColumnMapping>>;
  normalizePayees(raw: string[], ctx): Promise<TaskResult<PayeeNormalization[]>>;
  parseQuickAdd(text: string, ctx): Promise<TaskResult<TransactionDraft>>;
  summarizeMonth(facts: MonthFacts, ctx): Promise<TaskResult<MonthSummary>>;
  explainRecommendation(rec: RecommendationFacts, ctx): Promise<TaskResult<string>>;
  answerQuestion(q: string, tools: QueryTools, ctx): Promise<TaskResult<Answer>>;
}
type TaskResult<T> = { ok: true; value: T; meta: AiMeta } | { ok: false; reason: 'off' | 'budget' | 'invalid_output' | 'provider_error' | 'refused'; meta?: AiMeta };
```

A failure never throws to the feature. It returns `ok: false`, and the caller degrades:
the review queue for categorization, the manual mapping UI for column mapping, and
template text for summaries (graceful degradation, §8).

## 2. Provider modes (§8.1)

| Mode | Adapter | Notes |
| --- | --- | --- |
| `builtin` (default) | `AnthropicAdapter` (official `@anthropic-ai/sdk`) using Montra's account, in the workspace's region | Data processing agreement in place. Inputs are not used for training. A second-provider failover route can be configured (OPS-07). |
| `byok` | `AnthropicAdapter`, `OpenAiAdapter`, `GeminiAdapter`, `AzureOpenAiAdapter` with the **user's key** (KMS-encrypted, never logged) | A disclosure is shown per provider (UP-06). |
| `local` | `OpenAiCompatibleAdapter` → Ollama / LM Studio / vLLM URL; on-device (mobile) later | The URL is reached from the user's own network. Self-hosted edition: the worker calls it directly. Hosted service: the gateway can't reach the endpoint, so AI work for **async jobs** (import categorization, receipt extraction) is parked as `pending_local` tasks. The next open web or desktop client on the user's network claims them, runs them against the local endpoint and posts the validated results back. Until then, rows go through rules and history, and the rest to the review queue. See [10](10-assumptions.md). |
| `off` | `NullAdapter` | Every task returns `{ ok:false, reason:'off' }`. |

## 3. Per-task routing (AIA-02)

Routing is configuration, not code. It is versioned in `ai-routing.yaml` and overridable
per environment and per workspace mode.

| Task | Default model (builtin) | Effort | Batch | Output |
| --- | --- | --- | --- | --- |
| `categorize`, `normalize_payees`, `map_columns`, `parse_quick_add` | `claude-haiku-5-5` (small, cheap) | `low` | up to 100 rows per call | JSON schema |
| `extract_receipt`, `extract_payslip`, `extract_statement_table` | `claude-sonnet-5-5` (vision) | `medium` | 1 document | JSON schema |
| `summarize_month`, `explain_recommendation`, `answer_question` | `claude-opus-5-5` (larger) | `medium` | — | JSON (text fields) / tool use for Q&A |

Implementation notes for the Anthropic adapter (current API):

- Structured outputs through `output_config.format` (JSON schema generated from the Zod
  schema). Every response is then re-validated with Zod (AIA-04).
- Thinking is adaptive, and depth is controlled with `output_config.effort`. Requests
  do not send `temperature`, `top_p` or `top_k`.
- Check `stop_reason` before reading content. `refusal` and `max_tokens` map to
  `ok:false`. Server-side fallbacks are enabled where the model supports them.
- Prompt caching: the stable system prompt and the user's category list come first in
  the prompt, with a cache breakpoint after them. Row data comes after.
- `answer_question` (RPT-06) uses tool use: the model calls read-only query tools
  (`sum_postings`, `list_transactions`, `compare_periods`) whose results are computed in
  SQL. The returned number always comes from a tool result, never from the model's text
  (AIA-05).

## 4. Data minimization (AIA-03)

A `Minimizer` runs before every provider call:

- Sends only the fields the task needs: payee/description, amount band (for
  categorization, a rounded amount), account *type* (not name or number), entity type,
  date (month/day-of-week), and the category list as `{ id, name, group }`.
- Masks digit runs of 4 or more (card and account numbers become `••••`), emails,
  phone numbers and street numbers. Family member and tenant names are replaced with
  stable pseudonyms (`MEMBER_1`, `TENANT_3`) and mapped back on the way in.
- Never sends credentials, full account numbers or other workspaces' data.
- Images: receipts are sent as images (necessary). Payslip images **and statement
  PDFs/scans** are only sent to an LLM in `builtin`/`byok` with an explicit
  per-workspace opt-in (PAY-09, UP-06). The default for statements is: text layer
  (pdfplumber) or OCR in our own infrastructure (Textract under a DPA, or local
  Tesseract/PaddleOCR), then the **redacted text table** (account numbers, names and
  addresses masked) goes to `extract_statement_table`.

## 5. Caching and cost (AIA-07, AIA-08)

- Categorization cache key = `hash(task, model_version, normalized_payee, amount_band,
  account_type, entity_type, category_list_hash)`. Scope is the workspace. A hit skips
  the provider. TTL 90 days, invalidated when the category list changes.
- Per-workspace monthly AI budget (`ai_settings.monthly_budget_usd`). Costs are
  computed from token usage × the price table in reference data. At 80%, the gateway
  routes to cheaper models; at 100%, `reason:'budget'`, and categorization falls back to
  rules and history only. The user sees a banner.
- Batching and concurrency: up to 8 parallel calls per import, which meets AI-11 (1,000
  rows in under 60 s) because about 70% or more of rows resolve before step 5 after
  month 1.

## 6. Confidence calibration

Model-reported confidence is calibrated per provider and model with isotonic regression
fitted on the benchmark set (§7) and stored in reference data. The review-queue
threshold (default 0.80) applies to the *calibrated* score, so "accept all above 90%"
means the same thing whichever provider is used.

## 7. Evaluation (AIA-09)

- `packages/ai-gateway/eval`: a labelled benchmark of 5,000+ transactions (synthetic +
  consented anonymized), receipts with line truth and CSV mapping cases, with
  stratified splits.
- `pnpm eval --task categorize --provider builtin` reports accuracy, macro-F1,
  calibration error, latency and cost. It runs in CI nightly and per release; a drop of
  more than 2 points blocks the release.
- Production metric: the accepted-without-edit rate from `ai_event.user_action`
  (success metrics §1.4: ≥ 85% in month 1, ≥ 92% by month 3).

## 8. Audit (AIA-10) and disclaimers (AIA-12)

Every call writes `ai_event` (input **hash**, not input; model; output; confidence;
latency; cost; later the user action). The user can view and delete these entries.
Tax and financial outputs include the disclaimer string from reference data.

## 9. Prompt and schema management

Prompts live beside each task as versioned templates (`tasks/categorize/v3.prompt.md`)
with a JSON-schema output. The prompt version is part of the cache key and of
`ai_event`, so evaluation results are attributable to a version.
