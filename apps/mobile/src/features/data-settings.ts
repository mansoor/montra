/**
 * Notification and data settings on the phone (OPS-13). The server decides everything; these only shape what's on screen and what's
 * sent back, so a change to one switch can't overwrite the others.
 */
import type { ChannelPrefs, ExportJobDto, NotificationPrefsDto, NotificationType } from '@montra/schemas';

/** What someone can switch here, in the order it's shown. Backups aren't listed: those go out because they were asked for. */
export const NOTIFICATION_ROWS: readonly NotificationType[] = [
  'bill_due',
  'low_balance',
  'overspend_pace',
  'large_transaction',
  'rent_overdue',
  'lease_expiring',
  'reminder',
  'tax_due',
  'import_reminder',
  'monthly_review',
  'suggestion',
  'weekly_digest',
];

/** One channel of one type, leaving the other channels and types as they are. */
export function toggleChannel(
  channels: NotificationPrefsDto['channels'],
  type: NotificationType,
  channel: keyof ChannelPrefs,
  on: boolean,
): Partial<NotificationPrefsDto['channels']> {
  const current = channels[type] ?? { inApp: true, email: false, push: false };
  return { [type]: { ...current, [channel]: on } };
}

/** Whether anything is still being made, so the screen knows to look again. */
export const hasRunningExport = (jobs: readonly ExportJobDto[]): boolean =>
  jobs.some((j) => j.status === 'queued' || j.status === 'running');

/**
 * What to say when a request fails. Taking the books out or deleting the account needs a recent sign-in (AUTH-09), and the phone has no
 * password prompt of its own, so it says how to get one.
 */
export function needsFreshSignIn(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'reauth.required';
}

export function humanBytes(bytes: string | null): string {
  if (!bytes) return '';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
