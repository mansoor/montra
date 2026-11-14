/** The plan and the month's AI on the phone (ADR-0049 §1, §2). The phone shows plans; it doesn't sell them (ADR-0020 §5). */
import type { PlanOfferDto } from '@montra/schemas';

/** The share of this month's AI used, as a whole percent 0..100. Null when nothing limits it. */
export function aiUsedPercent(share: number | null | undefined): number | null {
  if (share === null || share === undefined || !Number.isFinite(share)) return null;
  return Math.min(100, Math.max(0, Math.floor(share * 100)));
}

/** Plans to show beside the one the workspace is on: paid ones with a price, in the owner's order. */
export function otherPlans(offers: readonly PlanOfferDto[], current: string): PlanOfferDto[] {
  return offers.filter((o) => o.key !== current && o.key !== 'free' && o.prices.length > 0);
}

/** The monthly price if there is one, else the yearly one. */
export function headlinePrice(offer: PlanOfferDto): PlanOfferDto['prices'][number] | null {
  return offer.prices.find((p) => p.interval === 'month') ?? offer.prices[0] ?? null;
}
