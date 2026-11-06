import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

/**
 * NFR-10, PLT-01: an automated WCAG 2.2 AA pass over the main screens in both themes. It catches about a third of what an audit would:
 * missing names, contrast, structure. A person with a screen reader still needs to go through it.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found = violations.map((v) => ({
    page: label,
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }));
  return found;
}

const PUBLIC_PAGES = ['/sign-in', '/help', '/help/getting-started', '/legal/privacy', '/status'];
const WORKSPACE_PAGES = [
  '',
  '/transactions',
  '/review',
  '/budget',
  '/goals',
  '/cash-flow',
  '/calendar',
  '/suggestions',
  '/receipts',
  '/payslips',
  '/payslips?tab=employers',
  '/upcoming',
  '/recurring',
  '/accounts',
  '/accounts/new',
  '/reports',
  '/reports/spending',
  '/reports/net-worth',
  '/search?q=coffee',
  '/ask',
  '/journal',
  '/imports',
  '/rules',
  '/members',
  '/insights',
  '/notifications',
  '/trash',
  '/help',
  '/settings?tab=profile',
  '/settings?tab=appearance',
  '/settings?tab=notifications',
  '/settings?tab=security',
  '/settings?tab=entities',
  '/settings?tab=family',
  '/settings?tab=accounts',
  '/settings?tab=sharing',
  '/settings?tab=planning',
  '/settings?tab=ai',
  '/settings?tab=data',
  '/settings?tab=privacy',
  '/settings?tab=billing',
  '/settings?tab=support',
];

/** PLT-01: usable from 360 px, which means no scrolling sideways. Wide tables scroll inside their own card. */
test('the main screens fit a 360 px phone', async ({ page }) => {
  test.setTimeout(240_000);
  await onboardHousehold(page, `narrow-${Date.now()}@example.com`, 'Joint checking');
  const base = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');
  await page.setViewportSize({ width: 360, height: 760 });
  const wide: { path: string; by: number }[] = [];
  for (const path of WORKSPACE_PAGES) {
    await page.goto(`${base}${path}`);
    await page.waitForLoadState('networkidle');
    const by = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (by > 0) wide.push({ path: path || '/', by });
  }
  expect(wide).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`in the ${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test('public pages have no WCAG violations', async ({ page }) => {
      const found = [];
      for (const path of PUBLIC_PAGES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        found.push(...(await audit(page, path)));
      }
      expect(found).toEqual([]);
    });

    test('the app’s screens have no WCAG violations', async ({ page }) => {
      test.setTimeout(240_000);
      await onboardHousehold(page, `a11y-${scheme}-${Date.now()}@example.com`, 'Joint checking');
      const base = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');
      // Enough in it that lists, tables and charts have something to show.
      const ws = `/api/v1/workspaces/${base.split('/')[2]}`;
      const accounts = (await (await page.request.get(`${ws}/accounts`)).json()).data as { id: string }[];
      const categories = (await (await page.request.get(`${ws}/categories`)).json()).data as {
        id: string;
        name: string;
      }[];
      await page.request.post(`${ws}/transactions`, {
        data: {
          date: new Date().toISOString().slice(0, 10),
          accountId: accounts[0]!.id,
          amount: { amount: '-4500', currency: 'USD' },
          payee: 'Corner Cafe',
          categoryId: categories.find((c) => c.name === 'Dining out')!.id,
        },
      });
      const entity = async (type: string, name: string) =>
        (await (await page.request.post(`${ws}/entities`, { data: { type, name } })).json()).id as string;
      const visa = (
        await (
          await page.request.post(`${ws}/accounts`, {
            data: {
              name: 'Visa',
              kind: 'credit_card',
              openingBalance: { amount: '30000', currency: 'USD' },
              openingDate: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
              creditLimit: '500000',
              interestRateBps: 1999,
              minPayment: '3500',
            },
          })
        ).json()
      ).id as string;
      const business = await entity('business', 'Side work');
      const rental = await entity('rental', 'Elm Rentals');
      const found = [];
      for (const path of [
        ...WORKSPACE_PAGES,
        `/accounts/${accounts[0]!.id}`,
        `/accounts/${visa}`,
        '/business',
        `/business/${business}`,
        `/business/${business}/invoices`,
        `/business/${business}/taxes`,
        '/rentals',
        `/rentals/${rental}`,
        `/rentals/${rental}/rent-roll`,
      ]) {
        await page.goto(`${base}${path}`);
        await page.waitForLoadState('networkidle');
        found.push(...(await audit(page, path || '/')));
      }
      expect(found).toEqual([]);
    });
  });
}
