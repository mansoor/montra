import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Logger, Post } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { parse } from '../common/zod.js';
import { Db } from '../db/database.js';
import { MAIL_PORT, templates, type MailPort } from '../mail/mail.service.js';
import { AUTH_PORT, type AuthPort } from './auth.js';
import { KratosAuthAdapter } from './kratos.adapter.js';

const Hook = z.object({
  event: z.enum(['recovery', 'settings', 'identity_deleted', 'password_changed', 'mfa_changed']),
  identity_id: z.string().min(1),
});

/**
 * Kratos `web_hook` target, called after account recovery and credential changes. Kratos revokes the
 * sessions itself; this drops our short-lived session cache so the revocation is immediate (AUTH-05, AUTH-07).
 * A password or two-step change is also noted in the account's security activity and emailed to its owner
 * (AUTH-12, ADR-0045).
 */
@Controller('internal/kratos')
export class KratosHooksController {
  private readonly logger = new Logger('KratosHooks');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_PORT) private readonly auth: AuthPort,
    @Inject(Db) private readonly db: Db,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
  ) {}

  @Post('hooks')
  @HttpCode(200)
  async hook(@Headers('x-montra-hook-secret') secret: string | undefined, @Body() body: unknown) {
    const expected = this.config.KRATOS_WEBHOOK_SECRET;
    if (
      !expected ||
      !secret ||
      secret.length !== expected.length ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))
    ) {
      throw new AppError(401, 'unauthenticated', 'Invalid hook secret');
    }
    const { event, identity_id } = parse(Hook, body);
    const evicted = this.auth instanceof KratosAuthAdapter ? this.auth.evictIdentity(identity_id) : 0;
    if (event === 'password_changed' || event === 'mfa_changed') await this.announce(event, identity_id);
    return { evicted };
  }

  /** Notes the change on the account and emails its owner. Never fails the hook: Kratos has already made the change. */
  private async announce(kind: 'password_changed' | 'mfa_changed', identityId: string): Promise<void> {
    try {
      const at = new Date();
      const { rows } = await this.db.run({}, (trx) =>
        sql<{
          email: string | null;
        }>`select app.note_identity_event(${identityId}, ${kind}, '{}'::jsonb) as email`.execute(trx),
      );
      const to = rows[0]?.email;
      if (!to) return;
      const url = `${this.config.WEB_URL}/settings/security`;
      await this.mail.send(
        kind === 'password_changed'
          ? templates.passwordChanged({ to, at, url })
          : templates.twoStepChanged({ to, at, url }),
      );
    } catch (err) {
      this.logger.warn(`Could not announce a ${kind}: ${(err as Error).message}`);
    }
  }
}
