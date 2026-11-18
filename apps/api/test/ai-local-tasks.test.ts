import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TASK_BATCH } from '../src/ai/ai.controller.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Local-mode AI tasks (ADR-0012): `GET ai/tasks` claims pending work for a client on the user's network.
let h: Harness;
let db: pg.Client;
let owner: Client;
let url: (p: string) => string;
let workspaceId: string;

const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((t) => t.id);

/** Parks `n` pending tasks, created a second apart so their order is fixed. */
async function park(n: number): Promise<string[]> {
  const made: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    await db.query(
      `insert into app.ai_task (workspace_id, id, task, input, subject_type, subject_id, created_at)
       values ($1, $2, 'categorize', '{}'::jsonb, 'transaction', $3, now() - make_interval(secs => $4))`,
      [workspaceId, id, randomUUID(), n - i],
    );
    made.push(id);
  }
  return made;
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  owner = h.as('ai-tasks-owner@example.test');
  const ws = (
    await owner.post('/v1/workspaces', { name: 'Local AI', baseCurrency: 'USD', template: 'household' })
  ).body;
  workspaceId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
});

afterAll(async () => {
  await db?.end();
  await h?.close();
});

describe('claiming local-mode tasks', () => {
  it('claims at most a batch, oldest first, and the next listing takes the rest', async () => {
    await db.query('delete from app.ai_task where workspace_id = $1', [workspaceId]);
    const parked = await park(TASK_BATCH + 5);
    // Statistics from a near-empty table make the planner expect one row, the case where an unlocked
    // IN (... limit) can be run again per row.
    await db.query('analyze app.ai_task');

    const first = await owner.get(url('/ai/tasks'));
    expect(first.status).toBe(200);
    expect(ids(first)).toEqual(parked.slice(0, TASK_BATCH));

    const second = await owner.get(url('/ai/tasks'));
    expect(ids(second)).toEqual(parked.slice(TASK_BATCH));
    expect((await owner.get(url('/ai/tasks'))).body.data).toEqual([]);

    const { rows } = await db.query(
      `select count(*)::int as n from app.ai_task where workspace_id = $1 and status = 'claimed'`,
      [workspaceId],
    );
    expect(rows[0].n).toBe(parked.length);
  });

  it('never gives the same task to two clients asking at once', async () => {
    await db.query('delete from app.ai_task where workspace_id = $1', [workspaceId]);
    const parked = await park(TASK_BATCH + 5);
    for (let round = 0; round < 5; round++) {
      await db.query(`update app.ai_task set status = 'pending', claimed_at = null where workspace_id = $1`, [
        workspaceId,
      ]);
      const [a, b] = await Promise.all([owner.get(url('/ai/tasks')), owner.get(url('/ai/tasks'))]);
      const got = [...ids(a), ...ids(b)];
      expect(ids(a).length).toBeLessThanOrEqual(TASK_BATCH);
      expect(ids(b).length).toBeLessThanOrEqual(TASK_BATCH);
      expect(new Set(got).size).toBe(got.length);
      expect(got.every((id) => parked.includes(id))).toBe(true);
    }
  });

  it('gives a claimed task out again only after 5 minutes, and never an expired one', async () => {
    await db.query('delete from app.ai_task where workspace_id = $1', [workspaceId]);
    const [stale, fresh, expired] = await park(3);
    await db.query(
      `update app.ai_task set status = 'claimed', claimed_at = now() - interval '6 minutes'
        where workspace_id = $1 and id = $2`,
      [workspaceId, stale],
    );
    await db.query(
      `update app.ai_task set status = 'claimed', claimed_at = now() - interval '1 minute'
        where workspace_id = $1 and id = $2`,
      [workspaceId, fresh],
    );
    await db.query(
      `update app.ai_task set expires_at = now() - interval '1 second' where workspace_id = $1 and id = $2`,
      [workspaceId, expired],
    );
    expect(ids(await owner.get(url('/ai/tasks')))).toEqual([stale]);
  });
});
