/**
 * Montra's adapter over the vault's own client package (ADR-0054 §2, §12.1; owner's answer 1). Since vault
 * 0.9.0-dev.63 the package sends the vault API key an owner pasted (a client ID and a secret, as HTTP Basic) on every
 * request, and reads the connection string; Montra adds what is Montra's: the address guard (§8), pinning the vault's
 * identity, and turning the vault's answers into a `VaultCheck` or a `VaultError` in Montra's words.
 *
 * PR 2 built connecting: reading what was pasted, identifying the vault, and the connection test. PR 3 adds sending,
 * asking what became of what was sent, withdrawing and deleting. PR 4 adds the changes feed and view links. PR 5 adds
 * reading back the exact file Montra sent (`sentFile`). The API-key PR replaces signing with the key.
 */
import type { Readable } from 'node:stream';
import { ApiRequestError, createApi, createHttp, NetworkError } from '@fdv/client';
import { createAppClient, parseConnectionString, type AppClient } from '@fdv/client/apps';
import { VAULT_CLIENT_ID_PATTERN, VAULT_SECRET_PATTERN } from '@montra/schemas';
import {
  VaultError,
  type VaultPermission,
  type VaultChange,
  type VaultChangesPage,
  type VaultCheck,
  type VaultDestination,
  type VaultDocument,
  type VaultItemState,
} from '../destinations/vault.js';
import { assertVaultAddress, type VaultTransport } from './transport.js';

/**
 * What a pasted connection string says, once read: where the vault is, which key, which vault (when it says), and the
 * key's secret when the owner chose to include it. The secret goes no further than sealing.
 */
export interface VaultConnectionString {
  address: string;
  clientId: string;
  /** The vault's installation id, when the string says it. */
  identity: string | null;
  secret: string | null;
}

/** The prefix of a connection string made before API keys (vault 0.9.0-dev.63), which signed requests instead. */
const SIGNED_PREFIX = 'fdvapp1.';

/**
 * Reads a pasted connection string (`fdvapp2.…`) through the package, strictly; one made before API keys is `old_code`,
 * anything else `invalid_code`. Checks nothing on the network, and never says what was pasted.
 */
export function readConnectionString(text: string): VaultConnectionString {
  if (text.startsWith(SIGNED_PREFIX)) throw new VaultError('old_code');
  let c: ReturnType<typeof parseConnectionString>;
  try {
    c = parseConnectionString(text);
  } catch {
    throw new VaultError('invalid_code');
  }
  return { address: c.url, clientId: c.client_id, identity: c.instance_id, secret: c.secret ?? null };
}

/** Checks a client ID and a secret are in the vault's shapes before either goes anywhere near a header (§7). */
export function assertKeyShape(clientId: string, secret: string): void {
  if (!VAULT_CLIENT_ID_PATTERN.test(clientId) || !VAULT_SECRET_PATTERN.test(secret)) {
    throw new VaultError('invalid_key');
  }
}

/**
 * The vault's refusals that mean the connection itself needs a person (§12): the app's state on the vault's side, the
 * person it acts as, or the address. Their messages are written for people.
 */
const CONNECTION_REFUSALS = new Set([
  'app_revoked',
  'app_paused',
  'app_not_approved',
  'address_not_allowed',
  'https_required',
  'member_locked',
  'member_paused',
]);

/**
 * The vault's 401s about the key itself (API keys, vault 0.9.0-dev.63): in Montra's words, so owners know to paste a new
 * one. A request with no key at all can only mean something on the way took it off, so it is "not valid" too.
 */
const KEY_REFUSALS: Record<string, 'key_revoked' | 'key_expired' | 'key_invalid'> = {
  app_key_revoked: 'key_revoked',
  app_key_expired: 'key_expired',
  app_key_invalid: 'key_invalid',
  app_key_required: 'key_invalid',
};

/**
 * Any failure from the package, or the transport, as a `VaultError`. `detail` carries codes only, never content.
 * `permission` is what the action needs, so a 403 for a key without it says which (`not_permitted`).
 */
