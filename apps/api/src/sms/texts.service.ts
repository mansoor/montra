/**
 * What the API texts, and to whom (ADR-0049 §6). Every text goes only to the person's own verified number, only to a
 * country on the allowed list, and only for a kind the owner has switched on (except the code that confirms a number,
 * which goes to the number being confirmed). Reminders also need the person to have
 * turned them on, a plan whose `smsMonthly` is above 0, and a text left this month; security alerts need the person
 * to have turned them on and aren't counted. A number that replied STOP gets no more.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { maskPhone, textAllowedTo } from '@montra/domain';
import { AppError, unprocessable } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { Plans } from '../ops/plans.js';
import { ServiceSettings } from '../ops/service-settings.js';
import { SMS_PORT, SmsOptedOut, type SmsPort } from './sms.js';

type Ctx = { workspaceId: string; userId: string };

interface Target {
  phone: string | null;
  opted_out: boolean;
  sms_security: boolean;
  sms_reminders: boolean;
}

export type TextOutcome =
  | 'sent'
  | 'off'
  | 'kind_off'
  | 'not_wanted'
  | 'no_phone'
  | 'opted_out'
  | 'country'
  | 'plan'
  | 'used_up'
  | 'failed';

const monthStart = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;

/** A text says what happened and where to look, like push: never a figure, a payee or a note. */
const MAX_BODY = 300;

@Injectable()
export class TextsService {
  private readonly logger = new Logger('Texts');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SMS_PORT) private readonly sms: SmsPort,
    @Inject(ServiceSettings) private readonly settings: ServiceSettings,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  get enabled(): boolean {
    return this.config.SMS_MODE !== 'off';
  }

  private async target(userId: string): Promise<Target | null> {
    const { rows } = await this.db.run({ userId }, (trx) =>
      sql<Target>`select * from app.user_text_target(${userId}::uuid)`.execute(trx),
    );
    return rows[0] ?? null;
  }

  private async deliver(to: string, body: string): Promise<TextOutcome> {
    try {
      await this.sms.send({ to, body: body.slice(0, MAX_BODY) });
      return 'sent';
    } catch (e) {
      if (e instanceof SmsOptedOut) {
        await this.db.run({}, (trx) => sql`select app.note_sms_opt_out(${to})`.execute(trx));
        return 'opted_out';
      }
      this.logger.warn(`A text failed: ${(e as Error).message}`);
      return 'failed';
    }
  }

  /** ADR-0045 alerts by text too, when the person turned that on. Not counted against a plan. */
  async securityAlert(userId: string, body: string): Promise<TextOutcome> {
    if (!this.enabled) return 'off';
    const s = await this.settings.values();
    if (!s.smsKinds.includes('security')) return 'kind_off';
    const t = await this.target(userId);
    if (!t?.phone) return 'no_phone';
    if (!t.sms_security) return 'not_wanted';
    if (t.opted_out) return 'opted_out';
    if (!textAllowedTo(t.phone, s.smsCountries)) return 'country';
    return this.deliver(t.phone, `Montra: ${body}`);
  }

  /** A reminder, such as a bill due, on a plan that includes texts, taking one from the month's allowance. */
  async reminder(ctx: Ctx, body: string): Promise<TextOutcome> {
    if (!this.enabled) return 'off';
    const s = await this.settings.values();
    if (!s.smsKinds.includes('reminders')) return 'kind_off';
    const t = await this.target(ctx.userId);
    if (!t?.phone) return 'no_phone';
    if (!t.sms_reminders) return 'not_wanted';
    if (t.opted_out) return 'opted_out';
    if (!textAllowedTo(t.phone, s.smsCountries)) return 'country';
    const taken = await this.db.run(ctx, async (trx) => {
      const allowance = (await this.plans.entitlements(trx)).smsMonthly;
      if (allowance <= 0) return 'plan' as const;
      const { rows } = await sql<{ taken: boolean }>`
        select app.take_sms(${ctx.workspaceId}::uuid, ${monthStart()}::date, ${allowance}) as taken`.execute(
        trx,
      );
      return rows[0]?.taken ? ('ok' as const) : ('used_up' as const);
    });
    if (taken !== 'ok') return taken;
    return this.deliver(t.phone, `Montra: ${body}`);
  }

  /**
   * The code that confirms a number (ADR-0049 §6), before the number is anyone's: so it's the one text that goes to an
   * unconfirmed number, and only to a country on the allowed list. The caller limits how often. No link, ever.
   */
  async confirmationCode(phone: string, code: string, minutes: number): Promise<TextOutcome> {
    if (!this.enabled) return 'off';
    if (!(await this.allowedTo(phone))) return 'country';
    return this.deliver(
      phone,
      `Montra code to confirm this number: ${code}. It expires in ${minutes} minutes.`,
    );
  }

  /** Whether texts may go to this number's country (the owner's allowed list). */
  async allowedTo(phone: string): Promise<boolean> {
    return textAllowedTo(phone, (await this.settings.values()).smsCountries);
  }

  /** The Providers page's test: to the owner's own verified number, whatever the kinds and preferences say. */
  async test(userId: string): Promise<{ to: string }> {
    if (!this.enabled) throw new AppError(409, 'sms.not_configured', 'Text messages aren’t set up here');
    const t = await this.target(userId);
    if (!t?.phone)
      throw unprocessable('sms.no_phone', 'Add and verify a mobile number in your security settings first');
    const s = await this.settings.values();
    if (!textAllowedTo(t.phone, s.smsCountries)) {
      throw unprocessable('sms.country', 'Your number is in a country texts aren’t allowed to');
    }
    const outcome = await this.deliver(t.phone, 'Montra: this is a test text from the Providers page.');
    if (outcome !== 'sent')
      throw new AppError(502, 'sms.failed', 'The text didn’t go. See the Providers page.');
    return { to: maskPhone(t.phone) };
  }
}
