import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool, newId, withContext, type Database, type MemberRole, type Trx } from '../src/index.js';
import { APP_URL } from './env.js';

export function appDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: createPool(APP_URL, { max: 4 }) }) });
}

export async function createUser(db: Kysely<Database>, email: string): Promise<string> {
  return withContext(db, {}, async (trx) => {
    const { rows } = await sql<{ id: string }>`select app.resolve_user(${'dev|' + email}, ${email}, ${email}) as id`.execute(trx);
    return rows[0]!.id;
  });
}

export interface Fixture {
  workspaceId: string;
  ownerId: string;
  personalId: string;
  businessId: string;
  accounts: Record<'checking' | 'card' | 'groceries' | 'salary' | 'bizChecking' | 'office' | 'equity', string>;
}

export async function createWorkspace(db: Kysely<Database>, ownerEmail: string): Promise<Fixture> {
  const ownerId = await createUser(db, ownerEmail);
  const workspaceId = newId();
  const personalId = newId();
  const businessId = newId();
  const ids = {
    checking: newId(),
    card: newId(),
    groceries: newId(),
    salary: newId(),
    bizChecking: newId(),
    office: newId(),
    equity: newId(),
  };
  await withContext(db, { workspaceId, userId: ownerId }, async (trx) => {
    await trx.insertInto('app.workspace').values({ id: workspaceId, name: 'Home', base_currency: 'USD' }).execute();
    await trx.insertInto('app.workspace_member').values({ workspace_id: workspaceId, user_id: ownerId, role: 'owner' }).execute();
    await trx
      .insertInto('app.entity')
      .values([
        { workspace_id: workspaceId, id: personalId, type: 'personal', name: 'Personal', functional_currency: 'USD' },
        { workspace_id: workspaceId, id: businessId, type: 'business', name: 'Studio LLC', functional_currency: 'USD' },
      ])
      .execute();
    const acct = (id: string, entity_id: string, type: 'asset' | 'liability' | 'equity' | 'income' | 'expense', name: string) => ({
      workspace_id: workspaceId,
      id,
      entity_id,
      type,
      name,
      currency: 'USD',
      is_category: type === 'income' || type === 'expense',
    });
    await trx
      .insertInto('app.ledger_account')
      .values([
        acct(ids.checking, personalId, 'asset', 'Checking'),
        acct(ids.card, personalId, 'liability', 'Visa'),
        acct(ids.groceries, personalId, 'expense', 'Groceries'),
        acct(ids.salary, personalId, 'income', 'Salary'),
        acct(ids.equity, personalId, 'equity', 'Opening balance equity'),
        acct(ids.bizChecking, businessId, 'asset', 'Business checking'),
        acct(ids.office, businessId, 'expense', 'Office expense'),
      ])
      .execute();
  });
  return { workspaceId, ownerId, personalId, businessId, accounts: ids };
}

export async function addMember(db: Kysely<Database>, f: Fixture, email: string, role: MemberRole): Promise<string> {
  const userId = await createUser(db, email);
  await withContext(db, { workspaceId: f.workspaceId, userId: f.ownerId }, (trx) =>
    trx.insertInto('app.workspace_member').values({ workspace_id: f.workspaceId, user_id: userId, role }).execute(),
  );
  return userId;
}

export interface PostingSpec {
  account: string;
  amount: bigint;
  memberId?: string | null;
}

/** Inserts a transaction with one journal entry (postings debit-positive). */
export async function postEntry(
  trx: Trx,
  f: Fixture,
  entityId: string,
  date: string,
  postings: PostingSpec[],
  opts: { restricted?: boolean; restrictedMemberId?: string } = {},
): Promise<{ transactionId: string; entryId: string }> {
  const transactionId = newId();
  const entryId = newId();
  await trx
    .insertInto('app.transaction')
    .values({ workspace_id: f.workspaceId, id: transactionId, primary_entity_id: entityId, txn_date: date })
    .execute();
  await trx
    .insertInto('app.journal_entry')
    .values({
      workspace_id: f.workspaceId,
      id: entryId,
      entity_id: entityId,
      transaction_id: transactionId,
      entry_date: date,
      restricted: opts.restricted ?? false,
      restricted_member_id: opts.restrictedMemberId ?? null,
    })
    .execute();
  if (postings.length) {
    await trx
      .insertInto('app.posting')
      .values(
        postings.map((p, i) => ({
          workspace_id: f.workspaceId,
          id: newId(),
          journal_entry_id: entryId,
          entity_id: entityId,
          entry_date: date,
          line_no: i + 1,
          ledger_account_id: p.account,
          amount_minor: p.amount,
          currency: 'USD',
          functional_amount_minor: p.amount,
          member_id: p.memberId ?? null,
        })),
      )
      .execute();
  }
  return { transactionId, entryId };
}
