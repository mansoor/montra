import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kratosTemplateFiles } from '../src/mail/kratos-templates.js';
import { day, renderHtml, renderText, when } from '../src/mail/layout.js';
import { htmlFromText } from '../src/mail/mail.service.js';
import { templates } from '../src/mail/templates.js';

const at = new Date('2026-11-21T22:27:00Z');
const url = 'https://app.example.test/settings/security';

/** One of every email, with a value in each field that would break HTML if it weren't escaped. */
const evil = '<b>"Tom & Jerry\'s"</b>';
const every = [
  templates.invite({ to: 'a@example.test', inviter: evil, workspace: evil, role: 'member', url }),
  templates.newDevice({ to: 'a@example.test', userAgent: evil, ip: '203.0.113.9', at, url }),
  templates.passwordChanged({ to: 'a@example.test', at, url }),
  templates.phoneChanged({ to: 'a@example.test', at, url, now: '+14155550178' }),
  templates.twoStepChanged({ to: 'a@example.test', at, url }),
  templates.signInLocked({ to: 'a@example.test', ip: null, until: at, url }),
  templates.emailChangeOld({ to: 'a@example.test', newEmail: evil, code: '123456' }),
  templates.emailChangeNew({ to: 'b@example.test', code: '654321' }),
  templates.emailChanged({ to: 'a@example.test', newEmail: evil }),
  templates.mfaResetRequested({ to: 'a@example.test', eligibleAt: at, url }),
  templates.mfaResetCompleted({ to: 'a@example.test', url }),
  templates.accountSuspended({ to: 'a@example.test', support: 'help@example.test' }),
  templates.accountRestored({ to: 'a@example.test', url }),
  templates.accountClosing({
    to: 'a@example.test',
    purgeAfter: '2026-12-21',
    support: 'help@example.test',
    url,
  }),
  templates.planChanging({ to: 'a@example.test', plan: 'Plus', workspace: evil, date: '2026-12-21', url }),
  templates.notification({
    to: 'a@example.test',
    title: 'Water is due',
    body: evil,
    url,
    requested: false,
    unsubscribeUrl: `${url}?token=t`,
    oneClickUrl: `${url}?one=t`,
  }),
  templates.invoice({
    to: 'a@example.test',
    from: evil,
    number: 'INV-7',
    total: '$213.38',
    due: '2026-12-21',
    note: evil,
    replyTo: 'biz@example.test',
    pdf: new Uint8Array([1]),
  }),
  templates.staffNotice({ to: 'a@example.test', subject: 'Montra staff: x', paragraphs: [evil], url }),
  templates.aiCeilingReached({ to: 'a@example.test', ceiling: '$50.00', month: '2026-11', url }),
  templates.supportRequest({ to: 'a@example.test', kind: 'bug', id: 'r1', from: evil, url }),
  templates.providerTest({ to: 'a@example.test', sender: evil }),
];

describe('email templates (AUTH-05)', () => {
  it('give every email both parts, escaped, with no images or remote resources', () => {
    for (const m of every) {
      expect(m.text.length, m.subject).toBeGreaterThan(20);
      expect(m.html, m.subject).toMatch(/^<!doctype html>/);
      expect(m.html, m.subject).not.toContain(evil);
      expect(m.html, m.subject).not.toMatch(
        /<img|<link|<script|<style|url\(|https?:\/\/(?!app\.example\.test)/i,
      );
      // The footer says why it came, after the signature separator.
      expect(m.text, m.subject).toMatch(/\n-- \n.+/);
    }
  });

  it('writes every link out in the text part', () => {
    for (const m of every) {
      for (const [, href] of m.html!.matchAll(/href="([^"]+)"/g)) {
        const raw = href!.replace(/&amp;/g, '&');
        if (raw.startsWith('mailto:')) expect(m.text).toContain(raw.slice(7));
        else expect(m.text, m.subject).toContain(raw);
      }
    }
  });

  it('keeps what other code relies on: codes alone, unsubscribe headers, the invoice reply-to and PDF', () => {
    const change = every.find((m) => m.subject === 'Confirm your Montra email change')!;
    // The test helpers read the first six-digit number in the text.
    expect(/\b(\d{6})\b/.exec(change.text)![1]).toBe('123456');
    const note = every.find((m) => m.subject === 'Water is due')!;
    expect(note.category).toBe('notification');
    expect(note.headers).toEqual({
      'List-Unsubscribe': `<${url}?one=t>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(note.text).toContain('Turn them off');
    const asked = templates.notification({
      to: 'a@example.test',
      title: 'Your backup is ready',
      body: 'Done.',
      url,
      requested: true,
      unsubscribeUrl: `${url}?token=t`,
      oneClickUrl: `${url}?one=t`,
    });
    expect(asked).toMatchObject({ category: 'transactional' });
    expect(asked.headers).toBeUndefined();
    const invoice = every.find((m) => m.category === 'invoice')!;
    expect(invoice).toMatchObject({ replyTo: 'biz@example.test' });
    expect(invoice.attachments).toHaveLength(1);
    // Sent for the business: its name at the top, not Montra's.
    expect(invoice.html).toContain('&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;</td>');
  });

  it('says times in the person’s zone, and falls back to UTC', () => {
    expect(when(at, 'America/Los_Angeles')).toBe('Nov 21, 2026, 2:27 PM PST');
    expect(when(at, null)).toBe('Nov 21, 2026, 10:27 PM UTC');
    expect(when(at, 'Not/AZone')).toBe('Nov 21, 2026, 10:27 PM UTC');
    expect(day('2026-12-21')).toBe('Dec 21, 2026');
    const m = templates.passwordChanged({ to: 'a@example.test', at, url, timeZone: 'Asia/Karachi' });
    expect(m.text).toContain('Nov 22, 2026, 3:27 AM GMT+5');
  });

  it('wraps a message built without a template in the same layout', () => {
    const html = htmlFromText({ subject: 'Hi', text: 'One <two>.\n\nThree.' });
    expect(html).toContain('One &lt;two&gt;.</p>');
    expect(html).toContain('Three.</p>');
  });

  it('render the same content the same way each time', () => {
    const c = { subject: 's', blocks: [{ code: '1' }], footer: ['f'] };
    expect(renderHtml(c)).toBe(renderHtml(c));
    expect(renderText(c)).toBe('    1\n\n-- \nf\n');
  });

  it('match the committed Kratos templates (run `pnpm --filter @montra/api kratos:templates` after a change)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/kratos/templates');
    const files = kratosTemplateFiles();
    expect(Object.keys(files)).toHaveLength(12);
    for (const [path, content] of Object.entries(files)) {
      expect(readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n'), path).toBe(content);
    }
    // Kratos fills these in; the layout must leave them as they are.
    expect(files['recovery_code/valid/email.body.gotmpl']).toContain('{{ .RecoveryCode }}');
    expect(files['verification_code/valid/email.body.gotmpl']).toContain('href="{{ .VerificationURL }}"');
    expect(files['verification_code/valid/email.body.plaintext.gotmpl']).toContain('{{ .VerificationURL }}');
  });
});
