import type { Readable } from 'node:stream';

/**
 * The household's Family Document Vault as a destination (ADR-0054): the `StorageDestination` port, extended for the
 * steps a mirror doesn't have. A mirror only writes and deletes paths; the vault takes documents under an id Montra
 * chooses, says what became of them, reads back what Montra sent, opens them for a person, and deletes them.
 *
 * This is Montra's side of the seam, in Montra's words, and nothing more. The adapter (`../vault/connection.ts`) is
 * written over the vault's own published client package, `@fdv/client`, which sends the vault API key an owner pasted
 * on every request (HTTP Basic, since vault 0.9.0-dev.63; owner's answer 1); no vault client of Montra's own lives in
 * this repository. PR 2 builds the connection test (`check`); PR 3 sending, asking what became of a document,
 * withdrawing it and deleting it; PR 4 the changes feed and links; PR 5 reading back the file Montra sent
 * (`sentFile`).
 */
export interface VaultDestination {
  readonly kind: 'fdv';

  /**
   * §2, §12.1: the connection test (`GET /apps/me`, with the key). Also confirms the server is still the vault Montra
   * pinned; a different one at the same address is a `VaultError('identity_changed')`.
   */
  check(): Promise<VaultCheck>;

  /** §4: sends one document under its id. A resend under the same id is harmless. */
  send(doc: VaultDocument, body: Uint8Array | Readable): Promise<VaultItemState>;

  /** §4.4, §12.3: what became of documents Montra sent, by id. An id the vault doesn't know is left out of the map. */
  status(refs: readonly string[]): Promise<Map<string, VaultItemState>>;

  /**
   * §9: one page of the changes feed. `null` starts from the beginning, a full read of what Montra may see now. A
   * position the vault says is no longer valid starts from the beginning too, and the page says so (`restart`). The
   * feed may name documents Montra didn't send; the caller uses only its own (§1, one direction).
   */
  changes(cursor: string | null): Promise<VaultChangesPage>;

  /**
   * §5: the exact file Montra sent under `ref`, counted against the vault's daily read cap. Asked by Montra's own id, not
   * the vault's document, so it is the file Montra sent even after the family put a newer version in. A file the vault
   * won't return is a `VaultError('unavailable')`, and Montra never guesses why; the day's reading used up is
   * `read_cap`. The caller checks the hash.
   */
  sentFile(ref: string): Promise<{ bytes: Uint8Array; mediaType: string | null }>;

  /**
   * §9: a single-use link for a person's browser, made when they click. The caller redirects to it at once and never
   * stores, logs, caches, sends or renders it.
   */
  link(documentId: string, purpose: 'view' | 'download'): Promise<URL>;

  /** §10: asks the vault to delete a filed document; the vault does what its owner set for Montra's deletes. */
  remove(documentId: string): Promise<void>;

  /**
   * §10: withdraws an item still in someone's Inbox, so the family isn't asked about a file Montra deleted. Answers
   * what became of it (filed already, say), or null for an id the vault doesn't know.
   */
  withdraw(ref: string): Promise<VaultItemState | null>;

  close(): void;
}

