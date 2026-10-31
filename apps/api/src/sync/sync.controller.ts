import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  RegisterPushDeviceRequest,
  SyncPullQuery,
  SyncPushRequest,
  type ChangeDto,
  type PushDeviceDto,
  type SyncPullResponse,
  type SyncPushResponse,
} from '@montra/schemas';
import { sql } from 'kysely';
import { SyncService } from './sync.service.js';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { Db } from '../db/database.js';
import { parse } from '../common/zod.js';

const Query_ = z.object({
  since: z.coerce.bigint().min(0n).default(0n),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  /** Return only the current position (no changes): lets a new client start from "now". */
  head: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/**
 * Pull side of real-time sync (ADR-0008, PLT-06): ordered changes after `since`. RLS filters by entity access;
 * restricted (payslip) rows are only listed for owners. Clients re-read changed rows through the normal API.
 */
@Controller('v1/workspaces/:workspaceId/sync')
@UseGuards(AuthGuard, WorkspaceGuard)
export class SyncController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(SyncService) private readonly sync: SyncService,
  ) {}

  /** Resolved rows for the offline store (ADR-0013); `since=0` bootstraps. */
  @Get('pull')
  pull(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<SyncPullResponse> {
    return this.sync.pull(dbCtx(ctx), parse(SyncPullQuery, query));
  }

  /** The device outbox: idempotent ops with field-group last-write-wins (ADR-0013). */
  @Post('push')
  @HttpCode(200)
  push(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<SyncPushResponse> {
    return this.sync.push(dbCtx(ctx), parse(SyncPushRequest, body).ops);
  }

  @Get('changes')
  async changes(
    @Ctx() ctx: RequestContext,
    @Query() query: unknown,
  ): Promise<{ changes: ChangeDto[]; latestSeq: string; hasMore: boolean }> {
    const { since, limit, head } = parse(Query_, query);
    return this.db.run(dbCtx(ctx), async (trx) => {
      if (head) {
        const top = await trx
          .selectFrom('app.change_log')
          .select((eb) => eb.fn.max('seq').as('seq'))
          .where('workspace_id', '=', ctx.workspaceId!)
          .executeTakeFirst();
        return { changes: [], latestSeq: String(top?.seq ?? 0), hasMore: false };
      }
      const rows = await trx
        .selectFrom('app.change_log')
        .select(['seq', 'sub', 'table_name', 'row_id', 'op', 'restricted'])
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('seq', '>', since)
        .orderBy('seq')
        .orderBy('sub')
        .limit(limit + 1)
        .execute();
      let page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      // All changes of one transaction share `seq`: never end a page inside a transaction's group, or a
      // client resuming from `latestSeq` would skip the rest of it.
      if (hasMore && rows[limit]!.seq === page.at(-1)!.seq) {
        const lastSeq = page.at(-1)!.seq;
        const rest = await trx
          .selectFrom('app.change_log')
          .select(['seq', 'sub', 'table_name', 'row_id', 'op', 'restricted'])
          .where('workspace_id', '=', ctx.workspaceId!)
          .where('seq', '=', lastSeq)
          .where('sub', '>', page.at(-1)!.sub)
          .orderBy('sub')
          .execute();
        page = [...page, ...rest];
      }
      const latest = page.at(-1)?.seq ?? since;
      const more =
        hasMore &&
        Boolean(
          await trx
            .selectFrom('app.change_log')
            .select('seq')
            .where('workspace_id', '=', ctx.workspaceId!)
            .where('seq', '>', latest)
            .limit(1)
            .executeTakeFirst(),
        );
      // Clients re-read rows through the API, so one entry per row (latest operation) is enough.
      const byRow = new Map<string, (typeof page)[number]>();
      for (const r of page) {
        if (r.restricted && ctx.role !== 'owner') continue;
        byRow.delete(`${r.table_name}:${r.row_id}`);
        byRow.set(`${r.table_name}:${r.row_id}`, r);
      }
      return {
        changes: [...byRow.values()].map((r) => ({
          seq: r.seq.toString(),
          table: r.table_name,
          id: r.row_id,
          op: r.op,
        })),
        latestSeq: latest.toString(),
        hasMore: more,
      };
    });
  }
}

/** Push-notification devices of the signed-in user (registered by the mobile app, removed on sign-out). */
@Controller('v1/me/push-devices')
@UseGuards(AuthGuard)
export class PushDevicesController {
  constructor(@Inject(Db) private readonly db: Db) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<{ data: PushDeviceDto[] }> {
    const rows = await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx.selectFrom('app.push_device').selectAll().orderBy('last_seen_at', 'desc').execute(),
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        deviceName: r.device_name,
        appVersion: r.app_version,
        createdAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
      })),
    };
  }

  @Post()
  async register(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<{ id: string }> {
    const req = parse(RegisterPushDeviceRequest, body);
    const { rows } = await this.db.run({ userId: ctx.user.id }, (trx) =>
      sql<{
        id: string;
      }>`select app.register_push_device(${req.token}, ${req.platform}, ${req.deviceName ?? null},
                                                        ${req.appVersion ?? null}) as id`.execute(trx),
    );
    return { id: rows[0]!.id };
  }

  @Delete(':token')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('token') token: string): Promise<void> {
    await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx.deleteFrom('app.push_device').where('token', '=', token).execute(),
    );
  }
}
