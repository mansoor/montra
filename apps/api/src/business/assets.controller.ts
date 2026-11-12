/** Business assets, expense details and trips by driver (BIZ-16..19, ADR-0035). */
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
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  AssignAssetRequest,
  CalendarDateDto,
  CreateAssetRequest,
  DisposeAssetRequest,
  PostDepreciationRequest,
  ReturnAssetRequest,
  SetExpenseDetailRequest,
  UpdateAssetRequest,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { AssetsService } from './assets.service.js';
import { ExpenseDetailsService } from './expense-details.service.js';
import { MileageService } from './mileage.service.js';

const Id = z.uuid();
const Year = z.coerce.number().int().min(1990).max(2200);

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class AssetsController {
  constructor(
    @Inject(AssetsService) private readonly assets: AssetsService,
    @Inject(ExpenseDetailsService) private readonly details: ExpenseDetailsService,
    @Inject(MileageService) private readonly mileage: MileageService,
  ) {}

  // ----- The register (BIZ-16, BIZ-17) -------------------------------------------------------------------------

  /** A business's assets, totals and purchases that may be assets; with `personId`, only what that person holds. */
  @Get('business-assets')
  list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.assets.list(dbCtx(ctx), parse(z.object({ entityId: Id, personId: Id.optional() }), q));
  }

  @Post('business-assets')
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.assets.create(dbCtx(ctx), parse(CreateAssetRequest, body));
  }

  /** Catches every asset of a business up to a year's end. */
  @Post('business-assets/depreciation')
  @HttpCode(200)
  postDepreciation(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.assets.postDepreciation(dbCtx(ctx), parse(PostDepreciationRequest, body));
  }

  @Get('business-assets/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.assets.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('business-assets/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.assets.update(dbCtx(ctx), parse(Id, id), parse(UpdateAssetRequest, body));
  }

  @Delete('business-assets/:id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.assets.remove(dbCtx(ctx), parse(Id, id));
  }

  @Delete('business-assets/:id/depreciation/:year')
  unpost(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('year') year: string) {
    return this.assets.unpostYear(dbCtx(ctx), parse(Id, id), parse(Year, year));
  }

  @Post('business-assets/:id/disposal')
  @HttpCode(200)
  dispose(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.assets.dispose(dbCtx(ctx), parse(Id, id), parse(DisposeAssetRequest, body));
  }

  @Delete('business-assets/:id/disposal')
  undoDisposal(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.assets.undoDisposal(dbCtx(ctx), parse(Id, id));
  }

  @Post('business-assets/:id/assignments')
  assign(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.assets.assign(dbCtx(ctx), parse(Id, id), parse(AssignAssetRequest, body));
  }

  @Post('asset-assignments/:id/return')
  @HttpCode(200)
  returnAsset(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.assets.returnAssignment(dbCtx(ctx), parse(Id, id), parse(ReturnAssetRequest, body));
  }

  @Delete('asset-assignments/:id')
  removeAssignment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.assets.removeAssignment(dbCtx(ctx), parse(Id, id));
  }

  // ----- Expense details (BIZ-18) ------------------------------------------------------------------------------

  @Put('transactions/:id/expense-detail')
  setDetail(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.details.set(dbCtx(ctx), parse(Id, id), parse(SetExpenseDetailRequest, body));
  }

  @Get('reports/expenses-by-person')
  byPerson(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.details.byPerson(
      dbCtx(ctx),
      parse(z.object({ entityId: Id, from: CalendarDateDto.optional(), to: CalendarDateDto.optional() }), q),
    );
  }

  // ----- Trips by driver (BIZ-19) ------------------------------------------------------------------------------

  @Post('mileage-trips/:id/reimburse')
  @HttpCode(200)
  reimburseTrip(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.mileage.reimburse(dbCtx(ctx), parse(Id, id));
  }
}
