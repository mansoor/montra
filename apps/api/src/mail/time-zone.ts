import type { Db } from '../db/database.js';

/**
 * The person's own time zone, for the times in their emails. Null when it can't be read: the email then says UTC
 * rather than not going out.
 */
export async function timeZoneOf(db: Db, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const row = await db.run({ userId }, (trx) =>
      trx.selectFrom('app.app_user').select('time_zone').where('id', '=', userId).executeTakeFirst(),
    );
    return row?.time_zone ?? null;
  } catch {
    return null;
  }
}
