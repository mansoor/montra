/**
 * The asset register (BIZ-16, BIZ-17; ADR-0035). An asset is booked to Fixed assets, either by taking over the purchase
 * it came from or as the owner's contribution. Yearly depreciation and a disposal are journal entries with no
 * transaction, and the period lock guards them as it does every entry. Not tax advice: the owner's accountant confirms
 * the method and any Section 179 amount.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  newId,
  type AssetAssignmentRow,
  type AssetDepreciationRow,
  type BusinessAssetRow,
  type Trx,
} from '@montra/db';
import {
  asCurrencyCode,
  assetDepreciationForYear,
  assetDepreciationInDisposalYear,
  carveAssetSplits,
  DE_MINIMIS_MINOR,
  DEFAULT_LIFE,
  disposalGain,
  validateEntry,
  type AssetBasis,
  type AssetLife,
  type CalendarDate,
  type JournalEntryDraft,
} from '@montra/domain';
import type {
  AssetAssignmentDto,
  AssetListDto,
  AssignAssetRequest,
  BusinessAssetDto,
  CreateAssetRequest,
  DisposeAssetRequest,
  PostDepreciationDto,
  ReturnAssetRequest,
  UpdateAssetRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ownerOf, type TransactionSpec } from '../transactions/poster.js';
import { personName } from '../payroll/shared.js';
import { assetAccount } from './asset-accounts.js';
import { assetCandidates } from './expense-details.js';
import { PaymentLinks } from './payment-links.service.js';
import { businessEntity, dateOf, todayOf, type BusinessEntity, type Ctx } from './shared.js';

type StandardSpec = Extract<TransactionSpec, { type: 'standard' }>;

const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');

const yearOf = (d: CalendarDate | string) => Number(String(d).slice(0, 4));

@Injectable()
export class AssetsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(PaymentLinks) private readonly links: PaymentLinks,
  ) {}

  // ----- Reading -----------------------------------------------------------------------------------------

  async list(ctx: Ctx, q: { entityId: string; personId?: string }): Promise<AssetListDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, q.entityId);
      let rows = await trx
        .selectFrom('app.business_asset')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', e.id)
        .orderBy('in_service_date', 'desc')
        .orderBy('created_at', 'desc')
        .execute();
      if (q.personId) {
        const held = await trx
          .selectFrom('app.asset_assignment')
          .select('asset_id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('person_id', '=', q.personId)
          .where('returned_on', 'is', null)
          .execute();
        const ids = new Set(held.map((h) => h.asset_id));
        rows = rows.filter((r) => ids.has(r.id));
      }
      const assets = await this.dtos(trx, ctx, rows);
      const sum = (f: (a: BusinessAssetDto) => string) =>
        String(assets.reduce((t, a) => t + BigInt(f(a)), 0n));
      const live = assets.filter((a) => !a.disposal);
      return {
        entityId: e.id,
        currency: asCurrencyCode(e.currency),
        assets,
        totals: {
          cost: String(live.reduce((t, a) => t + BigInt(a.cost), 0n)),
          accumulated: String(live.reduce((t, a) => t + BigInt(a.accumulated), 0n)),
          bookValue: sum((a) => a.bookValue),
        },
        candidates: q.personId ? [] : await assetCandidates(trx, ctx, e.id),
        deMinimis: String(DE_MINIMIS_MINOR),
      };
    });
  }

  async get(ctx: Ctx, id: string): Promise<BusinessAssetDto> {
    return this.db.run(ctx, (trx) => this.getIn(trx, ctx, id));
  }

  private async getIn(trx: Trx, ctx: Ctx, id: string): Promise<BusinessAssetDto> {
    return (await this.dtos(trx, ctx, [await this.row(trx, ctx, id)]))[0]!;
  }

  private async row(trx: Trx, ctx: Ctx, id: string, lock = false): Promise<BusinessAssetRow> {
    const r = await trx
      .selectFrom('app.business_asset')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .$if(lock, (q) => q.forUpdate())
      .executeTakeFirst();
    if (!r) throw notFound('Asset');
    return r;
  }

  private async dtos(trx: Trx, ctx: Ctx, rows: BusinessAssetRow[]): Promise<BusinessAssetDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const posted = await trx
      .selectFrom('app.asset_depreciation')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('asset_id', 'in', ids)
      .execute();
    const assignments = await trx
      .selectFrom('app.asset_assignment')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('asset_id', 'in', ids)
      .orderBy('assigned_on', 'desc')
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => {
      const mine = posted.filter((p) => p.asset_id === r.id);
      const accumulated = mine.reduce((t, p) => t + BigInt(p.amount_minor), 0n);
      const cost = BigInt(r.cost_minor);
      const booked = r.method !== 'expense_now';
      const basis = basisOf(r);
      const disposed = r.disposed_on ? dateOf(r.disposed_on) : null;
      const schedule = scheduleOf(basis, disposed).map((s) => {
        const hit = mine.find((p) => p.year === s.year);
        return { year: s.year, amount: String(hit ? BigInt(hit.amount_minor) : s.amount), posted: !!hit };
      });
      const held = assignments.filter((a) => a.asset_id === r.id).map(assignmentDto);
      const bookValue = disposed || !booked ? 0n : cost - accumulated;
      return {
        id: r.id,
        entityId: r.entity_id,
        name: r.name,
        category: r.category,
        serial: r.serial,
        cost: String(cost),
        currency: asCurrencyCode(r.currency),
        inServiceDate: dateOf(r.in_service_date),
        method: r.method,
        lifeYears: r.life_years as AssetLife,
        section179: String(r.section_179_minor),
        transactionId: r.transaction_id,
        notes: r.notes,
        accumulated: String(accumulated),
        bookValue: String(bookValue),
        schedule,
        disposal: disposed
          ? {
              date: disposed,
              proceeds: String(r.disposal_proceeds_minor ?? 0n),
              gain: String(
                disposalGain(
                  BigInt(r.disposal_proceeds_minor ?? 0n),
                  booked ? cost : 0n,
                  booked ? accumulated : 0n,
                ),
              ),
              note: r.disposal_note,
              transactionId: r.disposal_transaction_id,
            }
          : null,
        assignedTo: held.find((a) => a.returnedOn === null) ?? null,
        assignments: held,
        version: Number(r.version),
      };
    });
  }

  // ----- Recording and changing ---------------------------------------------------------------------------

  async create(ctx: Ctx, req: CreateAssetRequest): Promise<BusinessAssetDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await writableBusiness(trx, ctx, req.entityId);
      const life = req.lifeYears ?? DEFAULT_LIFE[req.category];
      const section179 = BigInt(req.section179 ?? '0');
      checkMethod(req.category, req.method, BigInt(req.cost), section179);
      if (req.transactionId) {
        const taken = await trx
          .selectFrom('app.business_asset')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('transaction_id', '=', req.transactionId)
          .executeTakeFirst();
        if (taken) throw unprocessable('asset.purchase_taken', 'That purchase is already an asset');
      }
      const id = newId();
      const row = await trx
        .insertInto('app.business_asset')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: e.id,
          name: req.name,
          category: req.category,
          serial: req.serial ?? null,
          cost_minor: BigInt(req.cost),
          currency: e.currency,
          in_service_date: req.inServiceDate,
          method: req.method,
          life_years: life,
          section_179_minor: section179,
          transaction_id: req.transactionId ?? null,
          notes: req.notes ?? null,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.book(trx, ctx, e, row);
      return this.getIn(trx, ctx, id);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateAssetRequest): Promise<BusinessAssetDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id, true);
      const e = await writableBusiness(trx, ctx, r.entity_id);
      if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
      const next = {
        cost: req.cost !== undefined ? BigInt(req.cost) : BigInt(r.cost_minor),
        inServiceDate: req.inServiceDate ?? dateOf(r.in_service_date),
        method: req.method ?? r.method,
        lifeYears: req.lifeYears ?? r.life_years,
        section179: req.section179 !== undefined ? BigInt(req.section179) : BigInt(r.section_179_minor),
        category: req.category ?? r.category,
      };
      const moneyChanged =
        next.cost !== BigInt(r.cost_minor) ||
        next.inServiceDate !== dateOf(r.in_service_date) ||
        next.method !== r.method ||
        next.lifeYears !== r.life_years ||
        next.section179 !== BigInt(r.section_179_minor);
      checkMethod(next.category, next.method, next.cost, next.section179);
      if (moneyChanged) {
        if (r.disposed_on)
          throw unprocessable('asset.disposed', 'Undo the disposal before changing its cost');
        if (await this.postedYears(trx, ctx, id).then((p) => p.length > 0)) {
          throw unprocessable(
            'asset.depreciation_posted',
            'Un-post its depreciation before changing the cost, date or method',
          );
        }
        await this.unbook(trx, ctx, r);
      }
      const row = await trx
        .updateTable('app.business_asset')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.serial !== undefined ? { serial: req.serial } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
          category: next.category,
          cost_minor: next.cost,
          in_service_date: next.inServiceDate,
          method: next.method,
          life_years: next.lifeYears,
          section_179_minor: next.section179,
          ...(moneyChanged ? { previous_spec: null, capital_entry_id: null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (moneyChanged) await this.book(trx, ctx, e, row);
      return this.getIn(trx, ctx, id);
    });
  }

  /** Removes an asset recorded by mistake: its depreciation goes, and the purchase is an expense again. */
  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id, true);
      await writableBusiness(trx, ctx, r.entity_id);
      if (r.disposed_on) throw unprocessable('asset.disposed', 'Undo the disposal first');
      const posted = await this.postedYears(trx, ctx, id);
      await this.deleteEntries(
        trx,
        ctx,
        posted.map((p) => p.journal_entry_id),
      );
      await this.unbook(trx, ctx, r);
      await trx
        .deleteFrom('app.business_asset')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  /**
   * Books the cost (ADR-0035 §2): the purchase's cost moves into Fixed assets, or without a purchase the owner
   * contributed it. "Expense now" leaves the purchase as it is.
   */
  private async book(trx: Trx, ctx: Ctx, e: BusinessEntity, r: BusinessAssetRow): Promise<void> {
    if (r.method === 'expense_now') {
      if (r.transaction_id) await this.purchaseOf(trx, ctx, e, r.transaction_id, BigInt(r.cost_minor), false);
      return;
    }
    const fixed = await assetAccount(trx, ctx, e.id, e.currency, 'fixed_assets');
    const cost = BigInt(r.cost_minor);
    if (r.transaction_id) {
      const spec = await this.purchaseOf(trx, ctx, e, r.transaction_id, cost, true);
      const eligible = await this.businessExpenseAccounts(trx, ctx, e.id);
      const splits = carveAssetSplits(spec.splits, eligible, cost, fixed);
      if (!splits) {
        throw unprocessable(
          'asset.cost_over_purchase',
          "The cost is more than this purchase's spending in the business",
        );
      }
      const taken = await this.links.takeOver(trx, ctx, r.transaction_id, { assetId: r.id }, splits, {
        sign: -1,
        currency: e.currency,
      });
      await trx
        .updateTable('app.business_asset')
        .set({ previous_spec: JSON.stringify(taken.previous) })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', r.id)
        .execute();
      return;
    }
    const owner = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', e.id)
      .where('system_role', '=', 'owner_contribution')
      .executeTakeFirst();
    if (!owner) throw unprocessable('asset.no_equity', 'This business has no owner contribution account');
    const [entryId] = await this.post(trx, ctx, e, {
      date: dateOf(r.in_service_date),
      kind: 'manual',
      description: `Brought into the business: ${r.name}`,
      lines: [
        [fixed, cost],
        [owner.id, -cost],
      ],
    });
    await trx
      .updateTable('app.business_asset')
      .set({ capital_entry_id: entryId! })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', r.id)
      .execute();
  }

  /** Undoes `book`: the purchase gets its old categories back, or the contribution entry goes. */
  private async unbook(trx: Trx, ctx: Ctx, r: BusinessAssetRow): Promise<void> {
    if (r.transaction_id && r.previous_spec) {
      await trx
        .updateTable('app.business_asset')
        .set({ previous_spec: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', r.id)
        .execute();
      await this.links.release(trx, ctx, r.transaction_id, r.previous_spec);
    }
    if (r.capital_entry_id) {
      await trx
        .updateTable('app.business_asset')
        .set({ capital_entry_id: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', r.id)
        .execute();
      await this.deleteEntries(trx, ctx, [r.capital_entry_id]);
    }
  }

  /** The purchase, checked: posted money out of the business's currency, and not owned by something else. */
  private async purchaseOf(
    trx: Trx,
    ctx: Ctx,
    e: BusinessEntity,
    transactionId: string,
    cost: bigint,
    capitalize: boolean,
  ): Promise<StandardSpec> {
    const t = await trx
      .selectFrom('app.transaction')
      .select(['spec', 'status', 'deleted_at'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .executeTakeFirst();
    if (!t || t.deleted_at) throw notFound('Transaction');
    const spec = t.spec as TransactionSpec | null;
    if (t.status !== 'posted' || spec?.type !== 'standard' || BigInt(spec.amount) >= 0n) {
      throw unprocessable('asset.not_a_purchase', 'Choose a purchase: money out of an account');
    }
    if (capitalize && ownerOf(spec)) {
      throw unprocessable('asset.purchase_owned', 'This purchase already belongs to something else');
    }
    if (spec.currency !== e.currency) {
      throw unprocessable('currency.mismatch', `This purchase is not in ${e.currency}`);
    }
    if (-BigInt(spec.amount) < cost) {
      throw unprocessable('asset.cost_over_purchase', 'The cost is more than the purchase');
    }
    return spec;
  }

  private async businessExpenseAccounts(trx: Trx, ctx: Ctx, entityId: string): Promise<Set<string>> {
    const rows = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('type', '=', 'expense')
      .where('is_category', '=', true)
      .execute();
    return new Set(rows.map((r) => r.id));
  }

  // ----- Depreciation -----------------------------------------------------------------------------------------

  /** Catches every asset of the business up to the end of `throughYear`, one entry per asset and year (§4). */
  async postDepreciation(
    ctx: Ctx,
    req: { entityId: string; throughYear: number },
  ): Promise<PostDepreciationDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await writableBusiness(trx, ctx, req.entityId);
      if (req.throughYear > yearOf(todayOf(e))) {
        throw unprocessable('asset.future_year', `Depreciation for ${req.throughYear} can't be posted yet`);
      }
      const rows = await trx
        .selectFrom('app.business_asset')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', e.id)
        .where('method', '<>', 'expense_now')
        .orderBy('in_service_date')
        .forUpdate()
        .execute();
      const posted: PostDepreciationDto['posted'] = [];
      for (const r of rows) {
        const done = new Set((await this.postedYears(trx, ctx, r.id)).map((p) => p.year));
        const last = r.disposed_on ? yearOf(dateOf(r.disposed_on)) - 1 : req.throughYear;
        for (let y = yearOf(dateOf(r.in_service_date)); y <= Math.min(last, req.throughYear); y++) {
          if (done.has(y)) continue;
          const amount = assetDepreciationForYear(basisOf(r), y);
          if (amount <= 0n) continue;
          await this.postYear(trx, ctx, e, r, y, amount, `${y}-12-31` as CalendarDate);
          posted.push({ assetId: r.id, year: y, amount: String(amount) });
        }
      }
      return { posted };
    });
  }

  /** Un-posts the latest posted year, so the years stay continuous. */
  async unpostYear(ctx: Ctx, id: string, year: number): Promise<BusinessAssetDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id, true);
      await writableBusiness(trx, ctx, r.entity_id);
      if (r.disposed_on) throw unprocessable('asset.disposed', 'Undo the disposal first');
      const posted = await this.postedYears(trx, ctx, id);
      const hit = posted.find((p) => p.year === year);
      if (!hit) throw notFound('Depreciation year');
      if (posted.some((p) => p.year > year)) {
        throw unprocessable('asset.later_years', 'Un-post the later years first');
      }
      await this.deleteEntries(trx, ctx, [hit.journal_entry_id]);
      return this.getIn(trx, ctx, id);
    });
  }

  private async postYear(
    trx: Trx,
    ctx: Ctx,
    e: BusinessEntity,
    r: BusinessAssetRow,
    year: number,
    amount: bigint,
    date: CalendarDate,
  ): Promise<void> {
    const expense = await assetAccount(trx, ctx, e.id, e.currency, 'depreciation');
    const accumulated = await assetAccount(trx, ctx, e.id, e.currency, 'accumulated_depreciation');
    const [entryId] = await this.post(trx, ctx, e, {
      date,
      kind: 'depreciation',
      description: `Depreciation ${year}: ${r.name}`,
      lines: [
        [expense, amount],
        [accumulated, -amount],
      ],
    });
    await trx
      .insertInto('app.asset_depreciation')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: e.id,
        asset_id: r.id,
        year,
        amount_minor: amount,
        journal_entry_id: entryId!,
        created_by: ctx.userId,
      })
      .execute();
  }

  private postedYears(trx: Trx, ctx: Ctx, assetId: string): Promise<AssetDepreciationRow[]> {
    return trx
      .selectFrom('app.asset_depreciation')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('asset_id', '=', assetId)
      .orderBy('year')
      .execute();
  }

  // ----- Disposal (§5) -----------------------------------------------------------------------------------------

  async dispose(ctx: Ctx, id: string, req: DisposeAssetRequest): Promise<BusinessAssetDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id, true);
      const e = await writableBusiness(trx, ctx, r.entity_id);
      if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
      if (r.disposed_on) throw unprocessable('asset.disposed', 'This asset is already disposed of');
      if (req.date < dateOf(r.in_service_date)) {
        throw unprocessable('asset.disposal_date', 'The disposal date is before it was placed in service');
      }
      if (req.date > todayOf(e))
        throw unprocessable('asset.disposal_future', 'The disposal date is in the future');
      const open = await this.openAssignment(trx, ctx, id);
      if (open) {
        throw unprocessable('asset.assigned', `${open.person_name} still has it. Mark it returned first`);
      }
      const proceeds = BigInt(req.proceeds);
      if (proceeds > 0n && !req.payment) {
        throw unprocessable(
          'asset.proceeds_account',
          'Choose the deposit or the account the proceeds went to',
        );
      }
      const booked = r.method !== 'expense_now';
      const basis = basisOf(r);
      const year = yearOf(req.date);
      if (booked) {
        const posted = await this.postedYears(trx, ctx, id);
        if (posted.some((p) => p.year > year)) {
          throw unprocessable('asset.later_years', `Un-post depreciation after ${year} first`);
        }
        for (let y = yearOf(basis.inService); y < year; y++) {
          if (assetDepreciationForYear(basis, y) > 0n && !posted.some((p) => p.year === y)) {
            throw unprocessable('asset.missing_years', `Post depreciation for ${y} first`);
          }
        }
        // The disposal year is part of a year: a full year already posted for it is replaced.
        const full = posted.find((p) => p.year === year);
        if (full) await this.deleteEntries(trx, ctx, [full.journal_entry_id]);
        const part = assetDepreciationInDisposalYear(basis, req.date);
        if (part > 0n) await this.postYear(trx, ctx, e, r, year, part, req.date);
      }
      const accumulated = (await this.postedYears(trx, ctx, id)).reduce(
        (t, p) => t + BigInt(p.amount_minor),
        0n,
      );
      const gainLoss = await assetAccount(trx, ctx, e.id, e.currency, 'gain_loss');
      let disposalEntry: string | null = null;
      if (booked) {
        const cost = BigInt(r.cost_minor);
        const fixed = await assetAccount(trx, ctx, e.id, e.currency, 'fixed_assets');
        const acc = await assetAccount(trx, ctx, e.id, e.currency, 'accumulated_depreciation');
        disposalEntry = await this.postOne(trx, ctx, e, {
          date: req.date,
          kind: 'manual',
          description: `Disposal: ${r.name}`,
          lines: [
            [acc, accumulated],
            [gainLoss, cost - accumulated],
            [fixed, -cost],
          ],
        });
      }
      let transactionId: string | null = null;
      let previous: unknown = null;
      if (proceeds > 0n && req.payment) {
        const splits = [{ accountId: gainLoss, amount: String(proceeds), memberId: null }];
        if ('transactionId' in req.payment) {
          const t = await trx
            .selectFrom('app.transaction')
            .select('spec')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', req.payment.transactionId)
            .executeTakeFirst();
          if (!t) throw notFound('Transaction');
          if (BigInt((t.spec as { amount?: string } | null)?.amount ?? '0') !== proceeds) {
            throw unprocessable(
              'asset.proceeds_amount',
              'The deposit must be the exact amount of the proceeds',
            );
          }
          const taken = await this.links.takeOver(
            trx,
            ctx,
            req.payment.transactionId,
            { assetId: id },
            splits,
            {
              sign: 1,
              currency: e.currency,
            },
          );
          transactionId = req.payment.transactionId;
          previous = taken.previous;
        } else {
          transactionId = await this.links.create(trx, ctx, {
            entityId: e.id,
            accountId: req.payment.accountId,
            date: req.date,
            amount: proceeds,
            currency: e.currency,
            payee: `Sale of ${r.name}`.slice(0, 200),
            payeeKey: null,
            description: `Sale of ${r.name}`.slice(0, 500),
            source: 'manual',
            owner: { assetId: id },
            splits,
          });
        }
      }
      await trx
        .updateTable('app.business_asset')
        .set({
          disposed_on: req.date,
          disposal_proceeds_minor: proceeds,
          disposal_note: req.note ?? null,
          disposal_entry_id: disposalEntry,
          disposal_transaction_id: transactionId,
          disposal_previous_spec: previous ? JSON.stringify(previous) : null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return this.getIn(trx, ctx, id);
    });
  }

  /** Puts a disposed asset back: the write-off and the disposal year's part go, and the deposit is let go. */
  async undoDisposal(ctx: Ctx, id: string): Promise<BusinessAssetDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id, true);
      await writableBusiness(trx, ctx, r.entity_id);
      if (!r.disposed_on) throw unprocessable('asset.not_disposed', 'This asset is not disposed of');
      await trx
        .updateTable('app.business_asset')
        .set({
          disposed_on: null,
          disposal_proceeds_minor: null,
          disposal_note: null,
          disposal_entry_id: null,
          disposal_transaction_id: null,
          disposal_previous_spec: null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      const year = yearOf(dateOf(r.disposed_on));
      const part = (await this.postedYears(trx, ctx, id)).find((p) => p.year === year);
      await this.deleteEntries(trx, ctx, [
        ...(r.disposal_entry_id ? [r.disposal_entry_id] : []),
        ...(part ? [part.journal_entry_id] : []),
      ]);
      if (r.disposal_transaction_id) {
        await this.links.release(trx, ctx, r.disposal_transaction_id, r.disposal_previous_spec);
      }
      return this.getIn(trx, ctx, id);
    });
  }

  // ----- Assignments (BIZ-17) ----------------------------------------------------------------------------------

  async assign(ctx: Ctx, id: string, req: AssignAssetRequest): Promise<BusinessAssetDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id, true);
      await writableBusiness(trx, ctx, r.entity_id);
      if (r.disposed_on) throw unprocessable('asset.disposed', 'This asset is disposed of');
      const open = await this.openAssignment(trx, ctx, id);
      if (open) {
        throw unprocessable('asset.assigned', `${open.person_name} has it. Mark it returned first`);
      }
      const person = await trx
        .selectFrom('app.payroll_person')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', r.entity_id)
        .where('id', '=', req.personId)
        .executeTakeFirst();
      if (!person) throw notFound('Person');
      if (person.end_date && String(person.end_date).slice(0, 10) < req.assignedOn) {
        throw unprocessable('asset.person_left', `${personName(person)} had left by then`);
      }
      await trx
        .insertInto('app.asset_assignment')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: r.entity_id,
          asset_id: id,
          person_id: person.id,
          person_name: personName(person),
          assigned_on: req.assignedOn,
          note: req.note ?? null,
          created_by: ctx.userId,
        })
        .execute();
      return this.getIn(trx, ctx, id);
    });
  }

  async returnAssignment(ctx: Ctx, assignmentId: string, req: ReturnAssetRequest): Promise<BusinessAssetDto> {
    return this.db.run(ctx, async (trx) => {
      const a = await this.assignment(trx, ctx, assignmentId);
      await writableBusiness(trx, ctx, a.entity_id);
      if (BigInt(a.version) !== BigInt(req.version)) throw conflict();
      if (a.returned_on) throw unprocessable('asset.returned', 'This was already returned');
      if (req.returnedOn < dateOf(a.assigned_on)) {
        throw unprocessable('asset.return_date', 'The return date is before it was handed over');
      }
      await trx
        .updateTable('app.asset_assignment')
        .set({ returned_on: req.returnedOn })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', assignmentId)
        .execute();
      return this.getIn(trx, ctx, a.asset_id);
    });
  }

  /** Removes an assignment entered by mistake. */
  async removeAssignment(ctx: Ctx, assignmentId: string): Promise<BusinessAssetDto> {
    return this.db.run(ctx, async (trx) => {
      const a = await this.assignment(trx, ctx, assignmentId);
      await writableBusiness(trx, ctx, a.entity_id);
      await trx
        .deleteFrom('app.asset_assignment')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', assignmentId)
        .execute();
      return this.getIn(trx, ctx, a.asset_id);
    });
  }

  private async assignment(trx: Trx, ctx: Ctx, id: string): Promise<AssetAssignmentRow> {
    const a = await trx
      .selectFrom('app.asset_assignment')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!a) throw notFound('Assignment');
    return a;
  }

  private openAssignment(trx: Trx, ctx: Ctx, assetId: string) {
    return trx
      .selectFrom('app.asset_assignment')
      .select(['id', 'person_name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('asset_id', '=', assetId)
      .where('returned_on', 'is', null)
      .executeTakeFirst();
  }

  // ----- Ledger -------------------------------------------------------------------------------------------------

  /** One balanced entry with no transaction, in the business's currency. Zero lines are left out. */
  private async post(
    trx: Trx,
    ctx: Ctx,
    e: BusinessEntity,
    entry: {
      date: CalendarDate;
      kind: 'depreciation' | 'manual';
      description: string;
      lines: [string, bigint][];
    },
  ): Promise<string[]> {
    const lines = entry.lines.filter(([, amount]) => amount !== 0n);
    const draft: JournalEntryDraft = {
      entityId: e.id,
      functionalCurrency: asCurrencyCode(e.currency),
      entryDate: entry.date,
      kind: entry.kind,
      description: entry.description.slice(0, 500),
      postings: lines.map(([accountId, amount], i) => ({
        lineNo: i + 1,
        accountId,
        accountEntityId: e.id,
        currency: asCurrencyCode(e.currency),
        amount,
        functionalAmount: amount,
        fxRate: null,
        memberId: null,
        memo: null,
      })),
    };
    validateEntry(draft);
    return this.ledger.post(trx, ctx, null, [draft]);
  }

  private async postOne(...args: Parameters<AssetsService['post']>): Promise<string> {
    const [id] = await this.post(...args);
    return id!;
  }

  private async deleteEntries(trx: Trx, ctx: Ctx, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await trx
      .deleteFrom('app.journal_entry')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', ids)
      .execute();
  }
}

/** The business, for a change: readers get a clear refusal. */
export async function writableBusiness(trx: Trx, ctx: Ctx, entityId: string): Promise<BusinessEntity> {
  const e = await businessEntity(trx, ctx, entityId);
  const { rows } = await sql<{ ok: boolean }>`select app.can_write_entity(${entityId}::uuid) as ok`.execute(
    trx,
  );
  if (!rows[0]?.ok)
    throw new AppError(403, 'business.read_only', 'You can view this business but not change it');
  return e;
}

function checkMethod(category: string, method: string, cost: bigint, section179: bigint): void {
  if (method === 'expense_now') {
    if (cost > DE_MINIMIS_MINOR) {
      throw unprocessable(
        'asset.over_de_minimis',
        'Expensing right away is for items up to $2,500. Choose a depreciation method',
      );
    }
    if (section179 > 0n) throw unprocessable('asset.section_179', 'Section 179 needs a depreciation method');
  }
  if (method === 'macrs_half_year' && category === 'software') {
    throw unprocessable('asset.software_macrs', 'Software is depreciated straight line over 36 months');
  }
  if (section179 > cost) throw unprocessable('asset.section_179', 'Section 179 is more than the cost');
}

function basisOf(r: BusinessAssetRow): AssetBasis {
  return {
    category: r.category,
    method: r.method,
    life: r.life_years as AssetLife,
    cost: BigInt(r.cost_minor),
    section179: BigInt(r.section_179_minor),
    inService: dateOf(r.in_service_date),
  };
}

/** The years with a deduction, stopping at the disposal year, which gets only its part. */
function scheduleOf(basis: AssetBasis, disposed: CalendarDate | null): { year: number; amount: bigint }[] {
  if (basis.method === 'expense_now') return [];
  const start = yearOf(basis.inService);
  const out: { year: number; amount: bigint }[] = [];
  for (let y = start; y <= start + basis.life + 1; y++) {
    if (disposed && y > yearOf(disposed)) break;
    const amount =
      disposed && y === yearOf(disposed)
        ? assetDepreciationInDisposalYear(basis, disposed)
        : assetDepreciationForYear(basis, y);
    if (amount > 0n) out.push({ year: y, amount });
  }
  return out;
}

function assignmentDto(a: AssetAssignmentRow): AssetAssignmentDto {
  return {
    id: a.id,
    personId: a.person_id,
    personName: a.person_name,
    assignedOn: dateOf(a.assigned_on),
    returnedOn: a.returned_on ? dateOf(a.returned_on) : null,
    note: a.note,
    version: Number(a.version),
  };
}
