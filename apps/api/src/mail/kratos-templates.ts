/**
 * Kratos's own emails (the recovery and confirmation codes, AUTH-05) in the same layout as the API's. Kratos reads Go
 * templates from `infra/kratos/templates`; this writes them, so the look and the wording live in one place:
 *
 *   pnpm --filter @montra/api kratos:templates
 *
 * A test fails when the committed files differ from what this writes. `{{ .RecoveryCode }}` and the like pass through
 * the layout untouched and Kratos fills them in (Go's html/template escapes them in the HTML part).
 *
 * After changing these, send a real recovery and confirmation through Mailpit: `node scripts/kratos-smoke.mjs`.
 * A broken template answers differently for known and unknown addresses, which leaks whether an account exists.
 */
import { p, renderHtml, renderText, type EmailContent } from './layout.js';
import { FOOTERS } from './templates.js';

const UNKNOWN_FOOTER = ['You’re getting this because someone entered this email address on Montra.'];

/** Kratos's directory names: `<flow>_<method>/<valid|invalid>`. */
export const KRATOS_EMAILS: Record<string, EmailContent> = {
  'recovery_code/valid': {
    subject: 'Your Montra account recovery code',
    preview: 'Your code works once and expires in 30 minutes.',
    blocks: [
      p('Someone asked to recover the Montra account for this email address. Your recovery code:'),
      { code: '{{ .RecoveryCode }}' },
      // The code's lifetime is selfservice.methods.code.config.lifespan in kratos.yml. Change both together.
      p('Enter it on the page where you asked for it. It works once and expires in 30 minutes.'),
      p(
        'After you recover your account, you’ll still need your second factor if you have one set up, and every other session will be signed out.',
      ),
      p(
        'If this wasn’t you, ignore this email. Your password hasn’t changed. Montra staff will never ask for this code.',
      ),
    ],
    footer: FOOTERS.security,
  },
  // Sent only when notify_unknown_recipients is on for recovery, which it isn't (kratos.yml): see the README.
  'recovery_code/invalid': {
    subject: 'Montra account recovery',
    blocks: [
      p(
        'Someone asked to recover a Montra account using this email address, but we can’t complete that request from this address.',
      ),
      p(
        'If this was you, try the address you signed up with. If it wasn’t you, ignore this email. Nothing has changed.',
      ),
    ],
    footer: UNKNOWN_FOOTER,
  },
  'verification_code/valid': {
    subject: 'Confirm your email for Montra',
    preview: 'Your code works once and expires in 30 minutes.',
    blocks: [
      p('Please confirm this email address for your Montra account. Your confirmation code:'),
      { code: '{{ .VerificationCode }}' },
      { action: 'Confirm your email', href: '{{ .VerificationURL }}' },
      p('The code works once and expires in 30 minutes.'),
      p('If you didn’t create a Montra account, ignore this email.'),
    ],
    footer: FOOTERS.account,
  },
  'verification_code/invalid': {
    subject: 'Montra email confirmation',
    blocks: [
      p(
        'Someone asked to confirm this email address for a Montra account, but we can’t complete that request from this address.',
      ),
      p(
        'If this was you, try the address you signed up with. If it wasn’t you, ignore this email. Nothing has changed.',
      ),
    ],
    footer: UNKNOWN_FOOTER,
  },
};

/** Every template file, by its path under `infra/kratos/templates`. */
export function kratosTemplateFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [dir, content] of Object.entries(KRATOS_EMAILS)) {
    files[`${dir}/email.subject.gotmpl`] = `${content.subject}\n`;
    files[`${dir}/email.body.gotmpl`] = renderHtml(content);
    files[`${dir}/email.body.plaintext.gotmpl`] = renderText(content);
  }
  return files;
}
