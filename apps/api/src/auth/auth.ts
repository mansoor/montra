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
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { AppError, forbidden } from '../common/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  /** Authenticator assurance level: aal2 = signed in with a second factor (AUTH-04). */
  aal: 'aal1' | 'aal2';
  emailVerified: boolean;
  /** When the user last proved their credentials; used for re-authentication checks (AUTH-09). */
  authenticatedAt: Date;
  sessionId: string | null;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  authenticatedAt: string;
  expiresAt: string | null;
  devices: { userAgent: string | null; ipAddress: string | null; location: string | null }[];
}

/** Identity provider port (ADR-0006). */
export interface AuthPort {
  authenticate(req: FastifyRequest): Promise<AuthUser | null>;
  listSessions(req: FastifyRequest): Promise<SessionInfo[]>;
  /** Revokes one of the caller's other sessions (AUTH-07 remote sign-out). */
  revokeSession(req: FastifyRequest, sessionId: string): Promise<void>;
  /** Revokes all of the caller's sessions except the current one. */
  revokeOtherSessions(req: FastifyRequest): Promise<number>;
}
export const AUTH_PORT = Symbol('AUTH_PORT');

/** Resolves (or creates) the app user for an identity, outside any workspace context. */
export async function resolveAppUser(
  db: Db,
  identityId: string,
  email: string,
  name: string,
  verified: boolean,
) {
  return db.run({}, async (trx) => {
    const { rows } = await sql<{
      id: string;
    }>`select app.resolve_user(${identityId}, ${email}, ${name}) as id`.execute(trx);
    const id = rows[0]!.id;
    if (verified) {
      await sql`select set_config('app.user_id', ${id}, true)`.execute(trx);
      await trx
        .updateTable('app.app_user')
        .set({ email_verified_at: new Date() })
        .where('id', '=', id)
        .where('email_verified_at', 'is', null)
        .execute();
    }
    return id;
  });
}

/**
 * Development-only authentication: `Authorization: Bearer dev:<email>` signs in as that email, creating the
 * user on first use. Refused in production by config validation. Dev sessions count as verified and AAL2.
 */
@Injectable()
export class DevAuthAdapter implements AuthPort {
  constructor(@Inject(Db) private readonly db: Db) {}

  async authenticate(req: FastifyRequest): Promise<AuthUser | null> {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer dev:([^\s@]+@[^\s@]+\.[^\s@]+)$/i.exec(header);
    if (!m) return null;
    const email = m[1]!.toLowerCase();
    const id = await resolveAppUser(this.db, `dev|${email}`, email, email, true);
    return { id, email, aal: 'aal2', emailVerified: true, authenticatedAt: new Date(), sessionId: null };
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }

  async revokeSession(): Promise<void> {}

  async revokeOtherSessions(): Promise<number> {
    return 0;
  }
}

export interface RequestContext {
  user: AuthUser;
  workspaceId?: string;
  role?: MemberRole;
}

type ContextRequest = FastifyRequest & { montra?: RequestContext };

/** Writes allowed before the email is verified (AUTH-03): only the user's own profile. */
const UNVERIFIED_WRITE_ALLOWLIST = [/^\/v1\/me(\/|$)/];

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH_PORT) private readonly auth: AuthPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ContextRequest>();
    const user = await this.auth.authenticate(req);
    if (!user) throw new AppError(401, 'unauthenticated', 'Sign in required');
    if (
      !user.emailVerified &&
      req.method !== 'GET' &&
      !UNVERIFIED_WRITE_ALLOWLIST.some((r) => r.test(req.url))
    ) {
      throw new AppError(403, 'email.unverified', 'Verify your email address before adding financial data');
    }
    req.montra = { user };
    return true;
  }
}

/** Resolves `:workspaceId` and the caller's active membership; RLS enforces the rest. */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

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
    // AUTH-04: MFA is required for accountants, and for owners unless the deployment turns it off.
    const needsMfa =
      member.role === 'accountant' || (member.role === 'owner' && this.config.REQUIRE_OWNER_MFA);
    if (needsMfa && ctx.user.aal !== 'aal2') {
      throw new AppError(403, 'mfa.required', 'Sign in with your second factor to open this workspace');
    }
    ctx.workspaceId = workspaceId;
    ctx.role = member.role;
    return true;
  }
}

/** Privileged-session window for sensitive actions (AUTH-09). */
export const REAUTH_MAX_AGE_MS = 10 * 60_000;

/** Throws unless the user authenticated recently (export, deletion, unlocks, accountant invites, …). */
export function requireRecentAuth(ctx: RequestContext, now = Date.now()): void {
  if (now - ctx.user.authenticatedAt.getTime() > REAUTH_MAX_AGE_MS) {
    throw new AppError(403, 'reauth.required', 'Confirm your password or second factor to continue');
  }
}

export const Ctx = createParamDecorator((_: unknown, context: ExecutionContext): RequestContext => {
  const ctx = context.switchToHttp().getRequest<ContextRequest>().montra;
  if (!ctx) throw new AppError(401, 'unauthenticated', 'Sign in required');
  return ctx;
});

/** Database context for a workspace-scoped request. */
export const dbCtx = (ctx: RequestContext) => ({ workspaceId: ctx.workspaceId!, userId: ctx.user.id });
