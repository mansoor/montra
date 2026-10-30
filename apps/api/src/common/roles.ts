import type { MemberRole } from '@montra/db';
import type { RequestContext } from '../auth/auth.js';
import { forbidden } from './errors.js';

/** Friendly role check before RLS (which remains the enforcement backstop). */
export function requireRole(ctx: RequestContext, ...roles: MemberRole[]): void {
  if (!ctx.role || !roles.includes(ctx.role))
    throw forbidden(`This action requires the ${roles.join(' or ')} role`);
}
