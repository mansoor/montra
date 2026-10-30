import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AiTaskResultRequest,
  UpdateAiSettingsRequest,
  type AiEventDto,
  type AiSettingsDto,
  type AiTaskDto,
  type TestAiProviderResponse,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { Db } from '../db/database.js';
import { notFound } from '../common/errors.js';
import { parse } from '../common/zod.js';
import { requireRole } from '../common/roles.js';
import { AiService } from './ai.service.js';

const DEFAULT_PAGE = 50;

/** AI settings (UP-13), the audit log (AIA-10) and local-mode tasks (06 §2). */
@Controller('v1/workspaces/:workspaceId/ai')
@UseGuards(AuthGuard, WorkspaceGuard)
export class AiController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  @Get('settings')
  settings(@Ctx() ctx: RequestContext): Promise<AiSettingsDto> {
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.ai.settings(trx, c));
  }

  @Patch('settings')
  async update(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<AiSettingsDto> {
    requireRole(ctx, 'owner');
    const req = parse(UpdateAiSettingsRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, async (trx) => {
      await this.ai.updateSettings(trx, c, req);
      return this.ai.settings(trx, c);
    });
  }

  @Post('settings/test')
  @HttpCode(200)
  async test(@Ctx() ctx: RequestContext): Promise<TestAiProviderResponse> {
    const c = dbCtx(ctx);
    const runtime = await this.db.run(c, (trx) =>
      this.ai.runtime(trx, c, { type: 'settings', id: c.workspaceId }),
    );
    if (!runtime.available)
      return {
        ok: false,
        provider: runtime.ctx.provider.id,
        model: null,
        latencyMs: null,
        error: runtime.mode === 'off' ? 'AI is off' : 'No provider is configured for this mode',
      };
    const started = Date.now();
    const res = await this.ai.gateway.ping({ ...runtime.ctx, parkLocal: false });
    return res.ok
      ? {
          ok: true,
          provider: res.meta.provider,
          model: res.value.model,
          latencyMs: Date.now() - started,
          error: null,
        }
      : {
          ok: false,
          provider: runtime.ctx.provider.id,
          model: null,
          latencyMs: Date.now() - started,
          error: res.detail ?? res.reason,
        };
  }

  // ----- Audit log (AIA-10) -------------------------------------------------------------------------------

  @Get('events')
  async events(@Ctx() ctx: RequestContext, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const c = dbCtx(ctx);
    const PAGE = limit ? parse(z.coerce.number().int().min(1).max(200), limit) : DEFAULT_PAGE;
    return this.db.run(c, async (trx) => {
      let q = trx
        .selectFrom('app.ai_event')
        .selectAll()
        .where('workspace_id', '=', c.workspaceId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(PAGE + 1);
      if (cursor) {
        const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
        const atDate = new Date(at!);
        q = q.where((eb) =>
          eb.or([eb('created_at', '<', atDate), eb.and([eb('created_at', '=', atDate), eb('id', '<', id!)])]),
        );
      }
      const rows = await q.execute();
      const page = rows.slice(0, PAGE);
      const last = page.at(-1);
      return {
        data: page.map((e): AiEventDto => ({
          id: e.id,
          task: e.task,
          provider: e.provider,
          model: e.model,
          promptVersion: e.prompt_version,
          inputHash: e.input_hash,
          outcome: e.outcome,
          output: e.output,
          confidence: e.confidence === null ? null : Number(e.confidence),
          items: e.items,
          latencyMs: e.latency_ms,
          tokensIn: e.tokens_in,
          tokensOut: e.tokens_out,
          costUsd: Number(e.cost_micro_usd) / 1e6,
          userAction: e.user_action,
          subjectType: e.subject_type,
          subjectId: e.subject_id,
          createdAt: e.created_at.toISOString(),
        })),
        nextCursor:
          rows.length > PAGE && last
            ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
            : null,
      };
    });
  }

  @Delete('events/:id')
  @HttpCode(204)
  async deleteEvent(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    const c = dbCtx(ctx);
    const res = await this.db.run(c, (trx) =>
      trx
        .deleteFrom('app.ai_event')
        .where('workspace_id', '=', c.workspaceId)
        .where('id', '=', parse(z.uuid(), id))
        .executeTakeFirst(),
    );
    if (!res.numDeletedRows) throw notFound('AI event');
  }

  @Delete('events')
  async deleteAll(@Ctx() ctx: RequestContext): Promise<{ deleted: number }> {
    requireRole(ctx, 'owner', 'partner');
    const c = dbCtx(ctx);
    const res = await this.db.run(c, (trx) =>
      trx.deleteFrom('app.ai_event').where('workspace_id', '=', c.workspaceId).executeTakeFirst(),
    );
    return { deleted: Number(res.numDeletedRows) };
  }

  // ----- Local-mode tasks ---------------------------------------------------------------------------------

  /** Pending work for a client on the user's network; listing claims it for 5 minutes. */
  @Get('tasks')
  async tasks(@Ctx() ctx: RequestContext): Promise<{ data: AiTaskDto[] }> {
    const c = dbCtx(ctx);
    return this.db.run(c, async (trx) => {
      const rows = await trx
        .updateTable('app.ai_task')
        .set({ status: 'claimed', claimed_at: new Date() })
        .where('workspace_id', '=', c.workspaceId)
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('app.ai_task')
            .select('id')
            .where('workspace_id', '=', c.workspaceId)
            .where('expires_at', '>', new Date())
            .where((w) =>
              w.or([
                w('status', '=', 'pending'),
                w.and([w('status', '=', 'claimed'), w('claimed_at', '<', new Date(Date.now() - 5 * 60_000))]),
              ]),
            )
            .orderBy('created_at')
            .limit(20),
        )
        .returning(['id', 'task', 'input', 'created_at'])
        .execute();
      return {
        data: rows.map((r) => ({
          id: r.id,
          task: r.task,
          input: r.input,
          createdAt: r.created_at.toISOString(),
        })),
      };
    });
  }

  @Post('tasks/:id/result')
  @HttpCode(204)
  async taskResult(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const req = parse(AiTaskResultRequest, body);
    const c = dbCtx(ctx);
    const res = await this.db.run(c, (trx) =>
      trx
        .updateTable('app.ai_task')
        .set({ status: 'done', result: JSON.stringify(req.output ?? null) })
        .where('workspace_id', '=', c.workspaceId)
        .where('id', '=', parse(z.uuid(), id))
        .where('status', 'in', ['pending', 'claimed'])
        .executeTakeFirst(),
    );
    if (!res.numUpdatedRows) throw notFound('AI task');
  }
}
