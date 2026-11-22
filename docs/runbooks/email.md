# Email: templates and changes

Montra's email comes from two senders, and both use one layout:

- **The API** sends account and security alerts, invites, invoices, notifications, plan notices and staff notices,
  through `MAIL_URL` (`apps/api/src/mail/mail.service.ts`).
- **Kratos** sends the recovery and email-confirmation codes through its own courier, from the Go templates in
  `infra/kratos/templates`.

| File                                    | What                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/api/src/mail/layout.ts`           | The look: the card, the button, the code box, the footer, and the text part   |
| `apps/api/src/mail/templates.ts`        | Every email the API sends: subject, wording, footer and category              |
| `apps/api/src/mail/kratos-templates.ts` | Kratos's four emails in the same layout; writes `infra/kratos/templates`      |
| `apps/api/test/mail-templates.test.ts`  | Escaping, links in the text part, times, and the Kratos files being current   |

## Rules

- Every email has an HTML part and a text part saying the same thing, with every link written out in the text.
- No images, tracking pixels, remote fonts or stylesheets. Styles are inline, since mail clients drop `<style>`.
- Every value put into an email is escaped (the layout does it). Don't build HTML by hand at a call site.
- The footer says why the person got the email. Notification emails also link to turning them off, and carry the
  one-click `List-Unsubscribe` header (OPS-10).
- Times are in the person's own time zone when the sender knows who they are (`timeZoneOf` in
  `apps/api/src/mail/time-zone.ts`), else UTC, and always name the zone.
- A message sent without a template still goes out in the layout: `SmtpMail` wraps its text paragraphs.

## Changing an email

1. Edit `templates.ts` (or `layout.ts` for the look). Keep the subject unless you mean to change it: tests find
   emails by subject.
2. For Kratos's emails, edit `kratos-templates.ts`, then write the files:

   ```bash
   pnpm --filter @montra/api kratos:templates
   ```

3. Run `apps/api/test/mail-templates.test.ts` and the tests of the feature that sends it.
4. After any Kratos template change, send real ones through Mailpit with Kratos running:

   ```bash
   docker compose -f infra/docker-compose.yml --profile auth up -d --build kratos
   MAILPIT_URL=http://localhost:8025 node scripts/kratos-smoke.mjs
   ```

   Use your Mailpit's port. A broken Kratos template answers differently for known and unknown addresses, which leaks
   whether an account exists, so this check matters.

To look at the HTML, render a template with `tsx` and open the file in a browser, or send it to Mailpit (`MAIL_MODE=smtp`,
`MAIL_URL=smtp://localhost:1025`) and open the Mailpit UI.
