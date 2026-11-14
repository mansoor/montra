/**
 * The store's details on a receipt (RCP-01) as things to tap: the address opens the map, the phone number calls, the
 * website opens in the browser.
 */
import type { ReceiptDto } from '@montra/schemas';

export interface StoreLink {
  kind: 'place' | 'phone' | 'website';
  text: string;
  url: string;
}

export function storeLinks(
  r: Pick<ReceiptDto, 'storeAddress' | 'storePhone' | 'storeWebsite'>,
  os: string,
): StoreLink[] {
  const links: StoreLink[] = [];
  if (r.storeAddress) {
    const q = encodeURIComponent(r.storeAddress);
    links.push({
      kind: 'place',
      text: r.storeAddress,
      url: os === 'ios' ? `https://maps.apple.com/?q=${q}` : `geo:0,0?q=${q}`,
    });
  }
  if (r.storePhone) {
    const digits = r.storePhone.replace(/[^\d+]/g, '');
    if (digits) links.push({ kind: 'phone', text: r.storePhone, url: `tel:${digits}` });
  }
  if (r.storeWebsite) links.push({ kind: 'website', text: r.storeWebsite, url: `https://${r.storeWebsite}` });
  return links;
}
