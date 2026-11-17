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
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AcceptTaxFormDifferenceRequest,
  ConfirmTaxFormReadingRequest,
  CreateTaxFormRequest,
  CreateTaxFormWaiverRequest,
  Id,
  ListTaxFormsQuery,
  RecordFromTaxFormRequest,
  UpdateTaxFormRequest,
  UploadTaxFormFieldsDto,
  type TaxFormDto,
  type TaxFormUploadDto,
  type TaxFormReviewDto,
  type TaxFormWaiverDto,
  type TaxYearDto,
} from '@montra/schemas';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { AppError } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { MAX_TAX_FORM_FILES, TaxFormReading } from './tax-form-reading.js';
import { TAX_FORM_WRITERS, TaxFormsService } from './tax-forms.service.js';

/**
 * Tax forms received (ADR-0052, TAX-01..TAX-06, TAX-08): a year's forms with their checks and the forms expected,
 * typing one in, uploading files to read, matching and changing it, confirming a reading, accepting a difference,
 * recording income from it, deleting it to the Trash, waivers for expected forms, and Review's forms to check. Row-level
 * security decides which forms each login sees (§8.4).
 */
@Controller('v1/workspaces/:workspaceId/tax-forms')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class TaxFormsController {
  constructor(
    @Inject(TaxFormsService) private readonly taxForms: TaxFormsService,
    @Inject(TaxFormReading) private readonly reading: TaxFormReading,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: unknown): Promise<TaxYearDto> {
    return this.taxForms.year(dbCtx(ctx), parse(ListTaxFormsQuery, q).year);
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.create({ ...dbCtx(ctx), role: ctx.role }, parse(CreateTaxFormRequest, body));
  }

  /**
   * Several PDFs or photos at once (TAX-01), multipart: the files (any field name), with `year` (the year on screen)
   * and `source` (`upload` or `scan`). Each is read in the background; the same file again is refused with its form.
   */
  @Post('files')
  @HttpCode(202)
  async upload(@Ctx() ctx: RequestContext, @Req() req: FastifyRequest): Promise<TaxFormUploadDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    if (!req.isMultipart())
      throw new AppError(415, 'upload.multipart_required', 'Send the files as multipart/form-data');
    const files: { bytes: Uint8Array; fileName: string }[] = [];
    const fields: Record<string, string> = {};
    for await (const part of req.parts({
      limits: { fileSize: this.config.MAX_UPLOAD_BYTES, files: MAX_TAX_FORM_FILES },
    })) {
      if (part.type === 'file') {
        const bytes = new Uint8Array(await part.toBuffer());
        if (part.file.truncated) {
          throw new AppError(
            413,
            'upload.too_large',
            `Files can be up to ${this.config.MAX_UPLOAD_BYTES / 1_048_576} MB`,
          );
        }
        if (bytes.length === 0)
          throw new AppError(400, 'upload.empty', `${part.filename || 'A file'} is empty`);
        files.push({ bytes, fileName: part.filename || 'tax-form' });
      } else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
    }
    return this.reading.upload(dbCtx(ctx), files, parse(UploadTaxFormFieldsDto, fields));
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

  /** Confirm reading (§5.6): a person checked the boxes against the file. */
  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.confirm(
      { ...dbCtx(ctx), role: ctx.role },
      parse(Id, id),
      parse(ConfirmTaxFormReadingRequest, body),
    );
  }

  /** The form's original file (§8.3); every look is in the audit log (`tax_form.file_viewed`). */
  @Get(':id/files/:fileId')
  async file(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const f = await this.reading.file(dbCtx(ctx), parse(Id, id), parse(Id, fileId));
    void reply.header('content-type', f.mime);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('content-disposition', `inline; filename="${f.name.replace(/[^\w.-]+/g, '_')}"`);
    return Buffer.from(f.bytes);
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
