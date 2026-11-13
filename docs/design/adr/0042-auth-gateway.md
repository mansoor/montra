# ADR-0042: An auth gateway in front of Kratos

- Status: accepted
- Date: 2026-11-13

## Context

AUTH-08 asks for rate limits, progressive delays after 5 failed attempts and a challenge after repeated failures.
Montra self-hosts Ory Kratos (ADR-0006, ADR-0021), and self-hosted Kratos has no limits of its own: it answers every
password, authenticator code and emailed code it is sent. The Cloudflare rule in Terraform (never applied) challenges
an address after many requests to the sign-in paths, which helps against one noisy address but not against guessing
spread over many addresses, and it doesn't exist at all on a self-hosted install or on the LAN.

The app holds personal finances, business books and payroll, so a guessed password is the costliest failure it has.

Kratos's hooks don't help: its login hooks run before a flow starts or after a success, never after a failure.

## Decision

**Every request from a browser or the phone reaches Kratos through a small gateway**, `apps/api/src/auth-gateway`,
run as its own process from the API image (`node dist/auth-gateway-main.js`, port 4455). Kratos's public port is on
the private network only. Kratos's `serve.public.base_url` is the gateway's address, so the form actions and redirects
in every flow point back at the gateway.

The gateway passes everything through unchanged. For the submissions that can be guessed at, it counts:

| What                                             | Key                         | Pause after         | Delay starts after |
| ------------------------------------------------ | --------------------------- | ------------------- | ------------------ |
| Wrong password for one email                     | the email typed             | 10 in 15 min, 15 min | 5                  |
| Wrong passwords from one address, any email      | the client address          | 30 in 15 min, 15 min | 15                 |
| Wrong authenticator or recovery code             | the session                 | 5 in 15 min, 15 min  | 3                  |
| Wrong emailed code (recovery, verification)      | the address, and the flow   | 10 in 15 min, 15 min | 5                  |
| Recovery or verification emails asked for        | the address                 | 10 an hour           | 10                 |
| Sign-ups                                         | the address                 | 20 an hour           | 20                 |

- **Delay:** past the free attempts, each attempt waits 1 s, doubling to 8 s, before it reaches Kratos.
- **Pause:** a paused attempt never reaches Kratos. A browser goes back to its form with `notice=too_many_attempts` and
  the seconds left, and the page says so. The phone gets HTTP 429 and the flow with a Kratos-style error message
  (id 4290001), which its sign-in screen already shows.
- **Success** clears that email's or session's count. An address's count is left alone, since it may be trying many
  accounts.
- **The owner is told.** When an email is paused, the account with that email (if there is one) gets a
  `sign_in_locked` entry in its security activity and an email saying sign-in is paused and that a password reset
  still works. Whether the email has an account is never shown in a response.
- **Outcomes** are read from Kratos's answers: for JSON, 200 is a success and 400/401/403 a failure. For a browser,
  a session cookie is a success; a redirect back to the same flow is a failure when the flow now carries an error
  message, and a success when an emailed code moved it to `passed_challenge`.
- **Counters live in Postgres** (`app.auth_throttle`, migration 0043), so every gateway instance agrees, under a row
  lock so concurrent attempts can't slip past the limit together. Keys are HMACs under `AUTH_GATEWAY_SECRET`, so the
  table holds no email address, IP address or session token. Rows are pruned after three hours.
- **What the gateway is given:** the database URL, the mail URL and its HMAC key. It has no data key and no staff
  connection (`loadConfig(env, { process: 'auth-gateway' })`).
- **Locally**, run it with `pnpm --filter @montra/api dev:auth-gateway`; `NEXT_PUBLIC_KRATOS_URL` and the phone's
  `MONTRA_KRATOS_URL` are `http://localhost:4455`. Dev sign-in (`AUTH_MODE=dev`) doesn't use it.

The next step puts the password policy here too: the gateway is the one place that sees a new password before Kratos
stores it, so it can enforce a strength score and the minimum length the admin console sets.

## Consequences

- Guessing is slowed after a few tries and stopped after ten per account, from any number of addresses, without
  relying on Cloudflare. NIST SP 800-63B asks for no more than 100 consecutive failures; this is far stricter.
- **Someone can pause another person's password sign-in** by typing their email wrongly ten times. The pause lasts
  15 minutes, passkeys and a password reset still work, and the owner is emailed. That trade is the usual one for an
  account-level limit; a CAPTCHA instead of a pause would need a provider, and can be added in front later.
- Production has one more service (`auth-gateway`, Terraform `modules/compute`) and one more secret
  (`AUTH_GATEWAY_SECRET`). The load balancer's auth hostname points at the gateway; Kratos no longer has a target
  group.
- Every request to Kratos takes one more hop. Submissions that are counted also read and write one row; a browser
  submission that comes back to its form reads the flow once more to see how it went.
- A gateway that can't reach Kratos answers 502; one that can't reach Postgres fails the counted submissions, so
  sign-in stops rather than going unprotected.

## Alternatives considered

- **Cloudflare rate limiting alone:** limits per address only, needs a paid plan to count failures, and doesn't exist
  for self-hosted or LAN installs.
- **Ory Oathkeeper or a generic proxy (nginx, Envoy):** they limit requests per address, but can't tell a wrong
  password from a right one or count per account without custom code, which then lives outside the codebase and its
  tests.
- **The gateway inside the API process,** routed by hostname: no new service, but the API's blue/green deployments
  and scaling would carry sign-in traffic, and a fault in either would take down both.
- **Redis for the counters:** faster, but one more thing to run in production and on the LAN for a few writes per
  sign-in attempt.
