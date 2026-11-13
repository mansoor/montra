# ADR-0043: A password policy the admin console sets and the auth gateway enforces

- Status: accepted
- Date: 2026-11-13

## Context

AUTH-02 follows NIST SP 800-63B: at least 12 characters, a check against breached passwords, no composition rules and
no forced resets. Kratos does all of that, but its rules are fixed in `kratos.yml`, and a long but guessable password
such as `password12345678` passes when it isn't on a breach list. The owner wants operators to be able to tighten the
rule, and people to see how strong a password is while they type it.

A login is one identity across every workspace it belongs to, so a per-workspace password rule can't be enforced: the
same password opens all of them. The policy is therefore one setting for the whole service.

## Decision

- **The policy** is a minimum length (12–64, never below Kratos's 12) and a minimum strength score (0–4, default 3,
  "Strong"). It is stored as two `app.system_setting` rows (`password_min_length`, `password_min_score`) and set on
  the admin console's **Security** tab by admin staff (`PUT /v1/admin/password-policy`, logged as
  `password_policy.save`). Anyone can read it (`GET /v1/password-policy`), so sign-up can show it.
- **The score** is zxcvbn's guessability estimate (`@zxcvbn-ts/core` 4.2 with the common and English dictionaries),
  wrapped by the new `@montra/password` package so the gateway, the web and later the phone score alike. The person's
  email and name, and "montra", count against a password built from them. Only the first 64 characters are scored,
  and fuzzy (Levenshtein) matching is off: together they keep a check under about half a second at worst and around
  50 ms usually.
- **The auth gateway enforces it** (ADR-0042). It is the one place that sees a new password before Kratos stores it:
  sign-up and the settings flow, which also covers setting a password after a recovery. A password that falls short
  never reaches Kratos:
  - a browser goes back to its form with `notice=weak_password`, the problems (`too_short`, `too_weak`) and the
    minimum length;
  - the phone gets 400 with the flow and a Kratos-style message (id 4000901).
  Scoring runs on a worker thread so a slow check doesn't hold up other sign-ins. If scoring fails, the gateway checks
  the length only, and Kratos still checks its own minimum and the breach list. The gateway rereads the policy at most
  once a minute.
- **The web shows a meter** on the sign-up and security-settings password fields: four bars, the level, zxcvbn's
  reason when it's weak, and what the policy needs. It blocks the form (`setCustomValidity`) until the password
  passes. The scorer loads only on those pages.

## Consequences

- An operator can require longer or stronger passwords without a deployment, and the change reaches every gateway
  within a minute. Existing passwords keep working: the policy applies when a password is set.
- `password12345678`-style passwords are refused even when they aren't on a breach list.
- The meter's reasons are zxcvbn's English text; other languages need its translation packages.
- The client bundle for sign-up and security settings carries the dictionaries (loaded on demand).
- The phone's sign-up and password change (planned) will use the same package and the same gateway messages.

## Alternatives considered

- **Kratos's own settings only:** a fixed length and the breach check, with no strength score and no way to change
  them without redeploying Kratos.
- **A per-workspace policy:** can't be enforced on an identity shared by several workspaces, and would confuse people
  who belong to more than one.
- **Checking strength in a Kratos webhook:** Kratos's hooks don't receive the password.
- **Composition rules (a digit, a symbol, mixed case):** NIST advises against them; they push people to
  `Password1!`, which scores low here.
