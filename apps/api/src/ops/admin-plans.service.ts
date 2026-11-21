/**
 * The owner's side of the console (ADR-0049 §1, §3): staff, and plans. Every change goes through an admin_ function
 * that checks the caller's role in the database too, and is logged there.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  compareEntitlements,
  EntitlementsError,
  entitlementsJson,
  FREE_PLAN,
  parseEntitlements,
  PLAN_REDUCTION_NOTICE_DAYS,
  type PlanEntitlements,
} from '@montra/domain';
import type {
  AddPlanPriceRequest,
  AddPlanVersionRequest,
  AdminPlanDto,
  MoveSubscribersDto,
  MoveSubscribersRequest,
  SavePlanRequest,
  SetStaffRequest,
  StaffMemberDto,
  StaffRole,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { MAIL_PORT, templates, type MailPort } from '../mail/mail.service.js';
import { entitlementsDto } from './plans.js';
import { AdminDb } from './staff.js';

const DAY_MS = 86_400_000;

/** What the database says when a rule there refuses, as the API's own errors. */
function fromDb(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === '42501') throw new AppError(403, 'forbidden', 'This needs the owner role');
  if (err.code === 'P0002') throw notFound('Account');
  if (err.code === '23514' && /always be an owner/.test(err.message ?? '')) {
    throw unprocessable(
      'staff.last_owner',
      'There must always be an owner. Make someone else an owner first.',
    );
  }
  if (err.code === '23505') throw unprocessable('plan.duplicate', 'That price id is already on a plan');
  if (err.code === '23514' || err.code === '22023')
    throw unprocessable('plan.invalid', err.message ?? 'Not allowed');
  throw e;
}

