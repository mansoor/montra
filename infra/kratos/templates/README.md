# Kratos email templates

Kratos reads these through `courier.template_override_path` in `../kratos.yml`. The directory names are fixed by
Kratos: `<flow>_<method>/<valid|invalid>/email.{subject,body,body.plaintext}.gotmpl`. Montra uses the `code` method
for both flows, so only `recovery_code` and `verification_code` are here.

- `valid`: the address belongs to an account.
- `invalid`: the address does not. Kratos sends these only when `notify_unknown_recipients` is true for that flow. It
  is false for recovery in `kratos.yml`, so an unknown address gets no email and the page shows the same response
  either way (AUTH-05). They exist so turning the setting on can't fall back to Kratos' default wording.

The emails state "30 minutes" as plain text, because Kratos v1.3.1 didn't pass the code's lifetime to templates. v26.2.0
has `.ExpiresInMinutes`, but nothing here uses it yet. If `selfservice.methods.code.config.lifespan` changes, change the
emails too. Keep the HTML and plaintext bodies in step,
and don't add tracking links or images.

A broken template also answers differently for known and unknown addresses, which leaks whether an account exists. After
any change here, send a real recovery and verification email through Mailpit: `node scripts/kratos-smoke.mjs` does it.
