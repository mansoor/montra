import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { CONFIG, type AppConfig } from '../config.js';
import { ServiceSettings } from '../ops/service-settings.js';
import { p, renderHtml } from './layout.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** OPS-10: `notification` is the non-essential stream, and can be unsubscribed from. The rest are transactional. */
  category: 'security' | 'sharing' | 'invoice' | 'transactional' | 'notification';
  headers?: Record<string, string>;
  replyTo?: string;
  attachments?: { filename: string; content: Uint8Array; contentType: string }[];
}

/** Outgoing email port. Phase 10 routes these through the notification queue (retries, preferences). */
export interface MailPort {
  send(message: MailMessage): Promise<void>;
}
export const MAIL_PORT = Symbol('MAIL_PORT');

/** Development: write the message to the log instead of sending it. */
@Injectable()
export class LogMail implements MailPort {
  private readonly logger = new Logger('Mail');
  async send(m: MailMessage): Promise<void> {
    this.logger.log(`[${m.category}] to=${m.to} subject="${m.subject}"\n${m.text}`);
  }
}

/** Tests: keep messages in memory. */
@Injectable()
export class MemoryMail implements MailPort {
  readonly outbox: MailMessage[] = [];
  async send(m: MailMessage): Promise<void> {
    this.outbox.push(m);
  }
}

@Injectable()
export class SmtpMail implements MailPort {
  private readonly transport: Transporter;
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(ServiceSettings) private readonly settings?: ServiceSettings,
  ) {
    this.transport = nodemailer.createTransport(config.MAIL_URL!);
  }
  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail({
      // ADR-0049 §5: the sender owners set in the console, else MAIL_FROM.
      from: (await this.settings?.mailFrom().catch(() => null)) ?? this.config.MAIL_FROM,
      to: m.to,
      subject: m.subject,
      text: m.text,
      // A message built without a template still goes out in the shared layout.
      html: m.html ?? htmlFromText(m),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.attachments
        ? {
            attachments: m.attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.content),
              contentType: a.contentType,
            })),
          }
        : {}),
      headers: {
        'X-Montra-Category': m.category,
        'X-Montra-Stream': m.category === 'notification' ? 'notification' : 'transactional',
        ...m.headers,
      },
    });
  }
}

/** The text part's paragraphs in the layout, for a message that has no HTML of its own. */
export function htmlFromText(m: Pick<MailMessage, 'subject' | 'text'>): string {
  return renderHtml({
    subject: m.subject,
    blocks: m.text
      .trim()
      .split(/\n{2,}/)
      .map((para) => p(para)),
    footer: ['You’re getting this because of your Montra account.'],
  });
}

export const mailProvider = (config: AppConfig) => ({
  provide: MAIL_PORT,
  useClass: config.MAIL_MODE === 'smtp' ? SmtpMail : config.MAIL_MODE === 'memory' ? MemoryMail : LogMail,
});

// Every email's wording and layout: `templates.ts` and `layout.ts`.
export { templates } from './templates.js';
