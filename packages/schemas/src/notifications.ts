/** Notifications and their preferences (NOT-01..03, OPS-10; ADR-0019). */
import { z } from 'zod';
import { Id } from './common.js';

export const NOTIFICATION_TYPES = [
  'bill_due',
  'low_balance',
  'overspend_pace',
  'large_transaction',
  'rent_overdue',
  'lease_expiring',
  'import_reminder',
  'monthly_review',
  'tax_due',
  'reminder',
  'suggestion',
  'weekly_digest',
  'backup_ready',
  'storage_failing',
  'ai_allowance',
  /** ADR-0052 §11: on 16 February, the expected tax forms that haven't come. */
  'tax_forms_missing',
  /** ADR-0054 §12: the Family Document Vault needs a person (its connection stopped, or it didn't keep documents). */
  'vault_attention',
  /** ADR-0054 §5a: files Montra no longer holds that the vault didn't give back; at most one a day, no file names. */
  'files_missing',
  /** ADR-0055 §7: a bank feed needs a person (access revoked, payment, failing, a bank to sign in to); once, no amounts. */
  'bank_feed_attention',
  /** RCP-10 (migration 0079): receipts or files past their retention date wait for an owner's approval; once per new set. */
  'retention_due',
] as const;
export const NotificationType = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationType>;

export const NotificationDto = z.object({
  id: Id,
  type: NotificationType,
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type NotificationDto = z.infer<typeof NotificationDto>;

export const NotificationListDto = z.object({
  data: z.array(NotificationDto),
  unread: z.number().int(),
});
export type NotificationListDto = z.infer<typeof NotificationListDto>;

export const ChannelPrefs = z.object({ inApp: z.boolean(), email: z.boolean(), push: z.boolean() });
export type ChannelPrefs = z.infer<typeof ChannelPrefs>;

export const NotificationPrefsDto = z.object({
  channels: z.record(NotificationType, ChannelPrefs),
  /** Minutes after local midnight; both null turns quiet hours off. */
  quietStart: z.number().int().nullable(),
  quietEnd: z.number().int().nullable(),
  dailyCap: z.number().int(),
  /** 1 is Monday, as in `week_start`. */
  digestWeekday: z.number().int(),
  largeTransaction: z.string(),
  lowBalanceDays: z.number().int(),
  importReminderDays: z.number().int(),
  emailUnsubscribed: z.boolean(),
  /**
   * ADR-0049 §6: alerts and reminders by text, to the number verified in security settings. `available` is false when
   * this service doesn't send texts. Reminders by text also need a plan that includes them.
   */
  texts: z.object({
    available: z.boolean(),
    /** The country code and last four digits only. */
    phone: z.string().nullable(),
    verified: z.boolean(),
    /** The number replied STOP. Texts start again once the number changes. */
    optedOut: z.boolean(),
    security: z.boolean(),
    reminders: z.boolean(),
  }),
  version: z.number().int(),
});
export type NotificationPrefsDto = z.infer<typeof NotificationPrefsDto>;

const Minutes = z.number().int().min(0).max(1439);

export const UpdateNotificationPrefsRequest = z
  .object({
    channels: z.partialRecord(NotificationType, ChannelPrefs),
    quietStart: Minutes.nullable(),
    quietEnd: Minutes.nullable(),
    dailyCap: z.number().int().min(0).max(50),
    digestWeekday: z.number().int().min(1).max(7),
    largeTransaction: z.string().regex(/^\d{1,15}$/),
    lowBalanceDays: z.number().int().min(1).max(90),
    importReminderDays: z.number().int().min(1).max(90),
    emailUnsubscribed: z.boolean(),
    texts: z.object({ security: z.boolean(), reminders: z.boolean() }).partial(),
  })
  .partial()
  .refine((v) => (v.quietStart === undefined) === (v.quietEnd === undefined), {
    message: 'Set both ends of quiet hours',
  })
  .refine((v) => (v.quietStart === null) === (v.quietEnd === null), {
    message: 'Set both ends of quiet hours',
  });
export type UpdateNotificationPrefsRequest = z.output<typeof UpdateNotificationPrefsRequest>;

/**
 * ADR-0049 §6: the mobile number, confirmed by a code the API texts (`POST /v1/me/phone`, then
 * `POST /v1/me/phone/confirm`). Numbers show as the country code and last four digits only.
 */
export const PhoneStatusDto = z.object({
  /** False where this service doesn't send texts: a number couldn't be confirmed. */
  available: z.boolean(),
  phone: z.string().nullable(),
  verified: z.boolean(),
  /** A number waiting for its code, until the code expires. */
  pending: z.object({ phone: z.string(), expiresAt: z.string() }).nullable(),
});
export type PhoneStatusDto = z.infer<typeof PhoneStatusDto>;

/** With the country code; spaces, dashes and brackets are fine. */
export const StartPhoneVerificationRequest = z.object({ phone: z.string().trim().min(1).max(40) });
export type StartPhoneVerificationRequest = z.output<typeof StartPhoneVerificationRequest>;

export const ConfirmPhoneRequest = z.object({ code: z.string().regex(/^\d{6}$/) });
export type ConfirmPhoneRequest = z.output<typeof ConfirmPhoneRequest>;
