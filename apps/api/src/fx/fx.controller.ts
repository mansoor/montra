import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { FxRateQuery, type FxRateDto } from '@montra/schemas';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { AppError } from '../common/errors.js';
import { parse } from '../common/zod.js';
import { FxRatesService } from './fx.service.js';

@Controller('v1/workspaces/:workspaceId/fx')
@UseGuards(AuthGuard, WorkspaceGuard)
export class FxController {
  constructor(@Inject(FxRatesService) private readonly fx: FxRatesService) {}

  /** CUR-05: the reference rate for a day (the latest published within a week), direct, inverse or cross. */
  @Get('rates')
  async rate(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<FxRateDto> {
    const q = parse(FxRateQuery, query);
    const rate = await this.fx.rate(dbCtx(ctx), q.base, q.quote, q.date);
    if (!rate) {
      throw new AppError(
        404,
        'fx.no_rate',
        `No ${q.base}→${q.quote} rate on or within a week before ${q.date}`,
      );
    }
    return rate;
  }
}
