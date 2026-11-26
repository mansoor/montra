import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { CONFIG, type AppConfig } from '../config.js';
import { TextsService } from '../sms/texts.service.js';
import { Db } from '../db/database.js';
import { AppError } from '../common/errors.js';
import { MAIL_PORT, templates, type MailPort } from '../mail/mail.service.js';
import { timeZoneOf } from '../mail/time-zone.js';
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
    traits: { email?: string; phone?: string; name?: string | { first?: string; last?: string } };
    verifiable_addresses?: { value: string; verified: boolean; via: string }[];
  };
}

/** The part of an identity, from the admin API, that a number change reads. */
interface KratosAddress {
  value: string;
  via: string;
  verified?: boolean;
  status?: string;
}
interface KratosIdentity {
  traits?: { phone?: string };
  credentials?: Record<string, unknown>;
  verifiable_addresses?: KratosAddress[];
}

interface Credentials {
  headers: Record<string, string>;
  cacheKey: string;
  /** A browser's cookie (through the web server) or the phone's token. */
  kind: 'cookie' | 'token';
}

/**
 * A browser session unused for this long is ended on the server (AUTH-07, ADR-0044). The web signs out sooner on its
 * own, after the workspace's idle timeout; this catches a tab that stopped running. The phone has its app lock.
 */
export const WEB_IDLE_LIMIT_MS = 30 * 60_000;

/** One credential of an identity, as Kratos's admin API returns it. */
interface KratosCredential {
  type?: string;
  config?: { credentials?: unknown[] } | null;
}

/**
 * Whether an identity's credentials include a second factor (ADR-0044): TOTP, recovery codes, or a security key
 * that was actually registered. Kratos can leave a `webauthn` entry with no keys in it, which is not a factor.
 */
