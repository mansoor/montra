# ADR-0046: Account flows on the phone

- Status: accepted
- Date: 2026-11-13

## Context

The phone could only sign in, with a password and an authenticator code. Creating an account, resetting a forgotten
password, setting up two-step verification, saving recovery codes and signing in with one all meant going to the
web. A workspace that needs two-step verification (ADR-0044) refused a phone login that hadn't set it up, with nothing
to do about it on the phone.

Kratos has native (API) versions of every flow. Two details came out of trying them against Kratos v26.2.0:

- **Recovery:** a native recovery flow answered the emailed code with "redirect the browser" (422) unless
  `feature_flags.use_continue_with_transitions` is on. With it, the answer carries the session token and the settings
  flow to set a new password in. Browser flows still redirect as before; this was checked for sign-up and recovery.
- **The second sign-in step:** the phone asked `whoami` whether a second factor was missing. Montra's Kratos accepts a
  one-factor session there (`session.whoami.required_aal: aal1`), so a phone signed in without asking for the
  authenticator. An `aal=aal2` login flow offers an authenticator or recovery-code field only when the account has
  one, so that is the signal now.

## Decision

- **The phone's Kratos client** (`apps/mobile/src/auth/kratos.ts`) covers sign-up, email verification and resending
  the code, recovery, setting a password, the authenticator, recovery codes, signing in with a recovery code, and
  re-authenticating when Kratos needs a recent sign-in (`session_refresh_required`). It talks to the auth gateway
  like the web does. The gateway's refusals (a pause, a weak password) arrive as Kratos messages and show as such.
- **New screens:**
  - Sign-up: email, name and password, with the strength meter from `@montra/password` measuring against the service's
    policy. Then the emailed code, which can wait ("Later"): the API blocks money until the email is confirmed
    (AUTH-03).
  - Forgot password: email, then the emailed code, then the second factor when the account has one (AUTH-05 asks for
    it), then a new password with the meter. Kratos signs out the other devices.
  - Two-step verification, on More: set up an authenticator (the key to paste into an app on this phone, and the QR
    code for another device), then recovery codes to save. Passkeys and security keys stay on the web.
  - Sign-in offers "Forgot password?", "Create an account", and a recovery code instead of the authenticator.
- **When a workspace needs two-step verification** (`mfa.setup_required` or `mfa.required` from the API), the app shows
  the two-step screen in place of the workspace. It ends with a code from the authenticator, which brings the session
  up to the second factor; then the workspace loads.
- `kratos.yml` turns on `feature_flags.use_continue_with_transitions`.

## Consequences

- Everything a person needs to get in and stay safe works on the phone, but passkeys and security keys still need
  the web.
- The phone bundle carries zxcvbn's word lists for the meter (the Android bundle is 11 MB).
- The LAN phone build uses development sign-in (`MONTRA_AUTH_MODE=dev`), where these screens say they need the
  sign-in service. They appear once the build points at Kratos through the gateway.

## Alternatives considered

- **Opening the web for these flows in an in-app browser:** less code, but sign-up and recovery would leave the app,
  and the browser's session wouldn't reach the app's token.
- **Changing `whoami`'s `required_aal` to `highest_available`:** would also make `whoami` refuse one-factor sessions
  for people with a second factor everywhere, including the API's session check, which handles AAL per workspace on
  purpose (ADR-0044).
