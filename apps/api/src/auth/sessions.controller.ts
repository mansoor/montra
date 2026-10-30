import { Controller, Delete, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AUTH_PORT, AuthGuard, type AuthPort, type SessionInfo } from './auth.js';

/** Device list and remote sign-out (AUTH-07). */
@Controller('v1/me/sessions')
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(@Inject(AUTH_PORT) private readonly auth: AuthPort) {}

  @Get()
  async list(@Req() req: FastifyRequest): Promise<{ data: SessionInfo[] }> {
    return { data: await this.auth.listSessions(req) };
  }

  @Delete()
  async revokeOthers(@Req() req: FastifyRequest): Promise<{ revoked: number }> {
    return { revoked: await this.auth.revokeOtherSessions(req) };
  }

  @Delete(':sessionId')
  async revoke(
    @Req() req: FastifyRequest,
    @Param('sessionId') sessionId: string,
  ): Promise<{ revoked: true }> {
    await this.auth.revokeSession(req, sessionId);
    return { revoked: true };
  }
}
