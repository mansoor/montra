import type { Readable } from 'node:stream';

/**
 * The household's Family Document Vault as a destination (ADR-0054): the `StorageDestination` port, extended for the
 * steps a mirror doesn't have. A mirror only writes and deletes paths; the vault takes documents under an id Montra
 * chooses, says what became of them, reads back what Montra sent, opens them for a person, and deletes them.
 *
 * This is Montra's side of the seam, in Montra's words, and nothing more. The adapter (`../vault/connection.ts`) is
 * written over the vault's own published client package, `@fdv/client`, which does the signing (owner's answer 1); no
 * signer or vault client of Montra's own lives in this repository. PR 2 builds the connection test (`check`); PR 3
 * sending, asking what became of a document, withdrawing it and deleting it; reading back, the feed and links come with
 * the PRs that use them.
 */
export interface VaultDestination {
  readonly kind: 'fdv';

  /**
   * §2, §12.1: the signed connection test. Also confirms the server is still the vault Montra pinned; a different one
   * at the same address is a `VaultError('identity_changed')`.
   */
  check(): Promise<VaultCheck>;

  /** §4: sends one document under its id. Signed afresh on every attempt; a resend under the same id is harmless. */
  send(doc: VaultDocument, body: Uint8Array | Readable): Promise<VaultItemState>;

  /** §4.4, §12.3: what became of documents Montra sent, by id. An id the vault doesn't know is left out of the map. */
  status(refs: readonly string[]): Promise<Map<string, VaultItemState>>;

  /** §9: one page of the changes feed for documents Montra sent. `null` starts from the beginning. */
  changes(cursor: string | null): Promise<VaultChangesPage>;

  /**
   * §5: the bytes of a document Montra sent, counted against the vault's daily read cap. A document the vault won't
   * return is a `VaultError('unavailable')`; Montra never guesses why.
   */
  download(documentId: string): Promise<{ body: Readable; bytes: number; sha256: string | null }>;

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

  /** §2: registers a new public key under the current one. Montra keeps signing with the current key until confirmed. */
  registerKey(publicKey: string): Promise<void>;

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
  /** A key change Montra registered has been confirmed on the vault's side (§2). */
  newKeyConfirmed: boolean;
  /** The vault's next daily reset, when it says. */
  dailyResetAt: Date | null;
  /** Montra's clock against the vault's, measured from this answer (§7). */
  clockOffsetMs: number | null;
  /** Whom Montra acts as in the vault, by the name the vault shows. The vault decides where documents land. */
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

/** §9: one page of the feed. `restart` says Montra's position is no longer valid and the whole feed must be read again. */
export interface VaultChangesPage {
  changes: VaultChange[];
  cursor: string;
  more: boolean;
  restart: boolean;
}

export type VaultChange =
  | {
      documentId: string;
      change: 'updated';
      kind: string | null;
      title: string | null;
      date: string | null;
      version: string | null;
      newerVersion: boolean;
    }
  | { documentId: string; change: 'out_of_reach' };

export type VaultErrorCode =
  /** Worth trying again after `retryAfter` (plus jitter). */
  | 'retry_later'
  /** The day's sending, or reading, is used up until `heldUntil`. Not a failure (§12). */
  | 'send_cap'
  | 'read_cap'
  /** The connection itself needs a person: key not recognised or not confirmed, app paused, removed, not approved or
   *  lacking a permission, or the clock is off. Stops the whole connection (§12). */
  | 'connection'
  /** A different vault answers at the pinned address (§2). */
  | 'identity_changed'
  /** The vault's hash of a document doesn't match Montra's (§4.3). */
  | 'hash_mismatch'
  /** The vault won't return the document (§5a). */
  | 'unavailable'
  /** Can't reach the vault: network, timeout, TLS. */
  | 'unreachable'
  /** The address guard refused the vault's address (§8). */
  | 'not_allowed_host'
  /** The vault turned down this request; not retried. */
  | 'refused'
  /** §2: the pasted code isn't a connection code at all. */
  | 'invalid_code'
  /** §2: the pasted code names a key other than the one Montra made for this workspace. */
  | 'other_key'
  /** §2: the server at the code's address isn't a Family Document Vault that takes apps. */
  | 'not_a_vault'
  /** The vault failed; retried with backoff. */
  | 'failed';

const MESSAGES: Record<VaultErrorCode, string> = {
  retry_later: 'The vault asked Montra to wait a little before trying again.',
  send_cap: 'Waiting for the vault’s daily limit on documents sent.',
  read_cap: 'Waiting for the vault’s daily limit on documents read.',
  connection: 'The vault needs someone to look at Montra’s connection there.',
  identity_changed:
    'A different vault answered at this address. Montra stopped sending until the connection is checked.',
  hash_mismatch: 'The vault received a different file from the one Montra sent.',
  unavailable: 'The vault didn’t return this file.',
  unreachable: 'Montra couldn’t reach the vault. Check its address, and that it’s reachable over https.',
  not_allowed_host: 'Montra can’t connect to that address. Use the vault’s public address, over https.',
  refused: 'The vault turned this down.',
  invalid_code:
    'That isn’t a connection code from Family Document Vault. Copy the whole code and paste it again.',
  other_key:
    'That code is for a different key from the one Montra made for this workspace. Register the key shown here, then paste the code the vault gives for it.',
  not_a_vault: 'The address in that code isn’t a Family Document Vault that accepts connected apps.',
  failed: 'The vault couldn’t take this just now.',
};

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
    } = {},
  ) {
    super(MESSAGES[code]);
    this.name = 'VaultError';
  }

  /** The words to show: the vault's own for a connection problem, Montra's otherwise. */
  get shown(): string {
    return this.code === 'connection' && this.opts.vaultMessage ? this.opts.vaultMessage : this.message;
  }

  /** Stops the whole connection at once (`needs_vault`, or stopped for a changed identity), not just this document. */
  get stopsConnection(): boolean {
    return this.code === 'connection' || this.code === 'identity_changed';
  }

  /** A daily cap is a hold, not a failure: it doesn't count toward `failing` (§12). */
  get countsAsFailure(): boolean {
    return this.code !== 'send_cap' && this.code !== 'read_cap';
  }

  /** Tried again later on its own: waits and server failures, not refusals or anything a person must look at. */
  get retryable(): boolean {
    return this.code === 'retry_later' || this.code === 'failed' || this.code === 'unreachable';
  }
}
