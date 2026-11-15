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
  })
  .partial()
  .refine((v) => (v.quietStart === undefined) === (v.quietEnd === undefined), {
    message: 'Set both ends of quiet hours',
  })
  .refine((v) => (v.quietStart === null) === (v.quietEnd === null), {
    message: 'Set both ends of quiet hours',
  });
export type UpdateNotificationPrefsRequest = z.output<typeof UpdateNotificationPrefsRequest>;
