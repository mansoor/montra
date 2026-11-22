# ADR-0056: A Turnstile CAPTCHA after repeated failures, in the auth gateway

- Status: accepted
- Date: 2026-11-21
- Builds on: ADR-0042 (the auth gateway), whose counters it reads

## Context

AUTH-08 asks for "CAPTCHA after repeated failures". ADR-0042 built everything else: every browser and phone request to
Kratos goes through the auth gateway, which counts wrong passwords per email and per address, delays after 5 and pauses
after 10. Its Consequences left the CAPTCHA for later: "a CAPTCHA instead of a pause would need a provider, and can be
added in front later".

The owner chose on 2026-11-21: **Cloudflare Turnstile, off by default**. The app already sits behind Cloudflare in
production. Turnstile is free and usually passes people without a puzzle to solve. A LAN
or self-hosted install has no Cloudflare account and may have no internet path for its users, so it must work exactly as
before unless someone turns this on.

## Decision

**The gateway asks a browser for a Turnstile token once the failures it already counts reach a threshold. The web app
shows the widget only when asked.** Everything is configured, nothing is hard-coded:

| Setting                          | Where                    | Default | Meaning                                                                                               |
| -------------------------------- | ------------------------ | ------- | ----------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY`           | auth gateway only        | unset   | Turnstile's secret. Unset: no CAPTCHA, exactly the behaviour before this ADR. Never logged.           |
| `CAPTCHA_AFTER_FAILURES`         | auth gateway             | 5       | Failed passwords for one email, or from one address (ADR-0042's `account` and `address` counters)     |
| `CAPTCHA_AFTER_SIGNUPS`          | auth gateway             | 5       | Sign-up submissions from one address in the hour (ADR-0042's `sign_up` counter)                       |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | web, at build time       | unset   | Turnstile's site key, compiled in like `NEXT_PUBLIC_KRATOS_URL`. Also opens the CSP for Turnstile     |

1. **When it's asked for.** A browser (form-encoded, not JSON) password sign-in is challenged when the email's or the
   address's live failure count has reached `CAPTCHA_AFTER_FAILURES`. A browser sign-up submission is challenged when
   the address's sign-up count has reached `CAPTCHA_AFTER_SIGNUPS`. These are the same counters, windows and HMAC keys
   as the delay (ADR-0042); no new table or migration.
2. **How it's checked.** The form posts the widget's `cf-turnstile-response` field. The gateway posts the secret, the
   token and the client's address to `https://challenges.cloudflare.com/turnstile/v0/siteverify`, with a 5-second
   timeout. A token that passes is stripped from the body before the submission is forwarded, so Kratos never sees it.
3. **When it fails.** A missing or refused token is not forwarded and **counts nothing**: the browser goes back to its
   form with `notice=captcha_required` (and `flow`), the same way `too_many_attempts` works. A siteverify that can't be
   reached, times out, answers with an HTTP error or with `internal-error` or a secret error, also refuses, and is
   logged as a warning: sign-in stops rather than going unprotected, the same rule as ADR-0042's for Postgres.
4. **Asking ahead.** When a browser submission that Kratos sends back to the same flow's form leaves the counters at
   the threshold (the fifth wrong password, or a sign-up's profile step), the gateway adds `notice=captcha_required` to
   Kratos's redirect. The page then shows the widget at once, instead of the next try bouncing first.
5. **The web app.** With `notice=captcha_required` and a site key, the sign-in and sign-up pages say so and render the
   widget inside the form, just before the password (or profile) submit button, so its hidden input is posted with the
   form. The script, `https://challenges.cloudflare.com/turnstile/v0/api.js`, is loaded by the widget component only
   then (explicit rendering). Without a site key the page says an extra check is needed that this install can't show,
   and that waiting or resetting the password works. The gateway only asks when it has a secret, so this happens only
   when the two halves are configured differently.
6. **CSP.** `apps/web/lib/csp.mjs` adds `https://challenges.cloudflare.com` to `script-src` and adds
   `frame-src 'self' https://challenges.cloudflare.com` only when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set at build time.
   Without it the policy is unchanged.
7. **The pause still applies.** It is checked first: an email or address past ADR-0042's limit is paused whether or not
   the CAPTCHA would pass. A good token doesn't skip the delay either.
8. **Development and tests.** Cloudflare publishes test site keys and secret keys that always pass or always fail
   (see the runbook). They are for local development and the docs only; the tests never call siteverify, Cloudflare or
   any real service: the siteverify call is injectable (`turnstileVerifier({ post })`) and the gateway takes any
   verifier (`captcha.verify`).

## Consequences

- **The phone (JSON flows) is never asked for a CAPTCHA.** The Expo app signs in through Kratos's native API flows,
  which have no page to show a widget in, so they keep only ADR-0042's delay and pause. The same holds for any client
  that sends JSON, so **a scripted attacker who uses the API flows is not slowed by the CAPTCHA at all**; for them, the
  per-email pause after 10 and the per-address pause after 30 remain the limit, as before. The CAPTCHA raises the cost
  of guessing through the browser forms and of mass sign-ups from a browser, and gives a person who mistyped a few
  times a way to keep trying without being treated as an attacker. Closing the gap would need an attestation on the
  phone (App Attest, Play Integrity) or Turnstile in a web view; neither is planned.
- **Sign-ups are counted per submission.** A two-step sign-up (profile, then credentials) counts twice towards
  `CAPTCHA_AFTER_SIGNUPS`, as it already did towards ADR-0042's limit of 20.
- **An office behind one address** gets the CAPTCHA after 5 wrong passwords from anyone there in 15 minutes, well
  before the address's delay (15). It's a check, not a pause, so that's acceptable; raise `CAPTCHA_AFTER_FAILURES` if not.
- **Cloudflare sees the client's address and the token** for the attempts that are challenged, and the widget runs
  Cloudflare's script in the page. Nothing is sent when it's off, or below the threshold.
- **A Cloudflare outage stops challenged sign-ins** (point 3) until the window passes or a password reset is used.
  Unchallenged ones are unaffected.
- **Without JavaScript**, a challenged browser can't produce a token and keeps coming back to the form until the window
  passes.
- **Not wired into deployment yet.** The settings are read by the gateway and the web build (`apps/web/Dockerfile` takes
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` as a build argument). The Terraform module, the self-host Compose file and the deploy
  workflow don't pass them, so turning it on in production needs that wiring first (runbook). The hostname a token was
  issued for isn't checked against the web app's.

## Alternatives considered

- **hCaptcha or reCAPTCHA:** both work the same way, but each adds another company to the sign-in page, while
  production already runs behind Cloudflare.
- **A self-hosted proof-of-work challenge (such as ALTCHA):** no third party and works on the LAN, but only slows a
  script down rather than telling a person from one, and needs its own code to maintain. It may suit self-hosted installs
  later.
- **The CAPTCHA in Cloudflare's WAF (a managed challenge on the sign-in paths):** needs no code, but it can't see
  failures, only request rates, so it challenges people who never failed, and it doesn't exist off Cloudflare.
- **A CAPTCHA instead of the pause:** would stop someone from pausing another person's sign-in (ADR-0042), but would
  leave JSON flows with no stop at all. The pause stays.
- **An amendment to ADR-0042:** this adds a provider, settings and a client-side widget, and has its own trade-offs (the
  phone gap), so it gets its own record, as the password policy did (ADR-0043).
