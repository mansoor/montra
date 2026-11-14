import { describe, expect, it } from 'vitest';
import { asFileUri, scanPages } from '../src/features/scanner';

const scanner = (result: { scannedImages?: string[]; status?: string } | Error) => async () => ({
  default: {
    scanDocument: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  },
});

describe('the document scanner (ADR-0047)', () => {
  it('returns the cropped pages as file URIs', async () => {
    expect(
      await scanPages(
        scanner({ status: 'success', scannedImages: ['/data/user/0/scan-1.jpg', 'file:///x/2.jpg'] }),
      ),
    ).toEqual({ kind: 'scanned', uris: ['file:///data/user/0/scan-1.jpg', 'file:///x/2.jpg'] });
  });

  it('says when it was closed without a scan', async () => {
    expect(await scanPages(scanner({ status: 'cancel' }))).toEqual({ kind: 'cancelled' });
    expect(await scanPages(scanner({ status: 'success', scannedImages: [] }))).toEqual({
      kind: 'cancelled',
    });
  });

  it('falls back when the scanner isn’t on this phone or fails to start', async () => {
    const missing = () =>
      Promise.reject(new Error("TurboModuleRegistry: 'DocumentScanner' could not be found"));
    expect(await scanPages(missing)).toMatchObject({ kind: 'unavailable' });
    expect(await scanPages(scanner(new Error('Google Play services are missing')))).toEqual({
      kind: 'unavailable',
      reason: 'Google Play services are missing',
    });
  });

  it('leaves URIs alone', () => {
    expect(asFileUri('content://media/1')).toBe('content://media/1');
  });
});

describe('waiting for a scan to be read (ADR-0048)', () => {
  it('checks until the reading is done, or gives up', async () => {
    const { waitForScan } = await import('../src/features/scanner');
    const states = ['reading', 'reading', 'ready'];
    let calls = 0;
    const done = await waitForScan(
      async () => ({ status: states[calls++] ?? 'ready' }),
      10,
      1000,
      async () => undefined,
    );
    expect(done).toEqual({ status: 'ready' });
    expect(calls).toBe(3);
    const never = await waitForScan(
      async () => ({ status: 'reading' }),
      10,
      30,
      async () => undefined,
    );
    expect(never).toBeNull();
  });
});
