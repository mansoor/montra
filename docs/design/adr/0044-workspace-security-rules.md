# ADR-0044: A workspace's security rules: who needs two-step verification, and idle sign-out

- Status: accepted
- Date: 2026-11-13

## Context

AUTH-04 required a second factor (AAL2) of owners, admins and accountants, through a deployment setting. Partners,
and members or viewers given a business's books, could see payroll (salaries, tax IDs held for forms, bank
deposits) with a password alone. An owner had no way to require more of everyone.

Two more gaps:

- Someone required to use a second factor who hadn't set one up was sent to a sign-in step they couldn't complete.
- AUTH-07's idle timeout (web, 30 minutes by default, adjustable) wasn't built: a browser session lasted 30 days.

## Decision

- **Each workspace has a policy** (migration 0044, `app.workspace.mfa_policy`):
  - `standard`, the default: owners, admins, partners and accountants must sign in with a second factor, and so must
    anyone who can see business books, read-only included.
  - `everyone`: every login, viewers and family members included.

  Accountants always must. `REQUIRE_OWNER_MFA=false` (development) turns off the `standard` defaults but never
  `everyone`.
- **The workspace guard enforces it** for sessions without a second factor:
  - If the identity has a second factor (TOTP, a security key or recovery codes, read from Kratos's admin API and
    cached for a minute once known), it answers `mfa.required` and the web asks for it.
  - If it doesn't, it answers `mfa.setup_required`. The web then opens security settings with a note saying why and
    a link back. A "no" isn't cached, so the person gets in as soon as they've set one up.
- **Owners and admins see who has it**: `MemberDto.twoFactor`, shown in Sharing as "Two-step on" or "No two-step yet".
  It is null for everyone else.
- **Idle sign-out on the web** (`app.workspace.idle_timeout_minutes`, 5–30, default 30):
  - The workspace layout signs the browser out after that long without use (pointer, keys, wheel, touch), with a
    one-minute warning. All tabs share one "last used" time.
  - The API also ends a browser session (the web's cookie) unused for 30 minutes: it deletes the Kratos session and
    answers 401. This catches a tab that stopped running.
  - The phone isn't signed out; it has its app lock.
- **Changing the rules** is `PUT /v1/workspaces/:id/security`, for owners and admins with a recent sign-in, on the
  Sharing settings page.

## Consequences

- Payroll and other business books need a second factor by default, whatever the role.
- Turning on `everyone` locks out anyone without a second factor until they set one up; they're taken there.
- A workspace's shorter timeout applies in the browser only. The server's limit is 30 minutes for every browser
  session, since a session isn't tied to one workspace.
- The members list makes one admin API call per active member for owners and admins (in parallel, cached when "yes").
- The phone doesn't yet lead someone to set up a second factor (planned with phone sign-up and recovery). It shows the
  server's refusal.

## Alternatives considered

- **A role list the owner picks:** more to explain. Business access is what makes payroll visible, so it decides
  better than a role alone.
- **Kratos's own `required_aal: highest_available`:** it asks for a second factor only of people who have one, and
  can't depend on a workspace.
- **Server-side idle per workspace:** a session isn't tied to a workspace, and the strictest workspace would sign
  people out of all of them.
