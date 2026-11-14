/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { Plans } from '../src/ops/plans.js';
import { ServiceSettings } from '../src/ops/service-settings.js';
import { SMS_PORT, SmsOptedOut, TwilioSms, type MemorySms } from '../src/sms/sms.js';
import { TextsService } from '../src/sms/texts.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Texts through Twilio: who gets what, and how often (ADR-0049 §6).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const PHONE = '+14155550142';

let admin: pg.Client;
let h: Harness;
let c: Client;
let ws: string;
let userId: string;

const outbox = () => h.app.get<MemorySms>(SMS_PORT).outbox;
const prefs = async () => (await c.get('/v1/me/notification-prefs')).body;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  h = await startHarness({
    SMS_MODE: 'memory',
    BILLING_MODE: 'stripe',
    STRIPE_SECRET_KEY: 'sk_test_texts_only',
    STRIPE_WEBHOOK_SECRET: 'whsec_texts_only',
  });
  c = h.as('texts-person@example.test');
  const res = await c.post('/v1/workspaces', {
    name: 'Texts',
    type: 'household',
    baseCurrency: 'USD',
    timeZone: 'UTC',
  });
  ws = res.body.id;
  userId = (await admin.query(`select id from app.app_user where email = 'texts-person@example.test'`))
    .rows[0].id;
  // A plan with two reminder texts a month, as an owner would set one up.
  await admin.query(`insert into app.plan (key, name) values ('texting', 'Texting') on conflict do nothing`);
  const v = await admin.query(
    `insert into app.plan_version (plan_key, version, entitlements) values ('texting', 1, $1)
     on conflict (plan_key, version) do update set plan_key = excluded.plan_key returning id`,
    [
      JSON.stringify({
        businessBooks: 0,
        rentalPortfolios: 0,
        storageBytes: 5368709120,
        familyLogins: null,
        aiMonthlyMicroUsd: null,
        smsMonthly: 2,
        features: [],
      }),
    ],
  );
  await admin.query(
    `select app.apply_plan_version($1, $2, 'active', 'comp', null, null, null, null, null, null, false)`,
    [ws, v.rows[0].id],
  );
  // Kratos is where the number lives; this is the copy it leaves after the number is verified.
  await admin.query(`update app.app_user set phone_e164 = $2, phone_verified = true where id = $1`, [
    userId,
    PHONE,
  ]);
});
afterAll(async () => {
  await h.close();
  await admin.end();
});

/** A reminder as the jobs make one, delivered as the notification worker does. */
async function remind(key: string) {
  const notifications = h.app.get(NotificationsService);
  const db = h.app.get(Db);
  const ctx = { workspaceId: ws, userId };
  await db.run(ctx, async (trx) => {
    const p = await notifications.prefsIn(trx, userId);
    await notifications.create(
      trx,
      ctx,
      { type: 'bill_due', dedupeKey: key, title: 'Electric bill due tomorrow' },
      p,
      new Date(Date.now() - 86_400_000),
    );
  });
  await admin.query(
    `update app.notification set deliver_after = now() - interval '1 minute' where dedupe_key = $1`,
    [key],
  );
  await notifications.deliverWaiting();
}

