# ADR-0006: Ory Kratos for identity

- Status: accepted (confirmed 2026-10-30)
- Date: 2026-10-30

## Context
AUTH-01..11 require passwords with Argon2id and breach checks, passkeys, TOTP, recovery
codes, social sign-in, verification, recovery, sessions and device management. A future
self-hosted edition is planned.

## Decision
Use Ory Kratos (open source; self-hosted in our VPC or Ory Network managed). The API
depends on an `AuthPort` (`verifySession`, `requirePrivileged`, `revokeSessions`) so the
provider can be swapped.

## Consequences
We own the hosted UI pages (custom-branded in Next.js), which is more work than Clerk, but
there is no per-MAU pricing and the self-hosted edition is possible.

## Alternatives considered
Auth0 / Clerk / Cognito (managed, faster to start, not self-hostable, MAU pricing); Keycloak (heavier JVM).
