# 09 — Quality and Delivery

## 1. Test strategy

| Level | Tooling | What | Gate |
| --- | --- | --- | --- |
| Unit | Vitest | Pure functions in `packages/domain`, `importers`, `ai-gateway` | ≥ 90% line coverage on `domain` |
| Property | fast-check | Ledger invariants (every built entry balances; allocations sum exactly; FX rounding residual ≤ n−1 minor units; dedupe is symmetric; budget `available` identity holds) | Required in CI |
| DB integration | Vitest + real Postgres 16 | Migrations, RLS isolation (workspace A can never read B), balance trigger, lock trigger, change feed | Required in CI |
| API integration | Vitest + Nest testing module + Fastify `inject` | Endpoints against a real database: auth, RBAC, idempotency, ETags | Required in CI |
| Contract | Zod schemas → OpenAPI diff | Breaking-change detection on PRs | Required in CI |
| Import corpus | Golden files | ≥ 50 anonymized bank and card exports (CSV/XLSX/PDF) with expected parse output | Required in CI |
| AI eval | `pnpm eval` | Categorization benchmark (AIA-09), receipt extraction, column mapping | Nightly; release gate |
| E2E web | Playwright + axe | Onboarding, import, review, budget, reports; accessibility | Required on `develop` merges |
| E2E mobile | Maestro | Quick add, capture (mock camera), review, offline/online | Nightly + release |
| Performance | k6 + seeded 50k-transaction workspace | Dashboard p95 < 2 s, import 5k rows < 10 s | Release gate |
| Security | Semgrep, `pnpm audit`, Trivy, ZAP baseline; annual third-party pen test | OWASP ASVS L2 checklist | Release gate |

## 2. CI/CD (GitHub Actions)

- `ci.yml` on every PR and push: install (pnpm, cached) → lint → typecheck → unit and
  property tests → DB/API integration tests (Postgres service container) → build. Turbo
  runs only affected packages.
- `deploy-dev.yml` on push to `develop`: build images → push to ECR → migrate → deploy
  to dev. Expo preview build on mobile changes.
- `release.yml` on `v*` tags: tags on `release/*` deploy to staging; tags on `main`
  deploy to prod with manual approval. EAS production builds and store submission.
- Database migrations follow **expand → migrate → contract** across at least two
  releases, so old and new app versions run side by side during blue/green (OPS-04).

## 3. Branching and releases

```
main      ●───────────────────────────────●  v1.0.0        (released versions only)
           \                             / \
release/1.0 \                    ●──●──●    \  (rc tags, fixes only)
             \                  /             \
develop       ●──●──●──●──●──●──●──────────────●── v0.N.0-dev.M tags per phase
               \   / \     /
feature/*       ●─●   ●───●       (one per story/phase slice; PR → develop)
```

- `main`: protected; merges only from `release/*` or `hotfix/*`; every merge commit is
  tagged `vX.Y.Z`.
- `develop`: protected; PRs from feature branches need green CI and one review. The end
  of each phase is tagged as a development release `v0.<phase>.0-dev.<n>`, which deploys
  to the dev environment.
- `release/X.Y`: cut from `develop` when the scope is complete; only fixes are allowed;
  `-rc.N` tags deploy to staging; merged to `main` (tag) and back to `develop`.
- `hotfix/*`: from `main`, merged to `main` and `develop`.
- Commits follow Conventional Commits. Changesets generate the changelog.

## 4. Environments

| Env | Source | Data | Purpose |
| --- | --- | --- | --- |
| local | working tree | seed + fixtures (`pnpm db:seed`) | development (docker compose: postgres, redis, minio, mailpit, kratos) |
| dev | `develop` | synthetic | integration, demos per phase |
| staging | `release/*` rc tags | synthetic + anonymized corpus | UAT, performance, pen test |
| prod | `main` tags | real | users |

## 5. Definition of done (per story)

Code + tests (unit/property/integration as applicable) · API schema updated · audit and
change-feed entries for new mutable tables · RLS policy for new tables · i18n strings
externalized · accessibility checked · docs/ADR updated if a design decision changed ·
feature flag if partially shipped.
