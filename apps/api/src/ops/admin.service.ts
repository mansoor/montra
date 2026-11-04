/**
 * The staff console (OPS-01, OPS-02, OPS-05, NFR-13). Everything goes through `montra_admin` or `montra_support`, never the app's role, so
 * a mistake here can't reach anyone's money. Every change is written to the staff log.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { entitlementsFor, maintenanceNoticeOk, type Plan } from '@montra/domain';
import type {
  AdminAccountDto,
  AdminSetPlanRequest,
  AdminSupportRequestDto,
  AdminWorkspaceDto,
  AiAccuracyRowDto,
  AppVersionsDto,
  CreateNoticeRequest,
  FeatureFlagDto,
  ImportFailureRowDto,
  SaveFeatureFlagRequest,
  SaveMerchantRequest,
  SaveMileageRateRequest,
  SupportViewDto,
  SystemNoticeDto,
} from '@montra/schemas';
import { notFound, unprocessable } from '../common/errors.js';
import { AdminDb, SupportDb } from './staff.js';

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

@Injectable()
export class AdminService {
  constructor(
    @Inject(AdminDb) private readonly db: AdminDb,
    @Inject(SupportDb) private readonly support: SupportDb,
  ) {}

  private log(
    trx: Trx,
    staffId: string,
    action: string,
    subject: string | null,
    detail: Record<string, unknown> = {},
  ) {
    return trx
      .insertInto('app.admin_log')
      .values({ staff_id: staffId, action, subject, detail: JSON.stringify(detail) })
      .execute();
  }

  // ----- Accounts ---------------------------------------------------------------------------------

  async findAccounts(query: string): Promise<AdminAccountDto[]> {
    if (query.trim().length < 2) return [];
    return this.db.run(async (trx) => {
      const { rows } = await sql<{
        id: string;
        email: string;
        display_name: string;
        created_at: Date;
        deleted_at: Date | null;
        workspaces: string;
      }>`select * from app.admin_find_accounts(${query.trim()})`.execute(trx);
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        createdAt: r.created_at.toISOString(),
        deletedAt: iso(r.deleted_at),
        workspaces: Number(r.workspaces),
      }));
    });
  }

  async accountWorkspaces(userId: string): Promise<AdminWorkspaceDto[]> {
    return this.db.run(async (trx) => {
      const { rows } = await sql<{
        id: string;
        name: string;
        role: string;
        plan: 'free' | 'pro';
        status: string;
        provider: string | null;
        current_period_end: Date | null;
        grace_until: Date | null;
        quota_bytes: string;
        used_bytes: string;
        members: string;
        created_at: Date;
        deleted_at: Date | null;
        support_until: Date | null;
      }>`select * from app.admin_account_workspaces(${userId}::uuid)`.execute(trx);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        plan: r.plan,
        status: r.status,
        provider: r.provider,
        currentPeriodEnd: iso(r.current_period_end),
        graceUntil: iso(r.grace_until),
        quotaBytes: String(r.quota_bytes),
        usedBytes: String(r.used_bytes),
        members: Number(r.members),
        createdAt: r.created_at.toISOString(),
        deletedAt: iso(r.deleted_at),
        supportUntil: iso(r.support_until),
      }));
    });
  }

  /** A complimentary plan, or taking one away. A workspace paying through a provider is changed there, not here. */
  async setPlan(staffId: string, workspaceId: string, req: AdminSetPlanRequest): Promise<void> {
    await this.db.run(async (trx) => {
      const { rows } = await sql<{ provider: string | null; status: string }>`
        select * from app.admin_subscription(${workspaceId}::uuid)`.execute(trx);
      const current = rows[0];
      if (current?.provider && current.provider !== 'staff' && current.status !== 'canceled') {
        throw unprocessable(
          'billing.provider_managed',
          'This plan is paid for. Change it with the payment provider.',
        );
      }
      const plan = req.plan as Plan;
      const quota = entitlementsFor(plan).storageBytes.toString();
      await sql`select app.apply_subscription(${workspaceId}::uuid, ${plan}, ${plan === 'pro' ? 'active' : 'none'},
        ${plan === 'pro' ? 'staff' : null}, null, null, null, null, null, null, false, ${quota}::bigint)`.execute(
        trx,
      );
      await this.log(trx, staffId, 'plan.set', workspaceId, { plan, reason: req.reason });
    });
  }

  // ----- Flags ------------------------------------------------------------------------------------

  async listFlags(): Promise<FeatureFlagDto[]> {
    return this.db.run(async (trx) => {
      const rows = await trx.selectFrom('app.feature_flag').selectAll().orderBy('key').execute();
      return rows.map((r) => ({
        key: r.key,
        enabled: r.enabled,
        rollout: r.rollout,
        note: r.note,
        updatedAt: r.updated_at.toISOString(),
      }));
    });
  }

  async saveFlag(staffId: string, req: SaveFeatureFlagRequest): Promise<void> {
    await this.db.run(async (trx) => {
      await trx
        .insertInto('app.feature_flag')
        .values({ key: req.key, enabled: req.enabled, rollout: req.rollout, note: req.note })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({
            enabled: req.enabled,
            rollout: req.rollout,
            note: req.note,
            updated_at: sql`now()`,
          }),
        )
        .execute();
      await this.log(trx, staffId, 'flag.save', req.key, { enabled: req.enabled, rollout: req.rollout });
    });
  }

  async deleteFlag(staffId: string, key: string): Promise<void> {
    await this.db.run(async (trx) => {
      await trx.deleteFrom('app.feature_flag').where('key', '=', key).execute();
      await this.log(trx, staffId, 'flag.delete', key);
    });
  }

  // ----- Notices and versions ---------------------------------------------------------------------

  async listNotices(): Promise<(SystemNoticeDto & { showFrom: string })[]> {
    return this.db.run(async (trx) => {
      const rows = await trx
        .selectFrom('app.system_notice')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as SystemNoticeDto['kind'],
        title: r.title,
        body: r.body,
        showFrom: r.show_from.toISOString(),
        startsAt: iso(r.starts_at),
        endsAt: iso(r.ends_at),
      }));
    });
  }

  /** OPS-03: planned maintenance has to be announced 48 hours ahead. An incident can't wait, so it's posted at once. */
  async createNotice(staffId: string, req: CreateNoticeRequest): Promise<{ id: string }> {
    const showFrom = req.showFrom ? new Date(req.showFrom) : new Date();
    const startsAt = req.startsAt ? new Date(req.startsAt) : null;
    if (req.kind === 'maintenance') {
      if (!startsAt) throw unprocessable('notice.starts_required', 'Say when the maintenance starts');
      if (!maintenanceNoticeOk(showFrom, startsAt)) {
        throw unprocessable('notice.too_soon', 'Planned maintenance has to be announced 48 hours ahead');
      }
    }
    return this.db.run(async (trx) => {
      const row = await trx
        .insertInto('app.system_notice')
        .values({
          kind: req.kind,
          title: req.title,
          body: req.body,
          show_from: req.showFrom ? showFrom : sql<Date>`now()`,
          starts_at: startsAt,
          ends_at: req.endsAt ? new Date(req.endsAt) : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.log(trx, staffId, 'notice.create', row.id, { kind: req.kind });
      return { id: row.id };
    });
  }

  async endNotice(staffId: string, id: string): Promise<void> {
    await this.db.run(async (trx) => {
      const done = await trx
        .updateTable('app.system_notice')
        // The database's clock, which is the one the status page reads against.
        .set({ ends_at: sql<Date>`now()` })
        .where('id', '=', id)
        .executeTakeFirst();
      if (!done.numUpdatedRows) throw notFound('Notice');
      await this.log(trx, staffId, 'notice.end', id);
    });
  }

  async appVersions(): Promise<AppVersionsDto> {
    return this.db.run(async (trx) => {
      const rows = await trx.selectFrom('app.system_setting').select(['key', 'value']).execute();
      const get = (k: string) => rows.find((r) => r.key === k)?.value ?? '0.0.0';
      return { ios: get('min_app_version_ios'), android: get('min_app_version_android') };
    });
  }

  async saveAppVersions(staffId: string, req: AppVersionsDto): Promise<void> {
    await this.db.run(async (trx) => {
      for (const [key, value] of [
        ['min_app_version_ios', req.ios],
        ['min_app_version_android', req.android],
      ] as const) {
        await trx
          .insertInto('app.system_setting')
          .values({ key, value })
          .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: sql`now()` }))
          .execute();
      }
      await this.log(trx, staffId, 'app_version.save', null, { ...req });
    });
  }

  // ----- Analytics --------------------------------------------------------------------------------

  async importFailures(days: number): Promise<ImportFailureRowDto[]> {
    return this.db.run(async (trx) => {
      const { rows } = await sql<{
        institution: string;
        file_type: string;
        batches: string;
        failed: string;
        needed_mapping: string;
        rows_failed: string;
      }>`select * from app.admin_import_failures(${days}::int)`.execute(trx);
      return rows.map((r) => ({
        institution: r.institution,
        fileType: r.file_type,
        batches: Number(r.batches),
        failed: Number(r.failed),
        neededMapping: Number(r.needed_mapping),
        rowsFailed: Number(r.rows_failed),
      }));
    });
  }

  async aiAccuracy(days: number): Promise<AiAccuracyRowDto[]> {
    return this.db.run(async (trx) => {
      const { rows } = await sql<{
        task: string;
        provider: string;
        model: string;
        calls: string;
        failures: string;
        accepted: string;
        edited: string;
        rejected: string;
        cost_micro_usd: string;
      }>`select * from app.admin_ai_accuracy(${days}::int)`.execute(trx);
      return rows.map((r) => ({
        task: r.task,
        provider: r.provider,
        model: r.model,
        calls: Number(r.calls),
        failures: Number(r.failures),
        accepted: Number(r.accepted),
        edited: Number(r.edited),
        rejected: Number(r.rejected),
        costMicroUsd: String(r.cost_micro_usd),
      }));
    });
  }

  // ----- Support requests -------------------------------------------------------------------------

  async supportRequests(status: 'open' | 'closed'): Promise<AdminSupportRequestDto[]> {
    return this.db.run(async (trx) => {
      const { rows } = await sql<{
        id: string;
        email: string;
        kind: string;
        subject: string;
        body: string;
        context: Record<string, unknown>;
        has_screenshot: boolean;
        status: string;
        created_at: Date;
        workspace_id: string | null;
      }>`select * from app.admin_support_requests(${status})`.execute(trx);
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        kind: r.kind,
        subject: r.subject,
        body: r.body,
        context: r.context,
        hasScreenshot: r.has_screenshot,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        workspaceId: r.workspace_id,
      }));
    });
  }

  async supportScreenshot(id: string): Promise<Buffer> {
    return this.db.run(async (trx) => {
      const { rows } = await sql<{ shot: Buffer | null }>`
        select app.admin_support_screenshot(${id}::uuid) as shot`.execute(trx);
      const shot = rows[0]?.shot;
      if (!shot) throw notFound('Screenshot');
      return shot;
    });
  }

  async closeSupportRequest(staffId: string, id: string): Promise<void> {
    await this.db.run(async (trx) => {
      await sql`select app.admin_close_support_request(${id}::uuid)`.execute(trx);
      await this.log(trx, staffId, 'support_request.close', id);
    });
  }

  // ----- Support access (OPS-02) ------------------------------------------------------------------

  /** Refuses unless the owner has let support in, and tells them each time someone looks. */
  async supportView(staffId: string, workspaceId: string): Promise<SupportViewDto> {
    const grant = await this.db.run(async (trx) => {
      const { rows } = await sql<{ granted_by: string; expires_at: Date }>`
        select granted_by, expires_at from app.admin_support_grant(${workspaceId}::uuid)`.execute(trx);
      const g = rows[0];
      if (!g) return null;
      await sql`select app.log_support_access(${workspaceId}::uuid, ${g.granted_by}::uuid, ${staffId}::uuid, 'summary')`.execute(
        trx,
      );
      return g;
    });
    // The same answer as a workspace that doesn't exist.
    if (!grant) throw notFound('Workspace');
    return this.support.run(workspaceId, grant.granted_by, async (trx) => {
      const workspace = await trx
        .selectFrom('app.workspace')
        .select(['id', 'name', 'base_currency'])
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow();
      const entities = await trx
        .selectFrom('app.entity')
        .select(['id', 'type', 'name', 'functional_currency'])
        .where('workspace_id', '=', workspaceId)
        .execute();
      const imports = await trx
        .selectFrom('app.import_batch')
        .select([
          'id',
          'status',
          'file_type',
          'rows_read',
          'rows_added',
          'rows_failed',
          'mapping_source',
          'created_at',
        ])
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at', 'desc')
        .limit(25)
        .execute();
      const events = await trx
        .selectFrom('app.ai_event')
        .select(['task', 'provider', 'model', 'outcome', 'user_action', 'created_at'])
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at', 'desc')
        .limit(25)
        .execute();
      return {
        workspace: { id: workspace.id, name: workspace.name, baseCurrency: workspace.base_currency },
        expiresAt: grant.expires_at.toISOString(),
        entities: entities.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          currency: e.functional_currency,
        })),
        imports: imports.map((b) => ({
          id: b.id,
          status: b.status,
          fileType: b.file_type,
          rowsRead: b.rows_read,
          rowsAdded: b.rows_added,
          rowsFailed: b.rows_failed,
          mappingSource: b.mapping_source,
          createdAt: b.created_at.toISOString(),
        })),
        aiEvents: events.map((e) => ({
          task: e.task,
          provider: e.provider,
          model: e.model,
          outcome: e.outcome,
          userAction: e.user_action,
          createdAt: e.created_at.toISOString(),
        })),
      };
    });
  }

  // ----- Reference data (OPS-05) ------------------------------------------------------------------

  async merchants(query: string) {
    return this.db.run(async (trx) => {
      const rows = await trx
        .selectFrom('ref.merchant')
        .selectAll()
        .where('display_name', 'ilike', `%${query.replace(/[%_\\]/g, '')}%`)
        .orderBy('display_name')
        .limit(100)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        matchKey: r.match_key,
        mcc: r.mcc,
        categoryHint: r.category_hint,
        version: r.version,
      }));
    });
  }

  async saveMerchant(staffId: string, req: SaveMerchantRequest): Promise<void> {
    await this.db.run(async (trx) => {
      const values = {
        display_name: req.displayName,
        match_key: req.matchKey.toUpperCase(),
        mcc: req.mcc ?? null,
        category_hint: req.categoryHint ?? null,
      };
      await trx
        .insertInto('ref.merchant')
        .values({ id: req.id, ...values })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            ...values,
            version: sql`ref.merchant.version + 1`,
            updated_at: sql`now()`,
          }),
        )
        .execute();
      await this.log(trx, staffId, 'reference.merchant.save', req.id);
    });
  }

  async mileageRates() {
    return this.db.run(async (trx) => {
      const rows = await trx
        .selectFrom('ref.mileage_rate')
        .selectAll()
        .orderBy('country')
        .orderBy('effective_from', 'desc')
        .limit(100)
        .execute();
      return rows.map((r) => ({
        country: r.country,
        effectiveFrom: String(r.effective_from).slice(0, 10),
        tenthsOfCent: r.tenths_of_cent,
        source: r.source,
      }));
    });
  }

  async saveMileageRate(staffId: string, req: SaveMileageRateRequest): Promise<void> {
    await this.db.run(async (trx) => {
      await sql`
        insert into ref.mileage_rate as m (country, effective_from, tenths_of_cent, source)
        values (${req.country.toUpperCase()}, ${req.effectiveFrom}::date, ${req.tenthsOfCent}, ${req.source})
        on conflict (country, effective_from) do update
          set tenths_of_cent = excluded.tenths_of_cent, source = excluded.source,
              version = m.version + 1, updated_at = now()`.execute(trx);
      await this.log(trx, staffId, 'reference.mileage.save', `${req.country}:${req.effectiveFrom}`, {
        tenthsOfCent: req.tenthsOfCent,
      });
    });
  }
}
