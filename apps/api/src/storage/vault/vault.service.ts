/**
 * Connecting the workspace to the household's Family Document Vault (ADR-0054 §2, §7, §8; VLT-01, VLT-08). Montra makes
 * the key pair, the vault's owner registers it in the vault and gets a code, the owner pastes the code back, and Montra
 * checks it: the code names Montra's key, the address passes the guard, the vault says which vault it is (pinned), and
 * a signed connection test passes or says it waits for someone there to approve. Replacing the key and disconnecting
 * are here too. Nothing is sent yet: the connection's "send files" switch stays off until sending ships (PR 3).
 *
 * Only an owner connects, replaces the key or disconnects, with a recent sign-in (the controller asks for it; D4).
 * Owners and admins see the connection and may ask Montra to check it again. The private key goes in sealed and never
 * comes back out: not in a DTO, an error, a log line, the security log or an archive.
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
  vaultEffectiveModes,
  vaultFileKinds,
  vaultGroupModes,
  vaultGroupOf,
  vaultTypeKept,
  type DisconnectVaultRequest,
  type FileKind,
  type MoveToVaultRequest,
  type VaultBringBackDto,
  type VaultMoveDto,
  type FileStorageStatesResponse,
  type PasteVaultCodeRequest,
  type ReplaceVaultKeyRequest,
  type RetryVaultItemsRequest,
  type SendExistingToVaultRequest,
  type StorageFileKind,
  type UpdateVaultConnectionRequest,
  type VaultConnectionDto,
  type VaultExistingDto,
  type VaultItemDto,
  type VaultItemsQuery,
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
import { readVaultCode, VaultConnection, type VaultCode } from './connection.js';
import { makeVaultKey, VaultSecret } from './keys.js';
import { assertVaultAddress, VAULT_TRANSPORT, type VaultTransport } from './transport.js';

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
  publicKey: z.string(),
  fingerprint: z.string(),
  newKey: z.object({ publicKey: z.string(), fingerprint: z.string() }).nullable().default(null),
  address: z.string().nullable().default(null),
  appId: z.string().nullable().default(null),
  keyId: z.string().nullable().default(null),
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
    .array(z.object({ group: VaultGroup, mode: VaultGroupMode, vaultKind: z.string().nullable() }))
    .default([]),
  describeMore: z.boolean().default(false),
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
   * Step 1: a fresh key pair for this workspace, the private key sealed at once. Asking again before a code is pasted
   * gives back the same key, so a reload doesn't leave the vault with a key Montra has thrown away.
   */
  async start(ctx: Ctx, role: string): Promise<VaultConnectionDto> {
    if (role !== 'owner') throw ownerOnly();
    return this.db.run(ctx, async (trx) => {
      const existing = await this.row(trx, ctx);
      if (existing?.status === 'disconnected') return this.reconnect(trx, ctx, existing);
      if (existing) {
        if (configOf(existing).stage === 'register') return this.dto(trx, existing);
        throw new AppError(
          409,
          'vault.exists',
          'This workspace is already connected to a Family Document Vault',
        );
      }
      const key = makeVaultKey();
      const config: VaultConfig = VaultConfig.parse({
        stage: 'register',
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        groups: VAULT_GROUPS.map((group) => ({ group, mode: VAULT_GROUP_DEFAULTS[group], vaultKind: null })),
      });
      const ws = await trx
        .selectFrom('app.workspace')
        .select('name')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('app.storage_destination')
        .values({
          workspace_id: ctx.workspaceId,
          kind: 'fdv',
          label: VAULT_LABEL,
          config: JSON.stringify(config),
          secret_enc: (await this.seal(trx, ctx, {
            v: 1,
            current: { pkcs8: key.pkcs8, keyId: null },
            next: null,
          }))!,
          secret_hint: null,
          // Unused for a vault (backups never go there), but the column is NOT NULL (ADR-0054, As built: PR 1).
          folder: defaultFolder(ws.name),
          // Nothing is sent until the vault has approved Montra and the owner has mapped a group (§3).
          ...sendingColumns(config),
          status: 'needs_vault',
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // Nothing for the job to look at until there is a code.
      await trx
        .insertInto('app.vault_connection_state')
        .values({
          workspace_id: ctx.workspaceId,
          destination_id: row.id,
          next_check_at: sql<Date>`'infinity'::timestamptz`,
        })
        .execute();
      await this.security(trx, ctx, 'vault_changed', { keyMade: true, fingerprint: key.fingerprint });
      return this.dto(trx, row);
    });
  }

  /**
   * Step 3, and the end of a key change: the code the vault gave. Checked in order: it names the key Montra is waiting
   * on, its address passes the guard, the server there is a vault that takes apps (and, for a key change, the one
   * pinned), and a signed connection test passes. Nothing is saved unless all of that holds.
   */
  async paste(ctx: Ctx, role: string, req: PasteVaultCodeRequest): Promise<VaultConnectionDto> {
    if (role !== 'owner') throw ownerOnly();
    const row = await this.db.run(ctx, (trx) => this.row(trx, ctx));
    if (!row) throw notConnected();
    if (BigInt(row.version) !== BigInt(req.version)) throw conflict();
    const config = configOf(row);
    const rotating = config.newKey !== null;
    if (!rotating && config.stage !== 'register') {
      throw new AppError(
        409,
        'vault.already_connected',
        'Montra is already connected to this vault. To use a new code, replace the key or disconnect first.',
      );
    }

    let code: VaultCode;
    try {
      code = readVaultCode(req.code);
      const expected = rotating ? config.newKey!.fingerprint : config.fingerprint;
      if (code.fingerprint !== expected) throw new VaultError('other_key');
      // A new key is for the same app in the same vault.
      if (rotating && code.appId !== config.appId) throw new VaultError('other_key', { detail: 'other app' });
      assertVaultAddress(code.address);
    } catch (e) {
      throw refusal(e instanceof VaultError ? e : new VaultError('invalid_code'));
    }

    const secret = await this.unseal(ctx, row);
    const key = rotating ? secret.next : secret.current;
    if (!key) throw conflict();
    const check = await this.tryCheck(
      code.address,
      code.appId,
      code.keyId,
      key.pkcs8,
      rotating ? config.identity : null,
    );
    if (check instanceof VaultError) throw refusal(check);
    if (code.identity !== null && code.identity !== check.identity) {
      throw refusal(new VaultError('identity_changed', { detail: 'code' }));
    }

    const oldKeyId = secret.current.keyId;
    const updated = await this.db.run(ctx, async (trx) => {
      const now = new Date();
      const next: VaultConfig = {
        ...config,
        ...this.reported(check),
        stage: check.approved ? 'connected' : 'approval',
        address: new URL(code.address).origin,
        appId: code.appId,
        keyId: code.keyId,
        identity: check.identity,
        previousIdentity: null,
        ...(rotating
          ? { publicKey: config.newKey!.publicKey, fingerprint: config.newKey!.fingerprint, newKey: null }
          : {}),
      };
      const sealed: VaultSecret = rotating
        ? { v: 1, current: { pkcs8: secret.next!.pkcs8, keyId: code.keyId }, next: null }
        : { v: 1, current: { pkcs8: secret.current.pkcs8, keyId: code.keyId }, next: null };
      const saved = await trx
        .updateTable('app.storage_destination')
        .set({
          config: JSON.stringify(next),
          ...sendingColumns(next),
          secret_enc: (await this.seal(trx, ctx, sealed))!,
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
      // §10: connected again after a disconnect. The same vault resumes reading what only it holds; another vault's
      // documents aren't Montra's to read, so the old references go and those files stay missing.
      const reconnected = !rotating && config.previousIdentity !== null;
      const sameVault = reconnected && config.previousIdentity === check.identity;
      if (reconnected) await this.resume(trx, ctx, row.id, sameVault);
      if (check.approved) await scheduleVault(trx);
      if (rotating) {
        await this.security(trx, ctx, 'vault_key_replaced', { fingerprint: next.fingerprint });
      } else {
        await this.security(trx, ctx, 'vault_connected', {
          host: new URL(code.address).host,
          householdName: check.householdName,
          approved: check.approved,
          fingerprint: next.fingerprint,
          ...(reconnected ? { reconnected: true, sameVault } : {}),
        });
      }
      return this.dto(trx, saved);
    });

    // The old key is no longer used. The vault retires it on its own a few days after the new one is first used; this
    // only makes it sooner, so a vault that doesn't take it changes nothing.
    if (rotating && oldKeyId && oldKeyId !== code.keyId) {
      const conn = this.open(code.address, code.appId, code.keyId, secret.next!.pkcs8, check.identity);
      await conn.retireKey(oldKeyId).catch(() => undefined);
      conn.close();
    }
    return updated;
  }

  /**
   * "Check again" (§2 step 4, §12.1): the signed connection test, now. Approved: connected. Still waiting: as it was.
   * A problem with the connection itself, or a different vault at the address, stops it (`needs_vault`) with the words
   * to show; anything else is a failed check, and five in a row turn it `failing`.
   */
  async checkAgain(ctx: Ctx, role: string): Promise<VaultConnectionDto> {
    if (!isAdmin(role)) throw ownersAndAdmins();
    const row = await this.db.run(ctx, (trx) => this.row(trx, ctx));
    if (!row) throw notConnected();
    assertConnected(row);
    const config = configOf(row);
    if (config.stage === 'register' || !config.address || !config.appId || !config.keyId) {
      throw new AppError(409, 'vault.no_code', 'Paste the code from the vault first');
    }
    const done = await this.checkRow(ctx, row);
    // "Check again" also wakes sending, now that the connection may work again.
    if (!(done.check instanceof VaultError) && done.check.approved) {
      await this.db.run(ctx, (trx) => scheduleVault(trx));
    }
    return this.db.run(ctx, (trx) => this.dto(trx, done.row));
  }

  /**
   * The signed connection test for a saved connection, and what it changes (§12.1): for "Check again" and the job.
   * `stopped` says this check stopped a connection that wasn't stopped before, and `turnedFailing` that it made it
   * `failing`, so the job tells owners once. A check refreshes the status and what the vault reports, not the owner's
   * settings, so the version stays: someone changing the settings while a check runs isn't sent back to reload.
   */
  async checkRow(
    ctx: Ctx,
    row: Row,
  ): Promise<{ row: Row; check: VaultCheck | VaultError; stopped: boolean; turnedFailing: boolean }> {
    const before = configOf(row);
    if (!before.address || !before.appId || !before.keyId) {
      return {
        row,
        check: new VaultError('failed', { detail: 'no code' }),
        stopped: false,
        turnedFailing: false,
      };
    }
    const secret = await this.unseal(ctx, row);
    const check = await this.tryCheck(
      before.address,
      before.appId,
      before.keyId,
      secret.current.pkcs8,
      before.identity,
    );
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
          nextCheck = new Date(now.getTime() + NEXT_CHECK_MS.waiting);
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
   * "Replace the key" (§2): a new pair, sealed beside the current one. Someone in the vault adds its public key to
   * Montra's app there and gets a code, which the owner pastes as when connecting; Montra signs with the current key
   * until that code checks out. `cancel` drops a new key not yet confirmed.
   */
  async replaceKey(ctx: Ctx, role: string, req: ReplaceVaultKeyRequest): Promise<VaultConnectionDto> {
    if (role !== 'owner') throw ownerOnly();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw notConnected();
      if (BigInt(row.version) !== BigInt(req.version)) throw conflict();
      assertConnected(row);
      const config = configOf(row);
      if (config.stage === 'register' || !config.keyId) {
        throw new AppError(409, 'vault.no_code', 'Paste the code from the vault first');
      }
      const secret = await this.unseal(ctx, row, trx);
      const key = req.cancel ? null : makeVaultKey();
      const now = new Date();
      const saved = await trx
        .updateTable('app.storage_destination')
        .set({
          config: JSON.stringify({
            ...config,
            newKey: key ? { publicKey: key.publicKey, fingerprint: key.fingerprint } : null,
          } satisfies VaultConfig),
          secret_enc: (await this.seal(trx, ctx, {
            v: 1,
            current: secret.current,
            next: key ? { pkcs8: key.pkcs8, keyId: null } : null,
          }))!,
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .returningAll()
        .executeTakeFirst();
      if (!saved) throw conflict();
      await trx
        .updateTable('app.vault_connection_state')
        .set({
          key_rotation: key ? 'made' : 'none',
          key_rotation_at: key ? now : null,
          updated_at: now,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', row.id)
        .execute();
      if (key || config.newKey) {
        await this.security(
          trx,
          ctx,
          'vault_changed',
          key ? { newKeyMade: true, fingerprint: key.fingerprint } : { newKeyCancelled: true },
        );
      }
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
      (req.describeMore !== undefined || req.deleteWithMontra !== undefined || req.paused !== undefined)
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
      }));
      const changed: { group: VaultGroup; mode: VaultGroupMode; vaultKind: string | null }[] = [];
      const restricted: { group: VaultGroup; sent: boolean }[] = [];
      for (const g of req.groups ?? []) {
        const cur = groups.find((x) => x.group === g.group)!;
        const mode = g.mode ?? cur.mode;
        const vaultKind = g.vaultKind === undefined ? cur.vaultKind : g.vaultKind;
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
        if (mode !== cur.mode || vaultKind !== cur.vaultKind)
          changed.push({ group: g.group, mode, vaultKind });
        cur.mode = mode;
        cur.vaultKind = vaultKind;
      }
      const next: VaultConfig = { ...config, groups, describeMore: req.describeMore ?? config.describeMore };
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
      if (status !== row.status && (status === 'paused' || row.status === 'paused')) {
        detail.paused = status === 'paused';
      }
      if (Object.keys(detail).length) await this.security(trx, ctx, 'vault_changed', detail);
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
      }
      if (retried) await scheduleVault(trx);
      return { retried };
    });
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
                }
              : null,
          };
        }),
      };
    });
  }

  /** A signing connection for the job (§12): the key unsealed for this run, zeroed when it is closed. */
  async openRow(ctx: Ctx, row: Row): Promise<VaultConnection> {
    const config = configOf(row);
    if (!config.address || !config.appId || !config.keyId)
      throw new VaultError('failed', { detail: 'no code' });
    const secret = await this.unseal(ctx, row);
    return this.open(config.address, config.appId, config.keyId, secret.current.pkcs8, config.identity);
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
      .filter((f) => vaultTypeKept({ mime: f.mime, fileName: f.file_name }, config.mediaTypes))
      .filter((f) => Number(f.bytes) <= max)
      .map((f) => ({ id: f.id, group: vaultGroupOf({ kind: f.kind, sealed: false }) as VaultGroup }));
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
        config: JSON.stringify({ ...config, newKey: null } satisfies VaultConfig),
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

  /** §10: connecting again after a disconnect: a new key for the same connection, which keeps its outbox. */
  private async reconnect(trx: Trx, ctx: Ctx, row: Row): Promise<VaultConnectionDto> {
    const before = configOf(row);
    const key = makeVaultKey();
    const config: VaultConfig = VaultConfig.parse({
      stage: 'register',
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      groups: before.groups,
      describeMore: before.describeMore,
      previousIdentity: before.previousIdentity ?? before.identity,
    });
    const now = new Date();
    const saved = await trx
      .updateTable('app.storage_destination')
      .set({
        config: JSON.stringify(config),
        ...sendingColumns(config),
        secret_enc: (await this.seal(trx, ctx, {
          v: 1,
          current: { pkcs8: key.pkcs8, keyId: null },
          next: null,
        }))!,
        status: 'needs_vault',
        can_delete: false,
        consecutive_failures: 0,
        last_error: null,
        last_error_at: null,
        updated_at: now,
        version: sql`version + 1`,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('app.vault_connection_state')
      .set({ next_check_at: sql<Date>`'infinity'::timestamptz`, feed_next_at: null, updated_at: now })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('destination_id', '=', row.id)
      .execute();
    await this.security(trx, ctx, 'vault_changed', {
      keyMade: true,
      fingerprint: key.fingerprint,
      reconnecting: true,
    });
    return this.dto(trx, saved);
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
      .where('i.status', '=', 'filed')
      .where('i.remove_at', 'is', null)
      .where((eb) => eb.or([eb('i.vault_sha256', 'is', null), eb('i.vault_sha256', '=', eb.ref('f.sha256'))]))
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

  private open(address: string, appId: string, keyId: string, pkcs8: string, pinned: string | null) {
    return new VaultConnection({
      address,
      appId,
      keyId,
      privateKey: Buffer.from(pkcs8, 'base64'),
      pinned,
      transport: this.transport,
    });
  }

  /** The connection test, as a result or the `VaultError` it came to. The key is held only for this. */
  private async tryCheck(
    address: string,
    appId: string,
    keyId: string,
    pkcs8: string,
    pinned: string | null,
  ): Promise<VaultCheck | VaultError> {
    let conn: VaultConnection | undefined;
    try {
      conn = this.open(address, appId, keyId, pkcs8, pinned);
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
      publicKey: config.publicKey,
      fingerprint: config.fingerprint,
      newKey: config.newKey,
      actingAs: config.actingAs,
      groups: VAULT_GROUPS.map((group) => ({
        group,
        mode: modes[group],
        vaultKind: config.groups.find((g) => g.group === group)?.vaultKind ?? null,
      })),
      vaultKinds: config.sendKinds,
      describeMore: config.describeMore,
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
      clockOffsetMs: state?.clock_offset_ms ?? null,
      feedReadAt: iso(state?.feed_read_at),
      files: { onlyInVault: Number(held?.only ?? 0), missing: Number(held?.missing ?? 0) },
      bringingBack: state?.bring_back_then ? { then: state.bring_back_then } : null,
      mirrorGroups: VAULT_GROUPS.filter((g) => VAULT_GROUP_KINDS[g].some((k) => mirrored.includes(k))),
      keyRotation: state?.key_rotation ?? 'none',
      lastSuccessAt: iso(row.last_success_at),
      lastError: row.last_error,
      lastErrorAt: iso(row.last_error_at),
      createdAt: row.created_at.toISOString(),
      version: Number(row.version),
    };
  }

  private seal(trx: Trx, ctx: Ctx, secret: VaultSecret) {
    return this.crypto.encrypt(
      trx,
      ctx.workspaceId,
      SECRET_COLUMN,
      JSON.stringify(VaultSecret.parse(secret)),
    );
  }

  private async unseal(ctx: Ctx, row: Row, trx?: Trx): Promise<VaultSecret> {
    const open = (t: Trx) => this.crypto.decrypt(t, ctx.workspaceId, SECRET_COLUMN, row.secret_enc);
    const plain = trx ? await open(trx) : await this.db.run(ctx, open);
    return VaultSecret.parse(JSON.parse(plain!));
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

function modesOf(config: VaultConfig): Record<VaultGroup, VaultGroupMode> {
  return vaultGroupModes(Object.fromEntries(config.groups.map((g) => [g.group, g.mode])));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