export function hasSecondFactorCredential(
  credentials: Record<string, KratosCredential> | undefined,
): boolean {
  const c = credentials ?? {};
  if (c.totp || c.lookup_secret) return true;
  const keys = c.webauthn?.config?.credentials;
  return Array.isArray(keys) && keys.length > 0;
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
  /**
   * Identities known to have a second factor, for a minute (ADR-0044). A "no" isn't kept: someone who has just set one
   * up must get in at once.
   */
  private readonly factors = new Map<string, { value: boolean; until: number }>();
  private readonly baseUrl: string;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Optional() @Inject(TextsService) private readonly texts?: TextsService,
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
    await this.syncPhone(id, email, session.identity);
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
    if (creds.kind === 'cookie' && (await this.idleTooLong(user))) {
      await this.admin('DELETE', `/admin/sessions/${encodeURIComponent(session.id)}`, undefined, [404]).catch(
        (err: Error) => this.logger.warn(`Could not end an idle session: ${err.message}`),
      );
      return null;
    }
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
   * ADR-0049 §6: the number is Kratos's (a trait, verified by a texted code). The API keeps a copy for texting alerts,
   * refreshed here. A change is an identity change (ADR-0045): logged, and emailed to the address that signs in.
   */
  private async syncPhone(userId: string, email: string, identity: KratosSession['identity']): Promise<void> {
    const raw = typeof identity.traits.phone === 'string' ? identity.traits.phone.trim() : '';
    const phone = /^\+[1-9]\d{6,14}$/.test(raw) ? raw : null;
    const verified = Boolean(
      phone && identity.verifiable_addresses?.some((a) => a.via === 'sms' && a.value === phone && a.verified),
    );
    try {
      const { rows } = await this.db.run({ userId }, (trx) =>
        sql<{ previous: string | null; changed: boolean }>`
          select * from app.sync_user_phone(${userId}::uuid, ${phone}, ${verified})`.execute(trx),
      );
      if (!rows[0]?.changed) return;
      const at = new Date();
      await this.db.run({ userId }, (trx) =>
        trx
          .insertInto('app.security_event')
          .values({
            user_id: userId,
            workspace_id: null,
            kind: 'phone_changed',
            detail: JSON.stringify({ added: Boolean(phone && !rows[0]!.previous), removed: !phone }),
          })
          .execute(),
      );
      await this.mail.send(
        templates.phoneChanged({
          to: email,
          at,
          now: phone,
          url: `${this.config.WEB_URL}/settings/security`,
          timeZone: await timeZoneOf(this.db, userId),
        }),
      );
    } catch (err) {
      this.logger.warn(`Could not sync a phone number: ${(err as Error).message}`);
    }
  }

  /** When this browser session was last used, from the device list; idle past the limit means it's over. */
  private async idleTooLong(user: AuthUser): Promise<boolean> {
    if (!user.sessionId) return false;
    const row = await this.db.run({ userId: user.id }, (trx) =>
      trx
        .selectFrom('app.session_device')
        .select('last_seen_at')
        .where('user_id', '=', user.id)
        .where('kratos_session_id', '=', user.sessionId!)
        .executeTakeFirst(),
    );
    return Boolean(row && Date.now() - row.last_seen_at.getTime() > WEB_IDLE_LIMIT_MS);
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
      await this.db
        .run({ userId: user.id }, (trx) =>
          trx
            .insertInto('app.security_event')
            .values({
              user_id: user.id,
              workspace_id: null,
              kind: 'sign_in_new_device',
              detail: JSON.stringify({ userAgent, ip }),
            })
            .execute(),
        )
        .catch((err: Error) => this.logger.warn(`Could not log a new device: ${err.message}`));
      await this.mail
        .send(
          templates.newDevice({
            to: user.email,
            userAgent,
            ip,
            at: new Date(),
            url: `${this.config.WEB_URL}/settings/security`,
            timeZone: await timeZoneOf(this.db, user.id),
          }),
        )
        .catch((err: Error) => this.logger.warn(`new-device alert failed: ${err.message}`));
      await this.texts
        ?.securityAlert(
          user.id,
          'a new device signed in to your account. If it wasn’t you, change your password now.',
        )
        .catch((err: Error) => this.logger.warn(`new-device text failed: ${err.message}`));
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

  /**
   * Both addresses were confirmed by code, so the new address is stored as verified. Kratos rebuilds the verifiable
   * and recovery addresses from the traits, so the new email arrives as an unverified address and the recovery address
   * follows by itself; only the verified mark is ours to set. It's found by `via` and value, never by index: with a
   * number on the account, index 0 can be the number's address.
   */
  async changeEmail(identityId: string, newEmail: string): Promise<void> {
    const path = `/admin/identities/${encodeURIComponent(identityId)}`;
    await this.admin('PATCH', path, [{ op: 'replace', path: '/traits/email', value: newEmail }]);
    await this.markVerified(path, 'email', newEmail);
    this.evictIdentity(identityId);
  }

  async removeSecondFactors(identityId: string): Promise<void> {
    const base = `/admin/identities/${encodeURIComponent(identityId)}`;
    for (const type of ['totp', 'webauthn', 'lookup_secret']) {
      await this.admin('DELETE', `${base}/credentials/${type}`, undefined, [404]);
    }
    await this.admin('DELETE', `${base}/sessions`, undefined, [404]);
    this.evictIdentity(identityId);
    this.factors.delete(identityId);
  }

  /** ADR-0049 §4: an inactive identity can't sign in, and its sessions are ended at once. */
  async setIdentityActive(identityId: string, active: boolean): Promise<void> {
    const base = `/admin/identities/${encodeURIComponent(identityId)}`;
    await this.admin('PATCH', base, [
      { op: 'replace', path: '/state', value: active ? 'active' : 'inactive' },
    ]);
    if (!active) await this.admin('DELETE', `${base}/sessions`, undefined, [404]);
    this.evictIdentity(identityId);
  }

  /**
   * ADR-0049 §6: the number goes on the identity only once the API has confirmed it, and is marked verified in the
   * same step, so Kratos never holds it unverified (and never texts its own code, whose flow it doesn't name).
   */
  async setPhone(identityId: string, phone: string | null): Promise<void> {
    const path = `/admin/identities/${encodeURIComponent(identityId)}`;
    if (!phone) {
      // Kratos v26.2.0 keeps a removed number as a sign-in code identifier, which would stop anyone else ever adding
      // it; the code credential holds nothing else (email isn't a code identifier), so it goes too.
      const current = (await this.admin('GET', path)) as KratosIdentity;
      const ops = [
        ...(current.traits?.phone !== undefined ? [{ op: 'remove', path: '/traits/phone' }] : []),
        ...(current.credentials?.code ? [{ op: 'remove', path: '/credentials/code' }] : []),
      ];
      if (ops.length) await this.admin('PATCH', path, ops);
    } else {
      await this.admin('PATCH', path, [{ op: 'add', path: '/traits/phone', value: phone }]).catch(
        (err: unknown) => {
          if (err instanceof AppError && err.status === 409)
            throw new AppError(409, 'phone.in_use', 'That number is on another account');
          throw err;
        },
      );
      await this.markVerified(path, 'sms', phone);
    }
    this.evictIdentity(identityId);
  }

  /**
   * Marks one verifiable address verified. Kratos v26.2.0 doesn't keep them in a fixed order (the order a PATCH works on
   * can differ from what a read shows) and has no JSON Patch `test`, so an index can't be trusted: the whole list is
   * written back with that one address changed, then read again to be sure. Kratos stores an email address in lower
   * case whatever the trait's case, so emails match without it.
   */
  private async markVerified(path: string, via: 'email' | 'sms', value: string): Promise<void> {
    const same = (a: string) => (via === 'email' ? a.toLowerCase() === value.toLowerCase() : a === value);
    const matches = (a: KratosAddress) => a.via === via && same(a.value);
    const current = ((await this.admin('GET', path)) as KratosIdentity).verifiable_addresses ?? [];
    if (current.some(matches)) {
      await this.admin('PATCH', path, [
        {
          op: 'replace',
          path: '/verifiable_addresses',
          value: current.map((a) => (matches(a) ? { ...a, verified: true, status: 'completed' } : a)),
        },
      ]);
      const after = ((await this.admin('GET', path)) as KratosIdentity).verifiable_addresses ?? [];
      if (after.some((a) => matches(a) && a.verified)) return;
    }
    throw new AppError(502, 'auth.admin_failed', 'The address couldn’t be marked as confirmed');
  }

  /** From the identity's credentials: TOTP, a registered security key or recovery codes count (ADR-0044). */
  async hasSecondFactor(identityId: string): Promise<boolean | null> {
    const hit = this.factors.get(identityId);
    if (hit && hit.until > Date.now()) return hit.value;
    const base = this.config.KRATOS_ADMIN_URL?.replace(/\/$/, '');
    if (!base) return null;
    try {
      // `include_credential=webauthn` returns the security keys themselves: Kratos keeps an empty `webauthn` entry
      // on identities that never registered one (a password sign-up through the browser), so the type alone says
      // nothing.
      const url = `${base}/admin/identities/${encodeURIComponent(identityId)}?include_credential=webauthn`;
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { credentials?: Record<string, KratosCredential> };
      const value = hasSecondFactorCredential(body.credentials);
      if (value) this.factors.set(identityId, { value, until: Date.now() + 60_000 });
      return value;
    } catch (err) {
      this.logger.warn(`Could not read the second factors of an identity: ${(err as Error).message}`);
      return null;
    }
  }

  /** A call to Kratos's admin API; the JSON it answers, if any. */
  private async admin(
    method: 'GET' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<unknown> {
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
    const text = await res.text().catch(() => '');
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      return null;
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
      return { headers: { 'x-session-token': token }, cacheKey: hash(`t:${token}`), kind: 'token' };
    }
    const cookie = req.headers.cookie;
    const session = cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('ory_kratos_session='));
    if (session) return { headers: { cookie: session }, cacheKey: hash(`c:${session}`), kind: 'cookie' };
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
