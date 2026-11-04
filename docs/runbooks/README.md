# Runbooks

| Runbook                                   | Use it when                                   |
| ----------------------------------------- | --------------------------------------------- |
| [First-time setup](first-time-setup.md)   | Building an environment from nothing          |
| [Deploy](deploy.md)                       | Releasing, migrating or rolling back          |
| [Incident response](incident-response.md) | Something is broken, or a breach is suspected |
| [Disaster recovery](disaster-recovery.md) | Data is lost or a region or account is gone   |
| [Restore drill](restore-drill.md)         | Every quarter, to prove the backups work      |
| [Security patching](security-patching.md) | A scanner or advisory reports a vulnerability |
| [Launch checklist](launch-checklist.md)   | Going from closed beta to `v1.0.0`            |

## What has and hasn't been tested

Nothing here has been run against a real AWS, Cloudflare, Stripe or Sentry account. Treat every cloud step as a first
attempt, and correct the runbook when reality differs.

These were run locally in Docker, and only these:

| What                                                                        | Result                                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `infra/db/production-roles.sql` as a superuser, then migrating as the owner | Works. As a plain `CREATEROLE` user it fails, see [setup](first-time-setup.md#3-create-the-database-roles) |
| Connection strings with `sslmode=verify-full` from Node, Python and Kratos  | Work, against a local Postgres with a test CA                                                              |
| `infra/db/reconciliation-checks.sql`                                        | Returns no rows on a clean local database with 80 postings                                                 |
| Recovery and verification email through Kratos and Mailpit                  | Correct text; same response for an unknown address; the code works once                                    |
| Kratos with the production environment variables                            | Starts, and uses the configured URLs and hook secret                                                       |
| API, worker, web and doc worker images                                      | Start as non-root; `/readyz` answers                                                                       |
