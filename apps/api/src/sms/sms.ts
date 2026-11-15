/**
 * Outgoing texts (ADR-0049 §6), as mail has a port: `log` writes them to the log, `memory` keeps them for tests, and
 * `twilio` sends through a Messaging Service, so Twilio's opt-out handling, sender pool and pumping protection apply.
 * Kratos texts its own codes through its courier; this is for the API's alerts and reminders.
 */
import { Inject, Injectable, Logger, type Provider } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsPort {
  send(message: SmsMessage): Promise<{ id: string }>;
}
export const SMS_PORT = Symbol('SMS_PORT');

/** Twilio's answer for a number that replied STOP, so the API stops texting it. */
export class SmsOptedOut extends Error {
  constructor() {
    super('The recipient has opted out of texts');
  }
}

@Injectable()
export class LogSms implements SmsPort {
  private readonly logger = new Logger('Sms');
  async send(m: SmsMessage): Promise<{ id: string }> {
    // The number is masked even in the log: it's someone's personal data.
    this.logger.log(`to=…${m.to.slice(-4)} ${m.body}`);
    return { id: 'log' };
  }
}

@Injectable()
export class MemorySms implements SmsPort {
  readonly outbox: SmsMessage[] = [];
  async send(m: SmsMessage): Promise<{ id: string }> {
    this.outbox.push(m);
    return { id: `memory-${this.outbox.length}` };
  }
}

/** Twilio error codes that mean the number won't take texts from us. */
const OPTED_OUT = new Set([21610]);

@Injectable()
export class TwilioSms implements SmsPort {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async send(m: SmsMessage): Promise<{ id: string }> {
    const sid = this.config.TWILIO_ACCOUNT_SID!;
    const auth = Buffer.from(`${sid}:${this.config.TWILIO_AUTH_TOKEN!}`).toString('base64');
    const res = await fetch(
      `${this.config.TWILIO_API_URL}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          To: m.to,
          Body: m.body,
          MessagingServiceSid: this.config.TWILIO_MESSAGING_SERVICE_SID!,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number };
    if (!res.ok) {
      if (body.code !== undefined && OPTED_OUT.has(body.code)) throw new SmsOptedOut();
      // Twilio's message can name the number, so only its code is kept.
      throw new AppError(
        502,
        'sms.provider_error',
        `The text provider refused the message (${body.code ?? res.status})`,
      );
    }
    return { id: body.sid ?? '' };
  }
}

/** With texts off there's nothing to send through; the service checks the mode before it gets here. */
export class NoSms implements SmsPort {
  async send(): Promise<{ id: string }> {
    throw new AppError(409, 'sms.not_configured', 'Text messages aren’t set up here');
  }
}

export const smsProvider = (config: AppConfig): Provider => ({
  provide: SMS_PORT,
  useClass:
    config.SMS_MODE === 'twilio'
      ? TwilioSms
      : config.SMS_MODE === 'memory'
        ? MemorySms
        : config.SMS_MODE === 'log'
          ? LogSms
          : NoSms,
});
