/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { SMS_PORT, type MemorySms } from '../src/sms/sms.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Confirming a mobile number with a code the API texts (ADR-0049 §6, migration 0056).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let admin: pg.Client;
let h: Harness;

const texts = () => h.app.get<MemorySms>(SMS_PORT).outbox;
const mails = () => (h.app.get(MAIL_PORT) as MemoryMail).outbox;
const codeIn = (body: string) => /\b(\d{6})\b/.exec(body)?.[1] ?? '';
const lastCodeTo = (to: string) =>
  codeIn(
    texts()
      .filter((m) => m.to === to)
      .at(-1)?.body ?? '',
  );
const userOf = async (email: string) =>
  (await admin.query(`select id, phone_e164, phone_verified from app.app_user where email = $1`, [email]))
    .rows[0];

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  h = await startHarness({ SMS_MODE: 'memory' });
});
afterAll(async () => {
  await h.close();
  await admin.end();
});

describe('confirming a mobile number (ADR-0049 §6)', () => {
  it('texts a code, confirms the number with it, and says so by email', async () => {
    const c = h.as('phone-confirm@example.test');
    expect((await c.get('/v1/me/phone')).body).toEqual({
      available: true,
      phone: null,
      verified: false,
      pending: null,
    });

    const sent = await c.post('/v1/me/phone', { phone: '+1 (415) 555-0161' });
    expect(sent.status).toBe(201);
    expect(sent.body.phone).toBe('+1 ••• 0161');
    const text = texts().at(-1)!;
    expect(text.to).toBe('+14155550161');
    expect(text.body).toMatch(/^Montra code to confirm this number: \d{6}\. It expires in 10 minutes\.$/);
    expect(text.body).not.toMatch(/https?:|www\./);

    // Stored hashed: the code itself is nowhere in the table.
    const code = codeIn(text.body);
    const row = (
      await admin.query(
        `select code_hash, phone from app.phone_verification order by created_at desc limit 1`,
      )
    ).rows[0];
    expect(row.phone).toBe('+14155550161');
    expect(row.code_hash).not.toContain(code);
    expect((await c.get('/v1/me/phone')).body.pending).toMatchObject({ phone: '+1 ••• 0161' });

    const before = mails().length;
    const done = await c.post('/v1/me/phone/confirm', { code });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ phone: '+1 ••• 0161', verified: true, pending: null });
    expect(await userOf('phone-confirm@example.test')).toMatchObject({
      phone_e164: '+14155550161',
      phone_verified: true,
    });
    expect(mails().slice(before)).toEqual([
      expect.objectContaining({
        to: 'phone-confirm@example.test',
        subject: 'The mobile number on your Montra account changed',
      }),
    ]);
    const events = await admin.query(
      `select e.kind, e.detail from app.security_event e join app.app_user u on u.id = e.user_id
        where u.email = 'phone-confirm@example.test'`,
    );
    expect(events.rows).toEqual([{ kind: 'phone_changed', detail: { added: true, removed: false } }]);
    // The notification settings see it at once: texts can now be switched on.
    expect((await c.get('/v1/me/notification-prefs')).body.texts).toMatchObject({
      phone: '+1 ••• 0161',
      verified: true,
    });

    // Single use.
    const again = await c.post('/v1/me/phone/confirm', { code });
    expect(again).toMatchObject({ status: 422, body: { code: 'phone.no_code' } });
    // Asking again for the same confirmed number is refused rather than texted.
    expect((await c.post('/v1/me/phone', { phone: '+14155550161' })).body.code).toBe('phone.unchanged');
  });

  it('allows five tries per code, then a new one is needed', async () => {
    const c = h.as('phone-guess@example.test');
    await c.post('/v1/me/phone', { phone: '+14155550162' });
    const code = lastCodeTo('+14155550162');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/v1/me/phone/confirm', { code: wrong });
      expect(r).toMatchObject({ status: 422, body: { code: 'phone.wrong_code' } });
    }
    // Even the right code is too late now.
    const r = await c.post('/v1/me/phone/confirm', { code });
    expect(r).toMatchObject({ status: 422, body: { code: 'phone.no_code' } });
    expect((await userOf('phone-guess@example.test')).phone_e164).toBeNull();

    // A new request replaces the old: its code works, the old one doesn't.
    await c.post('/v1/me/phone', { phone: '+14155550162' });
    const fresh = lastCodeTo('+14155550162');
    expect((await c.post('/v1/me/phone/confirm', { code: fresh })).status).toBe(200);
  });

  it('stops wrong guesses across new codes, per person', async () => {
    const c = h.as('phone-guesser@example.test');
    let last = '';
    for (let round = 0; round < 3; round++) {
      await c.post('/v1/me/phone', { phone: '+14155550163' });
      last = lastCodeTo('+14155550163');
      const wrong = last === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4 && round * 4 + i < 10; i++) await c.post('/v1/me/phone/confirm', { code: wrong });
    }
    // Ten wrong codes in 15 minutes locks the person out of guessing, even with the right code.
    const r = await c.post('/v1/me/phone/confirm', { code: last });
    expect(r).toMatchObject({ status: 429, body: { code: 'sms.too_many' } });
  });

  it('limits codes per number, whoever asks, and per person (against SMS pumping)', async () => {
    const one = h.as('phone-pump-1@example.test');
    const two = h.as('phone-pump-2@example.test');
    const n = texts().length;
    for (let i = 0; i < 3; i++)
      expect((await one.post('/v1/me/phone', { phone: '+14155550164' })).status).toBe(201);
    for (let i = 0; i < 2; i++)
      expect((await two.post('/v1/me/phone', { phone: '+14155550164' })).status).toBe(201);
    const sixth = await two.post('/v1/me/phone', { phone: '+14155550164' });
    expect(sixth).toMatchObject({ status: 429, body: { code: 'sms.too_many' } });
    expect(texts().length - n).toBe(5);

    // One person spreading requests over many numbers is stopped as well.
    const three = h.as('phone-pump-3@example.test');
    for (let i = 0; i < 5; i++)
      expect((await three.post('/v1/me/phone', { phone: `+1415555017${i}` })).status).toBe(201);
    expect((await three.post('/v1/me/phone', { phone: '+14155550179' })).status).toBe(429);
  });

  it('texts only countries on the allowed list, and only well-formed numbers', async () => {
    const c = h.as('phone-abroad@example.test');
    const n = texts().length;
    expect((await c.post('/v1/me/phone', { phone: '+44 7700 900123' })).body.code).toBe('sms.country');
    expect((await c.post('/v1/me/phone', { phone: '415 555 0123' })).body.code).toBe('phone.invalid');
    expect((await c.post('/v1/me/phone', { phone: '' })).status).toBe(400);
    expect(texts().length).toBe(n);
    expect((await c.get('/v1/me/phone')).body.pending).toBeNull();
  });

  it('won’t text a number already confirmed on another account', async () => {
    const owner = h.as('phone-owner@example.test');
    await owner.post('/v1/me/phone', { phone: '+14155550167' });
    await owner.post('/v1/me/phone/confirm', { code: lastCodeTo('+14155550167') });
    const n = texts().length;
    const r = await h.as('phone-taker@example.test').post('/v1/me/phone', { phone: '+14155550167' });
    expect(r).toMatchObject({ status: 409, body: { code: 'phone.in_use' } });
    expect(texts().length).toBe(n);
  });

  it('removes the number, logs it and says so', async () => {
    const c = h.as('phone-remove@example.test');
    await c.post('/v1/me/phone', { phone: '+14155550165' });
    await c.post('/v1/me/phone/confirm', { code: lastCodeTo('+14155550165') });
    const before = mails().length;
    const r = await c.delete('/v1/me/phone');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ phone: null, verified: false });
    expect(await userOf('phone-remove@example.test')).toMatchObject({
      phone_e164: null,
      phone_verified: false,
    });
    expect(
      mails()
        .slice(before)
        .map((m) => m.text),
    ).toEqual([expect.stringMatching(/was removed/)]);
  });
});

describe('where texts are off', () => {
  let off: Harness;
  beforeAll(async () => {
    off = await startHarness({ SMS_MODE: 'off' });
  });
  afterAll(async () => {
    await off.close();
  });

  it('offers no number, and texts nothing', async () => {
    const c = off.as('phone-off@example.test');
    expect((await c.get('/v1/me/phone')).body.available).toBe(false);
    expect((await c.post('/v1/me/phone', { phone: '+14155550166' })).body.code).toBe('sms.not_configured');
  });
});
