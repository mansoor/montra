import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import type { KmsPort } from './crypto.service.js';

export type VaultFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The Transit engine of HashiCorp Vault or OpenBao (ADR-0050 §3): like AWS KMS, the master key never leaves it, and
 * data keys are wrapped and unwrapped there. The wrapped value is Vault's own `vault:vN:…` string, stored as bytes.
 *
 * The token comes from VAULT_TOKEN, or from VAULT_TOKEN_FILE read again on each call, so a Vault Agent that renews the
 * token in that file is picked up without a restart.
 */
export class VaultKms implements KmsPort {
  private readonly base: string;
  private readonly key: string;

  constructor(
    private readonly config: AppConfig,
    private readonly http: VaultFetch = (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
  ) {
    const mount = config.VAULT_TRANSIT_MOUNT.replace(/^\/+|\/+$/g, '');
    this.base = `${(config.VAULT_ADDR ?? '').replace(/\/+$/, '')}/v1/${mount}`;
    this.key = encodeURIComponent(config.VAULT_TRANSIT_KEY);
  }

  async wrap(dataKey: Buffer): Promise<Buffer> {
    const out = await this.call('encrypt', { plaintext: dataKey.toString('base64') });
    if (typeof out.ciphertext !== 'string') throw new Error('Vault returned no ciphertext');
    return Buffer.from(out.ciphertext, 'utf8');
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const ciphertext = wrapped.toString('utf8');
    // Not one of Vault's: don't send another adapter's bytes across the network.
    if (!/^vault:v\d+:/.test(ciphertext)) throw new Error('Not a Vault Transit ciphertext');
    const out = await this.call('decrypt', { ciphertext });
    if (typeof out.plaintext !== 'string') throw new Error('Vault returned no plaintext');
    return Buffer.from(out.plaintext, 'base64');
  }

  private token(): string {
    const file = this.config.VAULT_TOKEN_FILE;
    return file ? readFileSync(file, 'utf8').trim() : (this.config.VAULT_TOKEN ?? '');
  }

  private async call(op: 'encrypt' | 'decrypt', body: object): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-vault-token': this.token(),
    };
    if (this.config.VAULT_NAMESPACE) headers['x-vault-namespace'] = this.config.VAULT_NAMESPACE;
    const res = await this.http(`${this.base}/${op}/${this.key}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Vault's errors name the key and the reason, never the plaintext.
      const detail = await res.text().catch(() => '');
      throw new Error(`Vault ${op} failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Record<string, unknown> };
    return json.data ?? {};
  }
}
