import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ConnectStorageRequest,
  StorageConnection,
  StorageFolder,
  StorageItemsQuery,
  UpdateStorageRequest,
} from '@montra/schemas';
import { z } from 'zod';
import {
  AuthGuard,
  Ctx,
  dbCtx,
  requireRecentAuth,
  WorkspaceGuard,
  type RequestContext,
} from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { Plans } from '../ops/plans.js';
import { StorageDestinationsService } from './storage-destinations.service.js';

const TestRequest = z.object({ connection: StorageConnection, folder: StorageFolder.optional() });

/** The workspace's own storage (ADR-0031). `storage` itself is the usage meter (BAK-08), so this is `storage-destination`. */
@Controller('v1/workspaces/:workspaceId/storage-destination')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class StorageController {
  constructor(
    @Inject(StorageDestinationsService) private readonly storage: StorageDestinationsService,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  @Get()
  async get(@Ctx() ctx: RequestContext) {
    return { destination: await this.storage.get(dbCtx(ctx), ctx.role!) };
  }

  @Post('test')
  @HttpCode(200)
  test(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const req = parse(TestRequest, body);
    return this.storage.test(dbCtx(ctx), ctx.role!, req.connection, req.folder);
  }

  @Post()
  async connect(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    // AUTH-09: a copy of everything goes somewhere new.
    requireRecentAuth(ctx);
    await this.plans.requireFeature(dbCtx(ctx), 'ownStorage');
    return this.storage.connect(dbCtx(ctx), ctx.role!, parse(ConnectStorageRequest, body));
  }

  @Patch()
  update(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const req = parse(UpdateStorageRequest, body);
    if (req.connection || req.folder) requireRecentAuth(ctx);
    return this.storage.update(dbCtx(ctx), ctx.role!, req);
  }

  @Delete()
  @HttpCode(204)
  async disconnect(@Ctx() ctx: RequestContext): Promise<void> {
    requireRecentAuth(ctx);
    await this.storage.disconnect(dbCtx(ctx), ctx.role!);
  }

  @Post('backfill')
  @HttpCode(200)
  backfill(@Ctx() ctx: RequestContext) {
    return this.storage.backfill(dbCtx(ctx), ctx.role!);
  }

  @Post('retry')
  @HttpCode(200)
  retry(@Ctx() ctx: RequestContext) {
    return this.storage.retry(dbCtx(ctx), ctx.role!);
  }

  @Get('items')
  async items(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.storage.items(dbCtx(ctx), ctx.role!, parse(StorageItemsQuery, query)) };
  }
}
