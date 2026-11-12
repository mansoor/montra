import { expect, test } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

/**
 * A business's legal setup and registrations (BIZ-21..25; ADR-0037): the owner sets the entity type, fiscal year and
 * registrations in Settings, sees the EIN masked and shows it once, and payroll reads the EIN from there. Adding the
 * owner as an employee of a sole proprietorship warns them. Made-up numbers only.
 */
test('legal setup and registrations, read by payroll', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `bizreg-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const entity = await page.request.post(`${ws}/entities`, {
    data: { type: 'business', name: 'Harbor Kites', businessType: 'llc' },
  });
  expect(entity.status()).toBe(201);
  const entityId = (await entity.json()).id as string;
  const here = `/w/${workspaceId}/business/${entityId}`;

  // Entity type and fiscal year.
  await page.goto(`${here}/settings`);
  const legal = page.getByRole('form', { name: 'Legal and tax setup' });
  await expect(legal.getByTestId('return-form')).toHaveText(
    'Schedule C is assumed until you choose the entity type',
  );
  await legal.getByLabel('Entity type').selectOption('multi_member_llc_s_corp');
  await expect(legal.getByTestId('return-form')).toHaveText('Form 1120-S');
  await expect(legal.getByRole('note')).toContainText('a guide only');
  await legal.getByLabel('S-corp election effective (Form 2553)').fill('2026-01-01');
  await legal.getByLabel('Fiscal year starts in').selectOption('7');
  await legal.getByRole('button', { name: 'Save legal setup' }).click();
  await expect(legal.getByRole('status')).toHaveText('Legal setup saved');

  // Registrations: federal, California and local.
  const regs = page.getByRole('form', { name: 'Registrations' });
  await regs.getByLabel('Employer identification number (EIN)').fill('12-3456789');
  await regs.getByLabel('NAICS code').fill('451110');
  await regs.getByLabel('State of formation').fill('CA');
  await regs.getByLabel('Secretary of State entity number').fill('202612345678');
  await regs.getByLabel('EDD employer account number').fill('123-4567-8');
  await regs.getByLabel('Fictitious business name (DBA)').fill('Kite Shack');
  await regs.getByLabel('DBA expires').fill('2031-01-02');
  await regs.getByLabel('Street address').fill('1 Harbor Rd');
  await regs.getByLabel('City', { exact: true }).fill('Monterey');
  await regs.getByLabel('State', { exact: true }).fill('CA');
  await regs.getByLabel('ZIP code').fill('93940');
  await regs.getByRole('button', { name: 'Save registrations' }).click();
  await expect(regs.getByRole('status')).toHaveText('Registrations saved');
  await expect(regs.getByTestId('registration-ein')).toContainText('••-•••6789');
  await regs.getByRole('button', { name: 'Show Employer identification number (EIN)' }).click();
  await expect(regs.getByTestId('registration-ein')).toContainText('12-3456789');

  const others = page.getByRole('form', { name: 'Add registration' });
  await others.getByLabel('What it is').fill('County health permit');
  await others.getByLabel('Expires').fill('2027-03-31');
  await others.getByRole('button', { name: 'Add registration' }).click();
  await expect(page.getByText('County health permit')).toBeVisible();

  // Overview and Taxes say what it is and what it files.
  await page.goto(here);
  await expect(page.getByTestId('entity-type')).toContainText('Multi-member LLC, taxed as an S-corp');
  await expect(page.getByTestId('entity-type')).toContainText('files Form 1120-S');
  await page.goto(`${here}/taxes`);
  await expect(page.getByTestId('schedule-c-range')).toBeVisible();

  // Payroll reads the EIN and EDD account from Settings.
  await page.goto(`${here}/payroll/taxes`);
  const numbers = page.getByTestId('employer-numbers');
  await expect(numbers).toContainText('••-•••6789');
  await expect(numbers).toContainText('••••5678');
  await expect(page.getByRole('link', { name: 'Change them in Business → Settings' })).toBeVisible();

  // A sole proprietor adding themselves as an employee is warned.
  await page.goto(`${here}/settings`);
  await page
    .getByRole('form', { name: 'Legal and tax setup' })
    .getByLabel('Entity type')
    .selectOption('sole_prop');
  await page.getByRole('button', { name: 'Save legal setup' }).click();
  await expect(page.getByRole('form', { name: 'Legal and tax setup' }).getByRole('status')).toHaveText(
    'Legal setup saved',
  );
  await page.goto(`${here}/people`);
  await page.getByRole('button', { name: 'Add an employee' }).click();
  await page.getByLabel('This person is an owner of the business').check();
  await expect(page.getByTestId('owner-warning')).toContainText('owner draws');
});
