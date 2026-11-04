/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, localClock, startOfMonth, todayIn } from '@montra/domain';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { NotificationJobs } from '../src/notifications/notification-jobs.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { PUSH_PORT, type MemoryPush } from '../src/notifications/push.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// The notification engine (NOT-01..03, OPS-10; ADR-0019 §5, §6).
const today = todayIn('UTC');
const year = Number(today.slice(0, 4));
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'notify@example.com';
const PARTNER = 'notify-partner@example.com';

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let jobs: NotificationJobs;
let service: NotificationsService;
let mail: MemoryMail;
let push: MemoryPush;
let url: (p: string) => string;
let wsId: string;
let ownerId: string;
let personal: string;
let business: string;
let checking: string;
let cat: (name: string, entity?: string) => string;

const inbox = async (client = c) => (await client.get(url('/notifications'))).body;
const ofType = async (type: string, client = c) =>
  (await inbox(client)).data.filter((n: any) => n.type === type);
const sent = () => mail.outbox.filter((m) => m.category === 'notification');
const clearWorkspace = async () => {
  await admin.query(`delete from app.notification where workspace_id = $1`, [wsId]);
  mail.outbox.length = 0;
  push.outbox.length = 0;
};
/** Off, so tests aren't at the mercy of what time of day they run. */
const noQuietHours = () =>
  c.patch('/v1/me/notification-prefs', { quietStart: null, quietEnd: null, dailyCap: 50 });

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(ImportJobs).register();
  jobs = h.app.get(NotificationJobs);
  service = h.app.get(NotificationsService);
  mail = h.app.get(MAIL_PORT) as MemoryMail;
  push = h.app.get(PUSH_PORT) as MemoryPush;
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Notify', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await c.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  business = (await c.post(url('/entities'), { type: 'business', name: 'Studio', businessType: 'sole_prop' }))
    .body.id;
  const account = async (name: string, entityId: string, opening: string) =>
    (
      await c.post(url('/accounts'), {
        name,
        kind: 'checking',
        openingBalance: usd(opening),
        openingDate: `${year - 1}-12-01`,
        entityId,
      })
    ).body.id;
  checking = await account('Checking', personal, '1000000');
  await account('Studio bank', business, '1000000');
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name, entity = personal) => cats.find((x: any) => x.name === name && x.entityId === entity).id;
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
  ownerId = (await admin.query(`select id from app.app_user where email = $1`, [EMAIL])).rows[0].id;
  await c.post('/v1/me/push-devices', { token: 'ExponentPushToken[owner]', platform: 'ios' });
});
afterAll(async () => {
  await admin.end();
  await h.close();
});
beforeEach(async () => {
  await clearWorkspace();
  await noQuietHours();
});

