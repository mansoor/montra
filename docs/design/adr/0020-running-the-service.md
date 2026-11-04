# ADR-0020: Running the service: plans, staff, support, notices, observability

**Status:** accepted · **Date:** 2026-11-04 · **Phase:** 11

## Context

Phase 11 needs billing, a staff console, support access, in-app notices, a minimum mobile version, error tracking and metrics. What
ties these together is that staff get a way in for the first time, and R1 promises they can't see financial data unless someone lets
them (OPS-01, OPS-02). Prices are still an open product question (assumption 2).

## Decisions

1. **Entitlements, not prices, in code.** `@montra/domain` maps a plan to what it allows: free has personal books and 5 GB, Pro adds
   business and rental books and 50 GB. Prices live in Stripe and are referred to by id, so changing them needs no release.
   `BILLING_MODE=off`, the default, turns gating off for self-hosted installs, development and tests.
2. **The clock counts as well as the provider.** `effectivePlan` looks at the trial end and grace date, so a missed webhook can't keep
   a lapsed plan on. An hourly sweep also writes the lapse down, which lowers the quota.
3. **A lapse only stops adding.** New business and rental books and uploads over quota are refused. Existing books stay readable,
   editable and exportable (OPS-08). Blocking writes would hold people's records hostage, and restoring access is a poor time to find
   a backlog.
4. **Stripe through plain HTTPS behind a port.** Checkout and the billing portal mean card details never reach us, and the portal gives
   invoices and cancelling for free. Webhooks are verified with the signing secret against the raw body, and each event id is
   handled once.
5. **The phone doesn't sell.** Store rules require in-app purchase for a sale inside the app, which needs native code and store
   accounts. For now the phone shows the plan and doesn't link out to buy. The schema allows `apple` and `google` as providers.
6. **Three database roles.** `montra_app` runs the product. `montra_admin` runs the staff console: it has no grant on any financial
   table, reaches accounts only through `admin_*` functions that return people, plans and counts, and a test fails if it can read
   anything else. `montra_support` runs support sessions: `SELECT` on a short list of tables and columns, in a `READ ONLY` transaction.
7. **Functions stop being public.** Until now any role could call any function, which didn't matter with only one role. Migration 0021
   revokes `EXECUTE` from `PUBLIC` across `app`, and new functions default to `montra_app`.
8. **Support access is always read-only.** The requirement says read-only by default, but we have no need for a write mode, and not
   building one is the safest way to keep the promise. An owner grants it (72 hours by default, 7 days at most) and can revoke it.
   Each look is written to that person's security log and to the staff log. A session shows books and their currencies, import results and AI outcomes, not
   transactions, balances, notes, payslips or tenants, which covers most support questions. If it turns out not to, widen the grant list on purpose.
9. **Staff are added by hand.** `pnpm staff:add` is run by someone with the owner role. Staff need a second factor, as owners do. There's
   no separate staff SSO yet; `AuthPort` is unchanged.
10. **Metrics come from the database.** `/internal/metrics`, behind a token, reports counts for queues, failures and AI through
    definer functions, plus request timings from the API process. The worker needs no HTTP port, and a restart loses nothing.
11. **Sentry behind a port, on the API.** The API reports its own 5xx errors and failed jobs, and web and mobile send client errors to it
    when someone is signed in. This means one SDK and one place to scrub. Bodies and query strings are never sent.
12. **A minimum version per platform.** The phone sends `X-App-Version` and `X-App-Platform`. Below the minimum, the API answers 426 and
    the phone shows an update screen. Requests without the headers, such as the web's, aren't affected.
13. **Migrations stay backward compatible.** `scripts/check-migrations.mjs` refuses destructive statements in a new migration unless it
    carries `-- contract: <why>`, so an old task can keep running during a blue/green deploy (OPS-03, OPS-04).
14. **Legal text is a draft until a lawyer has read it.** The pages exist and say so. Montra sets only cookies that it needs, so there's
    no consent banner to show; this needs confirming in the legal review too.
15. **Widgets slip.** PLT-08 needs WidgetKit and Glance code that can't be run here, and it's a should-have. The plan allows should-haves to move to R1.x.

## Consequences

- A migration that adds a table needs thought about `montra_admin` and the backup catalog; tests fail otherwise.
- `bootstrap.sql` must be rerun once on an existing local cluster to add the two roles.
- Real Stripe, Sentry, KMS and store billing haven't been run against. Tests use the same code with a stubbed network.

## Alternatives considered

- **Impersonating a user for support:** gives writes and everything the user can see. It's what OPS-02 exists to prevent.
- **Filtering staff access in application code on the app role:** one missing filter would expose someone's finances. A role with no grants fails closed.
- **OpenTelemetry for metrics now:** more moving parts than the need justifies at launch. `prom-client` gives the same names, and traces can come later.
- **Unleash for flags:** another service to run, for a small table and a hash.
