/**
 * The business's asset accounts (ADR-0035 §1), made the first time they're needed and found again by subtype, as
 * payroll's are. Depreciation is an expense on Schedule C line 13; a gain or loss on a sale goes on Form 4797, so it has
 * no Schedule C line. Mileage paid back to staff is on line 9, in its own category so the owner's car isn't confused
 * with it (§8).
 */
import { newId, type Trx } from '@montra/db';
import type { Ctx } from './shared.js';

export type AssetAccountRole =
  'fixed_assets' | 'accumulated_depreciation' | 'depreciation' | 'gain_loss' | 'mileage_reimbursements';

const ACCOUNTS: Record<
  AssetAccountRole,
  {
    name: string;
    type: 'asset' | 'expense' | 'income';
    taxLine: string | null;
    category: boolean;
    subtype: string;
  }
> = {
  fixed_assets: {
    name: 'Equipment and fixed assets',
    type: 'asset',
    taxLine: null,
    category: false,
    subtype: 'business_asset:fixed_assets',
  },
  accumulated_depreciation: {
    name: 'Accumulated depreciation',
    type: 'asset',
    taxLine: null,
    category: false,
    subtype: 'business_asset:accumulated_depreciation',
  },
  depreciation: {
    name: 'Depreciation',
    type: 'expense',
    taxLine: 'US_SCH_C_L13',
    category: true,
    subtype: 'business_asset:depreciation',
  },
  gain_loss: {
    name: 'Gain or loss on assets sold',
    type: 'income',
    taxLine: null,
    category: false,
    subtype: 'business_asset:gain_loss',
  },
  mileage_reimbursements: {
    name: 'Mileage reimbursements',
    type: 'expense',
    taxLine: 'US_SCH_C_L9',
    category: true,
    subtype: 'mileage:reimbursements',
  },
};

export const GAIN_LOSS_SUBTYPE = ACCOUNTS.gain_loss.subtype;
export const MILEAGE_REIMBURSEMENTS_SUBTYPE = ACCOUNTS.mileage_reimbursements.subtype;

export async function assetAccount(
  trx: Trx,
  ctx: Ctx,
  entityId: string,
  currency: string,
  role: AssetAccountRole,
): Promise<string> {
  const a = ACCOUNTS[role];
  const existing = await trx
    .selectFrom('app.ledger_account')
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('entity_id', '=', entityId)
    .where('subtype', '=', a.subtype)
    .executeTakeFirst();
  if (existing) return existing.id;
  // Categories join the business's own group, so they show with its other costs.
  const group = a.category
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
      subtype: a.subtype,
      name: a.name,
      currency,
      is_category: a.category,
      category_group_id: group?.id ?? null,
      tax_line_code: a.taxLine,
    })
    .execute();
  return id;
}
