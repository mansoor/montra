/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { ProviderHealth, scrubDetail, track } from '../src/ops/provider-health.js';
import { ServiceSettings } from '../src/ops/service-settings.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// The Providers page: keys stay out, what isn't secret shows, and each provider's last success and failure (ADR-0049 §5).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const SMTP_PASSWORD = 'hunter2-smtp-password';
const STRIPE_KEY = 'sk_test_providerspagesecret0000';
const WEBHOOK = 'whsec_providers_page_secret';

let admin: pg.Client;
let h: Harness;
let owner: Client;
let adminStaff: Client;

const userId = async (email: string) =>
  (await admin.query(`select id from app.app_user where email = $1`, [email])).rows[0].id as string;

async function staff(email: string, role: string) {
  const c = h.as(email);
  await c.get('/v1/me');
  await admin.query(
    `insert into app.staff_user (user_id, role) values ($1, $2) on conflict (user_id) do update set role = $2`,
    [await userId(email), role],
  );
  return c;
}

const row = async (key: string) =>
  (await owner.get('/v1/admin/providers')).body.rows.find((r: any) => r.key === key);

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  h = await startHarness({
    MAIL_URL: `smtp://montra:${SMTP_PASSWORD}@mail.example.test:2525`,
    BILLING_MODE: 'stripe',
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK,
  });
  owner = await staff('providers-owner@example.test', 'owner');
  adminStaff = await staff('providers-admin@example.test', 'admin');
});
afterAll(async () => {
  // These settings are the whole service's: leave them as they were for other test files.
  await admin.query(
    `update app.system_setting set value = '' where key in ('mail_from_name', 'mail_from_address')`,
  );
  await admin.query(`delete from app.system_setting where key in ('sms_kinds', 'sms_countries')`);
  await h.close();
  await admin.end();
});

describe('the Providers page (ADR-0049 §5)', () => {
  it('is the owner’s', async () => {
    expect((await adminStaff.get('/v1/admin/providers')).status).toBe(403);
    expect((await adminStaff.post('/v1/admin/providers/test-email')).status).toBe(403);
    expect((await adminStaff.put('/v1/admin/providers/settings', { mailFromName: 'x' })).status).toBe(403);
  });

  it('shows every provider, what isn’t secret, and never a key or password', async () => {
    const res = await owner.get('/v1/admin/providers');
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: any) => r.key)).toEqual([
      'email',
      'sms',
      'payments',
      'errors',
      'ai',
      'storage',
      'keys',
      'push',
      'exchange_rates',
    ]);
    const find = (k: string) => res.body.rows.find((r: any) => r.key === k);
    expect(find('email').details).toEqual(
      expect.arrayContaining([{ label: 'host', value: 'mail.example.test:2525' }]),
    );
    expect(find('payments')).toMatchObject({
      configured: true,
      mode: 'stripe',
      details: [
        { label: 'key_mode', value: 'test' },
        { label: 'webhook', value: 'set' },
      ],
    });
    expect(find('sms')).toMatchObject({ configured: false, mode: 'off' });
    const seen = JSON.stringify(res.body);
    for (const secret of [SMTP_PASSWORD, STRIPE_KEY, WEBHOOK, 'montra:']) expect(seen).not.toContain(secret);
  });

  it('sends a test email to the owner’s own address, and notes that email worked', async () => {
    const outbox = h.app.get<MemoryMail>(MAIL_PORT).outbox;
    const before = outbox.length;
    const res = await owner.post('/v1/admin/providers/test-email');
    expect(res.body).toEqual({ to: 'providers-owner@example.test' });
    expect(outbox.slice(before)).toEqual([
      expect.objectContaining({ to: 'providers-owner@example.test', subject: 'Montra test email' }),
    ]);
    await vi.waitFor(async () => expect((await row('email')).lastOkAt).not.toBeNull());
  });

  it('has no texts to test until Twilio is set up', async () => {
    const res = await owner.post('/v1/admin/providers/test-text');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('sms.not_configured');
  });

  it('notes a failure, scrubbed, as the calls happen', async () => {
    const port = track(
      {
        async send(): Promise<void> {
          throw new Error(
            'push to ExponentPushToken[abcdefghijklmnopqrstuvwxyz0123] for kim@example.test failed',
          );
        },
      },
      'push',
      h.app.get(ProviderHealth),
    );
    await expect(port.send()).rejects.toThrow();
    await vi.waitFor(async () => {
      const push = await row('push');
      expect(push.lastFailureAt).not.toBeNull();
      expect(push.lastFailure).not.toMatch(/kim@|abcdefghijklmnop/);
    });
    expect(scrubDetail('see https://x.example.test/a?token=1 now')).toBe('see … now');
  });

  it('lets an owner change what isn’t secret, and the API uses it', async () => {
    const save = await owner.put('/v1/admin/providers/settings', {
      mailFromName: 'Montra Billing',
      mailFromAddress: 'billing@example.test',
      smsKinds: ['codes', 'security'],
      smsCountries: ['us', 'ca'],
    });
    expect(save.status).toBe(204);
    expect(
      (await owner.put('/v1/admin/providers/settings', { mailFromAddress: 'not an email' })).status,
    ).toBe(400);
    expect((await owner.put('/v1/admin/providers/settings', { mailFromName: 'Evil <x@y>' })).status).toBe(
      400,
    );
    expect((await owner.get('/v1/admin/providers')).body.settings).toMatchObject({
      mailFromName: 'Montra Billing',
      mailFromAddress: 'billing@example.test',
      smsKinds: ['codes', 'security'],
      smsCountries: ['US', 'CA'],
    });
    expect(await h.app.get(ServiceSettings).mailFrom()).toBe('Montra Billing <billing@example.test>');
    const log = await admin.query(`select detail from app.admin_log where action = 'providers.save'`);
    expect(log.rows[0].detail).toMatchObject({ mail_from_address: 'billing@example.test' });
  });
});