/** What the connection test tells Montra (§2 step 3, §3, §12.1). */
export interface VaultCheck {
  /** Someone on the vault's side has approved Montra. */
  approved: boolean;
  /** The vault's own identity, pinned at connect time. */
  identity: string;
  householdName: string | null;
  /** The vault's kinds Montra may send, with the names the vault shows. */
  sendKinds: { key: string; name: string }[];
  /** The file types the vault keeps (§3, D8). Others stay in Montra only. */
  mediaTypes: string[];
  /** Montra may read back and download what it sent. */
  mayReadBack: boolean;
  /** The vault lets Montra delete what it sent. */
  mayDelete: boolean;
  /** §9: the vault lets Montra read its changes feed (and so see what became of what it sent). */
  mayRead: boolean;
  /** §9: the vault lets Montra make links for a person to open a document. */
  mayOpen: boolean;
  /** Montra's app in the vault: a new key must be for the same one (§2). */
  appId: string;
  /**
   * The key that made this request, as the vault describes it (never its secret): its permissions and when it expires
   * (null: never), so Montra can warn owners before it does (§12).
   */
  key: {
    clientId: string;
    name: string | null;
    permissions: string[];
    createdAt: string | null;
    expiresAt: string | null;
  } | null;
  /** Whom Montra acts as (APP8): itself, or one person of the family. */
  actsAs: 'app' | 'person' | null;
  /** The vault's next daily reset, when it says. */
  dailyResetAt: Date | null;
  /** Montra's clock against the vault's, measured from this answer (§7). Kept for support; no longer needed to sign. */
  clockOffsetMs: number | null;
  /**
   * Whom Montra acts as in the vault, by the name the vault shows: the person's, or Montra's own app name when it acts
   * as itself. The vault decides where documents land.
   */
  actingAs: string | null;
  /** The hints the vault takes with a document (§3): Montra sends no others. */
  hints: string[];
  /** The vault's limits on sending, as of this answer (§12). */
  limits: { filesPerDay: number; filesToday: number; maxUploadBytes: number } | null;
}

/** What Montra says about a document (§3, D5). Never transactions, ledger data, or anything a person didn't upload. */
export interface VaultDocument {
  /** Chosen once and saved before the first send (§4.1). */
  ref: string;
  /** The group's mapped vault kind. */
  vaultKind: string;
  title: string;
  fileName: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  /** The paper's date, `YYYY-MM-DD`, when known. */
  date: string | null;
  /** The household member it belongs to, by name, when known and the vault takes the hint. */
  person: string | null;
  /** A tax document's year, when known. */
  taxYear?: number | null;
  /** Only with "Describe documents in more detail": an amount as a decimal string and an account's last four digits. */
  detail?: { amounts?: { amount: string; currency: string }[]; accountLast4?: string };
}

/**
 * §4: where a document is in the vault. `contentAvailable` is whether the vault says Montra could download the exact
 * file again (null when it doesn't say). A filed document Montra may not read has no `documentId`.
 */
export type VaultItemState =
  | { state: 'received'; sha256: string | null; contentAvailable: boolean | null }
  | {
      state: 'filed';
      documentId: string | null;
      version: string | null;
      sha256: string | null;
      filedAt: Date | null;
      contentAvailable: boolean | null;
    }
  | {
      state: 'not_kept';
      /** The family removed it, it lapsed undecided, the vault refused it, or Montra withdrew it. */
      why: 'removed' | 'lapsed' | 'refused' | 'withdrawn';
      /** For a refusal: a kind Montra may not send, a type the vault doesn't keep, or too large. */
      refusal: 'kind' | 'type' | 'size' | null;
    };

/**
 * §9: one page of the feed. `restart`: the vault said Montra's position is no longer valid, so this page starts a full
 * read from the beginning, and anything Montra holds that the full read doesn't show is out of reach.
 */
export interface VaultChangesPage {
  changes: VaultChange[];
  cursor: string;
  more: boolean;
  restart: boolean;
}

/**
 * §9: one line of the feed. `updated`: the document as the vault has it now, its newest version included. `own` says
 * Montra's send made it (since vault 0.9.0-dev.63, whatever newer versions the family added since), and `ref` is then
 * Montra's id for it; a document that isn't Montra's own isn't one Montra sent. `out_of_reach`: Montra may no longer see
 * it, and never why.
 */
export type VaultChange =
  | {
      documentId: string;
      change: 'updated';
      own: boolean;
      ref: string | null;
      /** The vault's kind, by its key and the name it shows. */
      kind: { key: string; name: string } | null;
      title: string | null;
      /** The paper's date, `YYYY-MM-DD`. */
      date: string | null;
      version: string | null;
      sha256: string | null;
    }
  | { documentId: string; change: 'out_of_reach' };

