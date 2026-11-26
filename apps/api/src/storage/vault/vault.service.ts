/**
 * Connecting the workspace to the household's Family Document Vault (ADR-0054 §2, §7, §8; VLT-01, VLT-08). Since vault
 * 0.9.0-dev.63 an owner generates an API key for Montra in the vault and pastes its connection string (and its secret,
 * when the string doesn't include it); Montra checks it: the string is the vault's, the address passes the guard, the
 * vault says which vault it is (pinned), and the connection test with the key (`GET /apps/me`) passes or says it waits
 * for someone there to approve. Replacing the key (an owner pastes the new one, checked before Montra switches) and
 * disconnecting are here too.
 *
 * Only an owner connects, replaces the key or disconnects, with a recent sign-in (the controller asks for it; D4).
 * Owners and admins see the connection and may ask Montra to check it again. The key's secret goes in sealed and never
 * comes back out: not in a DTO, an error, a log line, the security log, an archive or a backup.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import type { StorageDestinationTable, Trx, VaultConnectionStateTable } from '@montra/db';
import {
  isSentMode,
  VAULT_GROUP_DEFAULTS,
  VAULT_GROUP_KINDS,
  VAULT_GROUPS,
  VAULT_RESTRICTED_GROUPS,
  VaultGroup,
  VaultGroupMode,
  VaultKindDto,
  VaultStage,
  VaultCoverNumber,
  VaultUnkeptChoice,
  VAULT_RENDERED_GROUPS,
  vaultEffectiveModes,
  vaultUnkeptDefault,
  vaultUnkeptOffered,
  vaultFileKinds,
  vaultGroupModes,
  vaultGroupOf,
  vaultTypeKept,
  type ConnectVaultRequest,
  type DisconnectVaultRequest,
  type FileKind,
  type MoveToVaultRequest,
  type VaultBringBackDto,
  type VaultMoveDto,
  type FileStorageStatesResponse,
  type ReplaceVaultKeyRequest,
  type RetryVaultItemsRequest,
  type SendExistingToVaultRequest,
  type StorageFileKind,
  type UpdateVaultConnectionRequest,
  type VaultConnectionDto,
  type VaultExistingDto,
  type VaultItemDto,
  type VaultItemsQuery,
  VAULT_KEY_WARN_DAYS,
  VaultKeyProblem,
} from '@montra/schemas';
import { AppError } from '../../common/errors.js';
import { isAdmin } from '../../common/roles.js';
import { FieldCrypto } from '../../crypto/crypto.service.js';
import { Db } from '../../db/database.js';
import { defaultFolder } from '../destinations/paths.js';
import { VaultError, type VaultCheck } from '../destinations/vault.js';
import { SECRET_COLUMN } from '../storage-destinations.service.js';
import { markMissing, MISSING_WORDS, MissingFiles } from '../missing-files.js';
import { backoffMs } from '../backoff.js';
import { assertKeyShape, readConnectionString, VaultConnection } from './connection.js';
import { sealedKey, VaultSecret, type VaultKey } from './keys.js';
import { assertVaultAddress, VAULT_TRANSPORT, type VaultTransport } from './transport.js';
import { TYPE_NOT_KEPT_WORDS } from './vault.conversions.js';
import { auditReveal } from '../../crypto/sealed-numbers.js';

type Ctx = { workspaceId: string; userId: string };
type Row = Selectable<StorageDestinationTable>;
type StateRow = Selectable<VaultConnectionStateTable>;

/** The connection's label; the vault's household name is shown once the vault has said it. */
export const VAULT_LABEL = 'Family Document Vault';
/** Five failed checks in a row with no success turn the connection `failing`, as for a mirror (§12). */
export const VAULT_FAILING_AFTER = 5;
/** When the job (PR 3) should next look: daily once connected, sooner while waiting for approval (§2 step 4). */
const NEXT_CHECK_MS = { connected: 24 * 3600_000, waiting: 15 * 60_000 };

/** What isn't secret, as stored in `config` for an `fdv` row (§11). Parsed again whenever it is read. */
const VaultConfig = z.object({
  stage: VaultStage,
  /**
   * How Montra proves who it is to the vault: `key`, an API key an owner pasted (vault 0.9.0-dev.63 on); `signed`, the
   * Ed25519 key pair of a connection made before, which the vault no longer takes, so it needs a new key. A connection
   * saved before API keys has no `auth`, so it reads as `signed`.
   */
  auth: z.enum(['signed', 'key']).default('signed'),
  address: z.string().nullable().default(null),
  appId: z.string().nullable().default(null),
  /** The API key's client ID: it names the key, and isn't secret. The secret is sealed in `secret_enc`. */
  clientId: z.string().nullable().default(null),
  /** The key as the vault last described it (`GET /apps/me`): its permissions and when it expires. */
  key: z
    .object({
      clientId: z.string(),
      name: z.string().nullable(),
      permissions: z.array(z.string()),
      createdAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
    })
    .nullable()
    .default(null),
  /** The vault refused the key (revoked, expired, not valid): an owner must paste a new one. */
  keyProblem: VaultKeyProblem.nullable().default(null),
  /** §12: the key expiry owners were told of, once (`VAULT_KEY_WARN_DAYS` before). */
  keyWarnedFor: z.string().nullable().default(null),
  /** Whom Montra acts as in the vault (APP8): itself, or one person. */
  actsAs: z.enum(['app', 'person']).nullable().default(null),
  /** The vault's installation id, pinned when the code was accepted. */
  identity: z.string().nullable().default(null),
  /**
   * §10: the vault this connection was disconnected from, while connecting again: the same one (by its installation id)
   * resumes reading the files only it holds; another starts afresh.
   */
  previousIdentity: z.string().nullable().default(null),
  householdName: z.string().nullable().default(null),
  actingAs: z.string().nullable().default(null),
  sendKinds: z.array(VaultKindDto).default([]),
  mediaTypes: z.array(z.string()).default([]),
  mayReadBack: z.boolean().default(false),
  mayDelete: z.boolean().default(false),
  /** §9: the vault lets Montra read its changes feed, and make links for a person to open a document. */
  mayRead: z.boolean().default(false),
  mayOpen: z.boolean().default(false),
  groups: z
    .array(
      z.object({
        group: VaultGroup,
        mode: VaultGroupMode,
        vaultKind: z.string().nullable(),
        /** ADR-0057 §1: "Files the vault doesn't keep"; absent means the group's default (`vaultUnkeptDefault`). */
        unkept: VaultUnkeptChoice.optional(),
      }),
    )
    .default([]),
  describeMore: z.boolean().default(false),
  /** ADR-0057 §3: the account number on a rendered PDF's cover, with `describeMore` on. The setting, never a number. */
  coverNumber: VaultCoverNumber.default('last4'),
  /** The hints the vault takes (§3); null until a check has said, so the job checks first. */
  hints: z.array(z.string()).nullable().default(null),
  /** The vault's sending limits as of the last check (§12). */
  limits: z
    .object({ filesPerDay: z.number().int(), filesToday: z.number().int(), maxUploadBytes: z.number() })
    .nullable()
    .default(null),
});
export type VaultConfig = z.infer<typeof VaultConfig>;

const ownerOnly = () =>
  new AppError(
    403,
    'vault.owner_only',
    'Only an owner can connect, change or disconnect the Family Document Vault',
  );
const ownersAndAdmins = () =>
  new AppError(
    403,
    'vault.not_allowed',
    'Only an owner or admin can see the Family Document Vault connection',
  );
const notConnected = () => new AppError(404, 'not_found', 'The Family Document Vault isn’t connected');
const conflict = () =>
  new AppError(
    409,
    'version.conflict',
    'The vault connection was changed by someone else; reload and try again',
  );
/** A `VaultError` as an answer to the person who asked: its words, never its detail. */
const refusal = (e: VaultError) => new AppError(422, `vault.${e.code}`, e.shown);
const DAY_MS = 24 * 3600_000;

/** What was pasted, once read: where the vault is, which vault it says it is, and the key. */
interface Pasted {
  address: string;
  identity: string | null;
  key: VaultKey;
}

/**
 * A connection string, and the secret when the string doesn't include it, read and checked for shape. Nothing goes on
 * the network, and nothing pasted is ever in what this throws: only Montra's words.
 */
function readPasted(connectionString: string, secret: string | undefined): Pasted {
  try {
    const c = readConnectionString(connectionString);
    const s = secret ?? c.secret;
    if (!s) throw new VaultError('secret_needed');
    assertKeyShape(c.clientId, s);
    assertVaultAddress(c.address);
    return {
      address: new URL(c.address).origin,
      identity: c.identity,
      key: { clientId: c.clientId, secret: s },
    };
  } catch (e) {
    throw refusal(e instanceof VaultError ? e : new VaultError('invalid_code'));
  }
}

