/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '@montra/db';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Payments to different accounts are different payees (backlog item 11): "ONLINE PAYMENT TO CARD XXXX4321" and
// "… XXXX8765" used to share the payee key "TO", and with it one payee, one history and one transfer memory.
const EMAIL = 'payee-keys@example.test';

let h: Harness;
let c: Client;
let worker: Worker;
let admin: pg.Client;
let wsId: string;
let url: (p: string) => string;
let checking: string;

async function upload(text: string) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: url('/uploads'),
    headers: {
      authorization: `Bearer dev:${EMAIL}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="payments.csv"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
      Buffer.from(text),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  return JSON.parse(res.body).fileId as string;
}

const txnsByDescription = async () =>
  Object.fromEntries(
    (
      await admin.query(
        `select t.description, t.payee_key, p.display_name, p.normalized_key
           from app.transaction t left join app.payee p on p.workspace_id = t.workspace_id and p.id = t.payee_id
          where t.workspace_id = $1 and t.deleted_at is null`,
        [wsId],
      )
    ).rows.map((r) => [r.description, r]),
  );

beforeAll(async () => {
  h = await startHarness({
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-payee-keys-')),
    AI_PROVIDER: 'fake',
  });
  h.app.get(ImportJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Payee keys', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  checking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
});
afterAll(async () => {
  await admin?.end();
  await h?.close();
});

describe('payee keys for payments to accounts (backlog item 11)', () => {
  it('gives each card its own payee when a statement is imported, and leaves merchants as they were', async () => {
    const csv = [
      'Date,Description,Amount',
      '2026-11-02,ONLINE PAYMENT TO CARD XXXX4321,-100.00',
      '2026-11-03,ONLINE PAYMENT TO CARD XXXX8765,-200.00',
      '2026-11-04,SQ *BLUE BOTTLE 0423 SF CA,-5.00',
    ].join('\n');
    const batch = (await c.post(url('/imports'), { fileId: await upload(csv), accountId: checking })).body;
    await worker.drain(['import', 'ai']);
    await c.post(url(`/imports/${batch.id}/commit`));
    await worker.drain(['import', 'ai']);
    expect((await c.get(url(`/imports/${batch.id}`))).body.status).toBe('committed');
    const t = await txnsByDescription();
    expect(t['ONLINE PAYMENT TO CARD XXXX4321']).toMatchObject({
      payee_key: 'TO ••4321',
      normalized_key: 'TO ••4321',
      display_name: 'Payment to Card ••4321',
    });
    expect(t['ONLINE PAYMENT TO CARD XXXX8765']).toMatchObject({
      payee_key: 'TO ••8765',
      normalized_key: 'TO ••8765',
    });
    expect(t['SQ *BLUE BOTTLE 0423 SF CA']).toMatchObject({ payee_key: 'BLUE BOTTLE' });
    // A payment typed in by hand gets the same key.
    const typed = await c.post(url('/transactions'), {
      date: '2026-11-05',
      accountId: checking,
      amount: { amount: '-5000', currency: 'USD' },
      payee: 'AUTOPAY TO AMEX XXXXX1002',
    });
    expect(typed.status).toBe(201);
    expect(
      (await admin.query(`select payee_key from app.transaction where id = $1`, [typed.body.id])).rows[0],
    ).toEqual({
      payee_key: 'AUTOPAY TO AMEX ••1002',
    });
  });

  it('moves what was stored under the shared key to each account (migration 0076), and a second run changes nothing', async () => {
    // As before the change: both payments on the payee "TO", each counted once in its history, with a correction each.
    const cat = (
      await admin.query(
        `select id from app.ledger_account where workspace_id = $1 and name = 'Miscellaneous' limit 1`,
        [wsId],
      )
    ).rows[0].id as string;
    const shared = (
      await admin.query(
        `insert into app.payee (workspace_id, display_name, normalized_key) values ($1, 'Online Payment To Card Xxxx4321', 'TO')
         returning id`,
        [wsId],
      )
    ).rows[0].id as string;
    const payments = (
      await admin.query(
        `update app.transaction
            set payee_key = 'TO', payee_id = $2,
                categorization = jsonb_build_object('step', 'user', 'confidence', 1, 'explanation', 'Chosen',
                                                    'ruleId', null, 'suggested', null,
                                                    'learned', jsonb_build_object('categoryId', $3::text, 'memberId', null, 'band', 4))
          where workspace_id = $1 and description like 'ONLINE PAYMENT TO CARD%' returning id`,
        [wsId, shared, cat],
      )
    ).rows.map((r) => r.id as string);
    expect(payments).toHaveLength(2);
    await admin.query(`delete from app.payee_history where workspace_id = $1 and payee_key like 'TO%'`, [
      wsId,
    ]);
    await admin.query(
      `insert into app.payee_history (workspace_id, payee_key, amount_band, category_id, member_id, count)
       values ($1, 'TO', 4, $2, null, 2)`,
      [wsId, cat],
    );
    for (const id of payments)
      await admin.query(
        `insert into app.correction (workspace_id, transaction_id, payee_key, field, from_value, to_value, from_step)
         values ($1, $2, 'TO', 'category', null, $3, 'none')`,
        [wsId, id, cat],
      );

    const migration = readFileSync(join(MIGRATIONS_DIR, '0076_payment_payee_keys.sql'), 'utf8');
    const state = async () => ({
      txns: Object.fromEntries(
        Object.entries(await txnsByDescription())
          .filter(([d]) => d.startsWith('ONLINE PAYMENT'))
          .map(([d, r]: [string, any]) => [d, [r.payee_key, r.normalized_key]]),
      ),
      history: (
        await admin.query(
          `select payee_key, count from app.payee_history where workspace_id = $1 and payee_key like 'TO%' order by 1`,
          [wsId],
        )
      ).rows.map((r) => [r.payee_key, r.count]),
      corrections: (
        await admin.query(`select payee_key from app.correction where workspace_id = $1 order by 1`, [wsId])
      ).rows.map((r) => r.payee_key),
    });
    await admin.query(migration);
    const after = await state();
    expect(after).toEqual({
      txns: {
        'ONLINE PAYMENT TO CARD XXXX4321': ['TO ••4321', 'TO ••4321'],
        'ONLINE PAYMENT TO CARD XXXX8765': ['TO ••8765', 'TO ••8765'],
      },
      history: [
        ['TO', 0],
        ['TO ••4321', 1],
        ['TO ••8765', 1],
      ],
      corrections: ['TO ••4321', 'TO ••8765'],
    });
    await admin.query(migration);
    expect(await state()).toEqual(after);
  });
});
