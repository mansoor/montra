/**
 * The workspace's key pair for the household's Family Document Vault (ADR-0054 §2, §7). Montra makes a fresh Ed25519
 * pair for each workspace and each connection, never one used before. The private key is sealed at once with
 * `FieldCrypto` (`storage_destination.secret`) and leaves this process only as that ciphertext: it is never returned,
 * logged, archived or written anywhere else. The public key and its fingerprint aren't secret, and are shown so an owner
 * can compare them with what the vault shows.
 */
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';

/** A public key as the vault takes it when someone registers Montra there: `ed25519:` and the raw key, base64url. */
export type VaultPublicKey = `ed25519:${string}`;

export interface VaultKeyPair {
  publicKey: VaultPublicKey;
  fingerprint: string;
  /** PKCS#8 DER, base64. Sealed straight away; never anywhere else. */
  pkcs8: string;
}

/**
 * A key's fingerprint as the vault shows it and as its connection code carries it: the first 128 bits of the raw
 * public key's SHA-256, in hex, in groups of four.
 */
export function fingerprintOf(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 32).match(/.{4}/g)!.join(' ');
}

/** A fresh pair, never used before. */
export function makeVaultKey(): VaultKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return {
    publicKey: `ed25519:${raw.toString('base64url')}`,
    fingerprint: fingerprintOf(raw),
    pkcs8: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
  };
}

/** The public half of a sealed private key, to check that what is sealed is what the vault was given. */
export function publicKeyOf(pkcs8: string): VaultPublicKey {
  const key = createPrivateKey({ key: Buffer.from(pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  const x = key.export({ format: 'jwk' }).x!;
  return `ed25519:${x}`;
}

const SealedKey = z.object({
  pkcs8: z.string().min(1),
  /** The vault's id for this key, from the code that named it. Null until then. */
  keyId: z.string().nullable(),
});

/**
 * What `secret_enc` holds for a vault connection, as one JSON value: the key Montra signs with and, while it is being
 * replaced, the new one (§2, §7).
 */
export const VaultSecret = z.object({
  v: z.literal(1),
  current: SealedKey,
  next: SealedKey.nullable(),
});
export type VaultSecret = z.infer<typeof VaultSecret>;
