/**
 * The mobile number, confirmed by a code the API texts (ADR-0049 §6). Kratos v26.2.0 texts a code when a number is
 * saved in a settings flow, but never names the verification flow that code belongs to, so it can't be entered. So:
 *
 * 1. `POST /v1/me/phone` texts a 6-digit code to the number. Only to a country on the allowed list, and counted under
 *    the auth gateway's `sms_send` limit per number (the same counter the gateway uses) and per person, against SMS
 *    pumping. The code is hashed, lasts 10 minutes and is single use; a new request replaces the last.
 * 2. `POST /v1/me/phone/confirm` checks it: five tries per code, and wrong codes count per person too. A right code
 *    puts the number on the Kratos identity, already verified, through the admin API (which texts nothing).
 * 3. `DELETE /v1/me/phone` removes it.
 *
 * Adding, changing and removing the number need a recent sign-in (AUTH-09), as other identity changes do, and each is
 * logged and emailed to the address that signs in (ADR-0045), as the number's sync from Kratos does.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Inject, Logger, Post, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { maskPhone, normalizePhone } from '@montra/domain';
import { ConfirmPhoneRequest, StartPhoneVerificationRequest, type PhoneStatusDto } from '@montra/schemas';
import {
  AUTH_PORT,
  AuthGuard,
  Ctx,
  requireRecentAuth,
  type AuthPort,
  type RequestContext,
} from '../auth/auth.js';
import { RULES, ThrottleStore, keyOf, lockedFor, throttleSecret } from '../auth-gateway/throttle.js';
import { AppError, unprocessable } from '../common/errors.js';
import { parse } from '../common/zod.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { MAIL_PORT, templates, type MailPort } from '../mail/mail.service.js';
import { TextsService } from './texts.service.js';

export const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;

const codeHash = (requestId: string, code: string) =>
  createHash('sha256').update(`${requestId}:${code}`).digest('hex');
const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

@Controller('v1/me/phone')
@UseGuards(AuthGuard)
export class PhoneController {
  private readonly logger = new Logger('Phone');
  private readonly throttle: ThrottleStore;
  private readonly secret: string;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_PORT) private readonly auth: AuthPort,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(TextsService) private readonly texts: TextsService,
  ) {
    this.throttle = new ThrottleStore(db);
    this.secret = throttleSecret(config);
  }

  @Get()
  async status(@Ctx() ctx: RequestContext): Promise<PhoneStatusDto> {
    return this.db.run({ userId: ctx.user.id }, async (trx) => {
      const user = await trx
        .selectFrom('app.app_user')
        .select(['phone_e164', 'phone_verified'])
        .where('id', '=', ctx.user.id)
        .executeTakeFirst();
      const pending = await this.open(trx, ctx.user.id);
      return {
        available: this.texts.enabled,
        phone: user?.phone_e164 ? maskPhone(user.phone_e164) : null,
        verified: Boolean(user?.phone_e164 && user.phone_verified),
        pending: pending
          ? { phone: maskPhone(pending.phone), expiresAt: pending.expires_at.toISOString() }
          : null,
      };
    });
  }

  @Post()
  async start(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    if (!this.texts.enabled)
      throw new AppError(409, 'sms.not_configured', 'Text messages aren’t set up here');
    requireRecentAuth(ctx);
    const phone = normalizePhone(parse(StartPhoneVerificationRequest, body).phone);
    if (!phone)
      throw unprocessable('phone.invalid', 'Enter the number with its country code, such as +1 415 555 0123');
    const current = await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .selectFrom('app.app_user')
        .select(['phone_e164', 'phone_verified'])
        .where('id', '=', ctx.user.id)
        .executeTakeFirst(),
    );
    if (current?.phone_e164 === phone && current.phone_verified)
      throw unprocessable('phone.unchanged', 'That number is already confirmed');
    const { rows } = await this.db.run({ userId: ctx.user.id }, (trx) =>
      sql<{ taken: boolean }>`select app.phone_in_use(${phone}) as taken`.execute(trx),
    );
    if (rows[0]?.taken) throw new AppError(409, 'phone.in_use', 'That number is on another account');
    if (!(await this.texts.allowedTo(phone)))
      throw unprocessable('sms.country', 'Texts can’t go to numbers in that country');

    // Each text costs money and SMS pumping asks for many: the gateway's limit, per number and per person.
    const keys = [`number:${phone}`, `person:${ctx.user.id}`].map((v) => keyOf(this.secret, 'sms_send', v));
    const buckets = await this.throttle.get(keys);
    const now = new Date();
    const locked = Math.max(0, ...keys.map((k) => lockedFor(buckets.get(k), now)));
    if (locked > 0) throw this.tooMany(locked);
    for (const k of keys) await this.throttle.fail(k, RULES.sms_send, now);

    const code = newCode();
    const request = await this.db.run({ userId: ctx.user.id }, async (trx) => {
      await trx
        .updateTable('app.phone_verification')
        .set({ cancelled_at: now })
        .where('user_id', '=', ctx.user.id)
        .where('completed_at', 'is', null)
        .where('cancelled_at', 'is', null)
        .execute();
      const id = crypto.randomUUID();
      return trx
        .insertInto('app.phone_verification')
        .values({
          id,
          user_id: ctx.user.id,
          phone,
          code_hash: codeHash(id, code),
          expires_at: new Date(now.getTime() + CODE_MINUTES * 60_000),
        })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow();
    });
    const outcome = await this.texts.confirmationCode(phone, code, CODE_MINUTES);
    if (outcome !== 'sent') {
      await this.cancel(ctx.user.id, request.id);
      if (outcome === 'country')
        throw unprocessable('sms.country', 'Texts can’t go to numbers in that country');
      if (outcome === 'opted_out')
        throw unprocessable('sms.opted_out', 'That number replied STOP, so Montra can’t text it');
      if (outcome === 'off')
        throw new AppError(409, 'sms.not_configured', 'Text messages aren’t set up here');
      throw new AppError(502, 'sms.failed', 'The text didn’t go. Try again in a few minutes');
    }
    return { phone: maskPhone(phone), expiresAt: request.expires_at.toISOString() };
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<PhoneStatusDto> {
    const { code } = parse(ConfirmPhoneRequest, body);
    // Wrong codes count per person across requests too, so new codes don't buy more guesses.
    const guessKey = keyOf(this.secret, 'code', `phone:${ctx.user.id}`);
    const now = new Date();
    const locked = lockedFor((await this.throttle.get([guessKey])).get(guessKey), now);
    if (locked > 0) throw this.tooMany(locked);

    const result = await this.db.run({ userId: ctx.user.id }, async (trx) => {
      const req = await this.open(trx, ctx.user.id, true);
      if (!req || req.attempts >= MAX_ATTEMPTS) return { kind: 'none' as const };
      if (!sameHash(codeHash(req.id, code), req.code_hash)) {
        await trx
          .updateTable('app.phone_verification')
          .set({ attempts: req.attempts + 1 })
          .where('id', '=', req.id)
          .execute();
        return { kind: 'wrong' as const };
      }
      // Single use: spent before the identity changes, so a second try with it finds nothing.
      await trx
        .updateTable('app.phone_verification')
        .set({ completed_at: now })
        .where('id', '=', req.id)
        .execute();
      return { kind: 'right' as const, phone: req.phone };
    });
    if (result.kind === 'none')
      throw unprocessable('phone.no_code', 'That code has expired or was used up. Ask for a new one');
    if (result.kind === 'wrong') {
      await this.throttle.fail(guessKey, RULES.code, now);
      throw unprocessable('phone.wrong_code', 'That code isn’t right');
    }
    await this.throttle.clear([guessKey]);
    await this.auth.setPhone(ctx.user.identityId, result.phone);
    await this.record(ctx, result.phone);
    return this.status(ctx);
  }

  @Delete()
  async remove(@Ctx() ctx: RequestContext): Promise<PhoneStatusDto> {
    requireRecentAuth(ctx);
    await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .updateTable('app.phone_verification')
        .set({ cancelled_at: new Date() })
        .where('user_id', '=', ctx.user.id)
        .where('completed_at', 'is', null)
        .where('cancelled_at', 'is', null)
        .execute(),
    );
    await this.auth.setPhone(ctx.user.identityId, null);
    await this.record(ctx, null);
    return this.status(ctx);
  }

  /** The request still open: not used, cancelled or expired. */
  private open(trx: Trx, userId: string, lock = false) {
    let q = trx
      .selectFrom('app.phone_verification')
      .select(['id', 'phone', 'code_hash', 'attempts', 'expires_at'])
      .where('user_id', '=', userId)
      .where('completed_at', 'is', null)
      .where('cancelled_at', 'is', null)
      .where('expires_at', '>', new Date());
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private cancel(userId: string, id: string) {
    return this.db.run({ userId }, (trx) =>
      trx
        .updateTable('app.phone_verification')
        .set({ cancelled_at: new Date() })
        .where('id', '=', id)
        .execute(),
    );
  }

  private tooMany(seconds: number) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return new AppError(
      429,
      'sms.too_many',
      `Too many codes asked for. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}`,
    );
  }

  /**
   * The API's copy, which texts go to, and the alert: a security event and an email to the address that signs in
   * (ADR-0045). The next sync from Kratos then finds nothing changed, so there's no second alert.
   */
  private async record(ctx: RequestContext, phone: string | null): Promise<void> {
    const { rows } = await this.db.run({ userId: ctx.user.id }, (trx) =>
      sql<{ previous: string | null; changed: boolean }>`
        select * from app.sync_user_phone(${ctx.user.id}::uuid, ${phone}, ${phone !== null})`.execute(trx),
    );
    if (!rows[0]?.changed) return;
    await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .insertInto('app.security_event')
        .values({
          user_id: ctx.user.id,
          workspace_id: null,
          kind: 'phone_changed',
          detail: JSON.stringify({ added: Boolean(phone && !rows[0]!.previous), removed: !phone }),
        })
        .execute(),
    );
    await this.mail
      .send(
        templates.phoneChanged({
          to: ctx.user.email,
          at: new Date(),
          now: phone,
          url: `${this.config.WEB_URL}/settings/security`,
        }),
      )
      .catch((err: Error) => this.logger.warn(`Could not email a number change: ${err.message}`));
  }
}