@Injectable()
export class AdminPlansService {
  constructor(
    @Inject(AdminDb) private readonly db: AdminDb,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ----- Staff (owner) ----------------------------------------------------------------------------

  async staff(staffId: string): Promise<StaffMemberDto[]> {
    return this.db.run(async (trx) => {
      const { rows } = await sql<{
        user_id: string;
        email: string;
        display_name: string;
        role: StaffRole;
        created_at: Date;
        added_by_email: string | null;
      }>`select * from app.admin_staff(${staffId}::uuid)`
        .execute(trx)
        .catch(fromDb);
      return rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        createdAt: r.created_at.toISOString(),
        addedBy: r.added_by_email,
      }));
    });
  }

  /** Adds someone, or changes their role. Every owner is emailed (ADR-0049 §3). */
  async setStaff(staffId: string, staffEmail: string, req: SetStaffRequest): Promise<void> {
    const owners = await this.db.run(async (trx) => {
      const { rows } = await sql<{ user_id: string; previous: string | null }>`
        select * from app.admin_set_staff(${staffId}::uuid, ${req.email}, ${req.role})`
        .execute(trx)
        .catch(fromDb);
      if (rows[0]?.previous === req.role) return [];
      return this.ownerEmails(trx, staffId);
    });
    await this.tellOwners(
      owners,
      `Montra staff: ${req.email} is now ${req.role}`,
      `${staffEmail} made ${req.email} ${req.role === 'owner' ? 'an owner' : `${req.role} staff`} in the Montra console.\n\nIf you didn't expect this, check the staff list and the staff log now.`,
    );
  }

  async removeStaff(staffId: string, staffEmail: string, userId: string): Promise<void> {
    const { removed, owners } = await this.db.run(async (trx) => {
      const { rows } = await sql<{ email: string | null }>`
        select app.admin_remove_staff(${staffId}::uuid, ${userId}::uuid) as email`
        .execute(trx)
        .catch(fromDb);
      const removed = rows[0]?.email ?? null;
      return { removed, owners: removed ? await this.ownerEmails(trx, staffId) : [] };
    });
    if (!removed) throw notFound('Staff member');
    await this.tellOwners(
      owners,
      `Montra staff: ${removed} was removed`,
      `${staffEmail} removed ${removed} from the Montra console's staff.\n\nIf you didn't expect this, check the staff list and the staff log now.`,
    );
  }

  private async ownerEmails(trx: Trx, staffId: string): Promise<string[]> {
    const { rows } = await sql<{
      email: string;
    }>`select email from app.admin_owner_emails(${staffId}::uuid)`.execute(trx);
    return rows.map((r) => r.email);
  }

  private async tellOwners(to: string[], subject: string, text: string): Promise<void> {
    for (const email of to) {
      await this.mail.send(
        templates.staffNotice({
          to: email,
          subject,
          paragraphs: text.split('\n\n'),
          url: `${this.config.WEB_URL}/admin`,
        }),
      );
    }
  }

  // ----- Plans (owner to change; any staff to see) -------------------------------------------------

  async plans(): Promise<AdminPlanDto[]> {
    return this.db.run(async (trx) => {
      const plans = await trx
        .selectFrom('app.plan')
        .selectAll()
        .orderBy('sort_order')
        .orderBy('key')
        .execute();
      const versions = await trx
        .selectFrom('app.plan_version')
        .selectAll()
        .orderBy('plan_key')
        .orderBy('version', 'desc')
        .execute();
      const prices = await trx.selectFrom('app.plan_price').selectAll().orderBy('created_at').execute();
      const { rows: counts } = await sql<{ plan_version_id: string; subscribers: string; pending: string }>`
        select * from app.admin_plan_subscribers()`.execute(trx);
      const count = new Map(counts.map((c) => [c.plan_version_id, c]));
      return plans.map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description,
        sortOrder: p.sort_order,
        offered: p.offered,
        versions: versions
          .filter((v) => v.plan_key === p.key)
          .map((v) => ({
            id: v.id,
            version: v.version,
            entitlements: entitlementsDto(parseEntitlements(v.entitlements)),
            effectiveFrom: v.effective_from.toISOString(),
            createdAt: v.created_at.toISOString(),
            subscribers: Number(count.get(v.id)?.subscribers ?? 0),
            pending: Number(count.get(v.id)?.pending ?? 0),
            prices: prices
              .filter((pr) => pr.plan_version_id === v.id)
              .map((pr) => ({
                id: pr.id,
                provider: pr.provider,
                interval: pr.billing_interval,
                priceRef: pr.price_ref,
                amountMinor: String(pr.amount_minor),
                currency: pr.currency,
                active: pr.active,
              })),
          })),
      }));
    });
  }

  async savePlan(staffId: string, req: SavePlanRequest): Promise<void> {
    if (req.key === FREE_PLAN && !req.offered) {
      throw unprocessable('plan.free_offered', 'Free is always offered');
    }
    await this.db.run((trx) =>
      sql`select app.admin_save_plan(${staffId}::uuid, ${req.key}, ${req.name}, ${req.description},
        ${req.sortOrder}, ${req.offered})`
        .execute(trx)
        .catch(fromDb),
    );
  }

  /** The current version: the newest that has started. */
  private async current(trx: Trx, key: string) {
    return trx
      .selectFrom('app.plan_version')
      .selectAll()
      .where('plan_key', '=', key)
      .where('effective_from', '<=', new Date())
      .orderBy('effective_from', 'desc')
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Editing a plan writes a new version. New customers get it from its start. One that gives less than the current
   * version starts at least 30 days out; for Free, which every workspace without a paid plan is on, each is told.
   */
  async addVersion(
    staffId: string,
    key: string,
    req: AddPlanVersionRequest,
  ): Promise<{ id: string; version: number }> {
    let next: PlanEntitlements;
    try {
      next = parseEntitlements(req.entitlements);
    } catch (e) {
      if (e instanceof EntitlementsError) {
        throw new AppError(400, 'validation', 'Check the entitlements', [
          { path: `entitlements.${e.path}`, message: e.message },
        ]);
      }
      throw e;
    }
    const start = req.effectiveFrom ? new Date(req.effectiveFrom) : new Date();
    return this.db.run(async (trx) => {
      const current = await this.current(trx, key);
      const less = current
        ? compareEntitlements(parseEntitlements(current.entitlements), next) === 'less'
        : false;
      if (less && start.getTime() < Date.now() + PLAN_REDUCTION_NOTICE_DAYS * DAY_MS - 60_000) {
        throw unprocessable(
          'plan.notice_required',
          `This gives less than the current version, so it can start no sooner than ${PLAN_REDUCTION_NOTICE_DAYS} days from now`,
        );
      }
      const { rows } = await sql<{ id: string; version: number }>`
        select * from app.admin_add_plan_version(${staffId}::uuid, ${key}, ${JSON.stringify(entitlementsJson(next))}::jsonb,
          ${start})`
        .execute(trx)
        .catch(fromDb);
      const created = rows[0]!;
      if (less && key === FREE_PLAN) {
        await sql`select app.admin_notify_free_change(${staffId}::uuid, ${created.id}::uuid)`.execute(trx);
      }
      return created;
    });
  }

  async addPrice(staffId: string, versionId: string, req: AddPlanPriceRequest): Promise<{ id: string }> {
    return this.db.run(async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select app.admin_add_plan_price(${staffId}::uuid, ${versionId}::uuid, ${req.provider}, ${req.interval},
          ${req.priceRef}, ${req.amountMinor}::bigint, ${req.currency}) as id`
        .execute(trx)
        .catch(fromDb);
      return { id: rows[0]!.id };
    });
  }

  async endPrice(staffId: string, priceId: string): Promise<void> {
    const ended = await this.db.run(async (trx) => {
      const { rows } = await sql<{ ended: boolean }>`
        select app.admin_end_plan_price(${staffId}::uuid, ${priceId}::uuid) as ended`
        .execute(trx)
        .catch(fromDb);
      return rows[0]?.ended ?? false;
    });
    if (!ended) throw notFound('Price');
  }

  /**
   * Moves a version's subscribers to another version of the same plan (ADR-0049 §1). Giving at least as much, at
   * once. Giving less, from each subscriber's first renewal at least 30 days out, and each is told.
   */
  async moveSubscribers(staffId: string, req: MoveSubscribersRequest): Promise<MoveSubscribersDto> {
    return this.db.run(async (trx) => {
      const versions = await trx
        .selectFrom('app.plan_version')
        .select(['id', 'entitlements'])
        .where('id', 'in', [req.from, req.to])
        .execute();
      const from = versions.find((v) => v.id === req.from);
      const to = versions.find((v) => v.id === req.to);
      if (!from || !to) throw notFound('Plan version');
      const less =
        compareEntitlements(parseEntitlements(from.entitlements), parseEntitlements(to.entitlements)) ===
        'less';
      let after: Date | null = null;
      if (less) {
        if (!req.after) {
          throw unprocessable(
            'plan.notice_required',
            `This version gives less, so choose a date at least ${PLAN_REDUCTION_NOTICE_DAYS} days away`,
          );
        }
        after = new Date(req.after);
        if (after.getTime() < Date.now() + PLAN_REDUCTION_NOTICE_DAYS * DAY_MS - 60_000) {
          throw unprocessable(
            'plan.notice_required',
            `A move that gives less can start no sooner than ${PLAN_REDUCTION_NOTICE_DAYS} days from now`,
          );
        }
      }
      const { rows } = await sql<{ moved: number }>`
        select app.admin_move_subscribers(${staffId}::uuid, ${req.from}::uuid, ${req.to}::uuid, ${after}) as moved`
        .execute(trx)
        .catch(fromDb);
      return { moved: rows[0]?.moved ?? 0, when: less ? 'renewal' : 'now' };
    });
  }
}
