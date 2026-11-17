/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Access rules where the server and the clients disagreed (ADR-0053, "Inconsistencies found").
const usd = (amount: string) => ({ amount, currency: 'USD' });
const OWNER = 'access-owner@example.test';
const VIEWER = 'access-viewer@example.test';
const DEMOTED = 'access-demoted@example.test';

let h: Harness;
let db: pg.Client;
let owner: Client;
let url: (p: string) => string;
let workspaceId: string;
let business: string;
let bizChecking: string;

const join = async (email: string, body: object) => {
  const invite = await owner.post(url('/sharing/invites'), { email, ...body });
  expect(invite.status).toBe(201);
  expect((await h.as(email).post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
};
const memberOf = async (email: string) =>
  ((await owner.get(url('/sharing/members'))).body.data as any[]).find((m) => m.email === email);

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  owner = h.as(OWNER);
  const ws = (
    await owner.post('/v1/workspaces', {
      name: 'Access',
      baseCurrency: 'USD',
      template: 'hybrid',
      businessName: 'Studio',
    })
  ).body;
  workspaceId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await owner.get(url('/entities'))).body.data;
  business = entities.find((e: any) => e.type === 'business').id;
  bizChecking = (
    await owner.post(url('/accounts'), { name: 'Studio checking', kind: 'checking', entityId: business })
  ).body.id;
});
afterAll(async () => {
  await db.end();
  await h.close();
});

describe('a viewer is read-only (ADR-0053 Q2)', () => {
  it('refuses a write grant for a viewer in an invite', async () => {
    const res = await owner.post(url('/sharing/invites'), {
      email: VIEWER,
      role: 'viewer',
      entityGrants: [{ entityId: business, access: 'write' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('grant.viewer_write');
  });

  it('refuses a write grant for a viewer in their book access', async () => {
    await join(VIEWER, { role: 'viewer', entityGrants: [{ entityId: business, access: 'read' }] });
    const viewer = await memberOf(VIEWER);
    const res = await owner.put(url(`/sharing/members/${viewer.userId}/grants`), {
      grants: [{ entityId: business, access: 'write' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('grant.viewer_write');
    expect((await memberOf(VIEWER)).grants).toEqual([{ entityId: business, access: 'read' }]);
  });

  it('treats a write grant a viewer already has as read', async () => {
    // A grant saved before the API refused them.
    const viewer = await memberOf(VIEWER);
    await db.query(
      `update app.entity_grant set access = 'write' where workspace_id = $1 and user_id = $2 and entity_id = $3`,
      [workspaceId, viewer.userId, business],
    );
    const as = h.as(VIEWER);
    const res = await as.post(url('/transactions'), {
      date: '2026-10-01',
      accountId: bizChecking,
      amount: usd('-12'),
      description: 'Viewer write',
    });
    expect(res.status).not.toBe(201);
    const { rows } = await db.query(
      `select 1 from app.transaction where workspace_id = $1 and description = 'Viewer write'`,
      [workspaceId],
    );
    expect(rows).toHaveLength(0);
    const { entities } = (await as.get(`/v1/workspaces/${workspaceId}`)).body;
    expect(entities.find((e: any) => e.id === business).access).toBe('read');
  });

  it('turns write grants into read when someone becomes a viewer', async () => {
    await join(DEMOTED, { role: 'partner', entityGrants: [{ entityId: business, access: 'write' }] });
    const partner = await memberOf(DEMOTED);
    expect(partner.grants).toEqual([{ entityId: business, access: 'write' }]);
    const res = await owner.patch(url(`/sharing/members/${partner.userId}`), { role: 'viewer' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'viewer', grants: [{ entityId: business, access: 'read' }] });
    // Back to partner: the grant stays read until someone gives write again.
    const back = await owner.patch(url(`/sharing/members/${partner.userId}`), { role: 'partner' });
    expect(back.body.grants).toEqual([{ entityId: business, access: 'read' }]);
  });
});
