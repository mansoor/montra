/** Running the service: plans, the staff console, support access, notices and help (ADR-0020). */
import { z } from 'zod';
import { Id } from './common.js';

// ----- Plans and billing (UP-12, OPS-08) --------------------------------------------------------

export const PlanDto = z.enum(['free', 'pro']);
export type PlanDto = z.infer<typeof PlanDto>;

export const BillingDto = z.object({
  /** `off`: no plans here, as in a self-hosted install, and everything is available. */
  mode: z.enum(['off', 'stripe']),
  plan: PlanDto,
  status: z.enum(['none', 'trialing', 'active', 'past_due', 'canceled']),
  provider: z.enum(['stripe', 'apple', 'google', 'staff']).nullable(),
  interval: z.enum(['month', 'year']).nullable(),
  trialEnd: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  graceUntil: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  features: z.object({
    businessEntities: z.boolean(),
    rentalEntities: z.boolean(),
    maxBusinesses: z.number().int(),
    maxRentalPortfolios: z.number().int(),
    storageBytes: z.string(),
  }),
  flags: z.record(z.string(), z.boolean()),
  canManage: z.boolean(),
});
export type BillingDto = z.infer<typeof BillingDto>;

export const CheckoutRequest = z.object({ interval: z.enum(['month', 'year']) });
export type CheckoutRequest = z.output<typeof CheckoutRequest>;

export const BillingLinkDto = z.object({ url: z.string() });
export type BillingLinkDto = z.infer<typeof BillingLinkDto>;

// ----- Support access (OPS-02) ------------------------------------------------------------------

export const SUPPORT_GRANT_DEFAULT_HOURS = 72;

export const CreateSupportGrantRequest = z.object({
  hours: z.number().int().min(1).max(168).default(SUPPORT_GRANT_DEFAULT_HOURS),
  reason: z.string().trim().max(500).default(''),
});
export type CreateSupportGrantRequest = z.output<typeof CreateSupportGrantRequest>;

export const SupportGrantDto = z.object({
  id: Id,
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  reason: z.string(),
  createdAt: z.string(),
  active: z.boolean(),
});
export type SupportGrantDto = z.infer<typeof SupportGrantDto>;

// ----- Notices and status (OPS-03, OPS-04) ------------------------------------------------------

export const NoticeKind = z.enum(['maintenance', 'incident', 'info']);

export const SystemNoticeDto = z.object({
  id: Id,
  kind: NoticeKind,
  title: z.string(),
  body: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
});
export type SystemNoticeDto = z.infer<typeof SystemNoticeDto>;

/**
 * Background workers, judged by their queues: `delayed` when work has waited minutes without being picked up.
 * `documents` is the doc-worker (OCR of scans and receipts); `jobs` is the API's job worker (imports, AI).
 */
export const WorkerState = z.enum(['ok', 'delayed']);
export type WorkerState = z.infer<typeof WorkerState>;

export const StatusDto = z.object({
  status: z.enum(['operational', 'maintenance', 'incident', 'down']),
  checkedAt: z.string(),
  notices: z.array(SystemNoticeDto),
  workers: z.object({ documents: WorkerState, jobs: WorkerState }),
});
export type StatusDto = z.infer<typeof StatusDto>;

// ----- Help (OPS-09) ----------------------------------------------------------------------------

/** About 1.5 MB once it's base64: a screenshot, not a recording. */
export const MAX_SCREENSHOT_BASE64 = 2_000_000;

export const CreateSupportRequest = z.object({
  kind: z.enum(['question', 'bug']),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  workspaceId: Id.optional(),
  /** What the app was doing, sent only if the person left the box ticked. Never amounts or row data. */
  context: z
    .object({
      path: z.string().max(500).optional(),
      appVersion: z.string().max(50).optional(),
      userAgent: z.string().max(500).optional(),
      logs: z.array(z.string().max(500)).max(50).optional(),
    })
    .optional(),
  screenshot: z.string().max(MAX_SCREENSHOT_BASE64).optional(),
});
export type CreateSupportRequest = z.output<typeof CreateSupportRequest>;

export const ClientErrorRequest = z.object({
  message: z.string().max(500),
  stack: z.string().max(4000).optional(),
  path: z.string().max(500).optional(),
  source: z.enum(['web', 'mobile']),
});
export type ClientErrorRequest = z.output<typeof ClientErrorRequest>;

// ----- Staff console (OPS-01, OPS-05) -----------------------------------------------------------

export const StaffRole = z.enum(['support', 'admin']);
export type StaffRole = z.infer<typeof StaffRole>;

export const StaffMeDto = z.object({ role: StaffRole });
export type StaffMeDto = z.infer<typeof StaffMeDto>;

