# 10 — Assumptions and Open Questions

The requirements (§14.3) leave several questions open. The design proceeds on the
assumptions below, each chosen so it can be reversed cheaply.

**Status: confirmed by the product owner on 2026-10-30.** These are now the R1 baseline;
changing one is a scope change recorded in this file.

| # | Open question | Working assumption | Why / cost to change |
| --- | --- | --- | --- |
| 1 ⚑ | Target markets: US only, or also CA/UK/EU? | **US first** (Schedule C/E mappings shipped). Tax lines, mileage rates and categories are **reference data keyed by country**, so other countries are a data change, not a code change. Multi-currency is in R1 regardless (ACC-04, CUR). | Low: add reference datasets later. |
| 2 | Pricing: free personal tier + paid add-ons, or one subscription? | Build **entitlements** (`plan` + feature flags such as `entities.business`, `entities.rental`, `storage.gb`) and leave the price decision to product. Default: free personal, paid "Pro" unlocks business, rental and larger storage. | None: entitlement checks are generic. |
| 3 ⚑ | Default AI mode at launch? On-device model for R1 mobile? | **Built-in hosted (Anthropic) by default**, with BYOK and local endpoints available, and *Off* always available. **No on-device model in R1**: mobile uses the server gateway (or the local endpoint on the same network). | Medium: on-device can be added as another adapter. |
| 4 | Maximum scale per workspace? | 10 businesses, 50 properties, 200 units, 25 accounts per entity, 250k transactions. Enforced by soft limits in entitlements. | Low. |
| 5 ⚑ | Should household partners see business and rental entities by default? | **No.** A partner gets write access to Personal and **no access** to business/rental unless the owner grants it per entity. | Low: a default in `entity_grant`. |
| 6 | Confirm React Native (Expo) over native after a camera/OCR spike | Go with **Expo** (dev client + native modules). A time-boxed spike at the start of Phase 4 measures capture-to-preview latency (< 1.5 s target) and edge-detection quality; a fallback native module is allowed without abandoning RN. | Medium. |
| 7 | "Local / self-hosted" AI for the *hosted* service | A cloud server can't reach a user's `localhost`. In R1 hosted, **local mode runs through the client**: the web app (or the desktop on the same network) calls the user's Ollama/LM Studio endpoint directly (CORS-enabled) for `categorize`/`map_columns` and posts the results back. Full server-side local mode comes with the self-hosted edition. | Documented limitation. |
| 8 | Transaction ↔ journal cardinality (§11 says "one journal entry") | One entry **per entity** touched by the transaction (normally exactly one). See ADR-0005. | Needed for self-balancing per-entity books. |
| 9 | Identity provider | **Ory Kratos** (open source, self-hostable, managed option) instead of Auth0/Clerk, to keep the self-hosted edition possible and meet AUTH-02 (Argon2id, HIBP). ADR-0006. | Medium: identity sits behind an `AuthPort`. |
| 10 | Build vs buy LLM gateway | **In-process TypeScript gateway** with provider adapters. LiteLLM can sit behind the OpenAI-compatible adapter if wanted. ADR-0007. | Low. |
| 11 | Team and timeline | Estimates in the plan assume **3 full-stack engineers + 1 designer (part-time) + 1 QA (from Phase 3)**. The calendar scales roughly linearly with team size, except the mobile track, which needs one dedicated RN engineer from Phase 4. | — |