export type VaultErrorCode =
  /** Worth trying again after `retryAfter` (plus jitter). */
  | 'retry_later'
  /** The day's sending, or reading, is used up until `heldUntil`. Not a failure (§12). */
  | 'send_cap'
  | 'read_cap'
  /** The connection itself needs a person: the app paused, removed or not approved in the vault. Stops the whole
   *  connection (§12). */
  | 'connection'
  /** The vault API key no longer works: revoked, expired, or not valid. An owner pastes a new one. Stops the connection. */
  | 'key_revoked'
  | 'key_expired'
  | 'key_invalid'
  /** A connection made with a signing key before the vault used API keys: it needs a new key. Stops the connection. */
  | 'key_signed'
  /** The key lacks the permission an action needs (`permission`). Sending without it stops the connection. */
  | 'not_permitted'
  /** A different vault answers at the pinned address (§2). */
  | 'identity_changed'
  /** The vault's hash of a document doesn't match Montra's (§4.3). */
  | 'hash_mismatch'
  /** The vault won't return the document (§5a), or open it (§9). */
  | 'unavailable'
  /** §9: too many links this hour; worth asking again after `retryAfter`. Not a failure. */
  | 'links_full'
  /** §9: the vault can't show this type of file as pages; a download link may do instead. */
  | 'cannot_view'
  /** §9: the vault doesn't let Montra open documents for a person. */
  | 'cannot_open'
  /** Can't reach the vault: network, timeout, TLS. */
  | 'unreachable'
  /** The address guard refused the vault's address (§8). */
  | 'not_allowed_host'
  /** The vault turned down this request; not retried. */
  | 'refused'
  /** §2: what was pasted isn't a connection string from the vault at all. */
  | 'invalid_code'
  /** §2: a connection string from before the vault used API keys (`fdvapp1.`). */
  | 'old_code'
  /** §2: the connection string doesn't include the secret, and none was pasted. */
  | 'secret_needed'
  /** §2: the client ID or the secret isn't in the vault's shape. */
  | 'invalid_key'
  /** §2: a new key is for another app in the vault than the one Montra is connected as. */
  | 'other_app'
  /** §2: the server at the code's address isn't a Family Document Vault that takes apps. */
  | 'not_a_vault'
  /** The vault failed; retried with backoff. */
  | 'failed';

const MESSAGES: Record<VaultErrorCode, string> = {
  retry_later: 'The vault asked Montra to wait a little before trying again.',
  send_cap: 'Waiting for the vault’s daily limit on documents sent.',
  read_cap: 'Waiting for the vault’s daily limit on documents read.',
  connection: 'The vault needs someone to look at Montra’s connection there.',
  key_revoked: 'The vault key was revoked. An owner needs to paste a new key.',
  key_expired: 'The vault key has expired. An owner needs to paste a new key.',
  key_invalid: 'The vault key isn’t valid. An owner needs to paste a new key.',
  key_signed:
    'This connection was made before the vault used API keys, and has stopped working. An owner needs to generate an API key for Montra in the vault and paste it here.',
  not_permitted: 'The vault key doesn’t allow this. An owner can paste a key that does.',
  identity_changed:
    'A different vault answered at this address. Montra stopped sending until the connection is checked.',
  hash_mismatch: 'The vault received a different file from the one Montra sent.',
  unavailable: 'The vault didn’t return this file.',
  links_full:
    'Montra has opened as many documents from the vault as it may this hour. Try again a little later.',
  cannot_view: 'The vault can’t show this kind of file as pages.',
  cannot_open: 'The vault doesn’t let Montra open documents. An owner of the vault can allow it there.',
  unreachable: 'Montra couldn’t reach the vault. Check its address, and that it’s reachable over https.',
  not_allowed_host: 'Montra can’t connect to that address. Use the vault’s public address, over https.',
  refused: 'The vault turned this down.',
  invalid_code:
    'That isn’t a connection string from Family Document Vault. Copy the whole string and paste it again.',
  old_code:
    'That connection string is from before the vault used API keys. Generate an API key for Montra in the vault, and paste its connection string.',
  secret_needed:
    'That connection string doesn’t include the secret. Paste the client secret the vault showed with the key too.',
  invalid_key:
    'That isn’t a client ID and secret from Family Document Vault. A client ID starts fdvc_ and a secret fdvs_.',
  other_app:
    'That key is for a different app in the vault from the one Montra is connected as. Generate the key for that app, or disconnect and connect again.',
  not_a_vault: 'The address in that code isn’t a Family Document Vault that accepts connected apps.',
  failed: 'The vault couldn’t take this just now.',
};