describe('what gets a notification (NOT-01)', () => {
  it('tells about a large transaction, once', async () => {
    const t = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('-75000'),
        payee: 'BIG SHOP',
        categoryId: cat('Groceries'),
      })
    ).body;
    await jobs.nightly(wsId);
    const [n] = await ofType('large_transaction');
    expect(n).toMatchObject({
      title: 'Large transaction: BIG SHOP',
      read: false,
      link: `/w/${wsId}/transactions/${t.id}`,
    });
    await jobs.nightly(wsId);
    expect(await ofType('large_transaction')).toHaveLength(1);
    await c.delete(url(`/transactions/${t.id}`));
  });

  it('uses each person’s own threshold, and none means none', async () => {
    const t = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('-30000'),
        payee: 'MEDIUM SHOP',
        categoryId: cat('Groceries'),
      })
    ).body;
    await jobs.nightly(wsId);
    expect(await ofType('large_transaction')).toEqual([]);
    await c.patch('/v1/me/notification-prefs', { largeTransaction: '20000' });
    await jobs.nightly(wsId);
    expect(await ofType('large_transaction')).toHaveLength(1);
    await c.patch('/v1/me/notification-prefs', { largeTransaction: '50000' });
    await c.delete(url(`/transactions/${t.id}`));
  });

  it('warns of a bill due soon, with no amount in the wording', async () => {
    const vendor = (await c.post(url('/parties'), { entityId: business, kind: 'vendor', name: 'Water Co' }))
      .body;
    const bill = await c.post(url('/bills'), {
      entityId: business,
      partyId: vendor.id,
      billDate: today,
      dueDate: addDays(today, 2),
      amount: '12345',
      expenseAccountId: cat('Supplies', business),
    });
    expect(bill.status).toBe(201);
    await jobs.nightly(wsId);
    const bills = await ofType('bill_due');
    expect(bills.map((n: any) => n.title)).toContain(`Water Co is due on ${addDays(today, 2)}`);
    expect(JSON.stringify(bills)).not.toContain('123.45');
    // A partner with no access to the business doesn't hear about its bills.
    expect(await ofType('bill_due', partner)).toEqual([]);
  });

  it('forecasts a low balance', async () => {
    const low = await admin.query(
      `update app.bank_account set low_balance_minor = 99999999 where ledger_account_id = $1 returning 1`,
      [checking],
    );
    expect(low.rowCount).toBe(1);
    await jobs.nightly(wsId);
    const [n] = await ofType('low_balance');
    expect(n.title).toContain('Checking is forecast to run low');
    await admin.query(`update app.bank_account set low_balance_minor = 0 where ledger_account_id = $1`, [
      checking,
    ]);
  });

  it('reminds about imports only after they’ve gone quiet, and only once per import', async () => {
    await jobs.nightly(wsId);
    expect(await ofType('import_reminder')).toEqual([]);
    const batch = await admin.query(
      `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256)
       values ($1, 'statement', 'x/y', 'a.csv', 'text/csv', 1, repeat('a', 64)) returning id`,
      [wsId],
    );
    await admin.query(
      `insert into app.import_batch (workspace_id, entity_id, ledger_account_id, file_id, file_name, file_type, currency, status, committed_at)
       values ($1, $2, $3, $4, 'a.csv', 'csv', 'USD', 'committed', now() - interval '10 days')`,
      [wsId, personal, checking, batch.rows[0].id],
    );
    await jobs.nightly(wsId);
    const [n] = await ofType('import_reminder');
    expect(n.title).toBe('Your last import was 10 days ago');
    await jobs.nightly(wsId);
    expect(await ofType('import_reminder')).toHaveLength(1);
    // Someone who wants a longer gap doesn't hear yet.
    await admin.query(`delete from app.notification where workspace_id = $1`, [wsId]);
    await c.patch('/v1/me/notification-prefs', { importReminderDays: 30 });
    await jobs.nightly(wsId);
    expect(await ofType('import_reminder')).toEqual([]);
    await c.patch('/v1/me/notification-prefs', { importReminderDays: 9 });
  });

  it('tells about rent overdue and leases ending, to those who can see the portfolio', async () => {
    const rental = (await c.post(url('/entities'), { type: 'rental', name: 'Rentals' })).body.id;
    const property = (await c.post(url('/properties'), { entityId: rental, name: 'Elm House', type: 'sfh' }))
      .body;
    const tenant = (await c.post(url('/tenants'), { entityId: rental, name: 'Rae Tenant' })).body;
    const last = startOfMonth(addDays(startOfMonth(today), -1));
    const lease = await c.post(url('/leases'), {
      unitId: property.units[0].id,
      tenantIds: [tenant.id],
      startDate: last,
      endDate: addDays(today, 20),
      rent: '150000',
    });
    expect(lease.status).toBe(201);
    await jobs.nightly(wsId);
    expect((await ofType('rent_overdue'))[0].title).toBe('Rent is overdue: Elm House · Main');
    expect((await ofType('lease_expiring'))[0].title).toContain('Elm House · Main');
    expect(await ofType('rent_overdue', partner)).toEqual([]);
    expect(await ofType('lease_expiring', partner)).toEqual([]);
    await admin.query(`update app.entity set archived_at = now() where id = $1`, [rental]);
  });

  it('sends one suggestion notice a day however many there are', async () => {
    await admin.query(
      `insert into app.recommendation (workspace_id, entity_id, type, period_start, dedupe_key, payload)
       values ($1, $2, 'REC-02', $3, 'a', '{}'), ($1, $2, 'REC-03', $3, 'b', '{}'),
              ($1, $2, 'REC-07', $3, 'c', '{"title":"October in review"}'),
              ($1, $2, 'REC-09', $3, 'd', '{"title":"Set aside for tax"}')`,
      [wsId, personal, today],
    );
    await jobs.nightly(wsId);
    expect(await ofType('suggestion')).toHaveLength(1);
    expect((await ofType('monthly_review'))[0].title).toBe('October in review');
    expect((await ofType('tax_due'))[0].title).toBe('Set aside for tax');
    await admin.query(`delete from app.recommendation where workspace_id = $1`, [wsId]);
  });

  it('keeps the partner out of books they can’t see', async () => {
    await c.post(url('/transactions'), {
      date: today,
      accountId: (await c.get(url('/accounts'))).body.data.find((a: any) => a.name === 'Studio bank').id,
      amount: usd('-90000'),
      payee: 'STUDIO RENT',
      categoryId: cat('Supplies', business),
    });
    await jobs.nightly(wsId);
    expect((await ofType('large_transaction')).map((n: any) => n.title)).toContain(
      'Large transaction: STUDIO RENT',
    );
    expect((await ofType('large_transaction', partner)).map((n: any) => n.title)).not.toContain(
      'Large transaction: STUDIO RENT',
    );
  });

  it('writes the weekly digest on the chosen day, with figures in email and none on push', async () => {
    const weekday = localClock(new Date(), 'UTC').weekday;
    await c.patch('/v1/me/notification-prefs', {
      digestWeekday: (weekday % 7) + 1,
      channels: { weekly_digest: { inApp: true, email: true, push: true } },
    });
    await jobs.nightly(wsId);
    expect(await ofType('weekly_digest')).toEqual([]);
    await c.patch('/v1/me/notification-prefs', { digestWeekday: weekday });
    await jobs.nightly(wsId);
    const [digest] = await ofType('weekly_digest');
    expect(digest.body).toMatch(/You spent \$[\d,.]+ from/);
    await service.deliverWaiting();
    const email = sent().find((m) => m.subject === 'Your week in Montra');
    expect(email?.text).toMatch(/You spent \$/);
    const message = push.outbox.find((m) => m.title === 'Your week in Montra');
    expect(JSON.stringify(message)).not.toContain('$');
    await c.patch('/v1/me/notification-prefs', {
      channels: { weekly_digest: { inApp: true, email: true, push: false } },
    });
  });
});