export function asVaultError(
  e: unknown,
  transport?: VaultTransport,
  now = Date.now(),
  permission?: VaultPermission,
): VaultError {
  if (e instanceof VaultError) return e;
  const refused = transport?.refused();
  if (refused) return refused;
  // The package's short code for why (ECONNREFUSED, say), and only a code: never its `cause`, nor a message, which
  // can hold an address.
  if (e instanceof NetworkError) {
    const code = e.detail && /^[A-Z][A-Z0-9_]{1,39}$/.test(e.detail) ? ` ${e.detail}` : '';
    return new VaultError('unreachable', { detail: `${e.kind}${code}` });
  }
  if (e instanceof ApiRequestError) {
    const detail = `${e.status} ${e.code}`;
    const wait = e.retryAfterSeconds !== undefined ? new Date(now + e.retryAfterSeconds * 1000) : undefined;
    const key = KEY_REFUSALS[e.code];
    if (key) return new VaultError(key, { detail });
    if (e.code === 'scope_not_granted') {
      return new VaultError('not_permitted', { detail, ...(permission ? { permission } : {}) });
    }
    if (CONNECTION_REFUSALS.has(e.code))
      return new VaultError('connection', { vaultMessage: e.message, detail });
    if (e.code === 'app_day_full')
      return new VaultError('send_cap', { detail, ...(wait ? { heldUntil: wait } : {}) });
    if (e.code === 'app_read_day_full')
      return new VaultError('read_cap', { detail, ...(wait ? { heldUntil: wait } : {}) });
    // A wait the vault asks for (busy, too many requests, `rate_limited`): retried, never a failure (PR 3).
    if (e.status === 429 || e.status === 503 || (e.retriable && wait))
      return new VaultError('retry_later', { detail, ...(wait ? { retryAfter: wait } : {}) });
    if (e.status >= 500) return new VaultError('failed', { detail });
    return new VaultError('refused', { detail });
  }
  return new VaultError('failed', { detail: e instanceof Error ? e.name : 'unknown' });
}

/** What the server at an address says it is, before the key is sent: product, apps, and its installation id. */
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
  /** The API key: its client ID and secret, unsealed for this request or run only. */
  clientId: string;
  secret: string;
  /** The identity pinned at connect time, or null while connecting. */
  pinned: string | null;
  transport: VaultTransport;
  now?: () => number;
}

type IntakeState = Awaited<ReturnType<AppClient['status']>>;

/** The vault's refusals of a document itself (§4.5), as Montra's three reasons. */
const DOCUMENT_REFUSALS: Record<string, 'kind' | 'type' | 'size'> = {
  kind_not_allowed: 'kind',
  unsupported_type: 'type',
  too_large: 'size',
};

/** An intake state from the vault, in Montra's terms (§4). */
export function itemState(s: IntakeState): VaultItemState {
  const contentAvailable = typeof s.content_available === 'boolean' ? s.content_available : null;
  if (s.state === 'waiting') return { state: 'received', sha256: s.sha256 ?? null, contentAvailable };
  // `unavailable`: filed, but Montra may not see the document now (it may only send, say). Still filed.
  if (s.state === 'filed' || s.state === 'unavailable') {
    const filedAt = s.filed_at ? new Date(s.filed_at) : null;
    return {
      state: 'filed',
      documentId: s.document_id ?? null,
      version: s.version_id ?? null,
      sha256: s.sha256 ?? null,
      filedAt: filedAt && Number.isFinite(filedAt.getTime()) ? filedAt : null,
      contentAvailable,
    };
  }
  if (s.state === 'refused') {
    return { state: 'not_kept', why: 'refused', refusal: DOCUMENT_REFUSALS[s.refusal ?? ''] ?? null };
  }
  return {
    state: 'not_kept',
    why:
      s.removed_reason === 'expired' ? 'lapsed' : s.removed_reason === 'withdrawn' ? 'withdrawn' : 'removed',
    refusal: null,
  };
}

