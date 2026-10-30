import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { sql } from 'kysely';
import type { FastifyRequest } from 'fastify';
import type { MemberRole } from '@montra/db';
import { Db } from '../db/database.js';
import { AppError, forbidden } from '../common/errors.js';

export interface AuthUser {
  id: string;
  email: string;
}

/** Identity provider port (ADR-0006). Phase 1 adds the Ory Kratos adapter. */
export interface AuthPort {
  authenticate(req: FastifyRequest): Promise<AuthUser | null>;
}
export const AUTH_PORT = Symbol('AUTH_PORT');

/**
 * Development-only authentication: `Authorization: Bearer dev:<email>` signs in as that email, creating the
 * user on first use. Refused in production by config validation.
 */
@Injectable()
export class DevAuthAdapter implements AuthPort {
  constructor(@Inject(Db) private readonly db: Db) {}

  async authenticate(req: FastifyRequest): Promise<AuthUser | null> {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer dev:([^\s@]+@[^\s@]+\.[^\s@]+)$/i.exec(header);
    if (!m) return null;
    const email = m[1]!.toLowerCase();
    const id = await this.db.run({}, async (trx) => {
      const { rows } = await sql<{
        id: string;
      }>`select app.resolve_user(${'dev|' + email}, ${email}, ${email}) as id`.execute(trx);
      return rows[0]!.id;
    });
    return { id, email };
  }
}

export interface RequestContext {
  user: AuthUser;
  workspaceId?: string;
  role?: MemberRole;
}

type ContextRequest = FastifyRequest & { montra?: RequestContext };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH_PORT) private readonly auth: AuthPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ContextRequest>();
    const user = await this.auth.authenticate(req);
    if (!user) throw new AppError(401, 'unauthenticated', 'Sign in required');
    req.montra = { user };
    return true;
  }
}

/** Resolves `:workspaceId` and the caller's active membership; RLS enforces the rest. */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(Db) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ContextRequest>();
    const workspaceId = (req.params as Record<string, string | undefined>).workspaceId;
    const ctx = req.montra;
    if (!ctx || !workspaceId) throw forbidden();
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw forbidden();
    const member = await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .selectFrom('app.workspace_member')
        .select('role')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', ctx.user.id)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );
    // Same response whether the workspace exists or not.
    if (!member) throw forbidden();
    ctx.workspaceId = workspaceId;
    ctx.role = member.role;
    return true;
  }
}

export const Ctx = createParamDecorator((_: unknown, context: ExecutionContext): RequestContext => {
  const ctx = context.switchToHttp().getRequest<ContextRequest>().montra;
  if (!ctx) throw new AppError(401, 'unauthenticated', 'Sign in required');
  return ctx;
});

/** Database context for a workspace-scoped request. */
export const dbCtx = (ctx: RequestContext) => ({ workspaceId: ctx.workspaceId!, userId: ctx.user.id });
