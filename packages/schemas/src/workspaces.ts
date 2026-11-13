import { z } from 'zod';
import { CurrencyCodeDto, MemberRole } from './common.js';

export const WorkspaceTemplate = z.enum(['household', 'freelancer', 'landlord', 'hybrid']);

export const CreateWorkspaceRequest = z.object({
  name: z.string().trim().min(1).max(200),
  baseCurrency: CurrencyCodeDto,
  timeZone: z.string().min(1).max(64).default('UTC'),
  /** Onboarding template (UP-03): which entities to create alongside Personal. */
  template: WorkspaceTemplate.default('household'),
  businessName: z.string().trim().min(1).max(200).optional(),
  rentalName: z.string().trim().min(1).max(200).optional(),
});
export type CreateWorkspaceRequest = z.output<typeof CreateWorkspaceRequest>;

export const EntityDto = z.object({
  id: z.string(),
  type: z.enum(['personal', 'business', 'rental']),
  name: z.string(),
  functionalCurrency: z.string(),
  /** Books are closed through this date (DE-09); null when open. */
  lockedThrough: z.string().nullable(),
  /**
   * What the signed-in login may do in these books (AUTH-18): `read` for a viewer or a read-only grant. Books with no
   * access aren't listed. Clients hide what a read-only book can't take; the server still decides.
   */
  access: z.enum(['read', 'write']),
});
export type EntityDto = z.infer<typeof EntityDto>;

/**
 * A workspace's security rules (AUTH-04, AUTH-07, ADR-0044). `standard` requires two-step verification of owners,
 * admins, partners, accountants and anyone who can see business books; `everyone` of every login.
 */
export const MfaPolicy = z.enum(['standard', 'everyone']);
export type MfaPolicy = z.infer<typeof MfaPolicy>;

export const WorkspaceSecurityDto = z.object({
  mfaPolicy: MfaPolicy,
  idleTimeoutMinutes: z.number().int().min(5).max(30),
});
export type WorkspaceSecurityDto = z.infer<typeof WorkspaceSecurityDto>;

export const WorkspaceDto = z.object({
  id: z.string(),
  name: z.string(),
  baseCurrency: z.string(),
  timeZone: z.string(),
  role: MemberRole,
  entities: z.array(EntityDto),
  security: WorkspaceSecurityDto,
});
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;
