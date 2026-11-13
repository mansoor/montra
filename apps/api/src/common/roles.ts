import type { MemberRole } from '@montra/db';
import type { RequestContext } from '../auth/auth.js';
import { forbidden } from './errors.js';

/** The owner and admins: everything except the owner's own row and handing over ownership (AUTH-14, AUTH-15). */
export const ADMINS = ['owner', 'admin'] as const satisfies readonly MemberRole[];
/** Rules, rule suggestions and imports. */
export const RULE_EDITORS = [...ADMINS, 'partner', 'accountant'] as const satisfies readonly MemberRole[];

export const isAdmin = (role: string | null | undefined): boolean => role === 'owner' || role === 'admin';

/** Friendly role check before RLS (which remains the enforcement backstop). */
export function requireRole(ctx: RequestContext, ...roles: MemberRole[]): void {
  if (!ctx.role || !roles.includes(ctx.role))
    throw forbidden(`This action requires the ${roles.join(' or ')} role`);
}

export function requireWorkspaceAdmin(ctx: RequestContext): void {
  requireRole(ctx, ...ADMINS);
}

/**
 * What a member may change (AUTH-17): transactions, receipts and trips, and what recording them needs. Everything
 * else that writes is closed to them, so a new endpoint stays closed until it is added here. Paths are the route
 * patterns after `/v1/workspaces/:workspaceId/`.
 */
const MEMBER_WRITES = new Set([
  'POST transactions',
  'POST transactions/transfer',
  'POST transactions/bulk',
  'PATCH transactions/:id',
  'DELETE transactions/:id',
  'POST transactions/:id/restore',
  'POST transactions/:id/confirm',
  'POST transactions/:id/make-transfer',
  'PUT transactions/:id/expense-detail',
  'POST transactions/parse',
  'POST categorize/suggest',
  'POST review/accept',
  'POST review/:transactionId/resolve',
  'POST receipts/files',
  'POST receipts',
  'POST receipts/recommended/:transactionId/dismiss',
  'PATCH receipts/:id',
  'POST receipts/:id/apply',
  'POST receipts/:id/match',
  'POST receipts/:id/reject',
  'DELETE receipts/:id',
  'POST trips',
  'PATCH trips/:id',
  'DELETE trips/:id',
  'POST mileage-trips',
  'PATCH mileage-trips/:id',
  'DELETE mileage-trips/:id',
  'POST ai/tasks/:id/result',
  'POST notifications/:id/read',
  'POST notifications/read-all',
  'POST sync/push',
]);

/** True when a member may make this request. Reads are always allowed; RLS decides what they see. */
export function memberMayRequest(method: string, routeUrl: string | undefined): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const path = (routeUrl ?? '').replace(/^\/v1\/workspaces\/:workspaceId\/?/, '').replace(/\/+$/, '');
  return MEMBER_WRITES.has(`${m} ${path}`);
}
