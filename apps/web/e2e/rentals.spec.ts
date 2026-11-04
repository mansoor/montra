import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { nav, onboardHousehold } from './phase3-helpers';

const open = (page: Page, summary: string) => page.locator('summary', { hasText: summary }).click();

/**
 * Phase 9: a landlord adds a property and a lease, rent falls due and is logged, a deposit is held and partly returned, a
 * mortgage payment is split, and it all reaches the reports, Schedule E and its export (RNT-01..14, UP-10).
 */
test('a lease, rent, a deposit and a mortgage reach the reports and Schedule E', async ({ page }) => {
  test.setTimeout(180_000);
  await onboardHousehold(page, `rentals-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const thisMonth = `${today.slice(0, 7)}-01`;
  const lastMonthDate = new Date(`${thisMonth}T00:00:00Z`);
  lastMonthDate.setUTCMonth(lastMonthDate.getUTCMonth() - 1);
  const lastMonth = lastMonthDate.toISOString().slice(0, 10);

  const entity = await page.request.post(`${ws}/entities`, { data: { type: 'rental', name: 'Elm Rentals' } });
  expect(entity.status()).toBe(201);
  const entityId = (await entity.json()).id as string;
  const addAccount = async (name: string, kind: string, amount: string) => {
    const res = await page.request.post(`${ws}/accounts`, {
      data: {
        name,
        kind,
        entityId,
        openingBalance: { amount, currency: 'USD' },
        openingDate: `${Number(year) - 1}-12-01`,
      },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).id as string;
  };
  const checking = await addAccount('Rental checking', 'checking', '500000');
  await addAccount('Elm mortgage', 'mortgage', '20000000');
  await page.reload();

  // The sidebar offers rentals now there's a portfolio, and starts by asking for a property.
  await nav(page, 'Rentals');
  await expect(page.getByRole('heading', { name: 'Elm Rentals' })).toBeVisible();
  await expect(page.getByText('No properties yet')).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Rental sections' });

  // A property: a house gets its one unit without being asked (RNT-01, RNT-02).
  await sections.getByRole('link', { name: 'Properties' }).click();
  await open(page, 'Add property');
  const propertyForm = page.getByRole('form', { name: 'Add property' });
  await propertyForm.getByLabel('Name').fill('12 Elm St');
  await propertyForm.getByLabel('Address').fill('12 Elm St, Austin');
  await propertyForm.getByLabel('Current value').fill('200,000');
  await propertyForm.getByLabel('Cash invested').fill('50,000');
  await propertyForm.getByLabel('Your ownership %').fill('50');
  await propertyForm.getByRole('button', { name: 'Add property' }).click();
  await expect(page.getByText('Property added.')).toBeVisible();
  await page.getByRole('link', { name: '12 Elm St', exact: true }).click();
  await expect(page.getByTestId('unit-row')).toContainText('Main');
  await expect(page.getByTestId('unit-row')).toContainText('Vacant');

  // A lease that began last month writes its rent, last month's now late (RNT-03, RNT-04).
  await open(page, 'Add lease');
  const leaseForm = page.getByRole('form', { name: 'Add lease' });
  await leaseForm.getByLabel('Unit').selectOption({ label: 'Main' });
  await leaseForm.getByLabel('New tenant').fill('Rita Rollins');
  await leaseForm.getByLabel('Start date').fill(lastMonth);
  await leaseForm.getByLabel('Rent', { exact: true }).fill('1,500');
  await leaseForm.getByLabel('Late fee, flat').fill('25');
  await leaseForm.getByLabel('Security deposit').fill('1,500');
  await leaseForm.getByRole('button', { name: 'Add lease' }).click();
  await expect(page.getByText('Lease added, and rent charges written.')).toBeVisible();
  await expect(page.getByTestId('lease-row')).toContainText('Rita Rollins');
  await expect(page.getByTestId('unit-row')).toContainText('Occupied');

  // Rent roll: last month is late; logging it pays it.
  await sections.getByRole('link', { name: 'Rent roll' }).click();
  await page.getByRole('link', { name: /Previous/ }).click();
  const row = page.getByTestId('roll-row');
  await expect(row).toContainText('Rita Rollins');
  await expect(row).toContainText('Late');
  await sections.getByRole('link', { name: 'Arrears' }).click();
  await expect(page.getByTestId('arrears-row')).toContainText('$1,500.00');

  await sections.getByRole('link', { name: 'Rent roll' }).click();
  await page.getByRole('link', { name: /Previous/ }).click();
  await row.locator('summary').click();
  await row.getByLabel('Into').selectOption({ label: 'Rental checking' });
  await row.getByRole('button', { name: 'Record payment' }).click();
  await expect(row).toContainText('Paid');
  await expect(row).not.toContainText('Late');

  // The deposit is a liability: held, partly returned, never income (RNT-10).
  await row.getByRole('link', { name: /12 Elm St/ }).click();
  await expect(page.getByTestId('payment-row')).toHaveCount(1);
  const depositForm = page.getByRole('form', { name: 'Add to deposit record' });
  await depositForm.getByLabel('What happened').selectOption({ label: 'Received' });
  await depositForm.getByLabel('Amount').fill('1,500');
  await depositForm.getByLabel('Account').selectOption({ label: 'Rental checking' });
  await depositForm.getByRole('button', { name: 'Add to deposit record' }).click();
  await expect(page.getByTestId('deposit-held')).toContainText('Held: $1,500.00');
  await depositForm.getByLabel('What happened').selectOption({ label: 'Returned' });
  await depositForm.getByLabel('Amount').fill('2,000');
  await depositForm.getByRole('button', { name: 'Add to deposit record' }).click();
  await expect(page.getByText('This is more than is held for this lease')).toBeVisible();
  await depositForm.getByLabel('Amount').fill('500');
  await depositForm.getByRole('button', { name: 'Add to deposit record' }).click();
  await expect(page.getByTestId('deposit-held')).toContainText('Held: $1,000.00');

  // A mortgage: its schedule, and a payment split into its parts (RNT-08).
  await sections.getByRole('link', { name: 'Mortgages' }).click();
  await open(page, 'Add mortgage');
  const loanForm = page.getByRole('form', { name: 'Add mortgage' });
  await loanForm.getByLabel('Name').fill('Elm loan');
  await loanForm.getByLabel('Principal').fill('200,000');
  await loanForm.getByLabel('Interest rate %').fill('6');
  await loanForm.getByLabel('First payment').fill(today);
  await loanForm.getByLabel('Monthly escrow, taxes').fill('200');
  await loanForm.getByLabel('Monthly escrow, insurance').fill('100');
  await loanForm.getByRole('button', { name: 'Add mortgage' }).click();
  const loan = page.getByTestId('loan');
  await expect(loan).toContainText('$1,499.10');
  await loan.getByLabel('Paid from').selectOption({ label: 'Rental checking' });
  const first = page.getByTestId('schedule-row').first();
  await expect(first).toContainText('$1,000.00');
  await first.getByRole('button', { name: 'Record payment' }).click();
  await expect(loan).toContainText('1 of 360 payments made');

  // An expense on the property, chosen on the transaction (RNT-06).
  const repairsId = (
    (await (await page.request.get(`${ws}/categories?entityId=${entityId}`)).json()).data as {
      id: string;
      name: string;
    }[]
  ).find((c) => c.name === 'Repairs')!.id;
  const spend = await page.request.post(`${ws}/transactions`, {
    data: {
      date: today,
      accountId: checking,
      amount: { amount: '-30000', currency: 'USD' },
      payee: 'Handyman',
      categoryId: repairsId,
    },
  });
  expect(spend.status()).toBe(201);
  const spendId = (await spend.json()).id as string;
  await page.goto(`/w/${workspaceId}/transactions/${spendId}`);
  await page.getByLabel('Property').selectOption({ label: '12 Elm St' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

  // The reports: rent and the repair on the property, the deposit nowhere, ratios worked out (RNT-11).
  await page.goto(`/w/${workspaceId}/rentals/${entityId}`);
  const reportRow = page.getByTestId('property-report-row').filter({ hasText: '12 Elm St' });
  await expect(reportRow).toContainText('$1,500.00');
  // Expenses are the $300 repair and $300 of escrow; NOI is before the $1,199.10 of principal and interest.
  await expect(reportRow).toContainText('$600.00');
  await expect(reportRow).toContainText('$900.00');
  await expect(reportRow).toContainText('$1,199.10');
  await expect(reportRow).toContainText('-$299.10');

  // Schedule E, your half of the net, and a file for the accountant (UP-10).
  await sections.getByRole('link', { name: 'Schedule E' }).click();
  const schedule = page.getByTestId('schedule-e-property').filter({ hasText: '12 Elm St' });
  await expect(schedule.getByTestId('schedule-e-line').filter({ hasText: 'Rents received' })).toContainText(
    '$1,500.00',
  );
  await expect(schedule.getByTestId('schedule-e-line').filter({ hasText: 'Repairs' })).toContainText(
    '$300.00',
  );
  await expect(
    schedule.getByTestId('schedule-e-line').filter({ hasText: 'Mortgage interest' }),
  ).toContainText('$1,000.00');
  await expect(schedule).toContainText('Your share (50%)');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toBe(`schedule-e-${year}.csv`);

  // One bill shared across two properties, to the cent (RNT-07).
  const flat = await page.request.post(`${ws}/properties`, {
    data: { entityId, name: 'Oak Flat', type: 'condo' },
  });
  expect(flat.status()).toBe(201);
  const utilitiesId = (
    (await (await page.request.get(`${ws}/categories?entityId=${entityId}`)).json()).data as {
      id: string;
      name: string;
    }[]
  ).find((c) => c.name === 'Utilities')!.id;
  const shared = await page.request.post(`${ws}/transactions`, {
    data: {
      date: today,
      accountId: checking,
      amount: { amount: '-10001', currency: 'USD' },
      payee: 'Water Co',
      categoryId: utilitiesId,
    },
  });
  const sharedId = (await shared.json()).id as string;
  await page.goto(`/w/${workspaceId}/transactions/${sharedId}`);
  await open(page, 'Split across properties');
  const split = page.getByRole('form', { name: 'Split across properties' });
  await split.getByLabel('12 Elm St').check();
  await split.getByLabel('Oak Flat').check();
  await split.getByLabel('Percent for 12 Elm St').fill('60');
  await split.getByLabel('Percent for Oak Flat').fill('50');
  await split.getByRole('button', { name: 'Split it' }).click();
  await expect(split.getByText('The percentages must add up to 100.')).toBeVisible();
  await split.getByLabel('Percent for Oak Flat').fill('40');
  await split.getByRole('button', { name: 'Split it' }).click();
  await expect(split.getByText('Split across properties.', { exact: true })).toBeVisible();
  const parts = (
    (await (await page.request.get(`${ws}/transactions/${sharedId}`)).json()).splits as {
      amount: string;
    }[]
  ).map((x) => BigInt(x.amount));
  expect(parts).toHaveLength(2);
  expect(parts.reduce((t, x) => t + x, 0n)).toBe(-10001n);
  await page.goto(`/w/${workspaceId}/rentals/${entityId}/maintenance`);

  // Maintenance and a reminder (RNT-12, RNT-13).
  await sections.getByRole('link', { name: 'Maintenance' }).click();
  const issueForm = page.getByRole('form', { name: 'Log an issue' });
  await issueForm.getByLabel('Issue').fill('Leak under sink');
  await issueForm.getByLabel('Vendor').fill('Plumber');
  await issueForm.getByRole('button', { name: 'Log an issue' }).click();
  const issue = page.getByTestId('maintenance-row');
  await expect(issue).toContainText('Leak under sink');
  await issue.getByLabel('Status of Leak under sink').selectOption({ label: 'Done' });
  await expect(issue.locator('.chip')).toHaveText('Done');

  await sections.getByRole('link', { name: 'Reminders' }).click();
  await expect(page.getByText('Nothing to remember right now.')).toBeVisible();
  const reminderForm = page.getByRole('form', { name: 'Add reminder' });
  await reminderForm.getByLabel('What').fill('Renew insurance');
  await reminderForm.getByRole('button', { name: 'Add reminder' }).click();
  const reminder = page.getByTestId('reminder-row');
  await expect(reminder).toContainText('Renew insurance');
  await reminder.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Nothing to remember right now.')).toBeVisible();

  // A flagged repair becomes an improvement once it's given a property (RNT-09).
  const roof = await page.request.post(`${ws}/transactions`, {
    data: {
      date: today,
      accountId: checking,
      amount: { amount: '-300000', currency: 'USD' },
      payee: 'Acme Roofing',
      categoryId: repairsId,
    },
  });
  const roofId = (await roof.json()).id as string;
  const me = (await (await page.request.get('/api/v1/me')).json()) as { id?: string; user?: { id: string } };
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra',
  });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(`select set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)`, [
      workspaceId,
      me.user?.id ?? me.id,
    ]);
    await db.query(
      `insert into app.insight (workspace_id, kind, entity_id, transaction_id, dedupe_key, data)
       values ($1, 'capital_improvement', $2, $3, $4, $5)`,
      [
        workspaceId,
        entityId,
        roofId,
        `capital:${roofId}`,
        JSON.stringify({ payee: 'Acme Roofing', message: 'This may be an improvement.', propertyId: null }),
      ],
    );
    await db.query('commit');
  } finally {
    await db.end();
  }
  await nav(page, 'Insights');
  const flag = page.getByTestId('insight-row').filter({ hasText: 'Acme Roofing' });
  await expect(flag.getByRole('button', { name: 'Capitalize' })).toBeDisabled();
  await flag.getByLabel('Property for Acme Roofing').selectOption({ label: '12 Elm St' });
  await flag.getByRole('button', { name: 'Capitalize' }).click();
  await expect(page.getByText('Moved to improvements and added to depreciation.')).toBeVisible();
  await page.goto(`/w/${workspaceId}/rentals/${entityId}/properties`);
  await page.getByRole('link', { name: '12 Elm St', exact: true }).click();
  await expect(page.getByTestId('depreciation-row')).toContainText('Acme Roofing');
  await expect(page.getByTestId('depreciation-row')).toContainText('$3,000.00');

  // It's on the calendar too.
  await nav(page, 'Calendar');
  await expect(page.getByText('12 Elm St · Main').first()).toBeVisible();
});
