import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { nav, onboardHousehold } from './phase3-helpers';

/** As the database owner: staff are added by hand, which is the point. */
async function asOwner<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra');
  url.username = 'montra_owner';
  url.password = 'montra_owner';
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

const makeStaff = (email: string, role: 'support' | 'admin') =>
  asOwner((db) =>
    db.query(
      `insert into app.staff_user (user_id, role) select id, $2 from app.app_user where email = $1
       on conflict (user_id) do update set role = excluded.role`,
      [email, role],
    ),
  );

const signOut = async (page: Page) => {
  await page.context().clearCookies();
};

const signIn = async (page: Page, email: string) => {
  await signOut(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
};

/** OPS-11, OPS-03, OPS-09, OPS-10: these open for anyone, including from a link in an email. */
test('help, legal, status and unsubscribe open without signing in', async ({ page }) => {
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'Help', exact: true })).toBeVisible();
  await page.getByLabel('Search help').fill('restore backup');
  await expect(page.getByTestId('help-article')).toHaveCount(1);
  await page.getByTestId('help-article').click();
  await expect(page.getByRole('heading', { name: 'Backups, restoring and leaving' })).toBeVisible();
  await page.goto('/help/nothing-here');
  await expect(page.getByText(/not found|can’t be found|doesn’t exist/i).first()).toBeVisible();

  for (const [path, title] of [
    ['/legal/terms', 'Terms of service'],
    ['/legal/privacy', 'Privacy policy'],
    ['/legal/cookies', 'Cookies'],
    ['/legal/subprocessors', 'Who else handles data'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(page.getByTestId('legal-draft')).toBeVisible();
  }

  await page.goto('/status');
  await expect(page.getByTestId('status-now')).toBeVisible();

  await page.goto('/unsubscribe?token=00000000-0000-4000-8000-000000000000');
  await expect(page).toHaveURL(/unsubscribe/);
  await expect(page.getByRole('button')).toBeVisible();
});

/** NFR-01: what the browser's told about this site. */
test('pages come with security headers', async ({ page }) => {
  const res = await page.goto('/sign-in');
  const headers = res!.headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['strict-transport-security']).toContain('max-age=31536000');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
});

/** OPS-08: self-hosted and in tests, plans are off and the page says so. Paying is covered by the API tests, with Stripe stubbed. */
test('the plan page, a guided tour, and contacting support', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `help-${Date.now()}@example.com`, 'Joint checking');
  const base = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');

  await page.goto(`${base}/settings?tab=billing`);
  await expect(page.getByTestId('billing-off')).toBeVisible();

  await page.goto(`${base}/help`);
  await page.getByRole('button', { name: 'Take a tour' }).click();
  await expect(page.getByTestId('tour')).toContainText('Step 1 of');
  await page.getByTestId('tour').getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('tour')).toContainText('Step 2 of');
  await expect(page).toHaveURL(/accounts\/new/);
  // It stays with you on reload, and goes when you say.
  await page.reload();
  await expect(page.getByTestId('tour')).toContainText('Step 2 of');
  await page.getByTestId('tour').getByRole('button', { name: 'End tour' }).click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: /add/i }).first()).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);

  await page.goto(`${base}/help`);
  const form = page.getByRole('form', { name: 'Contact support' });
  await form.getByLabel('What is this?').selectOption({ label: 'Something’s not working' });
  await form.getByLabel('Subject').fill('The import button');
  await form.getByLabel('What’s happening?').fill('It does nothing when I press it.');
  await form.getByLabel('Screenshot (optional)').setInputFiles({
    name: 'shot.txt',
    mimeType: 'image/png',
    buffer: Buffer.from('not an image'),
  });
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /PNG or JPEG/ })).toBeVisible();
  await form.getByLabel('Screenshot (optional)').setInputFiles([]);
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Sent. We’ll reply by email.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('support-request').filter({ hasText: 'The import button' })).toContainText(
    'Open',
  );
});

