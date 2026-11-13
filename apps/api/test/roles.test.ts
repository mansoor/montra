/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberMayRequest } from '../src/common/roles.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Roles and family logins (AUTH-14..17; ADR-0041): admins, members, invites linked to family members, hand-over.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const OWNER = 'roles-owner@example.test';
const ADMIN = 'roles-admin@example.test';
const PARTNER = 'roles-partner@example.test';
const MEMBER = 'roles-member@example.test';

let h: Harness;
let owner: Client;
let admin: Client;
let partner: Client;
let member: Client;
let url: (p: string) => string;
let personal: string;
let checking: string;

const join = async (by: Client, who: Client, body: object) => {
  const invite = await by.post(url('/sharing/invites'), body);
  expect(invite.status).toBe(201);
  expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
  return invite.body;
};
const members = async (c: Client = owner) => (await c.get(url('/sharing/members'))).body.data as any[];
const family = async () => (await owner.get(url('/family-members'))).body.data as any[];
const userIdOf = async (email: string) => (await members()).find((m) => m.email === email).userId as string;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  owner = h.as(OWNER);
  admin = h.as(ADMIN);
  partner = h.as(PARTNER);
  member = h.as(MEMBER);
  const ws = (await owner.post('/v1/workspaces', { name: 'Roles', baseCurrency: 'USD', template: 'hybrid' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await owner.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  checking = (
    await owner.post(url('/accounts'), { name: 'Family checking', kind: 'checking', entityId: personal })
  ).body.id;
});
afterAll(() => h.close());

describe('inviting a family member (AUTH-16)', () => {
  it('adds the person to the Family list and links them when they accept', async () => {
    const invite = await join(owner, admin, {
      email: ADMIN,
      role: 'admin',
      familyMember: { name: 'Riley', relationship: 'spouse_partner' },
    });
    const riley = (await family()).find((f) => f.name === 'Riley');
    expect(invite.familyMemberId).toBe(riley.id);
    const adminId = await userIdOf(ADMIN);
    expect(riley.linkedUserId).toBe(adminId);
    expect((await members()).find((m) => m.userId === adminId)).toMatchObject({
      role: 'admin',
      familyMemberId: riley.id,
    });
    const listed = (await owner.get(url('/sharing/invites'))).body.data;
    expect(listed[0]).toMatchObject({ familyMemberId: riley.id, status: 'accepted' });
  });

  it('links someone already in the Family list', async () => {
    const kid = (await owner.post(url('/family-members'), { name: 'Kai', relationship: 'child' })).body;
    await join(owner, member, { email: MEMBER, role: 'member', familyMember: { id: kid.id } });
    expect((await family()).find((f) => f.id === kid.id).linkedUserId).toBe(await userIdOf(MEMBER));
  });

  it('refuses a person who already signs in with another email', async () => {
    const kai = (await family()).find((f) => f.name === 'Kai');
    const res = await owner.post(url('/sharing/invites'), {
      email: 'someone-else@example.test',
      role: 'viewer',
      familyMember: { id: kai.id },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invite.family_linked');
  });

  it('leaves choosing the login to owners and admins', async () => {
    await join(admin, partner, { email: PARTNER, role: 'partner' });
    const kai = (await family()).find((f) => f.name === 'Kai');
    const partnerId = await userIdOf(PARTNER);
    expect((await partner.patch(url(`/family-members/${kai.id}`), { linkedUserId: partnerId })).status).toBe(
      403,
    );
    // Partners still keep the Family list itself.
    expect((await partner.patch(url(`/family-members/${kai.id}`), { color: '#336699' })).status).toBe(200);
  });
});

describe('admins (AUTH-14)', () => {
  it('manage sharing and settings, as the owner does', async () => {
    expect((await admin.get(url('/sharing/invites'))).status).toBe(200);
    expect((await admin.patch(url('/ai/settings'), { mode: 'off' })).status).toBe(200);
    const partnerId = await userIdOf(PARTNER);
    expect((await admin.patch(url(`/sharing/members/${partnerId}`), { role: 'viewer' })).body.role).toBe(
      'viewer',
    );
    expect((await admin.patch(url(`/sharing/members/${partnerId}`), { role: 'partner' })).body.role).toBe(
      'partner',
    );
  });

  it('cannot change or remove the owner, or make themselves owner', async () => {
    const ownerId = await userIdOf(OWNER);
    expect((await admin.patch(url(`/sharing/members/${ownerId}`), { status: 'revoked' })).status).toBe(404);
    expect((await admin.patch(url(`/sharing/members/${ownerId}`), { role: 'viewer' })).status).toBe(404);
    const other = await admin.patch(url(`/sharing/members/${await userIdOf(PARTNER)}`), { role: 'owner' });
    expect(other.status).toBe(403);
    expect((await members()).find((m) => m.userId === ownerId).role).toBe('owner');
  });

  it('are out of reach of partners', async () => {
    expect(
      (await partner.post(url('/sharing/invites'), { email: 'x@example.test', role: 'viewer' })).status,
    ).toBe(403);
    const adminId = await userIdOf(ADMIN);
    expect((await partner.patch(url(`/sharing/members/${adminId}`), { status: 'revoked' })).status).toBe(403);
  });
});

describe('members (AUTH-17)', () => {
  it('add and correct transactions in the personal books', async () => {
    const made = [];
    for (const date of ['2026-10-01', '2026-10-08']) {
      const t = await member.post(url('/transactions'), {
        date,
        accountId: checking,
        amount: usd('-12'),
        description: 'XYZZY corner shop',
      });
      expect(t.status).toBe(201);
      made.push(t.body);
    }
    const household = (await member.get(url('/categories'))).body.data.find(
      (c: any) => c.name === 'Household',
    );
    // Two identical corrections would offer the owner a rule; for a member they just save.
    for (const t of made) {
      const res = await member.post(url(`/review/${t.id}/resolve`), { categoryId: household.id });
      expect(res.status).toBe(200);
      expect(res.body.ruleSuggestion ?? null).toBeNull();
    }
  });

  it('stay out of setup: categories, accounts, rules, settings and sharing', async () => {
    const attempts = [
      member.post(url('/categories'), { entityId: personal, name: 'Games', type: 'expense' }),
      member.post(url('/accounts'), { name: 'Mine', kind: 'checking', entityId: personal }),
      member.post(url('/rules'), { name: 'r', conditions: { all: [] }, actions: {} }),
      member.patch(url('/ai/settings'), { mode: 'builtin' }),
      member.post(url('/family-members'), { name: 'Pet', relationship: 'other' }),
      member.post(url('/sharing/invites'), { email: 'y@example.test', role: 'viewer' }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('role.member');
    }
  });

  it('see only what their books allow', async () => {
    const types = (await member.get(url('/entities'))).body.data.map((e: any) => e.type);
    expect(types).toEqual(['personal']);
  });

  it('may write only the routes listed for them', () => {
    expect(memberMayRequest('GET', '/v1/workspaces/:workspaceId/rules')).toBe(true);
    expect(memberMayRequest('PATCH', '/v1/workspaces/:workspaceId/transactions/:id')).toBe(true);
    expect(memberMayRequest('POST', '/v1/workspaces/:workspaceId/receipts/')).toBe(true);
    expect(memberMayRequest('POST', '/v1/workspaces/:workspaceId/imports')).toBe(false);
    expect(memberMayRequest('POST', '/v1/workspaces/:workspaceId/budgets')).toBe(false);
    expect(memberMayRequest('POST', undefined)).toBe(false);
  });
});

describe('book access for clients (AUTH-18)', () => {
  const accessOf = async (c: Client) =>
    Object.fromEntries((await c.get(url(''))).body.entities.map((e: any) => [e.type, e.access]));

  it('says which books a login may write', async () => {
    const all = await accessOf(owner);
    expect(Object.keys(all)).toContain('business');
    expect(new Set(Object.values(all))).toEqual(new Set(['write']));
    // A member sees only the personal books, writable by default.
    expect(await accessOf(member)).toEqual({ personal: 'write' });
    const viewer = h.as('roles-viewer@example.test');
    await join(owner, viewer, { email: 'roles-viewer@example.test', role: 'viewer' });
    expect(await accessOf(viewer)).toEqual({ personal: 'read' });
    // The phone's offline copy says the same.
    const pulled = (await viewer.get(url('/sync/pull?since=0'))).body.entities;
    expect(pulled.map((e: any) => [e.type, e.access])).toEqual([['personal', 'read']]);
  });
});

describe('handing over ownership (AUTH-15)', () => {
  it('needs an admin to hand to', async () => {
    const res = await owner.patch(url(`/sharing/members/${await userIdOf(PARTNER)}`), { role: 'owner' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('member.not_admin');
  });

  it('makes the admin owner and the old owner an admin', async () => {
    const adminId = await userIdOf(ADMIN);
    const ownerId = await userIdOf(OWNER);
    const res = await owner.patch(url(`/sharing/members/${adminId}`), { role: 'owner' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('owner');
    expect((await members(admin)).find((m) => m.userId === ownerId).role).toBe('admin');
    // The new owner is now out of the old one's reach.
    expect((await owner.patch(url(`/sharing/members/${adminId}`), { role: 'viewer' })).status).toBe(404);
  });
});
