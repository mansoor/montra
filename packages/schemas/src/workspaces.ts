import { z } from 'zod';
import { CurrencyCodeDto } from './common.js';

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
});
export type EntityDto = z.infer<typeof EntityDto>;

export const WorkspaceDto = z.object({
  id: z.string(),
  name: z.string(),
  baseCurrency: z.string(),
  timeZone: z.string(),
  role: z.enum(['owner', 'partner', 'viewer', 'accountant']),
  entities: z.array(EntityDto),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;
