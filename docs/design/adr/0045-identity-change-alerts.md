# ADR-0045: Log and announce password and two-step changes

- Status: accepted
- Date: 2026-11-13

## Context

AUTH-12 asks for a security activity log that people can see. Password changes and remote sign-outs were missing:
the first happens inside Kratos, which Montra never heard about, and the second wasn't recorded. A changed password
or a new authenticator added by someone else is how an account is taken over, so the owner should hear about it at
once, not only find it in a log. AUTH-05 also asks for a confirmation email after a reset.

## Decision

- **Kratos tells the API** after a settings change, by the `web_hook` it already uses for recovery:
  - `password_changed` after a new password (which also follows every recovery);
  - `mfa_changed` after a change to an authenticator app, security key or recovery codes.

  The hook carries only the event and the identity id, with the shared hook secret.
- **A new password signs out the other devices**: Kratos's `revoke_active_sessions` hook on the settings password
  method. The device in use stays signed in.
- **The API notes the event** in `app.security_event` through `app.note_identity_event` (migration 0045). It is a
  security definer function, because the hook has no user context; it accepts only these two kinds. The API then
  **emails the account owner** ("Your Montra password was changed", "Two-step verification changed on your Montra
  account") with a link to security settings. A failure here is logged and doesn't fail the hook, since Kratos has
  already made the change.
- **Signing devices out** (one, or all others) from the device list adds a `session_revoked` event with the count.
- Production repeats the hook lists in Terraform (`kratos_settings_hooks`), as setting one list item by environment
  variable replaces the whole list from `kratos.yml`.

## Consequences

- The security activity covers password, two-step, email and device changes, new-device sign-ins, lockouts, exports,
  restores, deletion and support access.
- The reset confirmation email AUTH-05 asks for is the password-changed email, sent after the new password is set.
- Changing a password signs out every other device. That is the safer default, and it matches what a reset already
  does.
- If the hook can't reach the API, the change still happens. Kratos logs the failed hook, and the event and email are
  lost.

## Alternatives considered

- **Polling Kratos for credential changes:** slower, and needs per-identity state to compare against.
- **Kratos's own courier for the alert:** it has templates for recovery and verification codes, not for settings
  changes.
