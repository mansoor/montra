/**
 * The vault's own fake (`@fdv/client/testing`), in this process, for tests and the e2e run only (ADR-0054 §15). It
 * checks every API key as the vault does (HTTP Basic, since vault 0.9.0-dev.63). Behind `FAMILY_VAULT_FAKE=on`, which
 * production refuses to start with, and loaded only then, so a production process never has it in hand.
 *
 * `register` stands in for the vault's owner connecting Montra in the vault's Settings and generating an API key for
 * it; `newKey` for generating another (to replace the key); `revokeKey` for revoking one. Each goes through the fake's
 * own routes, as an owner of the fake would, and gives back what the vault shows: the connection string, with or
 * without the secret, and the secret. Nothing here imitates the vault's answers.
 */
import type { createFakeVault as CreateFakeVault } from '@fdv/client/testing';
import type { VaultTransport } from './transport.js';

type FakeVault = ReturnType<typeof CreateFakeVault>;

/** What the vault shows an owner when it generates a key: the strings to paste, and the secret, this once. */
export interface FakeVaultKey {
  appId: string;
  keyId: string;
  clientId: string;
  secret: string;
  /** The connection string without the secret, and with it. */
  code: string;
  codeWithSecret: string;
}

export interface FakeKeyOptions {
  /** What the key may do: some of the app's scopes. The app's own scopes when left out. */
  permissions?: string[];
  /** How long it lasts; null: it never expires. 90 days when left out. */
  expiresInDays?: number | null;
  name?: string;
}

export interface FakeVaultHandle {
  readonly vault: FakeVault;
  /**
   * Connects Montra in the fake as its owner would, letting it send `kinds`, and generates its first key. By default it
   * acts as itself (APP8, the vault's default), reviewed by the owner. `approved: false` makes it act as another adult,
   * who must still turn it on (§2 step 4); `actsAs: 'person'` as the owner.
   */
  register(
    opts?: {
      approved?: boolean;
      actsAs?: 'app' | 'person';
      kinds?: string[];
      scopes?: string[];
    } & FakeKeyOptions,
  ): Promise<FakeVaultKey>;
  /** Another key for an app, as an owner generates one to replace the key (two live at most). */
  newKey(appId: string, opts?: FakeKeyOptions): Promise<FakeVaultKey>;
  /** An owner revokes a key: the app's next request with it is `401 app_key_revoked`. */
  revokeKey(appId: string, keyId: string): Promise<void>;
}

const OWNER = { email: 'owner@fake-vault.test', password: 'a long enough password' };
const OTHER_ADULT = 'fake-other-adult';

export async function fakeVaultTransport(): Promise<VaultTransport & { fake: FakeVaultHandle }> {
  const [{ createFakeVault }, { createApi, createHttp }] = await Promise.all([
    import('@fdv/client/testing'),
    import('@fdv/client'),
  ]);
  const vault = createFakeVault();
  const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
  let owner: { token: string; memberId: string } | null = null;

  const signIn = async () => {
    if (owner) return owner;
    const made = await api.setup({
      household_name: 'The fake family',
      display_name: 'Fake Owner',
      email: OWNER.email,
      password: OWNER.password,
    });
    // Generating or revoking a key asks the owner for a passkey or a code.
    vault.state.ownerTwoStep = true;
    vault.state.members.push({ id: OTHER_ADULT, display_name: 'Alex', role: 'adult', is_me: false });
    owner = { token: made.access_token, memberId: made.member_id };
    return owner;
  };

  const generate = async (appId: string, scopes: string[], opts: FakeKeyOptions): Promise<FakeVaultKey> => {
    const o = await signIn();
    const made = await api.connectedApps.generateKey(o.token, appId, {
      name: opts.name ?? 'Montra',
      permissions: (opts.permissions ?? scopes) as never,
      expires_in_days: opts.expiresInDays === undefined ? 90 : opts.expiresInDays,
    });
    return {
      appId,
      keyId: made.key.id,
      clientId: made.client_id,
      secret: made.secret,
      code: made.connection_string,
      codeWithSecret: made.connection_string_with_secret,
    };
  };

  const fake: FakeVaultHandle = {
    vault,
    async register(opts = {}) {
      const o = await signIn();
      const scopes = opts.scopes ?? ['documents.send'];
      const person = opts.approved === false || opts.actsAs === 'person';
      const made = await api.connectedApps.create(o.token, {
        name: 'Montra',
        ...(person
          ? { acts_as: 'person' as const, member_id: opts.approved === false ? OTHER_ADULT : o.memberId }
          : { acts_as: 'app' as const }),
        allowed_kinds: opts.kinds ?? ['utility_bill'],
        scopes: scopes as never,
      });
      return generate(made.id, scopes, opts);
    },
    async newKey(appId, opts = {}) {
      const app = vault.state.connectedApps?.find((a) => a.id === appId);
      if (!app) throw new Error('no such app in the fake vault');
      return generate(appId, app.scopes ?? ['documents.send'], opts);
    },
    async revokeKey(appId, keyId) {
      const o = await signIn();
      await api.connectedApps.revokeKey(o.token, appId, keyId);
    },
  };
  return { fetch: vault.fetch, refused: () => null, fake };
}
