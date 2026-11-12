import { expect, test, type Page } from '@playwright/test';
import { nav, onboardHousehold } from './phase3-helpers';

const open = (page: Page, summary: string) => page.locator('summary', { hasText: summary }).click();

/** A one-page PDF, enough for the upload to recognize it. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * Tenant details, the people on a lease and property contacts (RNT-17..21, ADR-0038): a property with its insurer, its
 * electricity company and a broker; a lease with a co-signer and an occupant, the signed lease attached and the broker's
 * fee recorded as a Schedule E commission; and the tenant's page showing where they live.
 */
test('a lease with a co-signer, an occupant, a broker fee and the signed lease; a property with its contacts', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await onboardHousehold(page, `rentals-people-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);

  const entity = await page.request.post(`${ws}/entities`, { data: { type: 'rental', name: 'Oak Rentals' } });
  expect(entity.status()).toBe(201);
  const entityId = (await entity.json()).id as string;
  const account = await page.request.post(`${ws}/accounts`, {
    data: {
      name: 'Oak checking',
      kind: 'checking',
      entityId,
      openingBalance: { amount: '1000000', currency: 'USD' },
      openingDate: `${Number(year) - 1}-12-01`,
    },
  });
  expect(account.status()).toBe(201);
  await page.reload();

  await nav(page, 'Rentals');
  const sections = page.getByRole('navigation', { name: 'Rental sections' });
  await sections.getByRole('link', { name: 'Properties' }).click();
  await open(page, 'Add property');
  const propertyForm = page.getByRole('form', { name: 'Add property' });
  await propertyForm.getByLabel('Name').fill('8 Oak Ave');
  await propertyForm.getByRole('button', { name: 'Add property' }).click();
  await expect(page.getByText('Property added.')).toBeVisible();
  await page.getByRole('link', { name: '8 Oak Ave', exact: true }).click();

  // Contacts: the insurer, the electricity company and a broker, each with links to call or write (RNT-21).
  await expect(page.getByText('No contacts for this property yet.')).toBeVisible();
  const addContact = async (role: string, company: string, extra: Record<string, string>) => {
    await open(page, 'Add contact');
    const form = page.getByRole('form', { name: 'Add contact' });
    await form.getByLabel('Role').selectOption({ label: role });
    await form.getByLabel('Company or name').fill(company);
    for (const [label, value] of Object.entries(extra)) await form.getByLabel(label).fill(value);
    await form.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByText('Contact added.')).toBeVisible();
    await expect(page.getByTestId('contact-row').filter({ hasText: company })).toBeVisible();
  };
  await addContact('Insurance', 'Acme Insurance', {
    'Contact person': 'Ivy Agent',
    Phone: '(555) 010-2000',
    Email: 'claims@acme.example',
    Website: 'acme.example',
    'Account or policy number': 'HO-123456',
  });
  await addContact('Electricity', 'Valley Power', {
    Phone: '1-800-555-0100',
    'Account or policy number': 'VP-9',
  });
  await addContact('Broker or agent', 'Oak Realty', { Phone: '555-010-3000' });

  const insurer = page.getByTestId('contact-row').filter({ hasText: 'Acme Insurance' });
  await expect(insurer).toContainText('Insurance');
  await expect(insurer).toContainText('Ivy Agent');
  await expect(insurer).toContainText('HO-123456');
  await expect(insurer.getByTestId('contact-phone')).toHaveAttribute('href', 'tel:5550102000');
  await expect(insurer.getByTestId('contact-email')).toHaveAttribute('href', 'mailto:claims@acme.example');
  await expect(insurer.getByTestId('contact-website')).toHaveAttribute('href', 'https://acme.example/');
  const power = page.getByTestId('contact-row').filter({ hasText: 'Valley Power' });
  await expect(power).toContainText('Electricity');
  await expect(power.getByTestId('contact-phone')).toHaveAttribute('href', 'tel:18005550100');

  // A lease signed by one tenant, with a co-signer and an occupant beside them, through the broker (RNT-18, RNT-19).
  await open(page, 'Add lease');
  const leaseForm = page.getByRole('form', { name: 'Add lease' });
  await leaseForm.getByLabel('Unit').selectOption({ label: 'Main' });
  await leaseForm.getByLabel('New tenant').fill('Tara Tenant');
  await leaseForm.getByLabel('Start date').fill(today);
  await leaseForm.getByLabel('Rent', { exact: true }).fill('2,000');
  await leaseForm.getByLabel('Broker or agent').selectOption({ label: 'Oak Realty' });
  await leaseForm.getByRole('button', { name: 'Add co-signer' }).click();
  const cosigner = leaseForm.getByRole('group', { name: 'Co-signer 1' });
  await cosigner.getByLabel('Name').fill('Gina Guarantor');
  await cosigner.getByLabel('Phone').fill('555-010-4000');
  await cosigner.getByLabel('Email').fill('gina@example.com');
  await leaseForm.getByRole('button', { name: 'Add occupant' }).click();
  const occupant = leaseForm.getByRole('group', { name: 'Occupant 1' });
  await occupant.getByLabel('Name').fill('Ollie Tenant');
  await occupant.getByLabel('Relationship').fill('Son');
  await occupant.getByLabel('Date of birth').fill('2015-04-01');
  await leaseForm.getByRole('button', { name: 'Add lease' }).click();
  await expect(page.getByText('Lease added, and rent charges written.')).toBeVisible();
  await page.getByTestId('lease-row').getByRole('link', { name: 'Tara Tenant' }).click();

  // The lease page: dates up front, people by role, and only the tenant pays.
  await expect(page.getByTestId('lease-dates')).toContainText('Month to month');
  await expect(page.getByTestId('lease-signer')).toHaveText('Tara Tenant');
  const cosignerRow = page.getByTestId('lease-cosigner');
  await expect(cosignerRow).toContainText('Gina Guarantor');
  await expect(cosignerRow.getByRole('link', { name: '555-010-4000' })).toHaveAttribute(
    'href',
    'tel:5550104000',
  );
  const occupantRow = page.getByTestId('lease-occupant');
  await expect(occupantRow).toContainText('Ollie Tenant');
  await expect(occupantRow).toContainText('Son');
  await expect(occupantRow.getByTestId('masked-value')).toHaveText('••/••/••••');
  await expect(page.getByText('2015')).toHaveCount(0);

  // The signed lease, attached and downloadable.
  await expect(page.getByText('Nothing attached yet.')).toBeVisible();
  const attach = page.getByRole('form', { name: 'Attach the signed lease' });
  await attach.getByLabel('PDF or photo').setInputFiles({
    name: 'signed-lease.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await attach.getByRole('button', { name: 'Attach the signed lease' }).click();
  await expect(page.getByText('Signed lease attached.')).toBeVisible();
  const file = page.getByTestId('lease-file').getByRole('link', { name: 'Download document 1' });
  const href = await file.getAttribute('href');
  expect(href).toContain(`/rentals/leases/`);
  const served = await page.request.get(href!);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toContain('application/pdf');

  // The broker's fee, paid from the portfolio's checking, is a commission on this property (Schedule E line 8).
  const costs = page.getByRole('form', { name: 'Record cost' });
  await costs.getByLabel('What for').selectOption({ label: 'Broker’s fee' });
  await costs.getByLabel('Amount').fill('2,000');
  await costs.getByLabel('Paid from').selectOption({ label: 'Oak checking' });
  await costs.getByLabel('Paid to').selectOption({ label: 'Oak Realty' });
  await costs.getByRole('button', { name: 'Record cost' }).click();
  await expect(page.getByText('Recorded as an expense.')).toBeVisible();
  const cost = page.getByTestId('lease-cost');
  await expect(cost).toContainText('Broker’s fee');
  await expect(cost).toContainText('$2,000.00');
  await expect(cost).toContainText('Oak Realty');
  await expect(page.getByTestId('amortization-note')).toContainText('spread over the lease term');

  await sections.getByRole('link', { name: 'Schedule E' }).click();
  const schedule = page.getByTestId('schedule-e-property').filter({ hasText: '8 Oak Ave' });
  await expect(schedule.getByTestId('schedule-e-line').filter({ hasText: 'Commissions' })).toContainText(
    '$2,000.00',
  );

  // The tenants list says where each one lives; the tenant's page lists the lease (RNT-17).
  await sections.getByRole('link', { name: 'Tenants' }).click();
  const tara = page.getByTestId('tenant-row').filter({ hasText: 'Tara Tenant' });
  await expect(tara.getByTestId('tenant-home')).toHaveText('8 Oak Ave · Main');
  await expect(page.getByTestId('tenant-row').filter({ hasText: 'Gina Guarantor' })).toHaveCount(0);
  await tara.getByRole('link', { name: 'Tara Tenant' }).click();
  await expect(page.getByTestId('tenant-current')).toContainText('8 Oak Ave · Main');
  const leaseRow = page.getByTestId('tenant-lease-row');
  await expect(leaseRow).toContainText('8 Oak Ave');
  await expect(leaseRow).toContainText('$2,000.00');
  await expect(leaseRow).toContainText('Active');

  // Details: a second phone and an emergency contact; the date of birth is kept masked.
  await page.getByRole('button', { name: 'Edit details' }).click();
  const details = page.getByRole('form', { name: 'Edit details' });
  await details.getByLabel('Second phone').fill('555-010-5000');
  await details.getByLabel('Date of birth').fill('1990-02-03');
  await details.getByLabel('Emergency contact name').fill('Ron Tenant');
  await details.getByLabel('Monthly income').fill('6,500');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Tenant saved.')).toBeVisible();
  await expect(page.getByTestId('tenant-dob').getByTestId('masked-value')).toHaveText('••/••/••••');
  await expect(page.getByText('1990')).toHaveCount(0);
  await expect(page.getByText('Ron Tenant')).toBeVisible();
  await expect(page.getByText('$6,500.00')).toBeVisible();
});
