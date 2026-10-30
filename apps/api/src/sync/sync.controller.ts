import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import type { ChangeDto } from '@montra/schemas';
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
  constructor(@Inject(Db) private readonly db: Db) {}

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
        .select(['seq', 'table_name', 'row_id', 'op', 'restricted'])
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('seq', '>', since)
        .orderBy('seq')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const latest = page.at(-1)?.seq ?? since;
      return {
        changes: page
          .filter((r) => !r.restricted || ctx.role === 'owner')
          .map((r) => ({ seq: r.seq.toString(), table: r.table_name, id: r.row_id, op: r.op })),
        latestSeq: latest.toString(),
        hasMore: rows.length > limit,
      };
    });
  }
}