describe('the inbox', () => {
  const seed = async (key: string) => {
    await admin.query(
      `insert into app.notification (workspace_id, user_id, type, title, dedupe_key, email_status, push_status)
       values ($1, $2, 'bill_due', $3, $3, 'none', 'none')`,
      [wsId, ownerId, key],
    );
  };

  it('counts what’s unread, and reads one or all', async () => {
    await seed('one');
    await seed('two');
    const list = await inbox();
    expect(list.unread).toBe(2);
    expect((await c.get(url('/notifications/unread-count'))).body.unread).toBe(2);
    expect((await c.post(url(`/notifications/${list.data[0].id}/read`))).status).toBe(204);
    expect((await inbox()).unread).toBe(1);
    expect((await c.get(url('/notifications?unread=true'))).body.data).toHaveLength(1);
    expect((await c.post(url('/notifications/read-all'))).status).toBe(204);
    expect((await inbox()).unread).toBe(0);
  });

  it('is private to its owner', async () => {
    await seed('mine');
    const [n] = (await inbox()).data;
    expect((await inbox(partner)).data).toEqual([]);
    expect((await partner.post(url(`/notifications/${n.id}/read`))).status).toBe(404);
  });
});

describe('delivery (NOT-01, NOT-03)', () => {
  const write = (key: string, type = 'bill_due', after = 'now()') =>
    admin.query(
      `insert into app.notification (workspace_id, user_id, type, title, link, dedupe_key, deliver_after)
       values ($1, $2, $3, $4, $5, $4, ${after})`,
      [wsId, ownerId, type, key, `/w/${wsId}/calendar`],
    );

  it('sends by email and push, marking what happened on each', async () => {
    await write('Water is due');
    expect(await service.deliverWaiting()).toBeGreaterThanOrEqual(1);
    const email = sent().find((m) => m.subject === 'Water is due')!;
    expect(email.to).toBe(EMAIL);
    expect(email.text).toContain(`/w/${wsId}/calendar`);
    expect(push.outbox.find((m) => m.title === 'Water is due')).toMatchObject({
      token: 'ExponentPushToken[owner]',
      link: `/w/${wsId}/calendar`,
    });
    const { rows } = await admin.query(
      `select email_status, push_status from app.notification where title = 'Water is due'`,
    );
    expect(rows[0]).toEqual({ email_status: 'sent', push_status: 'sent' });
    // Nothing goes twice.
    mail.outbox.length = 0;
    await service.deliverWaiting();
    expect(sent()).toEqual([]);
  });

  it('respects each type’s channels', async () => {
    await c.patch('/v1/me/notification-prefs', {
      channels: { bill_due: { inApp: true, email: false, push: false } },
    });
    await write('Silent bill');
    await service.deliverWaiting();
    expect(sent()).toEqual([]);
    expect(push.outbox).toEqual([]);
    const { rows } = await admin.query(
      `select email_status, push_status from app.notification where title = 'Silent bill'`,
    );
    expect(rows[0]).toEqual({ email_status: 'off', push_status: 'off' });
    await c.patch('/v1/me/notification-prefs', {
      channels: { bill_due: { inApp: true, email: true, push: true } },
    });
  });

  it('skips the inbox, but still sends, when in-app is off', async () => {
    await c.patch('/v1/me/notification-prefs', {
      channels: { large_transaction: { inApp: false, email: true, push: false } },
      largeTransaction: '1000',
    });
    const t = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('-2000'),
        payee: 'QUIET SHOP',
        categoryId: cat('Groceries'),
      })
    ).body;
    await jobs.nightly(wsId);
    expect((await inbox()).unread).toBe((await inbox()).data.filter((n: any) => !n.read).length);
    const [n] = (await inbox()).data.filter((x: any) => x.title.includes('QUIET SHOP'));
    expect(n.read).toBe(true);
    await service.deliverWaiting();
    expect(sent().some((m) => m.subject.includes('QUIET SHOP'))).toBe(true);
    await c.patch('/v1/me/notification-prefs', {
      channels: { large_transaction: { inApp: true, email: false, push: true } },
      largeTransaction: '50000',
    });
    await c.delete(url(`/transactions/${t.id}`));
  });

  it('holds until quiet hours end (NOT-03)', async () => {
    // All day, so it's quiet whenever this runs.
    await c.patch('/v1/me/notification-prefs', { quietStart: 0, quietEnd: 1439, largeTransaction: '1000' });
    const t = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('-3000'),
        payee: 'LATE SHOP',
        categoryId: cat('Groceries'),
      })
    ).body;
    await jobs.nightly(wsId);
    // It's in the app at once, and nothing goes out.
    expect((await inbox()).data.some((n: any) => n.title.includes('LATE SHOP'))).toBe(true);
    await service.deliverWaiting();
    expect(push.outbox.find((m) => m.title.includes('LATE SHOP'))).toBeUndefined();
    // Once the time passes, it does.
    await admin.query(`update app.notification set deliver_after = now() where title like '%LATE SHOP%'`);
    await service.deliverWaiting();
    expect(push.outbox.find((m) => m.title.includes('LATE SHOP'))).toBeDefined();
    await c.patch('/v1/me/notification-prefs', { largeTransaction: '50000' });
    await c.delete(url(`/transactions/${t.id}`));
  });

  it('stops at the daily cap, keeping the rest in-app (NOT-03)', async () => {
    await c.patch('/v1/me/notification-prefs', { dailyCap: 2 });
    for (const k of ['Cap 1', 'Cap 2', 'Cap 3', 'Cap 4']) await write(k);
    await service.deliverWaiting();
    expect(sent()).toHaveLength(2);
    expect(push.outbox).toHaveLength(2);
    const { rows } = await admin.query(
      `select title, email_status, push_status from app.notification where title like 'Cap %' order by title`,
    );
    expect(rows.map((r) => r.email_status)).toEqual(['sent', 'sent', 'capped', 'capped']);
    expect(rows.map((r) => r.push_status)).toEqual(['sent', 'sent', 'capped', 'capped']);
    expect((await inbox()).unread).toBe(4);
    await write('Cap 5');
    await service.deliverWaiting();
    expect(sent()).toHaveLength(2);
  });

  it('counts the cap from today’s sends, not all time', async () => {
    await c.patch('/v1/me/notification-prefs', { dailyCap: 1 });
    await write('Old');
    await service.deliverWaiting();
    await admin.query(
      `update app.notification set created_at = now() - interval '2 days' where title = 'Old'`,
    );
    await write('New');
    await service.deliverWaiting();
    expect(sent().map((m) => m.subject)).toEqual(['Old', 'New']);
  });

  it('forgets a device the provider says is gone', async () => {
    push.dead.add('ExponentPushToken[owner]');
    await write('To a dead phone');
    await service.deliverWaiting();
    expect((await c.get('/v1/me/push-devices')).body.data).toEqual([]);
    push.dead.clear();
    await c.post('/v1/me/push-devices', { token: 'ExponentPushToken[owner]', platform: 'ios' });
  });

  it('keeps going when one channel fails', async () => {
    const original = push.send.bind(push);
    push.send = async () => {
      throw new Error('down');
    };
    await write('Push is down');
    await service.deliverWaiting();
    push.send = original;
    const { rows } = await admin.query(
      `select email_status, push_status from app.notification where title = 'Push is down'`,
    );
    expect(rows[0]).toEqual({ email_status: 'sent', push_status: 'failed' });
  });
});

