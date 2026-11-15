# Runbooks

| Runbook                                   | Use it when                                   |
| ----------------------------------------- | --------------------------------------------- |
| [First-time setup](first-time-setup.md)   | Building an environment from nothing          |
| [Deploy](deploy.md)                       | Releasing, migrating or rolling back          |
| [Incident response](incident-response.md) | Something is broken, or a breach is suspected |
| [Disaster recovery](disaster-recovery.md) | Data is lost or a region or account is gone   |
| [Restore drill](restore-drill.md)         | Every quarter, to prove the backups work      |
| [Security patching](security-patching.md) | A scanner or advisory reports a vulnerability |
| [Key wrapping](key-wrapping.md)           | Making a master key, using Vault, or moving the wrapped keys |
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
| Recovery and verification email through Kratos v26.2.0 and Mailpit | Correct text; same response for an unknown address; the code works once; also through the web pages |
| Kratos v26.2.0 with the production environment variables, `serve` and `courier watch` as separate containers, Postgres over `verify-full` with a test CA | `scripts/kratos-smoke.mjs` passes, including the recovery hook to the API. A wrong CA is refused |
| Kratos migrations from v1.3.1 to v26.2.0, on a local database with an MFA identity | 23 migrations apply. The old session, password, TOTP and recovery codes still work |
| Going back from v26.2.0 to v1.3.1 on a local database | v1.3.1 fails sign-in on the migrated schema. After `migrate sql down --steps 23`, sign-in, TOTP and recovery codes work |
| API, worker, web and doc worker images                                      | Start as non-root; `/readyz` answers                                                                       |
