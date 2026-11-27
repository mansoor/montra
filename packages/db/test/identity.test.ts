import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { newId, withContext, type Database } from '../src/index.js';
import { appDb, createUser } from './fixtures.js';

// A development sign-in login moves to its person's Kratos identity on their first verified real sign-in.
let db: Kysely<Database>;
beforeAll(() => {
  db = appDb();
});
afterAll(() => db.destroy());

const resolve = (identity: string, email: string, verified: boolean) =>
  withContext(db, {}, async (trx) => {
    const { rows } = await sql<{
      id: string;
    }>`select app.resolve_user(${identity}, ${email}, ${'Pat'}, ${verified}) as id`.execute(trx);
    return rows[0]!.id;
  });
// Read as the person themself: row-level security shows a login only to its own person.
const identityOf = (id: string) =>
  withContext(db, { userId: id }, async (trx) => {
    const { rows } = await sql<{
      identity_id: string;
    }>`select identity_id from app.app_user where id = ${id}`.execute(trx);
    return rows[0]?.identity_id;
  });

describe('app.resolve_user with email verification', () => {
  it('borrows a dev login while the email is unverified, then takes it over once verified', async () => {
    const email = `relink-${newId()}@example.test`;
    const id = await createUser(db, email);
    const kratos = newId();

    expect(await resolve(kratos, email, false)).toBe(id);
    expect(await identityOf(id)).toBe(`dev|${email}`);

    expect(await resolve(kratos, email, true)).toBe(id);
    expect(await identityOf(id)).toBe(kratos);
    // Found by its identity from now on, and a dev sign-in still reaches the same person.
    expect(await resolve(kratos, email, false)).toBe(id);
    expect(await resolve(`dev|${email}`, email, true)).toBe(id);
    expect(await identityOf(id)).toBe(kratos);
  });

  it('never moves a login that another Kratos identity holds', async () => {
    const email = `held-${newId()}@example.test`;
    const first = newId();
    const id = await resolve(first, email, true);
    expect(await resolve(newId(), email, true)).toBe(id);
    expect(await identityOf(id)).toBe(first);
  });

  it('makes a new login for a new email', async () => {
    const email = `new-${newId()}@example.test`;
    const kratos = newId();
    const id = await resolve(kratos, email, false);
    expect(id).toBeTruthy();
    expect(await identityOf(id)).toBe(kratos);
  });
});
