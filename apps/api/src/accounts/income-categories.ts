/**
 * Finding interest and dividend income (ADR-0052 §5.7): categories on Schedule B's tax lines first (part I interest,
 * part II ordinary dividends), then, for categories a person made themselves with no tax line, by name. Used by
 * `interestEarned()` and by the tax forms' checks.
 */
import { sql, type RawBuilder } from 'kysely';

export const SCHEDULE_B = { INTEREST: 'US_SCH_B_L1', DIVIDENDS: 'US_SCH_B_L5' } as const;

export type IncomeKind = 'interest' | 'dividends';

const NAME_PATTERN: Record<IncomeKind, string> = { interest: '%interest%', dividends: '%dividend%' };
const LINE: Record<IncomeKind, string> = { interest: SCHEDULE_B.INTEREST, dividends: SCHEDULE_B.DIVIDENDS };

/** A condition on the ledger account aliased `alias`: an income category of this kind. */
export function incomeCategory(alias: string, kind: IncomeKind): RawBuilder<boolean> {
  const a = sql.ref(alias);
  return sql<boolean>`(${a}.type = 'income' and ${a}.is_category
    and (${a}.tax_line_code = ${LINE[kind]}
         or (${a}.tax_line_code is null and ${a}.name ilike ${NAME_PATTERN[kind]})))`;
}
