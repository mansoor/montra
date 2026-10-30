import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { AppError } from '../common/errors.js';
import { MAIL_PORT, templates, type MailPort } from '../mail/mail.service.js';
import { resolveAppUser, type AuthPort, type AuthUser, type SessionInfo } from './auth.js';

/** The subset of Kratos' session object Montra relies on. */
interface KratosSession {
  id: string;
  active: boolean;
  expires_at?: string;
  authenticated_at: string;
  authenticator_assurance_level: 'aal0' | 'aal1' | 'aal2' | 'aal3';
  devices?: { user_agent?: string; ip_address?: string; location?: string }[];
  identity: {
    id: string;
    traits: { email?: string; name?: string | { first?: string; last?: string } };
    verifiable_addresses?: { value: string; verified: boolean; via: string }[];
  };
}

interface Credentials {
  headers: Record<string, string>;
  cacheKey: string;
}

/**
 * Ory Kratos session validation (ADR-0006). Mobile sends `Authorization: Bearer <session token>`; the web
 * backend-for-frontend forwards the `ory_kratos_session` cookie. Valid sessions are cached briefly; any
 * revocation through this adapter clears the identity's cached sessions at once (AUTH-05, AUTH-07).
 */
@Injectable()
export class KratosAuthAdapter implements AuthPort {
  private readonly logger = new Logger('KratosAuthAdapter');
  private readonly cache = new Map<string, { user: AuthUser; identityId: string; until: number }>();
  private readonly baseUrl: string;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
  ) {
    this.baseUrl = config.KRATOS_PUBLIC_URL!.replace(/\/$/, '');
  }

  async authenticate(req: FastifyRequest): Promise<AuthUser | null> {
    const creds = this.credentials(req);
    if (!creds) return null;
    const hit = this.cache.get(creds.cacheKey);
    if (hit && hit.until > Date.now()) return hit.user;

    const res = await this.call('GET', '/sessions/whoami', creds);
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok)
      throw new AppError(503, 'auth.unavailable', 'Sign-in service is unavailable, try again shortly');
    const session = (await res.json()) as KratosSession;
    if (!session.active) return null;

    const email = (session.identity.traits.email ?? '').toLowerCase();
    if (!email) return null;
    const verified = Boolean(
      session.identity.verifiable_addresses?.some(
        (a) => a.via === 'email' && a.value.toLowerCase() === email && a.verified,
      ),
    );
    const name = session.identity.traits.name;
    const displayName = typeof name === 'string' ? name : [name?.first, name?.last].filter(Boolean).join(' ');
    const id = await resolveAppUser(this.db, session.identity.id, email, displayName, verified);
    const user: AuthUser = {
      id,
      identityId: session.identity.id,
      email,
      aal:
        session.authenticator_assurance_level === 'aal2' || session.authenticator_assurance_level === 'aal3'
          ? 'aal2'
          : 'aal1',
      emailVerified: verified,
      authenticatedAt: new Date(session.authenticated_at),
      sessionId: session.id,
    };
    await this.recordDevice(req, user);
    if (this.config.SESSION_CACHE_SECONDS > 0) {
      this.cache.set(creds.cacheKey, {
        user,
        identityId: session.identity.id,
        until: Date.now() + this.config.SESSION_CACHE_SECONDS * 1000,
      });
    }
    return user;
  }

  /**
   * Remembers each Kratos session the user signs in with and emails an alert the first time a new one shows
   * up, unless it is the account's very first session (AUTH-08).
   */
  private async recordDevice(req: FastifyRequest, user: AuthUser): Promise<void> {
    if (!user.sessionId) return;
    const userAgent = (req.headers['user-agent'] ?? null)?.slice(0, 300) ?? null;
    const ip = req.ip && /^[0-9a-f.:]+$/i.test(req.ip) ? req.ip : null;
    const { isNew, hadOthers } = await this.db.run({ userId: user.id }, async (trx) => {
      const inserted = await trx
        .insertInto('app.session_device')
        .values({
          user_id: user.id,
          kratos_session_id: user.sessionId!,
          user_agent: userAgent,
          ip_address: ip,
        })
        .onConflict((oc) =>
          oc.columns(['user_id', 'kratos_session_id']).doUpdateSet({ last_seen_at: new Date() }),
        )
        .returning(['first_seen_at', 'last_seen_at'])
        .executeTakeFirstOrThrow();
      const fresh = inserted.first_seen_at.getTime() === inserted.last_seen_at.getTime();
      const others = fresh
        ? await trx
            .selectFrom('app.session_device')
            .select('kratos_session_id')
            .where('user_id', '=', user.id)
            .where('kratos_session_id', '<>', user.sessionId!)
            .executeTakeFirst()
        : undefined;
      return { isNew: fresh, hadOthers: Boolean(others) };
    });
    if (isNew && hadOthers) {
      await this.mail
        .send(
          templates.newDevice({
            to: user.email,
            userAgent,
            ip,
            at: new Date(),
            url: `${this.config.WEB_URL}/settings/security`,
          }),
        )
        .catch((err: Error) => this.logger.warn(`new-device alert failed: ${err.message}`));
    }
  }

  async listSessions(req: FastifyRequest): Promise<SessionInfo[]> {
    const creds = this.require(req);
    const current = await this.call('GET', '/sessions/whoami', creds);
    const others = await this.call('GET', '/sessions', creds);
    if (!current.ok || !others.ok)
      throw new AppError(503, 'auth.unavailable', 'Sign-in service is unavailable');
    const toInfo = (s: KratosSession, isCurrent: boolean): SessionInfo => ({
      id: s.id,
      current: isCurrent,
      authenticatedAt: s.authenticated_at,
      expiresAt: s.expires_at ?? null,
      devices: (s.devices ?? []).map((d) => ({
        userAgent: d.user_agent ?? null,
        ipAddress: d.ip_address ?? null,
        location: d.location ?? null,
      })),
    });
    return [
      toInfo((await current.json()) as KratosSession, true),
      ...((await others.json()) as KratosSession[]).map((s) => toInfo(s, false)),
    ];
  }

  async revokeSession(req: FastifyRequest, sessionId: string): Promise<void> {
    const creds = this.require(req);
    const res = await this.call('DELETE', `/sessions/${encodeURIComponent(sessionId)}`, creds);
    if (res.status === 404) throw new AppError(404, 'not_found', 'Session not found');
    if (!res.ok) throw new AppError(503, 'auth.unavailable', 'Sign-in service is unavailable');
    this.evictIdentityOf(creds.cacheKey);
  }

  async revokeOtherSessions(req: FastifyRequest): Promise<number> {
    const creds = this.require(req);
    const res = await this.call('DELETE', '/sessions', creds);
    if (!res.ok) throw new AppError(503, 'auth.unavailable', 'Sign-in service is unavailable');
    this.evictIdentityOf(creds.cacheKey);
    const body = (await res.json().catch(() => ({}))) as { count?: number };
    return body.count ?? 0;
  }

  async changeEmail(identityId: string, newEmail: string): Promise<void> {
    const path = `/admin/identities/${encodeURIComponent(identityId)}`;
    // Both addresses were confirmed by code, so the new address is stored as verified.
    await this.admin('PATCH', path, [{ op: 'replace', path: '/traits/email', value: newEmail }]);
    await this.admin('PATCH', path, [
      { op: 'replace', path: '/verifiable_addresses/0/value', value: newEmail },
      { op: 'replace', path: '/verifiable_addresses/0/verified', value: true },
      { op: 'replace', path: '/verifiable_addresses/0/status', value: 'completed' },
    ]);
    this.evictIdentity(identityId);
  }

  async removeSecondFactors(identityId: string): Promise<void> {
    const base = `/admin/identities/${encodeURIComponent(identityId)}`;
    for (const type of ['totp', 'webauthn', 'lookup_secret']) {
      await this.admin('DELETE', `${base}/credentials/${type}`, undefined, [404]);
    }
    await this.admin('DELETE', `${base}/sessions`, undefined, [404]);
    this.evictIdentity(identityId);
  }

  private async admin(
    method: 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<void> {
    const base = this.config.KRATOS_ADMIN_URL?.replace(/\/$/, '');
    if (!base) throw new AppError(503, 'auth.admin_unavailable', 'Account administration is not configured');
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      this.logger.warn(`Kratos admin ${method} ${path} failed: ${(err as Error).message}`);
      throw new AppError(503, 'auth.unavailable', 'Sign-in service is unavailable, try again shortly');
    }
    if (!res.ok && !okStatuses.includes(res.status)) {
      if (res.status === 409) throw new AppError(409, 'email.in_use', 'That email address is already in use');
      throw new AppError(502, 'auth.admin_failed', `Account update failed (${res.status})`);
    }
  }

  /** Drops every cached session of an identity (Kratos webhook after recovery or credential changes). */
  evictIdentity(identityId: string): number {
    let n = 0;
    for (const [key, entry] of this.cache) {
      if (entry.identityId === identityId) {
        this.cache.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Drops every cached session of the identity behind `cacheKey` except that key itself. */
  private evictIdentityOf(cacheKey: string): void {
    const identityId = this.cache.get(cacheKey)?.identityId;
    if (!identityId) return;
    for (const [key, entry] of this.cache)
      if (entry.identityId === identityId && key !== cacheKey) this.cache.delete(key);
  }

  private require(req: FastifyRequest): Credentials {
    const creds = this.credentials(req);
    if (!creds) throw new AppError(401, 'unauthenticated', 'Sign in required');
    return creds;
  }

  private credentials(req: FastifyRequest): Credentials | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (!token || token.startsWith('dev:')) return null;
      return { headers: { 'x-session-token': token }, cacheKey: hash(`t:${token}`) };
    }
    const cookie = req.headers.cookie;
    const session = cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('ory_kratos_session='));
    if (session) return { headers: { cookie: session }, cacheKey: hash(`c:${session}`) };
    return null;
  }

  private async call(method: 'GET' | 'DELETE', path: string, creds: Credentials): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { accept: 'application/json', ...creds.headers },
        signal: AbortSignal.timeout(3000),
      });
    } catch (err) {
      this.logger.warn(`Kratos ${method} ${path} failed: ${(err as Error).message}`);
      throw new AppError(503, 'auth.unavailable', 'Sign-in service is unavailable, try again shortly');
    }
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
