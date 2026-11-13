import { normalizePolicy, type PasswordPolicy } from '@montra/password';
import type { Trx } from '@montra/db';

/** Where the admin console keeps the password policy (AUTH-02, ADR-0043): two `app.system_setting` rows. */
export const POLICY_KEYS = { minLength: 'password_min_length', minScore: 'password_min_score' } as const;

/** The stored policy, or the default for any part that was never set. */
export async function readPasswordPolicy(trx: Trx): Promise<PasswordPolicy> {
  const rows = await trx
    .selectFrom('app.system_setting')
    .select(['key', 'value'])
    .where('key', 'in', Object.values(POLICY_KEYS))
    .execute();
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return normalizePolicy({ minLength: get(POLICY_KEYS.minLength), minScore: get(POLICY_KEYS.minScore) });
}
