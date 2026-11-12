/**
 * The business's payroll accounts (ADR-0034 §6), made the first time a pay run needs them and found again by subtype.
 * Wages and the employer's payroll taxes are expense categories on Schedule C lines 26 and 23. What was withheld is
 * owed to the IRS, EDD or whoever a deduction is for, so it waits in a liability until it's paid over.
 */
import { newId, type Trx } from '@montra/db';
import type { Ctx } from './shared.js';

export type PayrollAccountRole =
  'wages' | 'employer_taxes' | 'federal_withholding' | 'fica' | 'state' | 'deductions' | 'contract_labor';

const ACCOUNTS: Record<
  PayrollAccountRole,
  { name: string; type: 'expense' | 'liability'; taxLine: string | null }
> = {
  wages: { name: 'Wages', type: 'expense', taxLine: 'US_SCH_C_L26' },
  employer_taxes: { name: 'Payroll taxes', type: 'expense', taxLine: 'US_SCH_C_L23' },
  // Contractors' billed hours (ADR-0036 §5), when the business has no Contract labor category of its own.
  contract_labor: { name: 'Contract labor', type: 'expense', taxLine: 'US_SCH_C_L11' },
  federal_withholding: { name: 'Federal income tax withheld', type: 'liability', taxLine: null },
  fica: { name: 'Social Security and Medicare owed', type: 'liability', taxLine: null },
  state: { name: 'California withholding owed', type: 'liability', taxLine: null },
  deductions: { name: 'Payroll deductions owed', type: 'liability', taxLine: null },
};

/** Where a withheld amount waits, by its line's kind and code. */
export function liabilityFor(
  kind: 'pre_tax_deduction' | 'employee_tax' | 'post_tax_deduction',
  code: string,
): PayrollAccountRole {
  if (kind !== 'employee_tax') return 'deductions';
  if (code === 'fit') return 'federal_withholding';
  if (code === 'ss' || code === 'medicare' || code === 'addl_medicare') return 'fica';
  return 'state';
}

export async function payrollAccount(
  trx: Trx,
  ctx: Ctx,
  entityId: string,
  currency: string,
  role: PayrollAccountRole,
): Promise<string> {
  const subtype = `employer_payroll:${role}`;
  const existing = await trx
    .selectFrom('app.ledger_account')
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('entity_id', '=', entityId)
    .where('subtype', '=', subtype)
    .executeTakeFirst();
  if (existing) return existing.id;
  const a = ACCOUNTS[role];
  // Expenses join the business's own category group, so they show with its other costs.
  const group =
    a.type === 'expense'
      ? await trx
          .selectFrom('app.category_group')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', entityId)
          .where('kind', '=', 'business')
          .orderBy('sort_order')
          .executeTakeFirst()
      : undefined;
  const id = newId();
  await trx
    .insertInto('app.ledger_account')
    .values({
      workspace_id: ctx.workspaceId,
      id,
      entity_id: entityId,
      type: a.type,
      subtype,
      name: a.name,
      currency,
      is_category: a.type === 'expense',
      category_group_id: group?.id ?? null,
      tax_line_code: a.taxLine,
    })
    .execute();
  return id;
}