/** The hints a document is sent with (§3, D5), in the vault's words: only what the caller chose to give. */
export function hintsOf(doc: VaultDocument): Record<string, unknown> {
  const hints: Record<string, unknown> = { kind: doc.vaultKind };
  if (doc.title) hints.title = doc.title;
  if (doc.date) hints.issued = doc.date;
  if (doc.person) hints.person = { name: doc.person };
  if (doc.taxYear) hints.tax_year = doc.taxYear;
  const amount = doc.detail?.amounts?.[0];
  if (amount) hints.amount = { value: amount.amount, currency: amount.currency };
  if (doc.detail?.accountLast4) hints.account_last4 = doc.detail.accountLast4;
  return hints;
}

/** The bytes on their own: a Node `Buffer` may be a view into a larger pool, which a multipart body mustn't read past. */
async function bytesOf(body: Uint8Array | Readable): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return new Uint8Array(Buffer.concat(chunks));
}

const notFound = (e: unknown) => e instanceof ApiRequestError && e.status === 404;

type FeedPage = Awaited<ReturnType<AppClient['changes']>>;

/** §9: the vault says Montra's position in the feed is no longer valid: too old, or not one it knows (a restore). */
const positionRefused = (e: unknown) =>
  e instanceof ApiRequestError &&
  (e.code === 'cursor_expired' ||
    (e.status === 422 && e.code === 'validation_failed' && e.detail === 'cursor'));

/** A page of the feed in Montra's terms (§9). Never more than the port says: no amounts, issuers or account digits. */
export function feedPage(page: FeedPage, restart: boolean): VaultChangesPage {
  const changes: VaultChange[] = [];
  for (const c of page.changes ?? []) {
    if (c.change === 'unavailable') {
      changes.push({ documentId: c.document_id, change: 'out_of_reach' });
      continue;
    }
    const d = c.document;
    if (!d?.id) continue;
    const date = d.issued?.date ?? d.paper_date ?? null;
    changes.push({
      documentId: d.id,
      change: 'updated',
      own: d.own === true,
      ref: d.own === true ? (d.external_id ?? null) : null,
      kind: d.kind ? { key: d.kind.key, name: d.kind.label } : null,
      title: d.title ?? null,
      date: typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      version: d.version?.id ?? null,
      sha256: d.version?.sha256 ?? null,
    });
  }
  return { changes, cursor: page.cursor, more: page.more === true, restart };
}

/** One run's connection to a vault: opened for a request or a job run, then closed. */
export class VaultConnection implements Pick<
  VaultDestination,
  'kind' | 'check' | 'send' | 'status' | 'changes' | 'sentFile' | 'link' | 'withdraw' | 'remove' | 'close'
