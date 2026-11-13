import { Controller, Delete, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Db } from '../db/database.js';
import { AUTH_PORT, AuthGuard, Ctx, type AuthPort, type RequestContext, type SessionInfo } from './auth.js';

/** Device list and remote sign-out (AUTH-07). Signing devices out shows in security activity (AUTH-12). */
@Controller('v1/me/sessions')
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(
    @Inject(AUTH_PORT) private readonly auth: AuthPort,
    @Inject(Db) private readonly db: Db,
  ) {}

  @Get()
  async list(@Req() req: FastifyRequest): Promise<{ data: SessionInfo[] }> {
    return { data: await this.auth.listSessions(req) };
  }

  @Delete()
  async revokeOthers(@Req() req: FastifyRequest, @Ctx() ctx: RequestContext): Promise<{ revoked: number }> {
    const revoked = await this.auth.revokeOtherSessions(req);
    if (revoked > 0) await this.log(ctx, { count: revoked });
    return { revoked };
  }

  @Delete(':sessionId')
  async revoke(
    @Req() req: FastifyRequest,
    @Ctx() ctx: RequestContext,
    @Param('sessionId') sessionId: string,
  ): Promise<{ revoked: true }> {
    await this.auth.revokeSession(req, sessionId);
    await this.log(ctx, { count: 1 });
    return { revoked: true };
  }

  private log(ctx: RequestContext, detail: { count: number }) {
    return this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .insertInto('app.security_event')
        .values({
          user_id: ctx.user.id,
          workspace_id: null,
          kind: 'session_revoked',
          detail: JSON.stringify(detail),
        })
        .execute(),
    );
  }
}
