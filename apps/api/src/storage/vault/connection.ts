/**
 * Montra's adapter over the vault's own client package (ADR-0054 §2, §12.1; owner's answer 1). The package signs every
 * request (RFC 9421) and reads the connection code; Montra adds what is Montra's: the address guard (§8), pinning the
 * vault's identity, and turning the vault's answers into a `VaultCheck` or a `VaultError` in Montra's words.
 *
 * PR 2 builds connecting: reading a code, identifying the vault, and the signed connection test. Sending, reading back,
 * links and deletes (the rest of `VaultDestination`) come with the PRs that use them.
 */
import { ApiRequestError, createApi, createHttp, NetworkError } from '@fdv/client';
import { createAppClient, parseConnectionString, type AppClient } from '@fdv/client/apps';
import { VaultError, type VaultCheck, type VaultDestination } from '../destinations/vault.js';
import { assertVaultAddress, type VaultTransport } from './transport.js';

/** What a pasted code says, once read: where the vault is, Montra's app and key there, and which vault it is. */
export interface VaultCode {
  address: string;
  appId: string;
  keyId: string;
  /** The vault's installation id, when the code says it. */
  identity: string | null;
  fingerprint: string;
}

/** Reads a pasted code through the package, strictly; anything else is `invalid_code`. Checks nothing on the network. */
export function readVaultCode(text: string): VaultCode {
  let c: ReturnType<typeof parseConnectionString>;
  try {
    c = parseConnectionString(text);
  } catch {
    throw new VaultError('invalid_code');
  }
  return {
    address: c.url,
    appId: c.app_id,
    keyId: c.key_id,
    identity: c.instance_id,
    fingerprint: c.fingerprint,
  };
}

/**
 * The vault's refusals that mean the connection itself needs a person (§12): the key, the app's state on the vault's
 * side, the person it acts as, a permission, the clock or the address. Their messages are written for people.
 */
const CONNECTION_REFUSALS = new Set([
  'app_key_unknown',
  'app_key_pending',
  'app_revoked',
  'app_paused',
  'app_not_approved',
  'address_not_allowed',
  'https_required',
  'signature_stale',
  'member_locked',
  'member_paused',
  'scope_not_granted',
]);

/** Any failure from the package, or the transport, as a `VaultError`. `detail` carries codes only, never content. */
export function asVaultError(e: unknown, transport?: VaultTransport, now = Date.now()): VaultError {
  if (e instanceof VaultError) return e;
  const refused = transport?.refused();
  if (refused) return refused;
  if (e instanceof NetworkError) return new VaultError('unreachable', { detail: e.kind });
  if (e instanceof ApiRequestError) {
    const detail = `${e.status} ${e.code}`;
    const wait = e.retryAfterSeconds !== undefined ? new Date(now + e.retryAfterSeconds * 1000) : undefined;
    if (CONNECTION_REFUSALS.has(e.code))
      return new VaultError('connection', { vaultMessage: e.message, detail });
    if (e.code === 'app_day_full')
      return new VaultError('send_cap', { detail, ...(wait ? { heldUntil: wait } : {}) });
    if (e.code === 'app_read_day_full')
      return new VaultError('read_cap', { detail, ...(wait ? { heldUntil: wait } : {}) });
    if (e.status === 429 || e.status === 503 || (e.retriable && wait))
      return new VaultError('retry_later', { detail, ...(wait ? { retryAfter: wait } : {}) });
    if (e.status >= 500) return new VaultError('failed', { detail });
    return new VaultError('refused', { detail });
  }
  return new VaultError('failed', { detail: e instanceof Error ? e.name : 'unknown' });
}

