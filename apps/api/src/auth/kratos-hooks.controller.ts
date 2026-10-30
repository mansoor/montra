import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { parse } from '../common/zod.js';
import { AUTH_PORT, type AuthPort } from './auth.js';
import { KratosAuthAdapter } from './kratos.adapter.js';

const Hook = z.object({
  event: z.enum(['recovery', 'settings', 'identity_deleted']),
  identity_id: z.string().min(1),
});

/**
 * Kratos `web_hook` target, called after account recovery and credential changes. Kratos revokes the
 * sessions itself; this drops our short-lived session cache so the revocation is immediate (AUTH-05, AUTH-07).
 */
@Controller('internal/kratos')
export class KratosHooksController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_PORT) private readonly auth: AuthPort,
  ) {}

  @Post('hooks')
  @HttpCode(200)
  hook(@Headers('x-montra-hook-secret') secret: string | undefined, @Body() body: unknown) {
    const expected = this.config.KRATOS_WEBHOOK_SECRET;
    if (
      !expected ||
      !secret ||
      secret.length !== expected.length ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))
    ) {
      throw new AppError(401, 'unauthenticated', 'Invalid hook secret');
    }
    const { identity_id } = parse(Hook, body);
    const evicted = this.auth instanceof KratosAuthAdapter ? this.auth.evictIdentity(identity_id) : 0;
    return { evicted };
  }
}