/** OPS-01, OPS-02, OPS-03: staff see people and plans, and only see more when the owner lets them. */
test('the staff console, support access and a notice', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = `console-owner-${Date.now()}@example.com`;
  const staff = `console-staff-${Date.now()}@example.com`;

  await onboardHousehold(page, owner, 'Very Private Account');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const base = `/w/${workspaceId}`;

  // Not staff: there's nothing here.
  const denied = await page.goto('/admin');
  expect(denied!.status()).toBe(404);

  await signIn(page, staff);
  await page.getByLabel('Workspace name').fill('Staff own');
  await page.getByRole('radio', { name: /Household/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();
  await makeStaff(staff, 'admin');

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Staff console' })).toBeVisible();
  await page.getByLabel('Find by email').fill(owner);
  await page.getByRole('button', { name: 'Search' }).click();
  const account = page.getByTestId('admin-account').filter({ hasText: owner });
  await account.getByRole('button', { name: 'Open' }).click();
  const workspace = account.getByTestId('admin-workspace');
  await expect(workspace).toContainText('free');
  await expect(workspace).toContainText('Support access not given');
  await expect(account).not.toContainText('Very Private Account');

  // Without the owner's say-so, a support view doesn't exist.
  const refused = await page.goto(`/admin/support/${workspaceId}`);
  expect(refused!.status()).toBe(404);

  // A planned-maintenance notice has to give 48 hours.
  const end = Date.now();
  const local = (ms: number) =>
    new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.goto('/admin?tab=notices');
  const notice = page.getByRole('form', { name: 'Post notice' });
  await notice.getByLabel('Title').fill('Too soon');
  await notice.getByLabel('Starts').fill(local(end + 3_600_000));
  await notice.getByRole('button', { name: 'Post notice' }).click();
  await expect(page.getByText(/48 hours ahead/).nth(0)).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '48 hours' })).toBeVisible();
  const title = `Upgrade ${end}`;
  await notice.getByLabel('Title').fill(title);
  await notice.getByLabel('Starts').fill(local(end + 50 * 3_600_000));
  await notice.getByRole('button', { name: 'Post notice' }).click();
  await expect(page.getByTestId('admin-notice').filter({ hasText: title })).toBeVisible();
  // The API keeps its answer for 15 seconds.
  await expect(async () => {
    await page.goto('/status');
    await expect(page.getByTestId('status-notice').filter({ hasText: title })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });

  // The owner sees it in the app, and lets support in.
  await signIn(page, owner);
  await expect(async () => {
    await page.goto(base);
    await expect(page.getByRole('region', { name: 'Announcement' }).filter({ hasText: title })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
  await page.goto(`${base}/settings?tab=support`);
  await page.getByRole('button', { name: 'Allow support access' }).click();
  await expect(page.getByTestId('support-grant')).toBeVisible();

  await signIn(page, staff);
  await page.goto(`/admin/support/${workspaceId}`);
  await expect(page.getByTestId('support-view')).toBeVisible();
  await expect(page.locator('main, body').first()).not.toContainText('Very Private Account');
  await page.goto('/admin?tab=notices');
  await page.getByRole('button', { name: `End ${title}` }).click();
  await expect(page.getByTestId('admin-notice').filter({ hasText: title })).toHaveCount(0);

  // They can see someone looked, and end it.
  await signIn(page, owner);
  await page.goto(`${base}/settings?tab=security`);
  await expect(
    page.getByTestId('security-event').filter({ hasText: 'Support accessed your data' }),
  ).toHaveCount(1);
  await page.goto(`${base}/settings?tab=support`);
  await page.getByRole('button', { name: 'End access' }).click();
  await expect(page.getByTestId('support-grant')).toHaveCount(0);
  await nav(page, 'Home');

  await signIn(page, staff);
  const after = await page.goto(`/admin/support/${workspaceId}`);
  expect(after!.status()).toBe(404);
});
