import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  CalendarDateDto,
  CreateRecurringRequest,
  UpdateRecurringRequest,
  type RecurringDto,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { RecurringService } from './recurring.service.js';

@Controller('v1/workspaces/:workspaceId/recurring')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class RecurringController {
  constructor(@Inject(RecurringService) private readonly recurring: RecurringService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<{ data: RecurringDto[] }> {
    return { data: await this.recurring.list(dbCtx(ctx)) };
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<RecurringDto> {
    return this.recurring.create(dbCtx(ctx), parse(CreateRecurringRequest, body));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<RecurringDto> {
    return this.recurring.update(dbCtx(ctx), parse(z.uuid(), id), parse(UpdateRecurringRequest, body));
  }

  /** Runs the schedule now (the nightly job does the same). */
  @Post('materialize')
  @HttpCode(200)
  materialize(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const { through } = parse(z.object({ through: CalendarDateDto.optional() }), body ?? {});
    return this.recurring.materialize(dbCtx(ctx), through);
  }
}
