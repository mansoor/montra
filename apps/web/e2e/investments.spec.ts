import { expect, test } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

/** ADR-0025: a 401(k) linked to its payslips, values from statements, and gain as a chart and table. */
test('a 401(k) takes its payslips, its statement values, and shows the gain', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `invest-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const checking = ((await (await page.request.get(`${ws}/accounts`)).json()).data as { id: string }[])[0]!
    .id;
  const sam = (
    await (
      await page.request.post(`${ws}/family-members`, {
        data: { name: 'Sam', relationship: 'spouse_partner' },
      })
    ).json()
  ).id as string;
  const acme = await page.request.post(`${ws}/employers`, {
    data: { memberId: sam, name: 'Acme', depositAccountId: checking },
  });
  expect(acme.status()).toBe(201);

  await page.goto(`/w/${workspaceId}/accounts/new`);
  await page.getByLabel('Account type').selectOption('investment');
  await page.getByLabel('Type of plan').selectOption({ label: '401(k)' });
  await page.getByLabel('Payslips from').selectOption({ label: 'Acme' });
  await page.getByRole('checkbox', { name: /Count my employer’s contributions/ }).check();
  await page.getByLabel('Name').fill('Acme 401(k)');
  await page.getByLabel('Current value').fill('40000');
  await page.getByLabel('As of').fill(daysAgo(200));
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Acme 401(k)' })).toBeVisible();
  const accountId = new URL(page.url()).pathname.split('/').pop()!;

  // A payslip's 401(k) and match go in, as money in, not gain.
  const p = await (
    await page.request.post(`${ws}/payslips`, {
      data: { employerId: (await acme.json()).id, payDate: daysAgo(100) },
    })
  ).json();
  const filled = await page.request.patch(`${ws}/payslips/${p.id}`, {
    data: {
      version: p.version,
      net: '400000',
      lines: [
        { section: 'earning', code: 'salary', label: 'Salary', amount: '500000' },
        { section: 'pre_tax', code: '401k', label: '401(k)', amount: '50000' },
        { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '50000' },
        { section: 'employer', code: 'match', label: 'Employer match', amount: '25000' },
      ],
    },
  });
  const confirmed = await page.request.post(`${ws}/payslips/${p.id}/confirm`, {
    data: { version: (await filled.json()).version },
  });
  expect(confirmed.status()).toBe(200);
  await page.reload();
  await expect(page.getByText('Value: $40,750.00')).toBeVisible();

  // Past statements pasted at once, then today's typed in.
  const updates = page.getByTestId('value-updates');
  await updates.getByText('Add several from past statements').click();
  await updates.getByLabel('One per line: date, value').fill(`${daysAgo(150)}, 41000\n${daysAgo(60)}, 42500`);
  await updates.getByRole('button', { name: 'Add these values' }).click();
  await expect(updates.getByText('2 values added.')).toBeVisible();
  await updates.getByLabel('Value', { exact: true }).fill('44000');
  await updates.getByLabel('Note (optional)').fill('Q3 statement');
  await updates.getByRole('button', { name: 'Update value' }).click();
  await expect(updates.getByText('Value updated.')).toBeVisible();
  await page.reload();

  // $40,000 to start, $750 in from the payslip, $44,000 now: $3,250 of gain.
  const perf = page.getByTestId('performance');
  await expect(perf.getByTestId('perf-gain')).toContainText('$3,250.00');
  await expect(perf.getByTestId('perf-in')).toContainText('$40,750.00');
  await expect(perf.getByTestId('perf-end')).toContainText('$44,000.00');
  await expect(perf.getByTestId('perf-return')).toContainText('%');
  await expect(perf.locator('svg')).toBeVisible();
  expect(await perf.getByTestId('performance-row').count()).toBeGreaterThan(5);
  await expect(page.getByTestId('value-row').first()).toContainText('Q3 statement');

  // Taking back the latest puts the value back.
  await page.getByTestId('value-row').first().getByRole('button', { name: 'Remove' }).click();
  await expect(updates.getByText('Value removed.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Value: $42,500.00')).toBeVisible();

  // The plan can be changed on the page, and it fits a phone.
  const plan = page.getByTestId('plan-settings');
  await plan.locator('summary').click();
  await expect(plan.getByLabel('Type of plan')).toHaveValue('401k');
  await page.setViewportSize({ width: 360, height: 760 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(accountId).toBeTruthy();
});