describe('texts (ADR-0049 §6)', () => {
  it('are off until the person turns them on, and show only the end of the number', async () => {
    expect((await prefs()).texts).toEqual({
      available: true,
      phone: '+1 ••• 0142',
      verified: true,
      optedOut: false,
      security: false,
      reminders: false,
    });
    await remind('bill:1');
    expect(outbox()).toHaveLength(0);
  });

  it('text reminders on a plan that includes them, up to its monthly count, with no figures', async () => {
    const res = await c.patch('/v1/me/notification-prefs', { texts: { reminders: true } });
    expect(res.body.texts.reminders).toBe(true);
    await remind('bill:2');
    await remind('bill:3');
    await remind('bill:4');
    expect(outbox().map((m) => m.to)).toEqual([PHONE, PHONE]);
    expect(outbox()[0]!.body).toBe('Montra: Electric bill due tomorrow');
    const usage = await admin.query(`select sent from app.sms_usage where workspace_id = $1`, [ws]);
    expect(usage.rows[0].sent).toBe(2);
  });

  it('text security alerts when turned on, not counted against the plan', async () => {
    const texts = h.app.get(TextsService);
    expect(await texts.securityAlert(userId, 'your password was changed.')).toBe('not_wanted');
    await c.patch('/v1/me/notification-prefs', { texts: { security: true } });
    const before = outbox().length;
    expect(await texts.securityAlert(userId, 'your password was changed.')).toBe('sent');
    expect(outbox().slice(before)).toEqual([{ to: PHONE, body: 'Montra: your password was changed.' }]);
  });

  it('go only to countries on the allowed list, and only for kinds the owner switched on', async () => {
    const db = h.app.get(Db);
    const settings = (values: Partial<Awaited<ReturnType<ServiceSettings['values']>>>) =>
      ({
        values: async () => ({ ...(await h.app.get(ServiceSettings).values()), ...values }),
      }) as unknown as ServiceSettings;
    const config = loadConfig({
      ...process.env,
      SMS_MODE: 'memory',
      DATABASE_URL: 'postgres://x@localhost/x',
    });
    const sms = { send: vi.fn(async () => ({ id: 'x' })) };
    const plans = h.app.get(Plans);
    const elsewhere = new TextsService(db, config, sms, settings({ smsCountries: ['GB'] }), plans);
    expect(await elsewhere.securityAlert(userId, 'x')).toBe('country');
    const noSecurity = new TextsService(
      db,
      config,
      sms,
      settings({ smsKinds: ['codes', 'reminders'] }),
      plans,
    );
    expect(await noSecurity.securityAlert(userId, 'x')).toBe('kind_off');
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('stop for a number that replied STOP, until the number changes', async () => {
    const db = h.app.get(Db);
    const config = loadConfig({
      ...process.env,
      SMS_MODE: 'memory',
      DATABASE_URL: 'postgres://x@localhost/x',
    });
    const stopped = { send: vi.fn(async () => Promise.reject(new SmsOptedOut())) };
    const texts = new TextsService(db, config, stopped, h.app.get(ServiceSettings), h.app.get(Plans));
    expect(await texts.securityAlert(userId, 'x')).toBe('opted_out');
    expect((await prefs()).texts.optedOut).toBe(true);
    expect(await h.app.get(TextsService).securityAlert(userId, 'x')).toBe('opted_out');
    // A new number starts afresh.
    await admin.query(`select app.sync_user_phone($1, '+14155550143', true)`, [userId]);
    expect((await prefs()).texts).toMatchObject({ phone: '+1 ••• 0143', optedOut: false });
  });

  it('send through Twilio’s Messaging Service, and recognise its STOP answer', async () => {
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: 'postgres://x@localhost/x',
      SMS_MODE: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: 'token-only-used-here',
      TWILIO_MESSAGING_SERVICE_SID: 'MG00000000000000000000000000000000',
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 })
        : new Response(JSON.stringify({ code: 21610, message: 'unsubscribed +14155550143' }), {
            status: 400,
          });
    });
    try {
      const twilio = new TwilioSms(config);
      expect(await twilio.send({ to: PHONE, body: 'Montra: hello' })).toEqual({ id: 'SM1' });
      expect(calls[0]!.url).toBe(
        'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json',
      );
      const form = new URLSearchParams(String(calls[0]!.init.body));
      expect(Object.fromEntries(form)).toEqual({
        To: PHONE,
        Body: 'Montra: hello',
        MessagingServiceSid: 'MG00000000000000000000000000000000',
      });
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
        `Basic ${Buffer.from('AC00000000000000000000000000000000:token-only-used-here').toString('base64')}`,
      );
      await expect(twilio.send({ to: PHONE, body: 'x' })).rejects.toBeInstanceOf(SmsOptedOut);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('send the owner’s test text to their own number from the Providers page', async () => {
    await admin.query(
      `insert into app.staff_user (user_id, role) values ($1, 'owner') on conflict do nothing`,
      [userId],
    );
    const before = outbox().length;
    const res = await c.post('/v1/admin/providers/test-text');
    expect(res.body).toEqual({ to: '+1 ••• 0143' });
    expect(outbox().slice(before)).toEqual([
      { to: '+14155550143', body: 'Montra: this is a test text from the Providers page.' },
    ]);
    const sms = (await c.get('/v1/admin/providers')).body.rows.find((r: any) => r.key === 'sms');
    expect(sms).toMatchObject({ configured: false, mode: 'memory' });
    await admin.query(`delete from app.staff_user where user_id = $1`, [userId]);
  });
});
