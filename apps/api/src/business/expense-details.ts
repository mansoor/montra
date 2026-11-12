/**
 * Expense details beside a business transaction (BIZ-18, ADR-0035 §7), and the purchases that may be assets (BIZ-16).
 * Plain functions, so the transaction loader can call them without depending on the business services.
 */
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { calendarDate, DE_MINIMIS_MINOR } from '@montra/domain';
import type { AssetCandidateDto, ExpenseDetailDto } from '@montra/schemas';
import { NOT_OWNED } from '../transactions/poster.js';

type Ctx = { workspaceId: string };

export const MEALS_LINE = 'US_SCH_C_L24B';

/**
 * Categories a piece of equipment is usually booked to: office expense, repairs, supplies and other expenses, or a
 * category whose name says so. A hint only, so a false match costs a dismissable prompt.
 */
const EQUIPMENT_LINES = ['US_SCH_C_L18', 'US_SCH_C_L21', 'US_SCH_C_L22', 'US_SCH_C_L27A'];
const EQUIPMENT_WORDS =
  '(equip|computer|laptop|hardware|furniture|machin|tool|vehicle|camera|printer|phone|device|electronic)';

const equipmentCategory = sql`(a.tax_line_code = any(${EQUIPMENT_LINES}::text[]) or a.name ~* ${EQUIPMENT_WORDS})`;

/**
 * A business's purchases over the de minimis limit on equipment-like categories, with no asset and nothing else owning
 * them, newest first. `ids` narrows it to those transactions.
 */
export async function assetCandidates(
  trx: Trx,
  ctx: Ctx,
  entityId: string,
  ids?: readonly string[],
): Promise<AssetCandidateDto[]> {
  if (ids && ids.length === 0) return [];
  const { rows } = await sql<{
    id: string;
    d: string;
    payee: string | null;
    amount: string;
    category: string | null;
  }>`
    select t.id, t.txn_date::text as d, coalesce(t.payee_raw, nullif(t.description, '')) as payee,
           sum(p.functional_amount_minor)::text as amount, min(a.name) as category
      from app.posting p
      join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
      join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
      join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
     where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
       and a.type = 'expense' and a.is_category and ${equipmentCategory}
       and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
       and ${NOT_OWNED}
       and not exists (select 1 from app.business_asset b
                        where b.workspace_id = t.workspace_id and b.transaction_id = t.id)
       ${ids ? sql`and t.id = any(${[...ids]}::uuid[])` : sql``}
     group by t.workspace_id, t.id
    having sum(p.functional_amount_minor) > ${String(DE_MINIMIS_MINOR)}::bigint
     order by t.txn_date desc, t.id
     limit 50`.execute(trx);
  return rows.map((r) => ({
    transactionId: r.id,
    date: calendarDate(r.d),
    payee: r.payee,
    amount: r.amount,
    categoryName: r.category,
  }));
}

/**
 * Each transaction's details in the first business it spends in, by transaction id. Transactions with no business
 * spending have none. Under RLS: a business the caller can't read isn't there.
 */
export async function loadExpenseDetails(
  trx: Trx,
  ctx: Ctx,
  ids: readonly string[],
): Promise<Map<string, ExpenseDetailDto>> {
  const out = new Map<string, ExpenseDetailDto>();
  if (ids.length === 0) return out;
  const { rows: spend } = await sql<{
    transaction_id: string;
    entity_id: string;
    meal: boolean;
    equipment: string;
    owned: boolean;
  }>`
    select je.transaction_id, p.entity_id,
           bool_or(a.tax_line_code = ${MEALS_LINE}) as meal,
           coalesce(sum(p.functional_amount_minor) filter (where ${equipmentCategory}), 0)::text as equipment,
           bool_or(not (${NOT_OWNED})) as owned
      from app.posting p
      join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
      join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
      join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
      join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
     where p.workspace_id = ${ctx.workspaceId} and je.transaction_id = any(${[...ids]}::uuid[])
       and e.type = 'business' and a.type = 'expense' and a.is_category
     group by je.transaction_id, p.entity_id
     order by je.transaction_id, p.entity_id`.execute(trx);
  if (spend.length === 0) return out;
  const first = new Map<string, (typeof spend)[number]>();
  for (const s of spend) if (!first.has(s.transaction_id)) first.set(s.transaction_id, s);
  const txIds = [...first.keys()];
  const details = await trx
    .selectFrom('app.expense_detail')
    .selectAll()
    .where('workspace_id', '=', ctx.workspaceId)
    .where('transaction_id', 'in', txIds)
    .execute();
  const partyIds = [...new Set(details.flatMap((d) => d.attendee_party_ids))];
  const parties = partyIds.length
    ? await trx
        .selectFrom('app.business_party')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', partyIds)
        .execute()
    : [];
  const assets = await trx
    .selectFrom('app.business_asset')
    .select(['id', 'transaction_id'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('transaction_id', 'in', txIds)
    .execute();
  for (const [id, s] of first) {
    const d = details.find((x) => x.transaction_id === id && x.entity_id === s.entity_id);
    const attendees = d
      ? [
          ...d.attendee_party_ids.map((p) => ({
            partyId: p,
            name: parties.find((x) => x.id === p)?.name ?? '',
          })),
          ...d.attendee_names.map((name) => ({ partyId: null, name })),
        ]
      : [];
    const purpose = d?.business_purpose ?? null;
    const assetId = assets.find((a) => a.transaction_id === id)?.id ?? null;
    out.set(id, {
      entityId: s.entity_id,
      spentBy: d?.spent_by ?? null,
      spentByPersonId: d?.spent_by_person_id ?? null,
      spentByName: d?.spent_by_name ?? null,
      attendees,
      businessPurpose: purpose,
      isMeal: s.meal,
      needsMealDetail: s.meal && (attendees.length === 0 || !purpose),
      assetCandidate: !assetId && !s.owned && BigInt(s.equipment) > DE_MINIMIS_MINOR,
      assetId,
      version: d ? Number(d.version) : 0,
    });
  }
  return out;
}