describe('unsubscribing (OPS-10)', () => {
  const write = (key: string, type = 'bill_due') =>
    admin.query(
      `insert into app.notification (workspace_id, user_id, type, title, dedupe_key) values ($1, $2, $3, $4, $4)`,
      [wsId, ownerId, type, key],
    );

  it('marks notification mail as its own stream, with a one-click link that works with no session', async () => {
    await write('Stream test');
    await service.deliverWaiting();
    const email = sent().find((m) => m.subject === 'Stream test')!;
    const header = email.headers?.['List-Unsubscribe'] ?? '';
    expect(email.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const token = /token=([0-9a-f-]+)/.exec(header)![1]!;
    expect(email.text).toContain(`token=${token}`);
    const res = await h.app.inject({ method: 'POST', url: `/v1/unsubscribe?token=${token}` });
    expect(res.statusCode).toBe(200);
    expect((await c.get('/v1/me/notification-prefs')).body.emailUnsubscribed).toBe(true);

    await write('After leaving');
    mail.outbox.length = 0;
    await service.deliverWaiting();
    expect(sent()).toEqual([]);
    // Push and the inbox carry on: only email was turned off.
    expect(push.outbox.find((m) => m.title === 'After leaving')).toBeDefined();
    await c.patch('/v1/me/notification-prefs', { emailUnsubscribed: false });
  });

  it('still sends what someone asked for', async () => {
    await c.patch('/v1/me/notification-prefs', { emailUnsubscribed: true, dailyCap: 0 });
    await write('Your backup is ready', 'backup_ready');
    await service.deliverWaiting();
    const email = mail.outbox.find((m) => m.subject === 'Your backup is ready');
    expect(email?.category).toBe('transactional');
    expect(email?.headers).toBeUndefined();
    await c.patch('/v1/me/notification-prefs', { emailUnsubscribed: false, dailyCap: 5 });
  });

  it('answers the same for a bad token, and does nothing', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/unsubscribe?token=00000000-0000-4000-8000-000000000000`,
    });
    expect(res.statusCode).toBe(200);
    const bad = await h.app.inject({ method: 'POST', url: `/v1/unsubscribe?token=nonsense` });
    expect(bad.statusCode).toBe(200);
    expect((await c.get('/v1/me/notification-prefs')).body.emailUnsubscribed).toBe(false);
  });
});

describe('preferences', () => {
  it('has sensible defaults before anything is saved', async () => {
    const fresh = h.as('notify-fresh@example.com');
    const p = (await fresh.get('/v1/me/notification-prefs')).body;
    expect(p).toMatchObject({
      quietStart: 1320,
      quietEnd: 420,
      dailyCap: 5,
      largeTransaction: '50000',
      version: 0,
    });
    expect(p.channels.bill_due).toEqual({ inApp: true, email: true, push: true });
    expect(p.channels.suggestion).toEqual({ inApp: true, email: false, push: false });
  });

  it('needs both ends of quiet hours', async () => {
    expect((await c.patch('/v1/me/notification-prefs', { quietStart: 60 })).status).toBe(400);
    expect((await c.patch('/v1/me/notification-prefs', { quietStart: 60, quietEnd: null })).status).toBe(400);
    expect((await c.patch('/v1/me/notification-prefs', { quietStart: 9999, quietEnd: 60 })).status).toBe(400);
  });

  it('merges channels rather than replacing them all', async () => {
    await c.patch('/v1/me/notification-prefs', {
      channels: { reminder: { inApp: true, email: false, push: false } },
    });
    const p = (await c.get('/v1/me/notification-prefs')).body;
    expect(p.channels.reminder.email).toBe(false);
    expect(p.channels.bill_due.email).toBe(true);
    await c.patch('/v1/me/notification-prefs', {
      channels: { reminder: { inApp: true, email: true, push: true } },
    });
  });
});
