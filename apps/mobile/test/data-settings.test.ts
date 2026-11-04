import { describe, expect, it } from 'vitest';
import type { ExportJobDto, NotificationPrefsDto } from '@montra/schemas';
import {
  hasRunningExport,
  humanBytes,
  NOTIFICATION_ROWS,
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

describe('humanBytes', () => {
  it('reads for people', () => {
    expect(humanBytes(null)).toBe('');
    expect(humanBytes('900')).toBe('900 B');
    expect(humanBytes('2048')).toBe('2.0 KB');
    expect(humanBytes(String(3 * 1024 ** 2))).toBe('3.0 MB');
  });
});