export type VaultPermission =
  'documents.send' | 'documents.read' | 'documents.download' | 'documents.links' | 'documents.delete';

/** What each permission a vault key may lack is for, as the words for a 403 on that action. */
export const PERMISSION_WORDS: Record<VaultPermission, string> = {
  'documents.send': 'The vault key doesn’t allow sending documents. An owner needs to paste a key that does.',
  'documents.read':
    'The vault key doesn’t allow reading what became of Montra’s documents. An owner can paste a key that does.',
  'documents.download':
    'The vault key doesn’t allow downloading Montra’s documents. An owner can paste a key that does.',
  'documents.links': 'The vault key doesn’t allow opening documents. An owner can paste a key that does.',
  'documents.delete': 'The vault key doesn’t allow deleting documents. An owner can paste a key that does.',
};

/** The key problems an owner fixes by pasting a new key, as the DTO says them. */
export const KEY_PROBLEMS = {
  key_revoked: 'revoked',
  key_expired: 'expired',
  key_invalid: 'invalid',
  key_signed: 'signed',
} as const;
export type KeyProblem = (typeof KEY_PROBLEMS)[keyof typeof KEY_PROBLEMS];

/** What went wrong with the vault, in words a person can act on. `detail` is for the log, never for a client. */
export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    readonly opts: {
      /** The vault's own message, written for people; shown to owners for `connection`. */
      vaultMessage?: string;
      retryAfter?: Date;
      heldUntil?: Date;
      detail?: string;
      /** For `not_permitted`: the permission the action needs. */
      permission?: VaultPermission;
    } = {},
  ) {
    super(code === 'not_permitted' && opts.permission ? PERMISSION_WORDS[opts.permission] : MESSAGES[code]);
    this.name = 'VaultError';
  }

  /** The key needs replacing, and why, in the DTO's terms; null for anything else. */
  get keyProblem(): KeyProblem | null {
    return Object.hasOwn(KEY_PROBLEMS, this.code)
      ? KEY_PROBLEMS[this.code as keyof typeof KEY_PROBLEMS]
      : null;
  }

  /** The words to show: the vault's own for a connection problem, Montra's otherwise. */
  get shown(): string {
    return this.code === 'connection' && this.opts.vaultMessage ? this.opts.vaultMessage : this.message;
  }

  /**
   * Stops the whole connection at once (`needs_vault`, or stopped for a changed identity), not just this document: the
   * app's state in the vault, its identity, a key that no longer works, or a key that may not send. A key that lacks
   * another permission stops only the action that needs it.
   */
  get stopsConnection(): boolean {
    return (
      this.code === 'connection' ||
      this.code === 'identity_changed' ||
      this.keyProblem !== null ||
      (this.code === 'not_permitted' && this.opts.permission === 'documents.send')
    );
  }

  /** A daily cap is a hold, not a failure: it doesn't count toward `failing` (§12). */
  get countsAsFailure(): boolean {
    return (
      this.code !== 'send_cap' &&
      this.code !== 'read_cap' &&
      this.code !== 'links_full' &&
      this.code !== 'cannot_view' &&
      this.code !== 'cannot_open'
    );
  }

  /** Tried again later on its own: waits and server failures, not refusals or anything a person must look at. */
  get retryable(): boolean {
    return this.code === 'retry_later' || this.code === 'failed' || this.code === 'unreachable';
  }
}
