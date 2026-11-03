/**
 * Receipt pages the app keeps until they upload (TXN-09): camera and picker files live in caches the OS may
 * clear, so each capture is copied to the app's documents directory first.
 */
import { Directory, File, Paths } from 'expo-file-system';
import type { ReceiptPage, ReceiptPageType } from '@montra/sync';
import { pageName } from '../features/receipt-capture';

export async function keepPages(
  receiptId: string,
  sources: ReadonlyArray<{ uri: string; type: ReceiptPageType; name?: string }>,
): Promise<ReceiptPage[]> {
  const dir = new Directory(Paths.document, 'receipts', receiptId);
  dir.create({ intermediates: true, idempotent: true });
  const pages: ReceiptPage[] = [];
  for (const [i, s] of sources.entries()) {
    const name = s.type === 'application/pdf' ? `page-${i + 1}.pdf` : pageName(i + 1);
    const dest = new File(dir, name);
    await new File(s.uri).copy(dest);
    pages.push({ uri: dest.uri, name: s.name ?? name, type: s.type });
  }
  return pages;
}

export async function removePage(uri: string): Promise<void> {
  const f = new File(uri);
  if (f.exists) f.delete();
}