export const AdminAccountDto = z.object({
  id: Id,
  email: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  workspaces: z.number().int(),
});
export type AdminAccountDto = z.infer<typeof AdminAccountDto>;

export const AdminWorkspaceDto = z.object({
  id: Id,
  name: z.string(),
  role: z.string(),
  plan: PlanDto,
  status: z.string(),
  provider: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  graceUntil: z.string().nullable(),
  quotaBytes: z.string(),
  usedBytes: z.string(),
  members: z.number().int(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  /** Set when the owner has let support look, until then. */
  supportUntil: z.string().nullable(),
});
export type AdminWorkspaceDto = z.infer<typeof AdminWorkspaceDto>;

export const AdminSetPlanRequest = z.object({
  plan: PlanDto,
  reason: z.string().trim().min(3).max(500),
});
export type AdminSetPlanRequest = z.output<typeof AdminSetPlanRequest>;

export const FeatureFlagDto = z.object({
  key: z.string(),
  enabled: z.boolean(),
  rollout: z.number().int(),
  note: z.string(),
  updatedAt: z.string(),
});
export type FeatureFlagDto = z.infer<typeof FeatureFlagDto>;

export const SaveFeatureFlagRequest = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  enabled: z.boolean(),
  rollout: z.number().int().min(0).max(100).default(100),
  note: z.string().trim().max(500).default(''),
});
export type SaveFeatureFlagRequest = z.output<typeof SaveFeatureFlagRequest>;

export const CreateNoticeRequest = z.object({
  kind: NoticeKind,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(2000).default(''),
  showFrom: z.iso.datetime().optional(),
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime().optional(),
});
export type CreateNoticeRequest = z.output<typeof CreateNoticeRequest>;

export const AppVersionsDto = z.object({
  ios: z.string().regex(/^\d+\.\d+\.\d+$/),
  android: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type AppVersionsDto = z.infer<typeof AppVersionsDto>;

export const ImportFailureRowDto = z.object({
  institution: z.string(),
  fileType: z.string(),
  batches: z.number().int(),
  failed: z.number().int(),
  neededMapping: z.number().int(),
  rowsFailed: z.number().int(),
});
export type ImportFailureRowDto = z.infer<typeof ImportFailureRowDto>;

export const AiAccuracyRowDto = z.object({
  task: z.string(),
  provider: z.string(),
  model: z.string(),
  calls: z.number().int(),
  failures: z.number().int(),
  accepted: z.number().int(),
  edited: z.number().int(),
  rejected: z.number().int(),
  costMicroUsd: z.string(),
});
export type AiAccuracyRowDto = z.infer<typeof AiAccuracyRowDto>;

export const AdminSupportRequestDto = z.object({
  id: Id,
  email: z.string(),
  kind: z.string(),
  subject: z.string(),
  body: z.string(),
  context: z.record(z.string(), z.unknown()),
  hasScreenshot: z.boolean(),
  status: z.string(),
  createdAt: z.string(),
  workspaceId: Id.nullable(),
});
export type AdminSupportRequestDto = z.infer<typeof AdminSupportRequestDto>;

export const ReferenceDataset = z.enum(['merchant', 'mileage_rate', 'tax_line']);
export type ReferenceDataset = z.infer<typeof ReferenceDataset>;

export const SaveMerchantRequest = z.object({
  id: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(200),
  matchKey: z.string().trim().min(2).max(200),
  mcc: z.string().trim().max(10).optional(),
  categoryHint: z.string().trim().max(200).optional(),
});
export type SaveMerchantRequest = z.output<typeof SaveMerchantRequest>;

export const SaveMileageRateRequest = z.object({
  country: z.string().length(2),
  effectiveFrom: z.iso.date(),
  tenthsOfCent: z.number().int().positive().max(100000),
  source: z.string().trim().min(1).max(200),
});
export type SaveMileageRateRequest = z.output<typeof SaveMileageRateRequest>;

export const SupportViewDto = z.object({
  workspace: z.object({ id: Id, name: z.string(), baseCurrency: z.string() }),
  expiresAt: z.string(),
  entities: z.array(z.object({ id: Id, type: z.string(), name: z.string(), currency: z.string() })),
  imports: z.array(
    z.object({
      id: Id,
      status: z.string(),
      fileType: z.string(),
      rowsRead: z.number().int(),
      rowsAdded: z.number().int(),
      rowsFailed: z.number().int(),
      mappingSource: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  aiEvents: z.array(
    z.object({
      task: z.string(),
      provider: z.string(),
      model: z.string(),
      outcome: z.string(),
      userAction: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type SupportViewDto = z.infer<typeof SupportViewDto>;
