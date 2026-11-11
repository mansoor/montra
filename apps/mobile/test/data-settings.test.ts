import { describe, expect, it } from 'vitest';
import type { ExportJobDto, NotificationPrefsDto, StorageDestinationDto } from '@montra/schemas';
import {
  hasRunningExport,
  humanBytes,
  needsFreshSignIn,
  NOTIFICATION_ROWS,
  storageStatusLine,
  toggleChannel,
} from '../src/features/data-settings';

const on = { inApp: true, email: true, push: true };

describe('toggleChannel', () => {
  it('changes one channel of one type and sends only that', () => {
    const channels = { bill_due: on, reminder: on } as NotificationPrefsDto['channels'];
    expect(toggleChannel(channels, 'bill_due', 'push', false)).toEqual({
      bill_due: { inApp: true, email: true, push: false },
    });
  });

  it('has safe defaults for a type it has not seen', () => {
    expect(toggleChannel({} as NotificationPrefsDto['channels'], 'reminder', 'email', true)).toEqual({
      reminder: { inApp: true, email: true, push: false },
    });
  });
});

describe('the rows', () => {
  it('don’t offer to turn off what someone asked for', () => {
    expect(NOTIFICATION_ROWS).not.toContain('backup_ready');
    expect(NOTIFICATION_ROWS).not.toContain('storage_failing');
    expect(NOTIFICATION_ROWS).toContain('weekly_digest');
  });
});

describe('hasRunningExport', () => {
  const job = (status: ExportJobDto['status']) => ({ status }) as ExportJobDto;

  it('looks again only while something is being made', () => {
    expect(hasRunningExport([job('ready'), job('running')])).toBe(true);
    expect(hasRunningExport([job('queued')])).toBe(true);
    expect(hasRunningExport([job('ready'), job('failed'), job('expired')])).toBe(false);
    expect(hasRunningExport([])).toBe(false);
  });
});

describe('needsFreshSignIn', () => {
  it('only for the step-up refusal', () => {
    expect(needsFreshSignIn({ code: 'reauth.required' })).toBe(true);
    expect(needsFreshSignIn({ code: 'forbidden' })).toBe(false);
    expect(needsFreshSignIn(new Error('boom'))).toBe(false);
    expect(needsFreshSignIn(null)).toBe(false);
  });
});

describe('humanBytes', () => {
  it('reads for people', () => {
    expect(humanBytes(null)).toBe('');
    expect(humanBytes('900')).toBe('900 B');
    expect(humanBytes('2048')).toBe('2.0 KB');
    expect(humanBytes(String(3 * 1024 ** 2))).toBe('3.0 MB');
  });
});

describe('storageStatusLine (ADR-0031)', () => {
  const d = (over: Partial<StorageDestinationDto>) =>
    ({
      status: 'active',
      files: { pending: 0, done: 3, failed: 0, skipped: 0 },
      ...over,
    }) as StorageDestinationDto;

  it('says what matters most first', () => {
    expect(storageStatusLine(d({ status: 'failing' })).key).toBe('storage.summary_failing');
    expect(storageStatusLine(d({ status: 'paused' })).key).toBe('storage.summary_paused');
    expect(storageStatusLine(d({ files: { pending: 2, done: 3, failed: 1, skipped: 0 } }))).toEqual({
      key: 'storage.summary_copying',
      values: { n: 2 },
    });
    expect(storageStatusLine(d({ files: { pending: 0, done: 3, failed: 1, skipped: 0 } })).key).toBe(
      'storage.summary_failed',
    );
    expect(storageStatusLine(d({}))).toEqual({ key: 'storage.summary_ok', values: { n: 3 } });
  });
});
