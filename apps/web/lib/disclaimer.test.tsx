import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RecommendationDto } from '@montra/api-client';
import { recommendationDisclaimer } from '@montra/schemas';
import { RecommendationList } from '@/components/planning/recommendations';
import { Disclaimer } from '@/components/ui/disclaimer';

// The list's actions refresh the page through the app router, which a static render doesn't mount.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const rec = (type: RecommendationDto['type'], id = type): RecommendationDto => ({
  id,
  type,
  entityId: 'e1',
  budgetId: null,
  periodStart: '2026-11-01' as RecommendationDto['periodStart'],
  status: 'open',
  title: `A ${type} suggestion`,
  wording: null,
  payload: { currency: 'USD', figures: {}, subjects: [], actions: [], review: null },
  createdAt: '2026-11-01T00:00:00Z',
  resolvedAt: null,
});

const count = (html: string, kind: string) => html.split(`data-testid="disclaimer-${kind}"`).length - 1;

describe('disclaimers (AIA-12, NFR-14)', () => {
  it('says a tax output is not tax advice, and a financial one not financial advice', () => {
    expect(renderToStaticMarkup(<Disclaimer kind="tax" />)).toContain('not tax advice');
    expect(renderToStaticMarkup(<Disclaimer kind="financial" />)).toContain('not financial advice');
  });

  it('picks the tax line for a list with a tax set-aside or due date, the financial one otherwise', () => {
    expect(recommendationDisclaimer(['REC-02', 'REC-06'])).toBe('financial');
    expect(recommendationDisclaimer(['REC-02', 'REC-09'])).toBe('tax');
    expect(recommendationDisclaimer(['BIZ-09'])).toBe('tax');
    expect(recommendationDisclaimer(['BIZ-11'])).toBe('financial');
  });

  it('ends a list of suggestions with the line once, and leaves it off when the page shows its own', () => {
    const items = [rec('REC-02'), rec('REC-05')];
    const html = renderToStaticMarkup(
      <RecommendationList workspaceId="w1" items={items} categoryNames={{}} />,
    );
    expect(count(html, 'financial')).toBe(1);
    expect(count(html, 'tax')).toBe(0);

    const tax = renderToStaticMarkup(
      <RecommendationList workspaceId="w1" items={[rec('BIZ-09'), rec('BIZ-11')]} categoryNames={{}} />,
    );
    expect(count(tax, 'tax')).toBe(1);

    const off = renderToStaticMarkup(
      <RecommendationList workspaceId="w1" items={items} categoryNames={{}} disclaimer={false} />,
    );
    expect(off).not.toContain('disclaimer-');
  });
});
