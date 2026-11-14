/**
 * The phone's own document scanner (ADR-0047): Google's ML Kit scanner on Android, Apple's VisionKit on iPhone. It
 * finds the receipt's edges as you aim, crops and straightens it, and takes several pages. Loaded lazily: where the
 * native module isn't there (Expo Go, a build without it, an Android phone without Google Play services), the
 * capture screen falls back to its own camera.
 */

export type ScanResult =
  { kind: 'scanned'; uris: string[] } | { kind: 'cancelled' } | { kind: 'unavailable'; reason: string };

interface Scanner {
  scanDocument(options: {
    croppedImageQuality?: number;
    maxNumDocuments?: number;
  }): Promise<{ scannedImages?: string[]; status?: string }>;
}

/** Up to 10 pages; 85 keeps a receipt's small print sharp at about a third of full quality's size. */
const OPTIONS = { croppedImageQuality: 85, maxNumDocuments: 10 };

/** File paths come back bare on some platforms; the rest of the app reads `file://` URIs. */
export const asFileUri = (path: string) => (path.startsWith('/') ? `file://${path}` : path);

export async function scanReceipt(
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
