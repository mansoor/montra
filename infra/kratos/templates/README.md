# Kratos email templates

Kratos reads these through `courier.template_override_path` in `../kratos.yml`. The directory names are fixed by
Kratos: `<flow>_<method>/<valid|invalid>/email.{subject,body,body.plaintext}.gotmpl`. Montra uses the `code` method
for both flows, so only `recovery_code` and `verification_code` are here.

**The email files are generated: don't edit them by hand.** They're written from
`apps/api/src/mail/kratos-templates.ts`, in the same layout as the API's own emails
([`docs/runbooks/email.md`](../../../docs/runbooks/email.md)):

```bash
pnpm --filter @montra/api kratos:templates
```

A test in `apps/api/test/mail-templates.test.ts` fails when these files differ from what it writes. The texts
(`*/sms.body.gotmpl`) aren't generated.

- `valid`: the address belongs to an account.
- `invalid`: the address does not. Kratos sends these only when `notify_unknown_recipients` is true for that flow. It
  is false for recovery in `kratos.yml`, so an unknown address gets no email and the page shows the same response
  either way (AUTH-05). They exist so turning the setting on can't fall back to Kratos' default wording.

The emails state "30 minutes" as plain text, because Kratos v1.3.1 didn't pass the code's lifetime to templates. v26.2.0
has `.ExpiresInMinutes`, but nothing here uses it yet. If `selfservice.methods.code.config.lifespan` changes, change the
emails too (in `kratos-templates.ts`). The generator keeps the HTML and plaintext bodies in step, with no tracking
links or images.

A broken template also answers differently for known and unknown addresses, which leaks whether an account exists. After
any change here, send a real recovery and verification email through Mailpit: `node scripts/kratos-smoke.mjs` does it.

## Texts (ADR-0049 §6)

`login_code/valid/sms.body.gotmpl` is the texted second factor. They're plain text with no links, and they say
"30 minutes" like the emails do.

`verification_code/valid/sms.body.gotmpl` isn't sent any more. Kratos v26.2.0 texts it when a number is saved in a
settings flow but never names the verification flow it belongs to, so the code can't be entered. The API confirms a
number with its own code instead and puts it on the identity already verified, through the admin API (ADR-0049 §6),
and the auth gateway turns away a settings save that would change the number. The template stays for a Kratos that
names the flow.

Texting is off unless the deployment sets two environment variables on Kratos:

- `COURIER_CHANNELS`: the JSON in `../sms-channel.example.json`, with the Twilio account id, the auth token, and in
  the base64 body (`../sms-body.jsonnet`) the Messaging Service id. The token is a secret: it comes from the secret
  store, like `COURIER_SMTP_CONNECTION_URI`.
- `SELFSERVICE_METHODS_CODE_MFA_ENABLED=true`: offers a texted code as a second factor to a verified number.

Recovery stays by email: Kratos v26.2.0's recovery form takes only an email address. Email isn't a `code` identifier
in the identity schema, so turning the second factor on never offers an emailed code as a second factor.

This was run against Kratos v26.2.0 with the channel pointed at a stand-in for Twilio: saving a number texted a
verification code (which can't be entered, as above), and the aal2 login texted a sign-in code, both as Twilio's form
(`To`, `Body`, `MessagingServiceSid`, basic auth).
