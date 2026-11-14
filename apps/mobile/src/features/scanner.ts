/**
 * The phone's own document scanner (ADR-0047): Google's ML Kit scanner on Android, Apple's VisionKit on iPhone. It
 * finds the page's edges as you aim, crops and straightens it, and takes several pages. Every paper document uses it
 * (ADR-0048): receipts, statements, payslips, bills and reimbursement photos. Loaded lazily: where the native module
 * isn't there (Expo Go, a build without it, an Android phone without Google Play services), the capture screen falls
 * back to its own camera.
 */

export type PageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

/** A page ready to upload: scanned, shot with the app's camera or picked. */
export interface CapturedPage {
  uri: string;
  type: PageType;
  name: string;
  /** Made by the app (scanner or camera), so the app removes it after upload; a picked file belongs to the picker. */
  shot: boolean;
}

export type ScanResult =
  { kind: 'scanned'; uris: string[] } | { kind: 'cancelled' } | { kind: 'unavailable'; reason: string };

interface Scanner {
  scanDocument(options: {
    croppedImageQuality?: number;
    maxNumDocuments?: number;
  }): Promise<{ scannedImages?: string[]; status?: string }>;
}

/** Up to 10 pages; 85 keeps small print sharp at about a third of full quality's size. */
const OPTIONS = { croppedImageQuality: 85, maxNumDocuments: 10 };

/** File paths come back bare on some platforms; the rest of the app reads `file://` URIs. */
export const asFileUri = (path: string) => (path.startsWith('/') ? `file://${path}` : path);

export async function scanPages(
  load: () => Promise<{ default: Scanner }> = () => import('react-native-document-scanner-plugin'),
): Promise<ScanResult> {
  let scanner: Scanner;
  try {
    scanner = (await load()).default;
  } catch (err) {
    return { kind: 'unavailable', reason: (err as Error).message };
  }
  try {
    const r = await scanner.scanDocument(OPTIONS);
    const uris = (r.scannedImages ?? []).filter(Boolean).map(asFileUri);
    if (r.status === 'cancel' || uris.length === 0) return { kind: 'cancelled' };
    return { kind: 'scanned', uris };
  } catch (err) {
    return { kind: 'unavailable', reason: (err as Error).message };
  }
}

/** Waits for a scan to be read (ADR-0048), checking every `everyMs`, for at most `limitMs`; null when it took longer. */
export async function waitForScan<T extends { status: string }>(
  get: () => Promise<T>,
  everyMs = 1500,
  limitMs = 120_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T | null> {
  for (let waited = 0; waited <= limitMs; waited += everyMs) {
    const scan = await get();
    if (scan.status !== 'reading') return scan;
    await sleep(everyMs);
  }
  return null;
}
