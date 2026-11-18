import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { FileProvidedAgainDto, MissingFilesResponse } from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { AppError } from '../common/errors.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { CONFIG, type AppConfig } from '../config.js';
import { MissingFiles } from './missing-files.js';

/** "Upload anyway": the person saw the possible-duplicate warning and goes on. */
export const AnywayQuery = z.object({ anyway: z.enum(['true', 'false']).default('false') }).transform((q) => ({
  anyway: q.anyway === 'true',
}));

/**
 * Review → "Files to provide again" (ADR-0054 §5a; VLT-11): files Montra no longer holds that the household's Family
 * Document Vault didn't give back. Owners and admins see them all; anyone else (but a viewer) the ones they uploaded,
 * and provides those again.
 */
@Controller('v1/workspaces/:workspaceId/missing-files')
@UseGuards(AuthGuard, WorkspaceGuard)
export class MissingFilesController {
  constructor(
    @Inject(MissingFiles) private readonly missing: MissingFiles,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  list(@Ctx() ctx: RequestContext): Promise<MissingFilesResponse> {
    return this.missing.list(dbCtx(ctx), ctx.role!);
  }

  /**
   * The paper again, as one file: stored under the same id. Bytes that are another file's are a 409
   * `file.possible_duplicate` unless `?anyway=true`, the person's answer to that warning.
   */
  @Post(':fileId')
  @HttpCode(200)
  async provide(
    @Ctx() ctx: RequestContext,
    @Param('fileId') fileId: string,
    @Query() query: unknown,
    @Req() req: FastifyRequest,
  ): Promise<FileProvidedAgainDto> {
    requireRole(ctx, 'owner', 'admin', 'partner', 'accountant', 'member');
    const id = parse(z.uuid(), fileId);
    if (!req.isMultipart())
      throw new AppError(415, 'upload.multipart_required', 'Send the file as multipart/form-data');
    const part = await req.file({ limits: { fileSize: this.config.MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) throw new AppError(400, 'upload.no_file', 'No file in the request');
    const bytes = new Uint8Array(await part.toBuffer());
    if (part.file.truncated) {
      throw new AppError(
        413,
        'upload.too_large',
        `Files can be up to ${this.config.MAX_UPLOAD_BYTES / 1_048_576} MB`,
      );
    }
    if (bytes.length === 0) throw new AppError(400, 'upload.empty', 'The file is empty');
    const { anyway } = parse(AnywayQuery, query ?? {});
    return this.missing.provideAgain(dbCtx(ctx), ctx.role!, id, bytes, anyway);
  }
}
