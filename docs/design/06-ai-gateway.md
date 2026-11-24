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
  mapTaxLines(input, ctx): Promise<TaskResult<TaxLineMapping[]>>;       // AI-10: proposes, the user maps
  flagSeparation(input, ctx): Promise<TaskResult<SeparationFlag[]>>;   // BIZ-03: flags, the user reclassifies
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
| `byok` | `AnthropicAdapter`, or `OpenAiCompatibleAdapter` speaking each provider's chat completions API (OpenAI at api.openai.com with `max_completion_tokens`; Google Gemini at its OpenAI-compatible endpoint; Azure OpenAI at the resource's `/openai/v1` with the key in `api-key` and deployment names as models; any other OpenAI-compatible server), with the **user's key** (KMS-encrypted, never logged) | A disclosure is shown per provider (UP-06). OpenAI and Gemini have default models (`reference/routing.ts`); Azure has only the deployments the user names. |
| `local` | `OpenAiCompatibleAdapter` → Ollama / LM Studio / vLLM URL; on-device (mobile) later | The URL is reached from the user's own network. Self-hosted edition: the worker calls it directly. Hosted service: the gateway can't reach the endpoint, so AI work for **async jobs** (import categorization, receipt extraction) is parked as `pending_local` tasks. The next open web or desktop client on the user's network claims them, sends each one's ready `chat/completions` body to the local endpoint and posts the answer back. The answer is then used where a provider's would be: the same work run again finds it (by the request's hash, or for row tasks by each item's cache key, whatever the batching) and puts it through the task's schema and checks. A follow-up job runs that work again for the person it was for: an import in preview gets the new suggestions, a committed import's transactions waiting in Review get them as suggestions, and a receipt waiting for its reading is read again. Until then, rows go through rules and history, and the rest to the review queue. A request is parked once while it waits or its answer lasts (7 days). See [10](10-assumptions.md). |
| `off` | `NullAdapter` | Every task returns `{ ok:false, reason:'off' }`. |

A mode that is on but can't run (BYOK with no key saved, Azure OpenAI without its resource URL or a deployment,
local with no URL, builtin with no provider on this server) also gets the `NullAdapter`. `AiRuntime.problem` and `AiSettingsDto.problem` say which, so the settings
page warns and features that degrade say the reason and the fix rather than "AI is off". Saving BYOK with a
provider that needs a key (all but an OpenAI-compatible server) and none is refused with `ai.key_required`; Azure
OpenAI without its URL or a deployment with `ai.endpoint_required` or `ai.model_required`.

## 3. Per-task routing (AIA-02)

Routing is configuration, not code. It is versioned in `ai-routing.yaml` and overridable
per environment and per workspace mode.

| Task | Default model (builtin) | Effort | Batch | Output |
| --- | --- | --- | --- | --- |
| `categorize`, `normalize_payees`, `map_columns`, `parse_quick_add` | `claude-haiku-5-5` (small, cheap) | `low` | up to 100 rows per call | JSON schema |
| `map_tax_lines`, `flag_separation`, `flag_capital` | `claude-haiku-5-5` (small, cheap) | `low` | 1 list per call | JSON schema; answers limited to what was offered, and the user decides |
| `suggest_property` (AI-02) | `claude-haiku-5-5` (small, cheap) | `low` | up to 100 rows per call, one call per set of rental books | JSON schema; short ids for properties (p1) and units (u1) |