> {
  readonly kind = 'fdv' as const;
  private client: AppClient | null;
  private readonly origin: string;

  constructor(private readonly opts: VaultConnectionOptions) {
    // Montra's guard first (public https only, D6): the package itself would also take plain http to this machine.
    this.origin = assertVaultAddress(opts.address).origin;
    assertKeyShape(opts.clientId, opts.secret);
    this.client = createAppClient({
      url: this.origin,
      clientId: opts.clientId,
      secret: opts.secret,
      fetch: opts.transport.fetch,
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  private get app(): AppClient {
    if (!this.client) throw new VaultError('failed', { detail: 'closed' });
    return this.client;
  }

  /**
   * §2, §12.1: who is at the address (pinned, or to pin), then the connection test with the key (`GET /apps/me`). A
   * different vault at a pinned address is `identity_changed`; a key the vault refuses is `key_*`; an app paused or
   * removed in the vault is a `connection` problem; one still waiting for a person there comes back with
   * `approved: false`.
   */
  async check(): Promise<VaultCheck> {
    const identity = await identifyVault(this.origin, this.opts.transport);
    if (this.opts.pinned !== null && identity !== this.opts.pinned) {
      throw new VaultError('identity_changed', { detail: 'capabilities' });
    }
    let me: Awaited<ReturnType<AppClient['me']>>;
    try {
      me = await this.app.me();
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
    // What this request may do: the app's scopes that the key has too (dev.63).
    const scopes = new Set<string>(me.scopes ?? []);
    const k = me.key;
    return {
      approved: me.state === 'active',
      identity,
      appId: me.app.id,
      key: k
        ? {
            clientId: k.client_id,
            name: k.name ?? null,
            permissions: [...(k.permissions ?? [])],
            createdAt: k.created_at ?? null,
            expiresAt: k.expires_at ?? null,
          }
        : null,
      actsAs: me.acts_as === 'app' || me.acts_as === 'person' ? me.acts_as : null,
      householdName: me.vault?.display_name ?? null,
      // Member fields may be null (APP8): Montra shows what the vault says, or nothing.
      actingAs: me.acting_as?.name ?? null,
      sendKinds: (me.send?.kinds ?? []).map((k) => ({ key: k.key, name: k.label })),
      mediaTypes: [...(me.limits?.accepted_types ?? [])],
      mayReadBack: scopes.has('documents.read') && scopes.has('documents.download'),
      mayDelete: scopes.has('documents.delete'),
      mayRead: scopes.has('documents.read'),
      mayOpen: scopes.has('documents.read') && scopes.has('documents.links'),
      dailyResetAt: Number.isFinite(resets) ? new Date(resets) : null,
      clockOffsetMs: Number.isFinite(vaultNow) ? Math.trunc(now - vaultNow) : null,
      hints: [...(me.send?.hints ?? [])],
      limits: me.limits
        ? {
            filesPerDay: me.limits.files_per_day,
            filesToday: me.limits.files_today,
            maxUploadBytes: me.limits.max_upload_bytes,
          }
        : null,
    };
  }

  /**
   * §4: one document, under the id Montra saved before this first attempt. An id the vault already has answers with
   * what became of it, so a resend is harmless; the same id with other bytes is a `hash_mismatch`. A refusal of the
   * document itself (its kind, type or size) is an answer, not a failure. A 503 busy (nobody who can review it now, or
   * an owner changing whom Montra acts as) is a wait, retried with backoff (PR 3).
   */
  async send(doc: VaultDocument, body: Uint8Array | Readable): Promise<VaultItemState> {
    const bytes = await bytesOf(body);
    try {
      const sent = await this.app.send({
        externalId: doc.ref,
        hints: hintsOf(doc),
        file: { bytes, filename: doc.fileName, contentType: doc.mediaType },
      });
      return itemState(sent.state);
    } catch (e) {
      if (e instanceof ApiRequestError && DOCUMENT_REFUSALS[e.code]) {
        return { state: 'not_kept', why: 'refused', refusal: DOCUMENT_REFUSALS[e.code]! };
      }
      if (e instanceof ApiRequestError && e.code === 'external_id_conflict') {
        throw new VaultError('hash_mismatch', { detail: `${e.status} ${e.code}` });
      }
      throw asVaultError(e, this.opts.transport, Date.now(), 'documents.send');
    }
  }

  /** §4.4, §12.3: what became of what Montra sent, a hundred ids at a time. Ids the vault doesn't know are left out. */
  async status(refs: readonly string[]): Promise<Map<string, VaultItemState>> {
    const out = new Map<string, VaultItemState>();
    for (let i = 0; i < refs.length; i += 100) {
      let page: Awaited<ReturnType<AppClient['statuses']>>;
      try {
        page = await this.app.statuses(refs.slice(i, i + 100));
      } catch (e) {
        throw asVaultError(e, this.opts.transport, Date.now(), 'documents.send');
      }
      for (const s of page.items ?? []) out.set(s.external_id, itemState(s));
    }
    return out;
  }

  /**
   * §9: a page of the changes feed, from `cursor` (null: the beginning). A position the vault refuses, as too old or one
   * it doesn't know (after it was restored from a backup, say), starts from the beginning, and the page says so.
   */
  async changes(cursor: string | null): Promise<VaultChangesPage> {
    try {
      return feedPage(
        await this.app.changes(cursor === null ? { limit: 100 } : { cursor, limit: 100 }),
        false,
      );
    } catch (e) {
      if (cursor === null || !positionRefused(e))
        throw asVaultError(e, this.opts.transport, Date.now(), 'documents.read');
    }
    try {
      return feedPage(await this.app.changes({ limit: 100 }), true);
    } catch (e) {
      throw asVaultError(e, this.opts.transport, Date.now(), 'documents.read');
    }
  }

  /**
   * §5: the exact file Montra sent under `ref`, as the vault has it, counted against its daily read cap. Whether the vault
   * returns it is the vault's decision (its document in the trash or private to someone, or a file too large for a day's
   * reading): all of those are `unavailable`, and Montra never guesses which. A key without `documents.download` is
   * `not_permitted` instead: the key's, not the file's. The day's reading used up is `read_cap`, held until the vault
   * says. A connection problem stops the connection as for any call.
   */
  async sentFile(ref: string): Promise<{ bytes: Uint8Array; mediaType: string | null }> {
    let got: Awaited<ReturnType<AppClient['sentFile']>>;
    try {
      got = await this.app.sentFile(ref);
    } catch (e) {
      if (notFound(e)) throw new VaultError('unavailable', { detail: '404' });
      if (e instanceof ApiRequestError) {
        const detail = `${e.status} ${e.code}`;
        if (e.code === 'larger_than_daily_read' || e.status === 410)
          throw new VaultError('unavailable', { detail });
      }
      // A key that may not download is the key's, not the file's (API keys): `not_permitted`, which an owner fixes with
      // a key that may, never a file asked for again. Sending goes on.
      throw asVaultError(e, this.opts.transport, Date.now(), 'documents.download');
    }
    if (got.status !== 200) throw new VaultError('failed', { detail: `content ${got.status}` });
    return { bytes: got.bytes, mediaType: got.contentType };
  }

  /**
   * §9: a single-use link for a person's browser, made now. The caller sends the browser to it at once and keeps it
   * nowhere. A link that isn't on the vault's own https address is refused, so a vault can't send a person elsewhere.
   */
  async link(documentId: string, purpose: 'view' | 'download'): Promise<URL> {
    let minted: Awaited<ReturnType<AppClient['link']>>;
    try {
      minted = await this.app.link(documentId, purpose);
    } catch (e) {
      if (notFound(e)) throw new VaultError('unavailable', { detail: '404' });
      if (e instanceof ApiRequestError) {
        const detail = `${e.status} ${e.code}`;
        if (e.code === 'view_unavailable') throw new VaultError('cannot_view', { detail });
        if (e.code === 'app_links_full') {
          const wait =
            e.retryAfterSeconds !== undefined ? Date.now() + e.retryAfterSeconds * 1000 : undefined;
          throw new VaultError('links_full', { detail, ...(wait ? { retryAfter: new Date(wait) } : {}) });
        }
        // Not allowed to open documents is about this, not the connection: sending goes on.
        if (e.code === 'scope_not_granted') throw new VaultError('cannot_open', { detail });
      }
      throw asVaultError(e, this.opts.transport, Date.now(), 'documents.links');
    }
    let url: URL;
    try {
      url = new URL(minted.url);
    } catch {
      throw new VaultError('failed', { detail: 'link' });
    }
    if (url.protocol !== 'https:' || url.origin !== this.origin)
      throw new VaultError('failed', { detail: 'link' });
    return url;
  }

  /** §10: takes an item back from the Inbox. Answers what became of it; null when the vault never had it. */
  async withdraw(ref: string): Promise<VaultItemState | null> {
    try {
      return itemState(await this.app.withdraw(ref));
    } catch (e) {
      if (notFound(e)) return null;
      // Filed already: what it is now, for the caller to decide.
      if (e instanceof ApiRequestError && e.status === 409)
        return (await this.status([ref])).get(ref) ?? null;
      throw asVaultError(e, this.opts.transport, Date.now(), 'documents.send');
    }
  }

  /** §10: asks the vault to delete a document Montra sent; the vault does what its owner chose. Gone already is fine. */
  async remove(documentId: string): Promise<void> {
    try {
      await this.app.delete(documentId);
    } catch (e) {
      if (notFound(e)) return;
      throw asVaultError(e, this.opts.transport, Date.now(), 'documents.delete');
    }
  }

  /**
   * Lets go of the client, and with it the key. A JavaScript string can't be zeroed, so the secret is held only for this
   * connection's life (one request or one run) and dropped here; it is never copied anywhere else.
   */
  close(): void {
    this.client = null;
  }
}