@Injectable()
export class VaultService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(VAULT_TRANSPORT) private readonly transport: VaultTransport,
    @Inject(MissingFiles) private readonly missing: MissingFiles,
  ) {}

  // ----- Reading ---------------------------------------------------------------------------------------------------

  async get(ctx: Ctx, role: string): Promise<VaultConnectionDto | null> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      return row ? this.dto(trx, row) : null;
    });
  }

  // ----- Connecting (§2) ---------------------------------------------------------------------------------------------

  /**
   * §2 (API keys, vault 0.9.0-dev.63): an owner connects with the connection string the vault showed when it generated
   * an API key for Montra, and the key's secret when the string doesn't include it. Checked in order: the string and the
   * key's shape, the address guard, that the server there is a vault that takes apps (its installation id is pinned),
   * and the connection test with the key (`GET /apps/me`), which says whether Montra is on yet. Nothing is saved unless
   * all of that holds, and the secret is sealed at once.
   *
   * With no connection, one is made. A kept one is connected again with its `version`: one disconnected while files
   * were kept only in the vault (§10), or one begun before API keys that never got its code. A working connection takes
   * a new key through "Replace the key", as does one made before API keys.
   */
  async connect(ctx: Ctx, role: string, req: ConnectVaultRequest): Promise<VaultConnectionDto> {
    if (role !== 'owner') throw ownerOnly();
    const existing = await this.db.run(ctx, (trx) => this.row(trx, ctx));
    if (existing) {
      const kept = existing.status === 'disconnected' || configOf(existing).stage === 'register';
      if (!kept) {
        throw new AppError(
          409,
          'vault.exists',
          'This workspace is already connected to a Family Document Vault. To use a new key, replace the key.',
        );
      }
      if (req.version === undefined || BigInt(existing.version) !== BigInt(req.version)) throw conflict();
    }
    const given = readPasted(req.connectionString, req.secret);
    const check = await this.tryCheck(given.address, given.key, null);
    if (check instanceof VaultError) throw refusal(check);
    if (given.identity !== null && given.identity !== check.identity) {
      throw refusal(new VaultError('identity_changed', { detail: 'code' }));
    }
    return existing ? this.connectAgain(ctx, existing, given, check) : this.connectNew(ctx, given, check);
  }

  private async connectNew(ctx: Ctx, given: Pasted, check: VaultCheck): Promise<VaultConnectionDto> {
    return this.db.run(ctx, async (trx) => {
      const config: VaultConfig = VaultConfig.parse({
        ...this.reported(check),
        stage: check.approved ? 'connected' : 'approval',
        auth: 'key',
        address: given.address,
        appId: check.appId,
        clientId: given.key.clientId,
        identity: check.identity,
        groups: VAULT_GROUPS.map((group) => ({ group, mode: VAULT_GROUP_DEFAULTS[group], vaultKind: null })),
      });
      const ws = await trx
        .selectFrom('app.workspace')
        .select('name')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const now = new Date();
      const row = await trx
        .insertInto('app.storage_destination')
        .values({
          workspace_id: ctx.workspaceId,
          kind: 'fdv',
          label: VAULT_LABEL,
          config: JSON.stringify(config),
          secret_enc: (await this.seal(trx, ctx, given.key))!,
          secret_hint: null,
          // Unused for a vault (backups never go there), but the column is NOT NULL (ADR-0054, As built: PR 1).
          folder: defaultFolder(ws.name),
          // Nothing is sent until the vault has approved Montra and the owner has mapped a group (§3).
          ...sendingColumns(config),
          can_delete: check.mayDelete,
          status: check.approved ? 'active' : 'needs_vault',
          ...(check.approved ? { last_success_at: now } : {}),
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.vault_connection_state')
        .values({ workspace_id: ctx.workspaceId, destination_id: row.id })
        .execute();
      await this.saveState(trx, ctx, row.id, check);
      if (check.approved) await scheduleVault(trx);
      await this.security(trx, ctx, 'vault_connected', {
        host: new URL(given.address).host,
        householdName: check.householdName,
        approved: check.approved,
        clientId: given.key.clientId,
        actsAs: check.actsAs,
      });
      return this.dto(trx, row);
    });
  }

  /**
   * §10: a kept connection connected again, keeping its groups and outbox. When it was disconnected from a vault (by
   * its installation id), the same vault resumes reading what only it holds; another vault's documents aren't Montra's
   * to read there, so the old references go and those files stay missing.
   */
  private async connectAgain(
    ctx: Ctx,
    row: Row,
    given: Pasted,
    check: VaultCheck,
  ): Promise<VaultConnectionDto> {
    const before = configOf(row);
    const previous = before.previousIdentity ?? (row.status === 'disconnected' ? before.identity : null);
    return this.db.run(ctx, async (trx) => {
      const now = new Date();
      const next: VaultConfig = VaultConfig.parse({
        ...this.reported(check),
        stage: check.approved ? 'connected' : 'approval',
        auth: 'key',
        address: given.address,
        appId: check.appId,
        clientId: given.key.clientId,
        identity: check.identity,
        previousIdentity: null,
        groups: before.groups,
        describeMore: before.describeMore,
      });
      const saved = await trx
        .updateTable('app.storage_destination')
        .set({
          config: JSON.stringify(next),
          ...sendingColumns(next),
          secret_enc: (await this.seal(trx, ctx, given.key))!,
          can_delete: check.mayDelete,
          status: check.approved ? 'active' : 'needs_vault',
          consecutive_failures: 0,
          last_error: null,
          last_error_at: null,
          ...(check.approved ? { last_success_at: now } : {}),
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .returningAll()
        .executeTakeFirst();
      if (!saved) throw conflict();
      await this.saveState(trx, ctx, row.id, check, { keyRotation: 'none' });
      const reconnected = previous !== null;
      const sameVault = reconnected && previous === check.identity;
      if (reconnected) await this.resume(trx, ctx, row.id, sameVault);
      if (check.approved) await scheduleVault(trx);
      await this.security(trx, ctx, 'vault_connected', {
        host: new URL(given.address).host,
        householdName: check.householdName,
        approved: check.approved,
        clientId: given.key.clientId,
        actsAs: check.actsAs,
        ...(reconnected ? { reconnected: true, sameVault } : {}),
      });
      return this.dto(trx, saved);
    });
  }

  /**
   * "Check again" (§2 step 4, §12.1): the connection test, now. Approved: connected. Still waiting: as it was. A key the
   * vault refuses, a problem with the connection itself, or a different vault at the address, stops it (`needs_vault`)
   * with the words to show; anything else is a failed check, and five in a row turn it `failing`.
   */
  async checkAgain(ctx: Ctx, role: string): Promise<VaultConnectionDto> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    const row = await this.db.run(ctx, (trx) => this.row(trx, ctx));
    if (!row) throw notConnected();
    assertConnected(row);
    const config = configOf(row);
    if (config.stage === 'register' || !config.address) {
      throw new AppError(409, 'vault.no_code', 'Connect the vault with an API key first');
    }
    const done = await this.checkRow(ctx, row);
    // "Check again" also wakes sending, now that the connection may work again.
    if (!(done.check instanceof VaultError) && done.check.approved) {
      await this.db.run(ctx, (trx) => scheduleVault(trx));
    }
    return this.db.run(ctx, (trx) => this.dto(trx, done.row));
  }

  /**
   * The connection test for a saved connection, and what it changes (§12.1): for "Check again" and the job. `stopped`
   * says this check stopped a connection that wasn't stopped before, and `turnedFailing` that it made it `failing`, so
   * the job tells owners once. A check refreshes the status and what the vault reports (the key's permissions and
   * expiry, whom Montra acts as), not the owner's settings, so the version stays: someone changing the settings while a
   * check runs isn't sent back to reload.
   *
   * A connection made before API keys is never sent to the vault: it stops at once, as needing a new key.
   */
  async checkRow(
    ctx: Ctx,
    row: Row,
  ): Promise<{ row: Row; check: VaultCheck | VaultError; stopped: boolean; turnedFailing: boolean }> {
    const before = configOf(row);
    let check: VaultCheck | VaultError;
    if (before.auth !== 'key') {
      check = new VaultError('key_signed');
    } else if (!before.address || !before.clientId) {
      return {
        row,
        check: new VaultError('failed', { detail: 'no key' }),
        stopped: false,
        turnedFailing: false,
      };
    } else {
      check = await this.tryCheck(before.address, await this.unseal(ctx, row), before.identity);
    }
    return this.db.run(ctx, async (trx) => {
      const cur =
        (await trx
          .selectFrom('app.storage_destination')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', row.id)
          .forUpdate()
          .executeTakeFirst()) ?? row;
      const config = configOf(cur);
      const now = new Date();
      const set: Record<string, unknown> = { updated_at: now };
      let stopped = false;
      let turnedFailing = false;
      let nextCheck: Date | null = null;
      if (check instanceof VaultError) {
        set.last_error = check.shown;
        set.last_error_at = now;
        if (check.stopsConnection) {
          if (cur.status !== 'paused') set.status = 'needs_vault';
          stopped = cur.status !== 'paused' && cur.status !== 'needs_vault';
          // Nothing changes for a refused key until an owner pastes a new one: looked at daily, not every 15 minutes.
          nextCheck = new Date(
            now.getTime() + (check.keyProblem ? NEXT_CHECK_MS.connected : NEXT_CHECK_MS.waiting),
          );
          if (check.keyProblem) {
            set.config = JSON.stringify({ ...config, keyProblem: check.keyProblem } satisfies VaultConfig);
          }
        } else if (check.countsAsFailure) {
          const failures = cur.consecutive_failures + 1;
          set.consecutive_failures = failures;
          if (failures >= VAULT_FAILING_AFTER && cur.status === 'active') {
            set.status = 'failing';
            turnedFailing = true;
          }
          nextCheck = new Date(now.getTime() + backoffMs(failures));
        } else {
          nextCheck = new Date(now.getTime() + NEXT_CHECK_MS.waiting);
        }
      } else {
        const next: VaultConfig = {
          ...config,
          ...this.reported(check),
          keyProblem: null,
          stage: check.approved ? 'connected' : 'approval',
        };
        set.config = JSON.stringify(next);
        Object.assign(set, sendingColumns(next));
        set.can_delete = check.mayDelete;
        set.last_error = null;
        set.last_error_at = null;
        set.consecutive_failures = 0;
        if (check.approved) set.last_success_at = now;
        if (cur.status !== 'paused') set.status = check.approved ? 'active' : 'needs_vault';
      }
      const saved = await trx
        .updateTable('app.storage_destination')
        .set(set as never)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (!(check instanceof VaultError)) await this.saveState(trx, ctx, row.id, check);
      else if (nextCheck) {
        await trx
          .updateTable('app.vault_connection_state')
          .set({ next_check_at: nextCheck, updated_at: now })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', row.id)
          .execute();
      }
      return { row: saved, check, stopped, turnedFailing };
    });
  }

  /**
   * "Replace the key" (§2), owner-driven: the owner generates a new API key for Montra in the vault and pastes it, as its
   * connection string or its client ID, with its secret unless the string includes it. Montra checks it with the vault
   * (`GET /apps/me`: the same app, at the same vault, by its installation id) and only then switches: the new key is
   * sealed in place of the old one, which goes on working until then. The old key is the owner's to revoke in the
   * vault; Montra can't. Also how a connection made before API keys, or one whose key was revoked or expired, gets a
   * key that works.
   */
  async replaceKey(ctx: Ctx, role: string, req: ReplaceVaultKeyRequest): Promise<VaultConnectionDto> {
    if (role !== 'owner') throw ownerOnly();
    const row = await this.db.run(ctx, (trx) => this.row(trx, ctx));
    if (!row) throw notConnected();
    if (BigInt(row.version) !== BigInt(req.version)) throw conflict();
    assertConnected(row);
    const config = configOf(row);
    if (config.stage === 'register' || !config.address) {
      throw new AppError(409, 'vault.no_code', 'Connect the vault with an API key first');
    }
    let given: Pasted;
    if (req.connectionString) {
      given = readPasted(req.connectionString, req.secret);
    } else {
      if (!req.secret) throw new AppError(422, 'vault.secret_needed', 'Paste the new key’s secret too.');
      try {
        assertKeyShape(req.clientId!, req.secret);
      } catch (e) {
        throw refusal(e as VaultError);
      }
      given = {
        address: config.address,
        identity: null,
        key: { clientId: req.clientId!, secret: req.secret },
      };
    }
    if (config.auth === 'key' && given.key.clientId === config.clientId) {
      throw new AppError(
        422,
        'vault.same_key',
        'That’s the key Montra already uses. Generate a new key for Montra in the vault, and paste that.',
      );
    }
    // The same vault: a different one at the address, or named in the string, is refused before the key is used.
    const check = await this.tryCheck(given.address, given.key, config.identity);
    if (check instanceof VaultError) throw refusal(check);
    if (given.identity !== null && given.identity !== check.identity) {
      throw refusal(new VaultError('identity_changed', { detail: 'code' }));
    }
    // The same app: another app's documents aren't the ones Montra sent.
    if (config.appId !== null && check.appId !== config.appId) throw refusal(new VaultError('other_app'));

    return this.db.run(ctx, async (trx) => {
      const now = new Date();
      const next: VaultConfig = {
        ...config,
        ...this.reported(check),
        stage: check.approved ? 'connected' : 'approval',
        auth: 'key',
        address: given.address,
        appId: check.appId,
        clientId: given.key.clientId,
        keyProblem: null,
        keyWarnedFor: null,
      };
      const saved = await trx
        .updateTable('app.storage_destination')
        .set({
          config: JSON.stringify(next),
          ...sendingColumns(next),
          secret_enc: (await this.seal(trx, ctx, given.key))!,
          can_delete: check.mayDelete,
          status: check.approved ? (row.status === 'paused' ? 'paused' : 'active') : 'needs_vault',
          consecutive_failures: 0,
          last_error: null,
          last_error_at: null,
          ...(check.approved ? { last_success_at: now } : {}),
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .returningAll()
        .executeTakeFirst();
      if (!saved) throw conflict();
      await this.saveState(trx, ctx, row.id, check, { keyRotation: 'none' });
      if (check.approved) await scheduleVault(trx);
      await this.security(trx, ctx, 'vault_key_replaced', {
        clientId: given.key.clientId,
        previousClientId: config.clientId,
        ...(config.auth !== 'key' ? { fromSigned: true } : {}),
        ...(config.keyProblem ? { previousKeyProblem: config.keyProblem } : {}),
      });
      return this.dto(trx, saved);
    });
  }

  /**
   * Disconnecting (§7, §10). With no file held only in the vault, the connection goes with its key, state and outbox;
   * connecting again makes a new key. The app stays registered in the vault until someone there removes it; Settings
   * says so.
   *
   * With files held only in the vault the owner chooses, and a disconnect that doesn't say is refused with their count
   * (409 `vault.files_only_in_vault`) so the choice can be shown:
   *
   * - `bringBack`: every such file is copied back into Montra first, one at a time (`startBringBack`), and the
   *   connection is disconnected once they are back;
   * - `anyway`: a soft disconnect now. The connection stays, `disconnected`, with its outbox (the references Montra
   *   reads those files back through): nothing is sent, the key is wiped, and the files become missing with that
   *   reason, in "Files to provide again". Connecting the same vault again resumes reading them.
   *
   * A connection already disconnected with such files left stays as it is: removing it would lose those references, so
   * that is refused until each is provided again or deleted. One being connected again, stopped before its code, goes
   * back to disconnected.
   */
  async disconnect(ctx: Ctx, role: string, req: DisconnectVaultRequest): Promise<void> {
    if (role !== 'owner') throw ownerOnly();
    const missing = await this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) return [];
      const config = configOf(row);
      const only = await onlyInVault(trx, ctx.workspaceId);
      if (only === 0) {
        await this.remove(trx, ctx, row);
        return [];
      }
      if (row.status === 'disconnected') throw filesOnlyInVault(only, true);
      if (config.stage === 'register' && config.previousIdentity !== null) {
        return this.softDisconnect(trx, ctx, row, { cancelledReconnect: true });
      }
      if (req.bringBack) {
        await this.startBringBack(trx, ctx, row, 'disconnect');
        return [];
      }
      if (!req.anyway) throw filesOnlyInVault(only, false);
      return this.softDisconnect(trx, ctx, row, { anyway: true });
    });
    await this.missing.tell(ctx, missing);
  }

  /**
   * §10 "Bring the files back", staying connected: every file held only in the vault is copied back into Montra's
   * storage by the job, one at a time, over days when the vault's daily read cap needs it, and every group sent with no
   * local copy becomes "sent, keep a local copy", so nothing is removed again. Owner only, with a recent sign-in.
   */
  async bringBack(ctx: Ctx, role: string): Promise<VaultBringBackDto> {
    if (role !== 'owner') throw ownerOnly();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      assertConnected(row);
      if (configOf(row).stage !== 'connected') {
        throw new AppError(409, 'vault.not_connected', 'The vault hasn’t approved Montra yet');
      }
      return this.startBringBack(trx, ctx, row, 'keep');
    });
  }

  /**
   * The job's end of "Bring the files back" (§10), once no file held only in the vault is left to fetch (each is back
   * in Montra, or missing because the vault didn't give it back): the hold is cleared and, when the owner chose to
   * disconnect, the connection is disconnected: removed when nothing is held only in the vault any more, else kept as
   * `disconnected` for the files still missing.
   */
  async finishBringBack(actor: Ctx, destinationId: string): Promise<void> {
    const missing = await this.db.run(actor, async (trx) => {
      const state = await trx
        .selectFrom('app.vault_connection_state')
        .select(['bring_back_then', 'bring_back_by'])
        .where('workspace_id', '=', actor.workspaceId)
        .where('destination_id', '=', destinationId)
        .forUpdate()
        .executeTakeFirst();
      if (!state?.bring_back_then) return [];
      await trx
        .updateTable('app.vault_connection_state')
        .set({ bring_back_at: null, bring_back_then: null, bring_back_by: null, updated_at: new Date() })
        .where('workspace_id', '=', actor.workspaceId)
        .where('destination_id', '=', destinationId)
        .execute();
      const who = { workspaceId: actor.workspaceId, userId: state.bring_back_by ?? actor.userId };
      const only = await onlyInVault(trx, actor.workspaceId);
      if (state.bring_back_then !== 'disconnect') {
        await this.security(trx, who, 'vault_changed', { broughtBack: true, stillOnlyInVault: only });
        return [];
      }
      const row = await this.row(trx, actor);
      if (!row || row.id !== destinationId) return [];
      if (only === 0) {
        await this.remove(trx, who, row, { afterBringBack: true });
        return [];
      }
      return this.softDisconnect(trx, who, row, { afterBringBack: true });
    });
    await this.missing.tell(actor, missing);
  }

  // ----- Moving existing documents (§5, §12) --------------------------------------------------------------------------

  /**
   * "Move existing documents" (§12): files of the groups sent with no local copy (`groups` narrows it) that the vault
   * filed while their group still kept a copy, and that Montra still holds. Moving them removes Montra's copy of each
   * under §5's conditions, as the job checks them one file at a time; nothing moves until the owner confirms the count.
   */
  async moveCount(ctx: Ctx, role: string, groups?: readonly VaultGroup[]): Promise<VaultMoveDto> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      return moveOf(await this.movable(trx, ctx, row, groups));
    });
  }

  /** "Move these N files too?" (§5): confirmed, each counted file is looked at by the job. Owner, recent sign-in. */
  async move(ctx: Ctx, role: string, req: MoveToVaultRequest): Promise<VaultMoveDto> {
    if (role !== 'owner') throw ownerOnly();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      assertConnected(row);
      if (configOf(row).stage !== 'connected') {
        throw new AppError(409, 'vault.not_connected', 'The vault hasn’t approved Montra yet');
      }
      const files = await this.movable(trx, ctx, row, req.groups);
      if (files.length !== req.expected) {
        throw new AppError(
          409,
          'vault.count_changed',
          'The number of documents to move has changed. Look at it again, then move.',
        );
      }
      if (files.length) {
        // The job's removal step (§5) takes them from here, one file per transaction, each condition checked again.
        await trx
          .updateTable('app.vault_item')
          .set({ remove_at: sql`now()`, updated_at: new Date() })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', row.id)
          .where(
            'file_id',
            'in',
            files.map((f) => f.id),
          )
          .execute();
        await this.security(trx, ctx, 'vault_move_started', {
          count: files.length,
          groups: moveOf(files).groups,
          keepCopy: false,
          alreadyFiled: true,
        });
        await scheduleVault(trx);
      }
      return moveOf(await this.movable(trx, ctx, row, req.groups));
    });
  }

  // ----- Sending (§3, §6, §12, §13) ---------------------------------------------------------------------------------

  /**
   * "Send these to the vault" (§6): each group's mode and vault kind, describing documents in more detail, deleting
   * with Montra, and pausing. An owner changes anything; turning payslips or tax documents on needs a recent sign-in,
   * and the web shows the warning first. An admin may set those two back to not sent, and nothing else (D4). Choosing
   * "sent, no local copy" needs a recent sign-in too: from then on, Montra removes its copy of each of the group's files
   * the vault files (§5); files the vault had already filed keep their copy until a move. A group no longer sent keeps
   * nothing waiting: what hasn't reached the vault stays in Montra only; what has stays there.
   *
   * ADR-0057 (VLT-12), owner only: each group's "Files the vault doesn't keep" (only statements can be converted), and
   * "Account number on the cover", where Full needs a recent sign-in and is in the security log. A change to either, or
   * to the detail switch, has the job look at every converted file again: PDFs not sent yet are made again; ones the
   * vault has stay as they are.
   */
  async update(
    ctx: Ctx,
    role: string,
    req: UpdateVaultConnectionRequest,
    assertRecent: () => void,
  ): Promise<VaultConnectionDto> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    const owner = role === 'owner';
    if (
      !owner &&
      (req.describeMore !== undefined ||
        req.deleteWithMontra !== undefined ||
        req.paused !== undefined ||
        req.coverNumber !== undefined)
    ) {
      throw ownerOnly();
    }
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      if (BigInt(row.version) !== BigInt(req.version)) throw conflict();
      assertConnected(row);
      const config = configOf(row);
      if (config.stage === 'register')
        throw new AppError(409, 'vault.no_code', 'Paste the code from the vault first');
      const bringing = (await this.bringBackState(trx, ctx, row.id)) !== null;
      const modes = modesOf(config);
      const groups = VAULT_GROUPS.map((group) => ({
        group,
        mode: modes[group],
        vaultKind: config.groups.find((g) => g.group === group)?.vaultKind ?? null,
        unkept: unkeptOf(config, group),
      }));
      const changed: {
        group: VaultGroup;
        mode: VaultGroupMode;
        vaultKind: string | null;
        unkept: VaultUnkeptChoice;
      }[] = [];
      const restricted: { group: VaultGroup; sent: boolean }[] = [];
      for (const g of req.groups ?? []) {
        const cur = groups.find((x) => x.group === g.group)!;
        const mode = g.mode ?? cur.mode;
        const vaultKind = g.vaultKind === undefined ? cur.vaultKind : g.vaultKind;
        const unkept = g.unkept ?? cur.unkept;
        if (unkept !== cur.unkept) {
          // ADR-0057 §1: an owner's choice, and only where Montra has a renderer.
          if (!owner) throw ownerOnly();
          if (!vaultUnkeptOffered(g.group).includes(unkept)) {
            throw new AppError(
              422,
              'vault.unkept_not_offered',
              'Montra can convert only statements to PDF. Other files the vault doesn’t keep stay in Montra.',
            );
          }
        }
        if (
          vaultKind !== null &&
          vaultKind !== cur.vaultKind &&
          !config.sendKinds.some((k) => k.key === vaultKind)
        ) {
          throw new AppError(
            422,
            'vault.kind_not_allowed',
            'The vault doesn’t let Montra send that kind of document',
          );
        }
        const isRestricted = VAULT_RESTRICTED_GROUPS.includes(g.group);
        if (!owner && !(isRestricted && mode === 'not_sent' && vaultKind === cur.vaultKind))
          throw ownerOnly();
        if (isRestricted && isSentMode(mode) && !isSentMode(cur.mode)) assertRecent();
        // §5: Montra will remove its copies of this group's files once the vault files them: a recent sign-in, as a move.
        if (mode === 'sent_no_copy' && cur.mode !== 'sent_no_copy') {
          // §10: not while the files are being brought back, which undoes it.
          if (bringing) {
            throw new AppError(
              409,
              'vault.bringing_back',
              'Montra is bringing the files back from the vault. Choose this again once they are back.',
            );
          }
          assertRecent();
        }
        if (isRestricted && isSentMode(mode) !== isSentMode(cur.mode)) {
          restricted.push({ group: g.group, sent: isSentMode(mode) });
        }
        if (mode !== cur.mode || vaultKind !== cur.vaultKind || unkept !== cur.unkept)
          changed.push({ group: g.group, mode, vaultKind, unkept });
        cur.mode = mode;
        cur.vaultKind = vaultKind;
        cur.unkept = unkept;
      }
      // ADR-0057 §3: the full account number on a cover goes to the vault, where the vault decides who sees it.
      const coverNumber = req.coverNumber ?? config.coverNumber;
      if (coverNumber === 'full' && config.coverNumber !== 'full') assertRecent();
      const next: VaultConfig = {
        ...config,
        groups,
        describeMore: req.describeMore ?? config.describeMore,
        coverNumber,
      };
      const status =
        req.paused === undefined
          ? row.status
          : req.paused
            ? 'paused'
            : row.status === 'paused'
              ? 'active'
              : row.status;
      const now = new Date();
      const saved = await trx
        .updateTable('app.storage_destination')
        .set({
          config: JSON.stringify(next),
          ...sendingColumns(next),
          delete_with_montra: req.deleteWithMontra ?? row.delete_with_montra,
          status,
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .returningAll()
        .executeTakeFirst();
      if (!saved) throw conflict();

      const before = vaultEffectiveModes(config.groups);
      const after = vaultEffectiveModes(groups);
      const stoppedKinds = VAULT_GROUPS.filter((g) => isSentMode(before[g]) && !isSentMode(after[g])).flatMap(
        (g) => VAULT_GROUP_KINDS[g],
      );
      if (stoppedKinds.length) {
        await trx
          .deleteFrom('app.vault_item')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', row.id)
          .where('status', 'in', ['queued', 'pending', 'failed'])
          .where('file_id', 'in', (eb) =>
            eb
              .selectFrom('app.file')
              .select('id')
              .where('workspace_id', '=', ctx.workspaceId)
              .where('kind', 'in', stoppedKinds),
          )
          .execute();
      }
      await this.conversionsChanged(trx, ctx, row.id, config, next);
      // Unpaused: look at the connection again before sending, whatever it was before the pause.
      if (row.status === 'paused' && status !== 'paused') {
        await trx
          .updateTable('app.vault_connection_state')
          .set({ next_check_at: sql`now()`, updated_at: now })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', row.id)
          .execute();
      }
      const detail: Record<string, unknown> = {};
      if (changed.length) detail.groups = changed;
      if (restricted.length) detail.restricted = restricted;
      if (req.describeMore !== undefined && req.describeMore !== config.describeMore) {
        detail.describeMore = req.describeMore;
      }
      if (req.deleteWithMontra !== undefined && req.deleteWithMontra !== row.delete_with_montra) {
        detail.deleteWithMontra = req.deleteWithMontra;
      }
      // The choice only, never a number.
      if (coverNumber !== config.coverNumber) detail.coverNumber = coverNumber;
      if (status !== row.status && (status === 'paused' || row.status === 'paused')) {
        detail.paused = status === 'paused';
      }
      if (Object.keys(detail).length) await this.security(trx, ctx, 'vault_changed', detail);
      // ADR-0057 §3, ACC-16: choosing to put full account numbers on covers is audited as a reveal is (never a number).
      if (coverNumber === 'full' && config.coverNumber !== 'full') {
        await auditReveal(trx, ctx, 'vault.cover_number_full', { type: 'storage_destination', id: row.id });
      }
      if (status !== 'paused') await scheduleVault(trx);
      return this.dto(trx, saved);
    });
  }

  /** §12: how many files of the groups being sent are in Montra and not yet sent, and how long they take. */
  async existing(ctx: Ctx, role: string): Promise<VaultExistingDto> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      return existingOf(await this.unsent(trx, ctx, row), configOf(row));
    });
  }

  /**
   * "Send existing documents" (§12): queues every file of the groups being sent that isn't in the outbox yet, oldest
   * first; the job sends them one at a time. `expected` is the count the person was shown, so a different number is
   * refused rather than surprising them. Owner only, with a recent sign-in (the controller asks).
   */
  async sendExisting(ctx: Ctx, role: string, req: SendExistingToVaultRequest): Promise<VaultExistingDto> {
    if (role !== 'owner') throw ownerOnly();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      assertConnected(row);
      const config = configOf(row);
      if (config.stage !== 'connected') {
        throw new AppError(409, 'vault.not_connected', 'The vault hasn’t approved Montra yet');
      }
      const files = await this.unsent(trx, ctx, row);
      if (files.length !== req.expected) {
        throw new AppError(
          409,
          'vault.count_changed',
          'The number of documents to send has changed. Look at it again, then send.',
        );
      }
      const shown = existingOf(files, config);
      if (files.length) {
        // One row per file, in the order the files came into Montra, so the oldest go first.
        await sql`
          insert into app.vault_item (workspace_id, destination_id, file_id, created_at)
          select ${ctx.workspaceId}::uuid, ${row.id}::uuid, x.id, clock_timestamp()
            from unnest(${files.map((f) => f.id)}::uuid[]) with ordinality as x(id, n)
           order by x.n
          on conflict do nothing`.execute(trx);
        const modes = vaultEffectiveModes(config.groups);
        await this.security(trx, ctx, 'vault_move_started', {
          count: files.length,
          groups: shown.groups,
          // §12: for a group sent with no local copy it is a move (§5 removes each copy once filed).
          keepCopy: !shown.groups.some((g) => modes[g.group] === 'sent_no_copy'),
        });
        await scheduleVault(trx);
      }
      return existingOf(await this.unsent(trx, ctx, row), config);
    });
  }

  /**
   * "Try again" (§12, D4: owners and admins): failed files go back in line under the id they had, so a file that did
   * reach the vault isn't sent twice. "Send again" (§4.5): a file the vault didn't keep, when a resend is allowed,
   * starts over as a new send with a new id, because the vault's answer about the old one won't change.
   */
  async retry(ctx: Ctx, role: string, req: RetryVaultItemsRequest): Promise<{ retried: number }> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      assertConnected(row);
      const now = new Date();
      let q = trx
        .updateTable('app.vault_item')
        // A row with an id may have reached the vault: one attempt counted, so the job asks before sending again.
        .set({
          status: 'pending',
          attempts: sql`case when vault_ref is null then 0 else 1 end`,
          next_attempt_at: sql`now()`,
          last_error: null,
          updated_at: now,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', row.id)
        .where('status', '=', 'failed');
      if (req.fileIds) q = q.where('file_id', 'in', req.fileIds);
      let retried = Number((await q.executeTakeFirst()).numUpdatedRows);
      if (req.fileIds) {
        const again = await trx
          .deleteFrom('app.vault_item')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', row.id)
          .where('status', '=', 'not_kept')
          .where('resend_allowed', '=', true)
          .where('file_id', 'in', req.fileIds)
          .returning('file_id')
          .execute();
        if (again.length) {
          await trx
            .insertInto('app.vault_item')
            .values(
              again.map((a) => ({
                workspace_id: ctx.workspaceId,
                destination_id: row.id,
                file_id: a.file_id,
              })),
            )
            .execute();
          retried += again.length;
        }
        retried += await this.sendConvertedAgain(trx, ctx, row.id, req.fileIds);
      }
      if (retried) await scheduleVault(trx);
      return { retried };
    });
  }

  /**
   * ADR-0057 §4 "Send again" for a file the vault doesn't keep: the vault has its PDFs, so they are not made again on
   * their own. Asked, the ones it has are set aside (`superseded_at`: they stay in the vault, and in Montra with their
   * original), and the job makes new ones with today's settings, sent as new documents. Answers how many files.
   */
  private async sendConvertedAgain(
    trx: Trx,
    ctx: Ctx,
    destinationId: string,
    fileIds: readonly string[],
  ): Promise<number> {
    const { rows } = await sql<{ file_id: string }>`
      select i.file_id from app.vault_item i
       where i.workspace_id = ${ctx.workspaceId}::uuid and i.destination_id = ${destinationId}::uuid
         and i.status = 'converted' and i.render_state = 'rendered' and i.file_id = any (${[...fileIds]}::uuid[])
         and exists (select 1 from app.file r
                       join app.vault_item ri on ri.workspace_id = r.workspace_id and ri.file_id = r.id
                                             and ri.destination_id = i.destination_id
                      where r.workspace_id = i.workspace_id and r.derived_from_file_id = i.file_id
                        and r.rendition is not null and r.superseded_at is null and ri.status <> 'queued')`.execute(
      trx,
    );
    if (!rows.length) return 0;
    const ids = rows.map((r) => r.file_id);
    // Only the ones the vault has had: one not sent yet is replaced by the new rendering anyway.
    await sql`
      update app.file r set superseded_at = now()
       where r.workspace_id = ${ctx.workspaceId}::uuid and r.derived_from_file_id = any (${ids}::uuid[])
         and r.rendition is not null and r.superseded_at is null
         and exists (select 1 from app.vault_item ri
                      where ri.workspace_id = r.workspace_id and ri.file_id = r.id
                        and ri.destination_id = ${destinationId}::uuid and ri.status <> 'queued')`.execute(
      trx,
    );
    await trx
      .updateTable('app.vault_item')
      .set({
        render_state: 'rendering',
        render_options: null,
        next_attempt_at: sql`now()`,
        updated_at: new Date(),
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', destinationId)
      .where('file_id', 'in', ids)
      .execute();
    return ids.length;
  }

  /**
   * ADR-0057 §4: the conversion settings changed (a group's "Files the vault doesn't keep", the detail switch, the
   * cover's account number). The job looks at every converted file again: PDFs not sent yet are made again, or dropped
   * when the group no longer converts; ones the vault has stay. Statements kept in Montra as "not a type the vault
   * keeps" go back in line when their group starts converting.
   */
  private async conversionsChanged(
    trx: Trx,
    ctx: Ctx,
    destinationId: string,
    before: VaultConfig,
    after: VaultConfig,
  ): Promise<void> {
    const settings = (c: VaultConfig) =>
      JSON.stringify([VAULT_RENDERED_GROUPS.map((g) => unkeptOf(c, g)), c.describeMore, c.coverNumber]);
    if (settings(before) === settings(after)) return;
    const now = new Date();
    await trx
      .updateTable('app.vault_item')
      .set({ next_attempt_at: sql`now()`, updated_at: now })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', destinationId)
      .where('status', '=', 'converted')
      .execute();
    const starting = VAULT_RENDERED_GROUPS.filter(
      (g) => unkeptOf(before, g) === 'dont_send' && unkeptOf(after, g) !== 'dont_send',
    ).flatMap((g) => [...VAULT_GROUP_KINDS[g]]);
    if (starting.length) {
      await trx
        .updateTable('app.vault_item')
        .set({ status: 'queued', not_kept_reason: null, next_attempt_at: sql`now()`, updated_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('status', '=', 'not_kept')
        .where('not_kept_reason', '=', TYPE_NOT_KEPT_WORDS)
        .where('file_id', 'in', (eb) =>
          eb
            .selectFrom('app.file')
            .select('id')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('kind', 'in', starting),
        )
        .execute();
    }
  }

  /** Settings' lists (§13): the files in one status, most recently changed first. */
  async items(ctx: Ctx, role: string, query: VaultItemsQuery): Promise<{ data: VaultItemDto[] }> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      const rows = await trx
        .selectFrom('app.vault_item as i')
        .leftJoin('app.file as f', (j) =>
          j.onRef('f.workspace_id', '=', 'i.workspace_id').onRef('f.id', '=', 'i.file_id'),
        )
        .select([
          'i.file_id',
          'i.status',
          'i.attempts',
          'i.last_error',
          'i.not_kept_reason',
          'i.resend_allowed',
          'i.received_at',
          'i.filed_at',
          'i.next_attempt_at',
          'f.file_name',
          'f.kind',
          'f.sealed',
        ])
        .where('i.workspace_id', '=', ctx.workspaceId)
        .where('i.destination_id', '=', row.id)
        .where('i.status', '=', query.status)
        .orderBy('i.updated_at', 'desc')
        .limit(query.limit)
        .execute();
      return {
        data: rows.map((r) => {
          const group = r.kind
            ? vaultGroupOf({ kind: r.kind as FileKind, sealed: r.sealed ?? false })
            : 'never';
          return {
            fileId: r.file_id,
            fileName: r.file_name ?? null,
            group: group === 'never' ? null : group,
            status: r.status,
            attempts: r.attempts,
            lastError: r.last_error,
            notKeptReason: r.not_kept_reason,
            resendAllowed: r.resend_allowed,
            receivedAt: iso(r.received_at),
            filedAt: iso(r.filed_at),
            nextAttemptAt: r.next_attempt_at.toISOString(),
          };
        }),
      };
    });
  }

  /**
   * The badges on files (§13), for anyone who can see them: only files the caller can see under row-level security are
   * asked about, and the vault's outbox answers with a status and words, nothing more.
   */
  async fileStates(ctx: Ctx, ids: readonly string[]): Promise<FileStorageStatesResponse> {
    return this.db.run(ctx, async (trx) => {
      const files = await trx
        .selectFrom('app.file')
        .select(['id', 'location', 'missing_since', 'missing_reason'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', [...ids])
        .execute();
      if (!files.length) return { data: [] };
      // §10: nothing opens in a vault Montra is disconnected from.
      const off = await sql<{ d: boolean }>`select app.vault_disconnected() as d`.execute(trx);
      const disconnected = off.rows[0]?.d === true;
      const { rows } = await sql<{
        file_id: string;
        status: VaultItemDto['status'];
        not_kept_reason: string | null;
        vault_meta: Record<string, unknown> | null;
      }>`select * from app.vault_file_states(${files.map((f) => f.id)}::uuid[])`.execute(trx);
      const byFile = new Map(rows.map((r) => [r.file_id, r]));
      // ADR-0057 §1, §4: how a file the vault doesn't keep was converted, and how far its PDFs got, in counts.
      const { rows: conv } = await sql<{
        file_id: string;
        render_state: 'rendering' | 'rendered' | 'not_converted' | 'import_undone';
        attached: boolean;
        parts: number;
        waiting: number;
        received: number;
        filed: number;
        not_kept: number;
        failed: number;
        earlier: number;
        combined: boolean | null;
      }>`select * from app.vault_file_conversions(${files.map((f) => f.id)}::uuid[])`.execute(trx);
      const converted = new Map(conv.map((r) => [r.file_id, r]));
      return {
        data: files.map((f) => {
          const v = byFile.get(f.id);
          const meta = v?.vault_meta ?? null;
          const text = (k: string) => (meta && typeof meta[k] === 'string' ? (meta[k] as string) : null);
          return {
            fileId: f.id,
            location: f.location,
            missing:
              f.missing_since && f.missing_reason
                ? { since: f.missing_since.toISOString(), reason: f.missing_reason }
                : null,
            vault: v
              ? {
                  status: v.status,
                  title: text('title'),
                  kind: text('kind'),
                  newerVersion: meta?.newerVersion === true,
                  notKeptReason: v.not_kept_reason,
                  // §9: filed, and the feed has shown it to Montra, so the vault has a document to open.
                  canOpen:
                    !disconnected &&
                    v.status === 'filed' &&
                    meta !== null &&
                    typeof meta.documentId === 'string',
                  converted: conversionOf(converted.get(f.id), disconnected),
                }
              : null,
          };
        }),
      };
    });
  }

  /**
   * A connection for the job, a link or a read-back (§12): the key unsealed for this run only, dropped when it is
   * closed. A connection made before API keys has no key the vault takes: `key_signed`, which stops it.
   */
  async openRow(ctx: Ctx, row: Row): Promise<VaultConnection> {
    const config = configOf(row);
    if (config.auth !== 'key') throw new VaultError('key_signed');
    if (!config.address || !config.clientId) throw new VaultError('failed', { detail: 'no key' });
    return this.open(config.address, await this.unseal(ctx, row), config.identity);
  }

  /** The files of the groups being sent that aren't in the outbox, oldest first, of a type and size the vault keeps. */
  private async unsent(trx: Trx, ctx: Ctx, row: Row): Promise<{ id: string; group: VaultGroup }[]> {
    const config = configOf(row);
    const kinds = vaultFileKinds(vaultEffectiveModes(config.groups));
    if (!kinds.length || config.stage !== 'connected') return [];
    const files = await trx
      .selectFrom('app.file as f')
      .select(['f.id', 'f.kind', 'f.mime', 'f.file_name', 'f.bytes'])
      .where('f.workspace_id', '=', ctx.workspaceId)
      .where('f.deleted_at', 'is', null)
      .where('f.sealed', '=', false)
      .where('f.kind', 'in', kinds)
      // ADR-0057 §1: a PDF Montra rendered goes only with its original's conversion, never on its own.
      .where('f.rendition', 'is', null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('app.vault_item as i')
              .select(sql`1`.as('one'))
              .whereRef('i.workspace_id', '=', 'f.workspace_id')
              .whereRef('i.file_id', '=', 'f.id')
              .where('i.destination_id', '=', row.id),
          ),
        ),
      )
      .orderBy('f.created_at')
      .orderBy('f.id')
      .execute();
    const max = config.limits?.maxUploadBytes ?? Number.POSITIVE_INFINITY;
    return files
      .map((f) => ({ ...f, group: vaultGroupOf({ kind: f.kind, sealed: false }) as VaultGroup }))
      .filter((f) =>
        vaultTypeKept({ mime: f.mime, fileName: f.file_name }, config.mediaTypes)
          ? Number(f.bytes) <= max
          : // ADR-0057 §1: a statement the vault doesn't keep goes as a PDF when its group converts it.
            unkeptOf(config, f.group) !== 'dont_send',
      )
      .map((f) => ({ id: f.id, group: f.group }));
  }

  // ----- Disconnecting and bringing back (§10) ------------------------------------------------------------------------

  /** Removes the connection with its key, state and outbox: nothing is held only in the vault. */
  private async remove(trx: Trx, ctx: Ctx, row: Row, detail: Record<string, unknown> = {}): Promise<void> {
    const config = configOf(row);
    await trx
      .deleteFrom('app.storage_destination')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', row.id)
      .execute();
    await this.security(trx, ctx, 'vault_disconnected', {
      host: config.address ? new URL(config.address).host : null,
      householdName: config.householdName,
      ...detail,
    });
  }

  /**
   * §10, a soft disconnect: the connection stays, `disconnected`, with its outbox. Nothing is sent or looked at, the
   * key is wiped, and every file held only in the vault becomes missing ("disconnected from the vault"), so Review asks
   * for it. Answers the files it marked, for the caller to tell people once the transaction has committed.
   */
  private async softDisconnect(
    trx: Trx,
    ctx: Ctx,
    row: Row,
    detail: Record<string, unknown>,
  ): Promise<string[]> {
    const config = configOf(row);
    const now = new Date();
    await trx
      .updateTable('app.storage_destination')
      .set({
        config: JSON.stringify({ ...config, keyWarnedFor: null } satisfies VaultConfig),
        mirror_files: false,
        file_kinds: [],
        secret_enc: null,
        status: 'disconnected',
        consecutive_failures: 0,
        last_error: null,
        last_error_at: null,
        updated_at: now,
        version: sql`version + 1`,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', row.id)
      .execute();
    await trx
      .updateTable('app.vault_connection_state')
      .set({
        next_check_at: sql<Date>`'infinity'::timestamptz`,
        feed_next_at: null,
        send_held_until: null,
        read_held_until: null,
        bring_back_at: null,
        bring_back_then: null,
        bring_back_by: null,
        key_rotation: 'none',
        key_rotation_at: null,
        updated_at: now,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', row.id)
      .execute();
    await trx
      .updateTable('app.vault_item')
      .set({ remove_at: null })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', row.id)
      .where('remove_at', 'is not', null)
      .execute();
    const held = await trx
      .selectFrom('app.file')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('location', '=', 'vault')
      .execute();
    const marked = await markMissing(
      trx,
      ctx,
      held.map((f) => f.id),
      MISSING_WORDS.disconnected,
      { includeTrash: true },
    );
    await this.security(trx, ctx, 'vault_disconnected', {
      host: config.address ? new URL(config.address).host : null,
      householdName: config.householdName,
      kept: true,
      onlyInVault: held.length,
      ...detail,
    });
    return marked;
  }

  /**
   * §10: the code of a connection made again checked out. The same vault (its installation id): the files it held that
   * were missing because of the disconnect aren't any more, and are read back as before. Another vault: the outbox
   * named the old vault's documents, which aren't Montra's to read there, so it goes and those files stay missing.
   */
  private async resume(trx: Trx, ctx: Ctx, destinationId: string, sameVault: boolean): Promise<void> {
    if (sameVault) {
      const found = await trx
        .updateTable('app.file')
        .set({ missing_since: null, missing_reason: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('location', '=', 'vault')
        .where('missing_reason', '=', MISSING_WORDS.disconnected)
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('app.vault_item')
            .select('file_id')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('destination_id', '=', destinationId)
            .where('status', '=', 'filed'),
        )
        .returning('id')
        .execute();
      if (found.length) {
        await trx
          .insertInto('app.audit_log')
          .values(
            found.map((f) => ({
              workspace_id: ctx.workspaceId,
              actor_user_id: ctx.userId,
              action: 'file.found_again',
              subject_type: 'file',
              subject_id: f.id,
              diff: JSON.stringify({ reconnected: true }),
            })),
          )
          .execute();
      }
      return;
    }
    // An object still to remove after a crash (§5) keeps its row, so the job deletes it.
    await trx
      .deleteFrom('app.vault_item')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', destinationId)
      .where((eb) => eb.or([eb('source_key', 'is', null), eb('source_removed_at', 'is not', null)]))
      .execute();
    await trx
      .updateTable('app.vault_connection_state')
      .set({ feed_cursor: null, feed_read_at: null, full_read_at: null, full_read_started_at: null })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', destinationId)
      .execute();
  }

  /**
   * §10 "Bring the files back": every group sent with no local copy becomes "sent, keep a local copy" (nothing is
   * removed again, and a move waiting is dropped), and the job is asked to copy the files back, then to keep the
   * connection or disconnect it.
   */
  private async startBringBack(
    trx: Trx,
    ctx: Ctx,
    row: Row,
    then: 'keep' | 'disconnect',
  ): Promise<VaultBringBackDto> {
    const config = configOf(row);
    const switched = config.groups.filter((g) => g.mode === 'sent_no_copy').map((g) => g.group);
    const next: VaultConfig = {
      ...config,
      groups: config.groups.map((g) =>
        g.mode === 'sent_no_copy' ? { ...g, mode: 'sent_keep_copy' as const } : g,
      ),
    };
    const now = new Date();
    await trx
      .updateTable('app.storage_destination')
      .set({
        config: JSON.stringify(next),
        ...sendingColumns(next),
        updated_at: now,
        version: sql`version + 1`,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', row.id)
      .execute();
    await trx
      .updateTable('app.vault_item')
      .set({ remove_at: null })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', row.id)
      .where('remove_at', 'is not', null)
      .execute();
    const state = await trx
      .updateTable('app.vault_connection_state')
      .set({ bring_back_at: sql`now()`, bring_back_then: then, bring_back_by: ctx.userId, updated_at: now })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', row.id)
      .returning('read_held_until')
      .executeTakeFirst();
    await this.security(trx, ctx, 'vault_changed', {
      bringBack: then,
      ...(switched.length ? { groups: switched.map((group) => ({ group, mode: 'sent_keep_copy' })) } : {}),
    });
    await scheduleVault(trx);
    const left = await trx
      .selectFrom('app.file')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('location', '=', 'vault')
      .where('missing_since', 'is', null)
      .executeTakeFirst();
    const held = state?.read_held_until;
    return {
      queued: Number(left?.n ?? 0),
      heldUntil: held && held.getTime() > Date.now() ? held.toISOString() : null,
    };
  }

  private async bringBackState(trx: Trx, ctx: Ctx, destinationId: string) {
    const s = await trx
      .selectFrom('app.vault_connection_state')
      .select('bring_back_then')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', destinationId)
      .executeTakeFirst();
    return s?.bring_back_then ?? null;
  }

  /**
   * §5, §12: filed files of the groups sent with no local copy whose copy Montra still holds and isn't already going,
   * oldest first: what "Move existing documents" counts. A file whose vault copy differs from Montra's never moves.
   */
  private async movable(
    trx: Trx,
    ctx: Ctx,
    row: Row,
    groups?: readonly VaultGroup[],
  ): Promise<{ id: string; group: VaultGroup }[]> {
    const config = configOf(row);
    if (row.status === 'disconnected' || config.stage !== 'connected') return [];
    const modes = vaultEffectiveModes(config.groups);
    const kinds = VAULT_GROUPS.filter(
      (g) => modes[g] === 'sent_no_copy' && (!groups || groups.includes(g)),
    ).flatMap((g) => [...VAULT_GROUP_KINDS[g]]);
    if (!kinds.length) return [];
    const rows = await trx
      .selectFrom('app.vault_item as i')
      .innerJoin('app.file as f', (j) =>
        j.onRef('f.workspace_id', '=', 'i.workspace_id').onRef('f.id', '=', 'i.file_id'),
      )
      .select(['f.id', 'f.kind'])
      .where('i.workspace_id', '=', ctx.workspaceId)
      .where('i.destination_id', '=', row.id)
      .where('i.remove_at', 'is', null)
      // A filed document whose copy is Montra's, or (ADR-0057 §7) an original the vault has inside a filed PDF.
      .where(
        sql<boolean>`((i.status = 'filed' and (i.vault_sha256 is null or i.vault_sha256 = f.sha256))
          or (i.status = 'converted' and ${carriedSql()}))`,
      )
      .where('f.location', '=', 'montra')
      .where('f.deleted_at', 'is', null)
      .where('f.sealed', '=', false)
      .where('f.kind', 'in', kinds)
      .orderBy('f.created_at')
      .orderBy('f.id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      group: vaultGroupOf({ kind: r.kind, sealed: false }) as VaultGroup,
    }));
  }

  // ----- Inside ----------------------------------------------------------------------------------------------------

  async row(trx: Trx, ctx: Ctx): Promise<Row | undefined> {
    return trx
      .selectFrom('app.storage_destination')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kind', '=', 'fdv')
      .executeTakeFirst();
  }

  private open(address: string, key: VaultKey, pinned: string | null) {
    return new VaultConnection({
      address,
      clientId: key.clientId,
      secret: key.secret,
      pinned,
      transport: this.transport,
    });
  }

  /** The connection test, as a result or the `VaultError` it came to. The key is held only for this. */
  private async tryCheck(
    address: string,
    key: VaultKey,
    pinned: string | null,
  ): Promise<VaultCheck | VaultError> {
    let conn: VaultConnection | undefined;
    try {
      conn = this.open(address, key, pinned);
      return await conn.check();
    } catch (e) {
      return e instanceof VaultError ? e : new VaultError('failed', { detail: 'check' });
    } finally {
      conn?.close();
    }
  }

  /** What the connection test says that Settings and sending use (§3, §12): kept in `config`. */
  private reported(check: VaultCheck): Partial<VaultConfig> {
    return {
      householdName: check.householdName,
      actingAs: check.actingAs,
      actsAs: check.actsAs,
      key: check.key,
      sendKinds: check.sendKinds,
      mediaTypes: check.mediaTypes,
      mayReadBack: check.mayReadBack,
      mayDelete: check.mayDelete,
      mayRead: check.mayRead,
      mayOpen: check.mayOpen,
      hints: check.hints,
      limits: check.limits,
    };
  }

  private async saveState(
    trx: Trx,
    ctx: Ctx,
    destinationId: string,
    check: VaultCheck,
    more: { keyRotation?: 'none' } = {},
  ): Promise<void> {
    const now = Date.now();
    await trx
      .updateTable('app.vault_connection_state')
      .set({
        checked_at: new Date(now),
        next_check_at: new Date(now + (check.approved ? NEXT_CHECK_MS.connected : NEXT_CHECK_MS.waiting)),
        daily_reset_at: check.dailyResetAt,
        clock_offset_ms:
          check.clockOffsetMs === null
            ? null
            : Math.max(-86_400_000, Math.min(86_400_000, check.clockOffsetMs)),
        ...(more.keyRotation ? { key_rotation: more.keyRotation, key_rotation_at: null } : {}),
        // §9: the job reads the feed only while the vault lets Montra read it; it starts at once the first time.
        feed_next_at: check.approved && check.mayRead ? sql`coalesce(feed_next_at, now())` : null,
        updated_at: new Date(now),
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', destinationId)
      .execute();
  }

  private async dto(trx: Trx, row: Row): Promise<VaultConnectionDto> {
    const config = configOf(row);
    const state = (await trx
      .selectFrom('app.vault_connection_state')
      .selectAll()
      .where('workspace_id', '=', row.workspace_id)
      .where('destination_id', '=', row.id)
      .executeTakeFirst()) as StateRow | undefined;
    const counts = await trx
      .selectFrom('app.vault_item')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('workspace_id', '=', row.workspace_id)
      .where('destination_id', '=', row.id)
      .groupBy('status')
      .execute();
    const n = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const modes = modesOf(config);
    const held = await trx
      .selectFrom('app.file')
      .select([
        (eb) => eb.fn.countAll<string>().as('only'),
        (eb) => eb.fn.count<string>('missing_since').as('missing'),
      ])
      .where('workspace_id', '=', row.workspace_id)
      .where('location', '=', 'vault')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const mirror = await trx
      .selectFrom('app.storage_destination')
      .select(['file_kinds', 'mirror_files'])
      .where('workspace_id', '=', row.workspace_id)
      .where('kind', 'in', ['s3', 'webdav'])
      .executeTakeFirst();
    const mirrored = mirror?.mirror_files ? mirror.file_kinds : [];
    return {
      id: row.id,
      stage: config.stage,
      status: row.status,
      address: config.address,
      householdName: config.householdName,
      key: config.key ? { ...config.key, expiresSoon: expiresSoon(config.key.expiresAt) } : null,
      keyProblem: config.auth !== 'key' ? 'signed' : config.keyProblem,
      actsAs: config.actsAs,
      actingAs: config.actingAs,
      groups: VAULT_GROUPS.map((group) => ({
        group,
        mode: modes[group],
        vaultKind: config.groups.find((g) => g.group === group)?.vaultKind ?? null,
        unkept: unkeptOf(config, group),
      })),
      vaultKinds: config.sendKinds,
      describeMore: config.describeMore,
      coverNumber: config.coverNumber,
      deleteWithMontra: row.delete_with_montra,
      canDelete: row.can_delete,
      items: {
        queued: n('queued'),
        pending: n('pending'),
        received: n('received'),
        filed: n('filed'),
        notKept: n('not_kept'),
        failed: n('failed'),
        outOfReach: n('out_of_reach'),
        converted: n('converted'),
      },
      heldUntil: {
        sending:
          state?.send_held_until && state.send_held_until > new Date() ? iso(state.send_held_until) : null,
        reading:
          state?.read_held_until && state.read_held_until > new Date() ? iso(state.read_held_until) : null,
      },
      dailyLimit: config.limits
        ? { files: config.limits.filesPerDay, filesToday: config.limits.filesToday }
        : null,
      feedReadAt: iso(state?.feed_read_at),
      files: { onlyInVault: Number(held?.only ?? 0), missing: Number(held?.missing ?? 0) },
      bringingBack: state?.bring_back_then ? { then: state.bring_back_then } : null,
      mirrorGroups: VAULT_GROUPS.filter((g) => VAULT_GROUP_KINDS[g].some((k) => mirrored.includes(k))),
      lastSuccessAt: iso(row.last_success_at),
      lastError: row.last_error,
      lastErrorAt: iso(row.last_error_at),
      createdAt: row.created_at.toISOString(),
      version: Number(row.version),
    };
  }

  /** The key, sealed as one JSON value under the workspace's data key (§7). */
  private seal(trx: Trx, ctx: Ctx, key: VaultKey) {
    return this.crypto.encrypt(trx, ctx.workspaceId, SECRET_COLUMN, JSON.stringify(sealedKey(key)));
  }

  /** The key, for one request or run. Only a connection with `auth: 'key'` is ever unsealed. */
  private async unseal(ctx: Ctx, row: Row): Promise<VaultKey> {
    const plain = await this.db.run(ctx, (t) =>
      this.crypto.decrypt(t, ctx.workspaceId, SECRET_COLUMN, row.secret_enc),
    );
    const parsed = VaultSecret.safeParse(JSON.parse(plain ?? 'null'));
    // Never the value in an error: a key Montra can't read is one an owner replaces.
    if (!parsed.success) throw new VaultError('key_invalid', { detail: 'sealed' });
    return { clientId: parsed.data.clientId, secret: parsed.data.secret };
  }

  private async security(trx: Trx, ctx: Ctx, kind: string, detail: Record<string, unknown>): Promise<void> {
    await trx
      .insertInto('app.security_event')
      .values({ user_id: ctx.userId, workspace_id: ctx.workspaceId, kind, detail: JSON.stringify(detail) })
      .execute();
  }
}

export function configOf(row: Row): VaultConfig {
  return VaultConfig.parse(row.config);
}

/**
 * §3, §11: what the trigger on `app.file` reads. Montra sends once the vault has approved it, and only the groups that
 * are sent and mapped to one of the vault's kinds, so nothing is queued for a group the vault can't take yet.
 */
export function sendingColumns(config: VaultConfig): {
  mirror_files: boolean;
  file_kinds: StorageFileKind[];
} {
  return {
    mirror_files: config.stage === 'connected',
    file_kinds: vaultFileKinds(vaultEffectiveModes(config.groups)),
  };
}

/** Wakes the vault's job (§12): soon after a change that may give it something to send. */
export async function scheduleVault(trx: Trx, at: Date = new Date()): Promise<void> {
  await sql`select app.schedule_system_job('schedule', 'storage.vault', ${at})`.execute(trx);
}

/** How many are waiting, by group, and how many days that is at the vault's daily limit. */
function existingOf(files: readonly { group: VaultGroup }[], config: VaultConfig): VaultExistingDto {
  const perDay = config.limits?.filesPerDay ?? null;
  return {
    count: files.length,
    groups: VAULT_GROUPS.map((group) => ({
      group,
      count: files.filter((f) => f.group === group).length,
    })).filter((g) => g.count > 0),
    perDay,
    days: perDay && perDay > 0 ? Math.ceil(files.length / perDay) : null,
  };
}

/** §10: a disconnected connection has no key: nothing is sent, checked or changed until it is connected again. */
function assertConnected(row: Row): void {
  if (row.status === 'disconnected') {
    throw new AppError(
      409,
      'vault.disconnected',
      'Montra is disconnected from the vault. Connect it again first.',
    );
  }
}

/** §10: why a disconnect needs a choice, or can't remove the connection yet, in words. */
function filesOnlyInVault(n: number, disconnected: boolean): AppError {
  const files = `${n} file${n === 1 ? ' is' : 's are'} kept only in the vault.`;
  return new AppError(
    409,
    'vault.files_only_in_vault',
    disconnected
      ? `${files} Montra keeps this connection, which is how it reads them back if the same vault is connected again, until each is uploaded again or deleted.`
      : `${files} Bring them back into Montra first, or disconnect anyway and upload them again later.`,
  );
}

/** How many are to move, by group. */
function moveOf(files: readonly { group: VaultGroup }[]): VaultMoveDto {
  return {
    count: files.length,
    groups: VAULT_GROUPS.map((group) => ({
      group,
      count: files.filter((f) => f.group === group).length,
    })).filter((g) => g.count > 0),
  };
}

/** §10: how many files of the workspace are held only in the vault (whatever their state), in the trash or not. */
async function onlyInVault(trx: Trx, workspaceId: string): Promise<number> {
  const r = await trx
    .selectFrom('app.file')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('workspace_id', '=', workspaceId)
    .where('location', '=', 'vault')
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}

/** ADR-0057 §1: a group's "Files the vault doesn't keep", its default when not chosen, and never one not offered. */
export function unkeptOf(config: VaultConfig, group: VaultGroup): VaultUnkeptChoice {
  const set = config.groups.find((g) => g.group === group)?.unkept;
  return set && vaultUnkeptOffered(group).includes(set) ? set : vaultUnkeptDefault(group);
}

/**
 * ADR-0057 §7, as SQL over `app.vault_item i` and its original `app.file f`: the vault has filed a PDF rendered from
 * `f` with `f` attached inside it, and holds the PDF Montra sent.
 */
export function carriedSql() {
  return sql<boolean>`exists (
    select 1 from app.file r
      join app.vault_item ri on ri.workspace_id = r.workspace_id and ri.file_id = r.id
                            and ri.destination_id = i.destination_id
     where r.workspace_id = f.workspace_id and r.derived_from_file_id = f.id and r.rendition is not null
       and ri.carries_original and ri.status = 'filed'
       and (ri.vault_sha256 is null or ri.vault_sha256 = r.sha256))`;
}

/** The badge's view of a conversion (ADR-0057 §4), from `app.vault_file_conversions`. */
function conversionOf(
  c:
    | {
        render_state: 'rendering' | 'rendered' | 'not_converted' | 'import_undone';
        attached: boolean;
        parts: number;
        waiting: number;
        received: number;
        filed: number;
        not_kept: number;
        failed: number;
        earlier: number;
        combined: boolean | null;
      }
    | undefined,
  disconnected: boolean,
): NonNullable<FileStorageStatesResponse['data'][number]['vault']>['converted'] {
  if (!c) return null;
  // ADR-0059: a receipt's or bill's page is in its record's PDF; moving or removing pages sends a new one.
  if (c.combined)
    return {
      state: c.render_state === 'import_undone' ? 'rendered' : c.render_state,
      attached: false,
      parts: c.parts,
      waiting: c.waiting,
      received: c.received,
      filed: c.filed,
      notKept: c.not_kept,
      failed: c.failed,
      earlier: c.earlier,
      canSendAgain: false,
      combined: true,
    };
  return {
    state: c.render_state,
    attached: c.attached,
    parts: c.parts,
    waiting: c.waiting,
    received: c.received,
    filed: c.filed,
    notKept: c.not_kept,
    failed: c.failed,
    earlier: c.earlier,
    canSendAgain: !disconnected && c.render_state === 'rendered' && c.parts > c.waiting,
  };
}

function modesOf(config: VaultConfig): Record<VaultGroup, VaultGroupMode> {
  return vaultGroupModes(Object.fromEntries(config.groups.map((g) => [g.group, g.mode])));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** §12: a key that expires within `VAULT_KEY_WARN_DAYS`, and hasn't yet. */
export function expiresSoon(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t > now && t - now <= VAULT_KEY_WARN_DAYS * DAY_MS;
}
