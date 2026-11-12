import { expect, test } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

/**
 * Staff time (PRL-23..28; ADR-0036): an hourly California employee takes vacation on a pay run, which pays it at the
 * regular rate, moves the balance when approved, and a contractor's hours become one bill to their vendor record.
 */
test('a pay run with vacation hours, and a contractor timesheet billed', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `staff-time-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const post = async (path: string, data: object) => {
    const res = await page.request.post(`${ws}${path}`, { data });
    expect(res.status(), path).toBeLessThan(300);
    return res.json();
  };
  const entityId = (await post('/entities', { type: 'business', name: 'Tidepool Cafe', businessType: 'llc' }))
    .id;
  const checking = (
    await post('/accounts', {
      name: 'Cafe checking',
      kind: 'checking',
      entityId,
      openingBalance: { amount: '1000000', currency: 'USD' },
      openingDate: '2026-01-01',
    })
  ).id;
  const schedule = await post('/payroll/schedules', {
    entityId,
    name: 'Every other Thursday',
    frequency: 'biweekly',
    anchorDate: '2026-01-04',
    payLagDays: 5,
    payFromAccountId: checking,
  });
  const employee = await post('/payroll/people', {
    entityId,
    kind: 'employee',
    firstName: 'Casey',
    lastName: 'Exampleton',
    hireDate: '2025-06-02',
    payType: 'hourly',
    rate: '2000',
    defaultHoursMilli: '72000',
    workState: 'CA',
    payScheduleId: schedule.id,
  });
  const contractor = await post('/payroll/people', {
    entityId,
    kind: 'contractor',
    firstName: 'Emery',
    lastName: 'Placeholder',
    payType: 'hourly',
    rate: '7500',
  });
  const base = `/w/${workspaceId}/business/${entityId}`;

  // Time off: vacation accrues 1 hour per 20 worked; sick leave is California's minimum by default.
  await page.goto(`${base}/payroll/time-off`);
  await expect(page.getByTestId('ca-sick-note')).toContainText('California paid sick leave');
  const vacation = page.getByRole('group', { name: 'Vacation' });
  await vacation.getByLabel('How it’s earned').selectOption('accrual');
  await vacation.getByLabel('Hours earned').fill('1');
  await vacation.getByLabel('Per hours worked').fill('20');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // An opening balance for hours earned before Montra.
  await page.goto(`${base}/people/${employee.id}`);
  await page.getByRole('button', { name: 'Add an opening balance or adjustment' }).click();
  const form = page.getByRole('form', { name: 'Add an opening balance or adjustment' });
  await form.getByLabel('Hours (negative to take away)').fill('10');
  await form.getByLabel('Date').fill('2026-01-01');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('balance-vacation')).toContainText('10 hours');

  // A pay run with 8 hours of vacation, paid at the regular rate.
  const run = await post('/payroll/runs', { entityId, scheduleId: schedule.id, periodDate: '2026-03-04' });
  await page.goto(`${base}/payroll/runs/${run.id}`);
  const paycheck = page.getByTestId('paycheck');
  await paycheck.getByRole('button', { name: 'Edit' }).click();
  await paycheck.getByLabel('Vacation hours').fill('8');
  await paycheck.getByRole('button', { name: 'Save', exact: true }).click();
  // 72 hours worked earn 3.6 hours: 10 − 8 + 3.6 = 5.6.
  await expect(paycheck.getByTestId('leave-vacation')).toContainText('5.6');
  await expect(paycheck.getByTestId('leave-sick')).toContainText('2.4');
  await expect(paycheck.getByTestId('overtime-method')).toHaveText('Overtime entered as hours.');
  const drafted = await (await page.request.get(`${ws}/payroll/runs/${run.id}`)).json();
  expect(drafted.paychecks[0].lines).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'vacation', hoursMilli: '8000', amount: '16000' }),
    ]),
  );

  await page.getByRole('checkbox', { name: /I’ve checked these amounts/ }).check();
  await page.getByRole('button', { name: 'Approve and post' }).click();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  await page.goto(`${base}/people/${employee.id}`);
  await expect(page.getByTestId('balance-vacation')).toContainText('5.6 hours');

  // A contractor's hours, billed as one bill to their vendor record.
  await page.goto(`${base}/people/${contractor.id}`);
  const sheet = page.getByRole('form', { name: 'Add hours' });
  await sheet.getByLabel('Date').fill('2026-03-02');
  await sheet.getByLabel('Hours').fill('3.5');
  await sheet.getByLabel('Project or client').fill('Menu design');
  await sheet.getByRole('button', { name: 'Add hours' }).click();
  await expect(page.getByTestId('time-entry')).toHaveCount(1);
  await sheet.getByLabel('Date').fill('2026-03-03');
  await sheet.getByLabel('Hours').fill('2');
  await sheet.getByLabel('Project or client').fill('Brunch setup');
  await sheet.getByRole('button', { name: 'Add hours' }).click();
  await expect(page.getByTestId('time-entry')).toHaveCount(2);
  await expect(page.getByText('5.5 hours not billed')).toBeVisible();
  await page.getByRole('button', { name: 'Choose all unbilled' }).click();
  await page.getByRole('button', { name: 'Bill these 5.5 hours' }).click();
  await expect(page.getByText('Billed 5.5 hours')).toBeVisible();
  await expect(page.getByTestId('time-entry').getByRole('link', { name: 'Billed' })).toHaveCount(2);

  const bills = await (await page.request.get(`${ws}/bills?entityId=${entityId}`)).json();
  expect(bills.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ partyId: contractor.vendorPartyId, amount: '41250', status: 'open' }),
    ]),
  );
});
