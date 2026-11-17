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
  UseInterceptors,
} from '@nestjs/common';
import {
  AcceptTaxFormDifferenceRequest,
  CreateTaxFormRequest,
  CreateTaxFormWaiverRequest,
  Id,
  ListTaxFormsQuery,
  RecordFromTaxFormRequest,
  UpdateTaxFormRequest,
  type TaxFormDto,
  type TaxFormReviewDto,
  type TaxFormWaiverDto,
  type TaxYearDto,
} from '@montra/schemas';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { TAX_FORM_WRITERS, TaxFormsService } from './tax-forms.service.js';

/**
 * Tax forms received (ADR-0052, TAX-01..TAX-06, TAX-08): a year's forms with their checks and the forms expected,
 * typing one in, matching and changing it, accepting a difference, recording income from it, deleting it to the Trash,
 * waivers for expected forms, and Review's forms to check. Uploading and reading files come later (PR 3). Row-level
 * security decides which forms each login sees (§8.4).
 */
@Controller('v1/workspaces/:workspaceId/tax-forms')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class TaxFormsController {
  constructor(@Inject(TaxFormsService) private readonly taxForms: TaxFormsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: unknown): Promise<TaxYearDto> {
    return this.taxForms.year(dbCtx(ctx), parse(ListTaxFormsQuery, q).year);
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.create({ ...dbCtx(ctx), role: ctx.role }, parse(CreateTaxFormRequest, body));
  }

  /** Review's "Tax forms to check" (§7.1). */
  @Get('review')
  async review(@Ctx() ctx: RequestContext): Promise<TaxFormReviewDto> {
    return { data: await this.taxForms.review(dbCtx(ctx)) };
  }

  @Post('waivers')
  createWaiver(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<TaxFormWaiverDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.createWaiver(dbCtx(ctx), parse(CreateTaxFormWaiverRequest, body));
  }

  @Delete('waivers/:id')
  @HttpCode(204)
  async removeWaiver(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    await this.taxForms.removeWaiver(dbCtx(ctx), parse(Id, id));
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<TaxFormDto> {
    return this.taxForms.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.update(
      { ...dbCtx(ctx), role: ctx.role },
      parse(Id, id),
      parse(UpdateTaxFormRequest, body),
    );
  }

  /** Accept a box's difference with a note (§5.6). */
  @Post(':id/accept')
  @HttpCode(200)
  accept(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.accept(dbCtx(ctx), parse(Id, id), parse(AcceptTaxFormDifferenceRequest, body));
  }

  /** Record from the form (§5.6): income on a valued account moved from investment gains to the income category. */
  @Post(':id/record')
  @HttpCode(200)
  record(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.record(dbCtx(ctx), parse(Id, id), parse(RecordFromTaxFormRequest, body));
  }

  /** Takes back what Record from the form made. */
  @Delete(':id/record')
  unrecord(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.unrecord(dbCtx(ctx), parse(Id, id));
  }

  /** To the Trash for 30 days; restored through `POST trash/tax_form/:id/restore`. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    await this.taxForms.remove(dbCtx(ctx), parse(Id, id));
  }
}
