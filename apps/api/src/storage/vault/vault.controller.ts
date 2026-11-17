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
  DisconnectVaultRequest,
  FileStorageStatesQuery,
  PasteVaultCodeRequest,
  ReplaceVaultKeyRequest,
  RetryVaultItemsRequest,
  SendExistingToVaultRequest,
  UpdateVaultConnectionRequest,
  VaultItemsQuery,
} from '@montra/schemas';
import { z } from 'zod';
import {
  AuthGuard,
  Ctx,
  dbCtx,
  requireRecentAuth,
  WorkspaceGuard,
  type RequestContext,
} from '../../auth/auth.js';
import { AppError } from '../../common/errors.js';
import { IdempotencyInterceptor } from '../../common/idempotency.interceptor.js';
import { parse } from '../../common/zod.js';
import { Plans } from '../../ops/plans.js';
import type { FakeVaultHandle } from './fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from './transport.js';
import { VaultService } from './vault.service.js';

/**
 * The household's Family Document Vault (ADR-0054 §2, §13). Connecting, replacing the key and disconnecting need an
 * owner with a recent sign-in (AUTH-09, D4); connecting needs the plan's `familyVault` feature.
 */
@Controller('v1/workspaces/:workspaceId/family-vault')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class VaultController {
  constructor(
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  @Get()
  async get(@Ctx() ctx: RequestContext) {
    return { connection: await this.vault.get(dbCtx(ctx), ctx.role!) };
  }

  /** §2 step 1: Montra makes the key pair. */
  @Post()
  async start(@Ctx() ctx: RequestContext) {
    requireRecentAuth(ctx);
    await this.plans.requireFeature(dbCtx(ctx), 'familyVault');
    return this.vault.start(dbCtx(ctx), ctx.role!);
  }

  /** §2 step 3: the code from the vault. Also ends a key change. */
  @Post('code')
  @HttpCode(200)
  async paste(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    await this.plans.requireFeature(dbCtx(ctx), 'familyVault');
    return this.vault.paste(dbCtx(ctx), ctx.role!, parse(PasteVaultCodeRequest, body));
  }

  /** "Check again": owners and admins (D4). */
  @Post('check')
  @HttpCode(200)
  check(@Ctx() ctx: RequestContext) {
    return this.vault.checkAgain(dbCtx(ctx), ctx.role!);
  }

  /** "Replace the key", or cancel a new key not yet confirmed. */
  @Post('key')
  @HttpCode(200)
  replaceKey(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    return this.vault.replaceKey(dbCtx(ctx), ctx.role!, parse(ReplaceVaultKeyRequest, body));
  }

  /**
   * "Send these to the vault" (§6): owners change anything; turning payslips or tax documents on needs a recent sign-in.
   * Admins may set those two back to not sent (D4).
   */
  @Patch()
  update(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.vault.update(dbCtx(ctx), ctx.role!, parse(UpdateVaultConnectionRequest, body), () =>
      requireRecentAuth(ctx),
    );
  }

  /** §12: how many existing documents would be sent, and how long that takes. */
  @Get('existing')
  existing(@Ctx() ctx: RequestContext) {
    return this.vault.existing(dbCtx(ctx), ctx.role!);
  }

  /** §12 "Send existing documents": owner only, with a recent sign-in. */
  @Post('existing')
  @HttpCode(200)
  async sendExisting(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    await this.plans.requireFeature(dbCtx(ctx), 'familyVault');
    return this.vault.sendExisting(dbCtx(ctx), ctx.role!, parse(SendExistingToVaultRequest, body));
  }

  /** "Try again" and "Send again" (§4.5, §12): owners and admins (D4). */
  @Post('retry')
  @HttpCode(200)
  retry(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.vault.retry(dbCtx(ctx), ctx.role!, parse(RetryVaultItemsRequest, body ?? {}));
  }

  @Get('items')
  items(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.vault.items(dbCtx(ctx), ctx.role!, parse(VaultItemsQuery, query));
  }

  /** The badges on files (§13): anyone who can see the files. */
  @Get('files')
  files(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.vault.fileStates(dbCtx(ctx), parse(FileStorageStatesQuery, query).ids);
  }

  @Delete()
  @HttpCode(204)
  async disconnect(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<void> {
    requireRecentAuth(ctx);
    await this.vault.disconnect(dbCtx(ctx), ctx.role!, parse(DisconnectVaultRequest, body ?? {}));
  }
}

const RegisterRequest = z
  .object({ publicKey: z.string().min(1).max(200), approved: z.boolean().default(true) })
  .strict();

/**
 * Only with `FAMILY_VAULT_FAKE=on` (never in production, `config.ts`): stands in for the vault's owner registering
 * Montra in the in-process fake vault, so the e2e run can connect a workspace end to end without any real vault.
 */
@Controller('v1/dev/fake-vault')
@UseGuards(AuthGuard)
export class FakeVaultController {
  constructor(@Inject(VAULT_TRANSPORT) private readonly transport: VaultTransport) {}

  @Post('apps')
  async register(@Body() body: unknown) {
    const fake = this.transport.fake as FakeVaultHandle | undefined;
    if (!fake) throw new AppError(404, 'not_found', 'Not found');
    const req = parse(RegisterRequest, body);
    const { code } = await fake.register(req.publicKey, { approved: req.approved });
    return { code };
  }
}
