/**
 * The vault API key Montra uses for a workspace (ADR-0054 §2, §7; API keys, vault 0.9.0-dev.63). An owner generates it
 * in the vault, for Montra's app there, and pastes it into Montra: a client ID (`fdvc_…`, which names the key and isn't
 * secret) and a secret (`fdvs_…`). The secret is sealed at once with `FieldCrypto` (`storage_destination.secret`) and
 * leaves this process only as that ciphertext: it is never returned, logged, archived, included in a backup or written
 * anywhere else, and no DTO carries it.
 *
 * A connection made before API keys holds a sealed Ed25519 private key instead (`v: 1`). The vault no longer takes
 * signed requests, so such a connection needs a new key: it is never unsealed for use, and its sealed key is replaced
 * when an owner pastes one.
 */
import { VAULT_CLIENT_ID_PATTERN, VAULT_SECRET_PATTERN } from '@montra/schemas';
import { z } from 'zod';

/** What `secret_enc` holds for a vault connection, as one JSON value: the API key's client ID and its secret. */
export const VaultSecret = z.object({
  v: z.literal(2),
  clientId: z.string().regex(VAULT_CLIENT_ID_PATTERN),
  secret: z.string().regex(VAULT_SECRET_PATTERN),
});
export type VaultSecret = z.infer<typeof VaultSecret>;

/** An API key as Montra is given it: the client ID and the secret, both in the vault's shapes. */
export interface VaultKey {
  clientId: string;
  secret: string;
}

/** The sealed value for a key: the one shape `secret_enc` is written in now. */
export const sealedKey = (key: VaultKey): VaultSecret =>
  VaultSecret.parse({ v: 2, clientId: key.clientId, secret: key.secret });
