import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { CONFIG, type AppConfig } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Transactional vs marketing streams are separated (OPS-10); everything here is transactional. */
  category: 'security' | 'sharing';
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
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.transport = nodemailer.createTransport(config.MAIL_URL!);
  }
  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.MAIL_FROM,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.html ? { html: m.html } : {}),
      headers: { 'X-Montra-Category': m.category },
    });
  }
}

export const mailProvider = (config: AppConfig) => ({
  provide: MAIL_PORT,
  useClass: config.MAIL_MODE === 'smtp' ? SmtpMail : config.MAIL_MODE === 'memory' ? MemoryMail : LogMail,
});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Transactional templates. Plain text first; the HTML part escapes every interpolated value. */
export const templates = {
  invite(args: { to: string; inviter: string; workspace: string; role: string; url: string }): MailMessage {
    const text = [
      `${args.inviter} invited you to the "${args.workspace}" workspace on Montra as ${args.role}.`,
      '',
      `Accept the invite: ${args.url}`,
      '',
      'The link expires in 7 days. If you did not expect this, you can ignore this email.',
    ].join('\n');
    return {
      to: args.to,
      subject: `${args.inviter} invited you to ${args.workspace} on Montra`,
      text,
      html: `<p>${escapeHtml(args.inviter)} invited you to the <strong>${escapeHtml(args.workspace)}</strong> workspace on Montra as ${escapeHtml(args.role)}.</p><p><a href="${escapeHtml(args.url)}">Accept the invite</a></p><p>The link expires in 7 days.</p>`,
      category: 'sharing',
    };
  },
  newDevice(args: {
    to: string;
    userAgent: string | null;
    ip: string | null;
    at: Date;
    url: string;
  }): MailMessage {
    const device = args.userAgent ?? 'an unknown device';
    const text = [
      `A new sign-in to your Montra account was made from ${device}${args.ip ? ` (${args.ip})` : ''} at ${args.at.toISOString()}.`,
      '',
      `If this was you, no action is needed. If not, sign out the session and change your password: ${args.url}`,
    ].join('\n');
    return { to: args.to, subject: 'New sign-in to your Montra account', text, category: 'security' };
  },
};
