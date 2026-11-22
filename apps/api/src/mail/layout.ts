/**
 * The one look for every email Montra sends (AUTH-05, Phase 11): a plain card on the app's paper colour, the brand
 * name at the top, the message, and a footer that says why the person got it. Each email has an HTML part and a plain
 * text part saying the same thing.
 *
 * Rules (see docs/runbooks/email.md): no images, no tracking, no remote fonts or CSS, styles inline (mail clients drop
 * `<style>`), every interpolated value escaped, and every link written out in the text part.
 */

/** A run of text inside a paragraph: plain, bold, or a link. */
export type Inline = string | { strong: string } | { link: string; href: string };

export type Block =
  | { p: Inline[] }
  /** The main thing to do: a button in HTML, `Label: url` in text. */
  | { action: string; href: string }
  /** A one-time code, large and spaced. */
  | { code: string }
  /** Label and value pairs, such as an invoice's total and due date. */
  | { facts: [string, string][] }
  /** Someone else's words, such as the note on an invoice: kept as written, set apart. */
  | { quote: string };

export interface EmailContent {
  subject: string;
  /** The name at the top. Montra unless the email is sent for someone else (a business's invoice). */
  brand?: string;
  /** Shown by some mail clients next to the subject in the inbox. */
  preview?: string;
  blocks: Block[];
  /** Why they got this email, and what they can do about it. */
  footer: Inline[];
}

/** Paragraph from parts. */
export const p = (...parts: Inline[]): Block => ({ p: parts });
export const strong = (s: string): Inline => ({ strong: s });
export const link = (label: string, href: string): Inline => ({ link: label, href });

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// The web app's light palette (apps/web/app/globals.css).
const C = {
  page: '#faf8f4',
  card: '#ffffff',
  border: '#e6e0d6',
  ink: '#1c1a17',
  muted: '#5e574e',
  accent: '#1f5d4c',
  onAccent: '#ffffff',
  soft: '#f2f6f3',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

const inlineHtml = (parts: Inline[], color = C.accent) =>
  parts
    .map((x) =>
      typeof x === 'string'
        ? escapeHtml(x)
        : 'strong' in x
          ? `<strong>${escapeHtml(x.strong)}</strong>`
          : `<a href="${escapeHtml(x.href)}" style="color:${color};text-decoration:underline">${escapeHtml(x.link)}</a>`,
    )
    .join('');

const inlineText = (parts: Inline[]) =>
  parts
    .map((x) =>
      typeof x === 'string'
        ? x
        : 'strong' in x
          ? x.strong
          : x.link === x.href
            ? x.href
            : `${x.link} (${x.href})`,
    )
    .join('');

const PARA = `margin:0 0 16px;font-size:15px;line-height:1.55;color:${C.ink}`;

function blockHtml(b: Block): string {
  if ('p' in b) return `<p style="${PARA}">${inlineHtml(b.p)}</p>`;
  if ('action' in b) {
    return (
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr>` +
      `<td style="border-radius:6px;background:${C.accent}">` +
      `<a href="${escapeHtml(b.href)}" style="display:inline-block;padding:11px 20px;font-family:${FONT};font-size:15px;font-weight:600;color:${C.onAccent};text-decoration:none;border-radius:6px">${escapeHtml(b.action)}</a>` +
      `</td></tr></table>` +
      `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${C.muted}">Or open this link: ` +
      `<a href="${escapeHtml(b.href)}" style="color:${C.accent};word-break:break-all">${escapeHtml(b.href)}</a></p>`
    );
  }
  if ('code' in b) {
    return `<p style="margin:0 0 16px;padding:14px 16px;background:${C.soft};border-radius:6px;font-family:${MONO};font-size:26px;font-weight:700;letter-spacing:4px;color:${C.ink};text-align:center">${escapeHtml(b.code)}</p>`;
  }
  if ('facts' in b) {
    const rows = b.facts
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 16px 4px 0;font-size:14px;color:${C.muted};white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>` +
          `<td style="padding:4px 0;font-size:14px;color:${C.ink}">${escapeHtml(v)}</td></tr>`,
      )
      .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${rows}</table>`;
  }
  return `<p style="margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid ${C.border};font-size:15px;line-height:1.55;color:${C.ink};white-space:pre-wrap">${escapeHtml(b.quote)}</p>`;
}

function blockText(b: Block): string {
  if ('p' in b) return inlineText(b.p);
  if ('action' in b) return `${b.action}: ${b.href}`;
  if ('code' in b) return `    ${b.code}`;
  if ('facts' in b) return b.facts.map(([k, v]) => `${k}: ${v}`).join('\n');
  return b.quote
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

export function renderHtml(c: EmailContent): string {
  const brand = c.brand ?? 'Montra';
  const preview = c.preview
    ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(c.preview)}</div>`
    : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${escapeHtml(c.subject)}</title>`,
    '</head>',
    `<body style="margin:0;padding:0;background:${C.page};font-family:${FONT}">`,
    preview,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:28px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">`,
    `<tr><td style="padding:0 4px 14px;font-family:${FONT};font-size:18px;font-weight:700;color:${C.accent}">${escapeHtml(brand)}</td></tr>`,
    `<tr><td style="padding:28px 28px 12px;background:${C.card};border:1px solid ${C.border};border-radius:10px;font-family:${FONT}">`,
    ...c.blocks.map(blockHtml),
    '</td></tr>',
    `<tr><td style="padding:16px 4px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted}">${inlineHtml(c.footer, C.muted)}</td></tr>`,
    '</table>',
    '</td></tr></table>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function renderText(c: EmailContent): string {
  // "-- " is the signature separator: mail clients set what follows apart.
  return `${c.blocks.map(blockText).join('\n\n')}\n\n-- \n${inlineText(c.footer)}\n`;
}

/**
 * A moment, in the person's time zone when known: "Nov 21, 2026, 2:27 PM PST". An unknown zone falls back to UTC
 * rather than failing the email.
 */
export function when(at: Date, timeZone?: string | null): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: tz,
    }).format(at) +
    ' ' +
    (new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(at)
      .find((x) => x.type === 'timeZoneName')?.value ?? tz);
  try {
    return format(timeZone || 'UTC');
  } catch {
    return format('UTC');
  }
}

/** A calendar day without a time: "Dec 21, 2026". Takes `YYYY-MM-DD`, read as that day wherever the person is. */
export function day(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${isoDate.slice(0, 10)}T00:00:00Z`),
  );
}