/** What the server at an address says it is, before anything is signed: product, apps, and its installation id. */
export async function identifyVault(address: string, transport: VaultTransport): Promise<string> {
  const origin = assertVaultAddress(address).origin;
  let caps: Awaited<ReturnType<ReturnType<typeof createApi>['capabilities']>>;
  try {
    caps = await createApi(createHttp({ baseUrl: origin, fetch: transport.fetch })).capabilities();
  } catch (e) {
    const err = asVaultError(e, transport);
    // Something answered, but not as a vault does.
    throw err.code === 'refused' ? new VaultError('not_a_vault', { detail: err.opts.detail ?? '' }) : err;
  }
  if (
    !caps ||
    typeof caps !== 'object' ||
    caps.product !== 'family-document-vault' ||
    caps.features?.connected_apps !== true
  ) {
    throw new VaultError('not_a_vault', { detail: 'capabilities' });
  }
  // A vault too old to say which installation it is can't be pinned (§2), so it isn't one Montra connects to.
  if (typeof caps.instance_id !== 'string' || !caps.instance_id) {
    throw new VaultError('not_a_vault', { detail: 'no instance id' });
  }
  return caps.instance_id;
}

export interface VaultConnectionOptions {
  address: string;
  appId: string;
  keyId: string;
  /** PKCS#8 DER. Zeroed when the connection is closed. */
  privateKey: Buffer;
  /** The identity pinned at connect time, or null while connecting. */
  pinned: string | null;
  transport: VaultTransport;
  now?: () => number;
}

/** One run's connection to a vault: opened for a request or a job run, then closed. */
export class VaultConnection implements Pick<VaultDestination, 'kind' | 'check' | 'close'> {
  readonly kind = 'fdv' as const;
  private readonly client: AppClient;
  private readonly origin: string;

  constructor(private readonly opts: VaultConnectionOptions) {
    this.origin = assertVaultAddress(opts.address).origin;
    this.client = createAppClient({
      baseUrl: this.origin,
      appId: opts.appId,
      keyId: opts.keyId,
      privateKey: new Uint8Array(
        opts.privateKey.buffer,
        opts.privateKey.byteOffset,
        opts.privateKey.byteLength,
      ),
      fetch: opts.transport.fetch,
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  /**
   * §2 step 3, §12.1: who is at the address (pinned, or to pin), then the signed connection test. A different vault at
   * a pinned address is `identity_changed`; an app paused or removed in the vault is a `connection` problem; one still
   * waiting for a person there comes back with `approved: false`.
   */
  async check(): Promise<VaultCheck> {
    const identity = await identifyVault(this.origin, this.opts.transport);
    if (this.opts.pinned !== null && identity !== this.opts.pinned) {
      throw new VaultError('identity_changed', { detail: 'capabilities' });
    }
    let me: Awaited<ReturnType<AppClient['me']>>;
    try {
      me = await this.client.me();
    } catch (e) {
      throw asVaultError(e, this.opts.transport);
    }
    const said = me.vault?.instance_id ?? null;
    if (said !== null && said !== identity) throw new VaultError('identity_changed', { detail: 'me' });
    if (me.state === 'paused') {
      throw new VaultError('connection', {
        vaultMessage: 'An owner of the vault has paused Montra there.',
        detail: `paused ${me.paused_reason ?? ''}`.trim(),
      });
    }
    const now = this.opts.now?.() ?? Date.now();
    const vaultNow = Date.parse(me.vault?.now ?? '');
    const resets = Date.parse(me.limits?.day_resets_at ?? '');
    const scopes = new Set<string>(me.scopes ?? []);
    return {
      approved: me.state === 'active',
      identity,
      householdName: me.vault?.display_name ?? null,
      actingAs: me.acting_as?.name ?? null,
      sendKinds: (me.send?.kinds ?? []).map((k) => ({ key: k.key, name: k.label })),
      mediaTypes: [...(me.limits?.accepted_types ?? [])],
      mayReadBack: scopes.has('documents.read') && scopes.has('documents.download'),
      mayDelete: scopes.has('documents.delete'),
      newKeyConfirmed: false,
      dailyResetAt: Number.isFinite(resets) ? new Date(resets) : null,
      clockOffsetMs: Number.isFinite(vaultNow) ? Math.trunc(now - vaultNow) : null,
    };
  }

  /** §2: retires a key Montra no longer signs with, signed with the current one. Best effort: the vault retires it too. */
  async retireKey(keyId: string): Promise<void> {
    try {
      await this.client.retireKey(keyId);
    } catch (e) {
      throw asVaultError(e, this.opts.transport);
    }
  }

  close(): void {
    this.opts.privateKey.fill(0);
  }
}
