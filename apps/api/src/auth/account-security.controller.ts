import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { Db } from '../db/database.js';
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { parse } from '../common/zod.js';
import { MAIL_PORT, type MailPort } from '../mail/mail.service.js';
import { AUTH_PORT, AuthGuard, Ctx, requireRecentAuth, type AuthPort, type RequestContext } from './auth.js';

const MAX_ATTEMPTS = 5;
const codeHash = (requestId: string, code: string) =>
  createHash('sha256').update(`${requestId}:${code}`).digest('hex');
const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * Email change with confirmation from both addresses (AUTH-11) and the lost-second-factor reset with a 72-hour
 * hold and alerts (AUTH-06). Codes are single use, hashed, expire in 24 hours and allow five attempts.
 */
@Controller('v1/me')
@UseGuards(AuthGuard)
export class AccountSecurityController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AUTH_PORT) private readonly auth: AuthPort,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('email-change')
  async requestEmailChange(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    const { newEmail } = parse(z.object({ newEmail: z.email().transform((e) => e.toLowerCase()) }), body);
    if (newEmail === ctx.user.email)
      throw new AppError(422, 'email.unchanged', 'That is already your email address');
    const oldCode = newCode();
    const freshCode = newCode();
    const id = await this.db.run({ userId: ctx.user.id }, async (trx) => {
      const { rows } = await sql<{ taken: boolean }>`select app.email_in_use(${newEmail}) as taken`.execute(
        trx,
      );
      if (rows[0]?.taken) throw new AppError(409, 'email.in_use', 'That email address is already in use');
      await trx
        .updateTable('app.email_change_request')
        .set({ cancelled_at: new Date() })
        .where('user_id', '=', ctx.user.id)
        .where('completed_at', 'is', null)
        .where('cancelled_at', 'is', null)
        .execute();
      const requestId = crypto.randomUUID();
      await trx
        .insertInto('app.email_change_request')
        .values({
          id: requestId,
          user_id: ctx.user.id,
          new_email: newEmail,
          old_code_hash: codeHash(requestId, oldCode),
          new_code_hash: codeHash(requestId, freshCode),
        })
        .execute();
      return requestId;
    });
    await this.mail.send({
      to: ctx.user.email,
      subject: 'Confirm your Montra email change',
      text: `Someone asked to change your Montra sign-in email to ${newEmail}.\n\nConfirmation code: ${oldCode}\n\nIf this wasn't you, ignore this email and change your password.`,
      category: 'security',
    });
    await this.mail.send({
      to: newEmail,
      subject: 'Confirm your new Montra email address',
      text: `Use this code to confirm ${newEmail} as your Montra sign-in email: ${freshCode}\n\nThe code expires in 24 hours.`,
      category: 'security',
    });
    return { requestId: id, expiresInHours: 24 };
  }

  @Post('email-change/confirm')
  @HttpCode(200)
  async confirmEmailChange(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), body);
    const result = await this.db.run({ userId: ctx.user.id }, async (trx) => {
      const req = await trx
        .selectFrom('app.email_change_request')
        .selectAll()
        .where('user_id', '=', ctx.user.id)
        .where('completed_at', 'is', null)
        .where('cancelled_at', 'is', null)
        .where('expires_at', '>', new Date())
        .orderBy('created_at', 'desc')
        .forUpdate()
        .executeTakeFirst();
      if (!req || req.attempts >= MAX_ATTEMPTS) {
        throw new AppError(422, 'email_change.invalid', 'No active email change, or too many attempts');
      }
      const hash = codeHash(req.id, code);
      const matchesOld = !req.old_confirmed_at && sameHash(hash, req.old_code_hash);
      const matchesNew = !req.new_confirmed_at && sameHash(hash, req.new_code_hash);
      if (!matchesOld && !matchesNew) {
        await trx
          .updateTable('app.email_change_request')
          .set({ attempts: req.attempts + 1 })
          .where('id', '=', req.id)
          .execute();
        return { error: true as const };
      }
      const oldConfirmed = req.old_confirmed_at ?? (matchesOld ? new Date() : null);
      const newConfirmed = req.new_confirmed_at ?? (matchesNew ? new Date() : null);
      await trx
        .updateTable('app.email_change_request')
        .set({ old_confirmed_at: oldConfirmed, new_confirmed_at: newConfirmed })
        .where('id', '=', req.id)
        .execute();
      return {
        id: req.id,
        newEmail: req.new_email,
        oldConfirmed: Boolean(oldConfirmed),
        newConfirmed: Boolean(newConfirmed),
      };
    });
    if ('error' in result) throw new AppError(422, 'email_change.wrong_code', 'That code is not correct');
    if (!(result.oldConfirmed && result.newConfirmed)) return { ...result, completed: false };

    await this.auth.changeEmail(ctx.user.identityId, result.newEmail);
    await this.db.run({ userId: ctx.user.id }, async (trx) => {
      await trx
        .updateTable('app.app_user')
        .set({ email: result.newEmail, email_verified_at: new Date() })
        .where('id', '=', ctx.user.id)
        .execute();
      await trx
        .updateTable('app.email_change_request')
        .set({ completed_at: new Date() })
        .where('id', '=', result.id)
        .execute();
    });
    await this.mail.send({
      to: ctx.user.email,
      subject: 'Your Montra sign-in email was changed',
      text: `Your Montra sign-in email is now ${result.newEmail}. If you didn't make this change, contact support right away.`,
      category: 'security',
    });
    return { ...result, completed: true };
  }

  @Get('mfa-reset')
  async mfaResetStatus(@Ctx() ctx: RequestContext) {
    const row = await this.pendingReset(ctx);
    return row ? { status: 'pending', eligibleAt: row.eligible_at } : { status: 'none' };
  }

  /** Starts the 72-hour hold. Works from a password-only (AAL1) session — that's the lost-device case. */
  @Post('mfa-reset')
  async requestMfaReset(@Ctx() ctx: RequestContext) {
    const existing = await this.pendingReset(ctx);
    if (existing) return { status: 'pending', eligibleAt: existing.eligible_at };
    const row = await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .insertInto('app.mfa_reset_request')
        .values({ user_id: ctx.user.id })
        .returning(['eligible_at'])
        .executeTakeFirstOrThrow(),
    );
    await this.mail.send({
      to: ctx.user.email,
      subject: 'Second-factor reset requested on your Montra account',
      text: [
        'A request was made to remove the second factor (authenticator app, passkeys, recovery codes) from your Montra account.',
        `For your safety it takes effect after ${row.eligible_at.toISOString()} (72 hours).`,
        '',
        `If this wasn't you, cancel it now from any signed-in device: ${this.config.WEB_URL}/settings/security`,
      ].join('\n'),
      category: 'security',
    });
    return { status: 'pending', eligibleAt: row.eligible_at };
  }

  @Post('mfa-reset/cancel')
  @HttpCode(200)
  async cancelMfaReset(@Ctx() ctx: RequestContext) {
    await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .updateTable('app.mfa_reset_request')
        .set({ status: 'cancelled', closed_at: new Date() })
        .where('user_id', '=', ctx.user.id)
        .where('status', '=', 'pending')
        .execute(),
    );
    return { status: 'cancelled' };
  }

  @Post('mfa-reset/complete')
  @HttpCode(200)
  async completeMfaReset(@Ctx() ctx: RequestContext) {
    const row = await this.pendingReset(ctx);
    if (!row) throw new AppError(422, 'mfa_reset.none', 'There is no pending second-factor reset');
    if (row.eligible_at.getTime() > Date.now()) {
      throw new AppError(
        409,
        'mfa_reset.waiting',
        `The reset can be completed after ${row.eligible_at.toISOString()}`,
      );
    }
    await this.auth.removeSecondFactors(ctx.user.identityId);
    await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .updateTable('app.mfa_reset_request')
        .set({ status: 'completed', closed_at: new Date() })
        .where('id', '=', row.id)
        .execute(),
    );
    await this.mail.send({
      to: ctx.user.email,
      subject: 'Second factor removed from your Montra account',
      text: 'Your second factor was removed and all sessions were signed out. Set up a new authenticator or passkey now.',
      category: 'security',
    });
    return { status: 'completed' };
  }

  private pendingReset(ctx: RequestContext) {
    return this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .selectFrom('app.mfa_reset_request')
        .select(['id', 'eligible_at'])
        .where('user_id', '=', ctx.user.id)
        .where('status', '=', 'pending')
        .executeTakeFirst(),
    );
  }
}