`suggest_property` (`tasks/suggest-property/v1.ts`) gets the lines whose rental property is still open after rules,
payee history and an address or unit in the text. It sends each line minimized as `categorize` does (masked payee and
description, a rounded amount, the category's name) and the books' properties as short ids with the owner's name for
each, masked like any text, and unit labels. It never sends an address. Its score is the model's own, not calibrated,
so the API applies it only at the AI threshold as well as the property threshold. Results are cached per line for 30
days.
| `extract_receipt`, `extract_payslip`, `extract_statement_table` | `claude-sonnet-5-5` (vision) | `medium` | 1 document | JSON schema |

`extract_receipt` (`tasks/extract-receipt/v3.ts`; v3 adds the store's address, phone and website) sends the receipt images in builtin and BYOK modes only,
with the masked OCR text when there is some. Local mode sends only the masked OCR text from the doc-worker
(`receipt.ocr`). Amounts come back as decimal strings, and `taxIncluded` marks VAT-style receipts. An answer
that loses more than half of its lines to validation is `invalid_output`.

| `summarize_month`, `explain_recommendation` | `claude-opus-5-5` (larger) | `medium` | — | JSON (text fields) |

Implementation notes for the Anthropic adapter (current API):

- Structured outputs through `output_config.format` (JSON schema generated from the Zod
  schema). Every response is then re-validated with Zod (AIA-04).
- Thinking is adaptive, and depth is controlled with `output_config.effort`. Requests
  do not send `temperature`, `top_p` or `top_k`.
- Check `stop_reason` before reading content. `refusal` and `max_tokens` map to
  `ok:false`. Server-side fallbacks are enabled where the model supports them.
- Prompt caching: the stable system prompt and the user's category list come first in
  the prompt, with a cache breakpoint after them. Row data comes after.
- `answer_question` (RPT-06) uses the small group and returns a plan, not an answer: the metric, categories, payee and periods. The
  API validates the plan against the workspace's categories and computes every figure in SQL, so the number can't come from the
  model (AIA-05). It sees the question, category names and today's date, and no amounts. This replaces the tool-use design: tool
  results would have carried amounts to the provider (ADR-0019).
- `summarize_month` (AIA-01, FLOW-01) words the Month in review. The API computes every figure (money in and out, usual,
  the clearest changes, the biggest purchases, the budget and next month's suggested budget from BUD-02's median) and
  sends them formatted and named, with the category and place names it may mention. The answer is a headline, up to five
  points and a budget note; any number in it that wasn't given fails the call (AIA-05), and the API then shows plain
  sentences built from the same figures. Results are cached per workspace by their input for 60 days, so reopening a month
  costs nothing until its figures change. The budget recommendation is computed (BUD-02) and only worded here.

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
  computed from token usage × the price table in reference data (`reference/prices.ts`: Anthropic, OpenAI and
  Gemini rates, dated steps for announced changes, a dated snapshot name priced as its model). The operator sets any
  model's rate with `AI_MODEL_PRICES` (JSON, USD per million tokens) without a release; a model nobody priced (an
  Azure deployment name) costs nothing, so a budget can't hold it back. At 80%, the gateway
  routes to cheaper models; at 100%, `reason:'budget'`, and categorization falls back to
  rules and history only. The user sees a banner.
- Batching and concurrency: up to 8 parallel calls per import, which meets AI-11 (1,000
  rows in under 60 s) because about 70% or more of rows resolve before step 5 after
  month 1.

## 6. Confidence calibration

Model-reported confidence is calibrated per provider and model with isotonic regression
fitted on the benchmark set (§7) and stored in reference data (`reference/calibration.ts`). Each fitted block keeps
its range of raw scores as a flat level and is smoothed ((right + 1) / (n + 2)), so no score claims 0% or 100%.
Thresholds apply to the *calibrated* score, so "accept all above 90%" means the same thing whichever provider is used.

There are two (owner, 2026-11-21): the review threshold (default 0.80) for rules, transfers, past transactions,
the file's own categories and known merchants, and the **AI threshold** (default 0.95) an AI suggestion must meet
to be applied, on categorized rows and receipt lines. Both are sliders in Settings → AI. Claude Haiku's
categorizing curve was fitted on the train split on 2026-11-21: it under-states its confidence (ECE 0.140 on the
test split as reported, 0.011 calibrated), and at 0.95 about nine in ten test rows apply at 99.2% precision.

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
Tax and financial outputs carry the disclaimer once per screen: `disclaimer.tax` or `disclaimer.financial` in the
messages, through one shared component on the web and one on the phone. Tax report files (Schedule C and E as CSV or
XLSX) and the tax package say it inside (STATUS §7g).

## 9. Prompt and schema management

Prompts live beside each task as versioned templates (`tasks/categorize/v3.prompt.md`)
with a JSON-schema output. The prompt version is part of the cache key and of
`ai_event`, so evaluation results are attributable to a version.
