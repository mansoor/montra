/**
 * Managing accounts (ADR-0049 §4): suspending and restoring, trials, given plans and coupons, and closing an account
 * on request. Staff still never see money. Every change is in the staff log, through the admin_ functions.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { FREE_PLAN } from '@montra/domain';
import type {
  AdminSetPlanRequest,
  CloseAccountRequest,
  CouponRequest,
  ExtendTrialRequest,
  SuspendRequest,
} from '@montra/schemas';
import { AUTH_PORT, type AuthPort } from '../auth/auth.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { OwnershipService } from '../data/ownership.service.js';
import { MAIL_PORT, templates, type MailPort } from '../mail/mail.service.js';
import { BILLING_PORT, type BillingPort } from './billing.port.js';
import { AdminDb } from './staff.js';
import { ServiceSettings } from './service-settings.js';

const DAY_MS = 86_400_000;

function fromDb(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === '42501') throw new AppError(403, 'forbidden', 'This needs a higher staff role');
  if (err.code === '22023') throw unprocessable('account.invalid', err.message ?? 'Not allowed');
  throw e;
}

@Injectable()
export class AdminAccountsService {
  private readonly logger = new Logger('AdminAccounts');

  constructor(
    @Inject(AdminDb) private readonly db: AdminDb,
    @Inject(AUTH_PORT) private readonly auth: AuthPort,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(BILLING_PORT) private readonly billing: BillingPort,
    @Inject(OwnershipService) private readonly ownership: OwnershipService,
    @Inject(ServiceSettings) private readonly settings: ServiceSettings,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private async support(): Promise<string> {
    return (await this.settings.supportEmail()) ?? 'support';
  }

  // ----- Suspend and restore ------------------------------------------------------------------------

  /**
   * For abuse, fraud or a legal hold. They can't sign in, their sessions end, and workspaces they own close to every
   * member, with the data kept. They're told, unless it's a legal hold.
   */
  async suspend(staffId: string, userId: string, req: SuspendRequest): Promise<void> {
    const person = await this.db.run(async (trx) => {
      const { rows } = await sql<{ identity_id: string | null; email: string }>`
        select * from app.admin_suspend(${staffId}::uuid, ${userId}::uuid, ${req.kind}, ${req.reason})`
        .execute(trx)
        .catch(fromDb);
      return rows[0];
    });
    if (!person) throw notFound('Account');
    if (person.identity_id) await this.auth.setIdentityActive(person.identity_id, false);
    if (req.kind !== 'legal_hold') {
      await this.mail.send(templates.accountSuspended({ to: person.email, support: await this.support() }));
    }
  }

  async restore(staffId: string, userId: string): Promise<void> {
    const person = await this.db.run(async (trx) => {
      const { rows } = await sql<{ identity_id: string | null; email: string; kind: string }>`
        select * from app.admin_restore(${staffId}::uuid, ${userId}::uuid)`
        .execute(trx)
        .catch(fromDb);
      return rows[0];
    });
    if (!person) throw notFound('Suspension');
    if (person.identity_id) await this.auth.setIdentityActive(person.identity_id, true);
    await this.mail.send(
      templates.accountRestored({ to: person.email, url: `${this.config.WEB_URL}/sign-in` }),
    );
  }

  // ----- Plans: trials, given plans and coupons -----------------------------------------------------

  private async plan(workspaceId: string) {
    return this.db.run(async (trx) => {
      const { rows } = await sql<{
        workspace_id: string;
        plan_name: string;
        trial_end: Date | null;
        subscription_ref: string | null;
      }>`select * from app.admin_workspace_plans(${[workspaceId]}::uuid[])`.execute(trx);
      const sub = await sql<{ status: string; provider: string | null }>`
        select status, provider from app.admin_subscription(${workspaceId}::uuid)`.execute(trx);
      return rows[0]
        ? { ...rows[0], status: sub.rows[0]?.status ?? 'none', provider: sub.rows[0]?.provider ?? null }
        : undefined;
    });
  }

  /** Up to 30 days at a time. A trial Stripe runs is extended there first, or its next event would undo it. */
  async extendTrial(
    staffId: string,
    workspaceId: string,
    req: ExtendTrialRequest,
  ): Promise<{ trialEnd: string }> {
    const p = await this.plan(workspaceId);
    if (!p) throw notFound('Workspace');
    if (p.status !== 'trialing' || !p.trial_end) {
      throw unprocessable('trial.none', 'That workspace isn’t on a trial');
    }
    const from = Math.max(p.trial_end.getTime(), Date.now());
    const until = new Date(from + req.days * DAY_MS);
    if (p.provider === 'stripe' && p.subscription_ref)
      await this.billing.extendTrial(p.subscription_ref, until);
    await this.db.run((trx) =>
      sql`select app.admin_extend_trial(${staffId}::uuid, ${workspaceId}::uuid, ${until}, ${req.reason})`
        .execute(trx)
        .catch(fromDb),
    );
    return { trialEnd: until.toISOString() };
  }

  /**
   * A given plan: provider `comp`, the plan's current version, until a date, never through Stripe. Free takes a given
   * plan away. A workspace paying through Stripe gets a coupon instead.
   */
  async givePlan(staffId: string, workspaceId: string, req: AdminSetPlanRequest): Promise<void> {
    await this.db.run(async (trx) => {
      const { rows } = await sql<{ provider: string | null; status: string }>`
        select * from app.admin_subscription(${workspaceId}::uuid)`.execute(trx);
      const current = rows[0];
      if (current?.provider === 'stripe' && current.status !== 'canceled' && current.status !== 'none') {
        throw unprocessable(
          'billing.provider_managed',
          'This plan is paid for through Stripe. Give a coupon instead.',
        );
      }
      const version = await trx
        .selectFrom('app.plan_version')
        .select(['id', 'version'])
        .where('plan_key', '=', req.plan)
        .where('effective_from', '<=', new Date())
        .orderBy('effective_from', 'desc')
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!version) throw unprocessable('plan.unknown', 'There is no such plan');
      const given = req.plan !== FREE_PLAN;
      if (given && !req.until) throw unprocessable('plan.until_required', 'A given plan needs an end date');
      const until = given ? new Date(`${req.until}T23:59:59Z`) : null;
      if (until && until.getTime() <= Date.now())
        throw unprocessable('plan.until_past', 'Choose a date ahead');
      await sql`select app.apply_plan_version(${workspaceId}::uuid, ${version.id}::uuid, ${given ? 'active' : 'none'},
        ${given ? 'comp' : null}, null, null, null, null, ${until}, null, false)`.execute(trx);
      await trx
        .insertInto('app.admin_log')
        .values({
          staff_id: staffId,
          action: given ? 'plan.give' : 'plan.set',
          subject: workspaceId,
          detail: JSON.stringify({
            plan: req.plan,
            version: version.version,
            until: req.until ?? null,
            reason: req.reason,
          }),
        })
        .execute();
    });
  }

  async coupon(staffId: string, workspaceId: string, req: CouponRequest): Promise<void> {
    const p = await this.plan(workspaceId);
    if (!p) throw notFound('Workspace');
    if (p.provider !== 'stripe' || !p.subscription_ref || p.status === 'canceled') {
      throw unprocessable('billing.no_subscription', 'A coupon is for a workspace paying through Stripe');
    }
    await this.billing.applyCoupon(p.subscription_ref, req.coupon);
    await this.db.run((trx) =>
      trx
        .insertInto('app.admin_log')
        .values({
          staff_id: staffId,
          action: 'plan.coupon',
          subject: workspaceId,
          detail: JSON.stringify({ coupon: req.coupon, reason: req.reason }),
        })
        .execute(),
    );
  }

  // ----- Closing on request (owner) -----------------------------------------------------------------

  /**
   * Starts the deletion the person could have started themselves (ADR-0019 §12), with the same 30 days to change
   * their mind. The request must have come from the account's own address, and where it came is recorded.
   */
  async close(
    staffId: string,
    userId: string,
    req: CloseAccountRequest,
  ): Promise<{ purgeAfter: string | null }> {
    const person = await this.db.run(async (trx) => {
      const { rows } = await sql<{ email: string; deleted_at: Date | null }>`
        select email, deleted_at from app.admin_find_accounts(${req.fromEmail}) where id = ${userId}::uuid`.execute(
        trx,
      );
      return rows[0];
    });
    if (!person || person.email.toLowerCase() !== req.fromEmail.toLowerCase()) {
      throw unprocessable(
        'account.email_mismatch',
        'The request must come from the account’s own email address',
      );
    }
    if (person.deleted_at) throw unprocessable('account.closing', 'This account is already being closed');
    const status = await this.ownership.requestDeletion(userId, 'support');
    await this.db.run((trx) =>
      trx
        .insertInto('app.admin_log')
        .values({
          staff_id: staffId,
          action: 'account.close',
          subject: userId,
          detail: JSON.stringify({ from: req.fromEmail, channel: req.channel, note: req.note }),
        })
        .execute(),
    );
    await this.mail.send(
      templates.accountClosing({
        to: person.email,
        purgeAfter: status.purgeAfter,
        support: await this.support(),
        url: `${this.config.WEB_URL}/sign-in`,
      }),
    );
    return { purgeAfter: status.purgeAfter };
  }
}
