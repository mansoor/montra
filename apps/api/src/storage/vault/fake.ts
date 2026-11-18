/**
 * The vault's own fake (`@fdv/client/testing`), in this process, for tests and the e2e run only (ADR-0054 §15). It
 * checks every signature as the vault does. Behind `FAMILY_VAULT_FAKE=on`, which production refuses to start with, and
 * loaded only then, so a production process never has it in hand.
 *
 * `register` stands in for the vault's owner registering Montra in the vault's Settings: it does that through the
 * fake's own routes, and gives back the code the vault would show. Nothing here imitates the vault's answers.
 */
import type { createFakeVault as CreateFakeVault } from '@fdv/client/testing';
import type { VaultTransport } from './transport.js';

type FakeVault = ReturnType<typeof CreateFakeVault>;

export interface FakeVaultHandle {
  readonly vault: FakeVault;
  /**
   * Registers Montra's public key in the fake as its owner would, letting it send `kinds`. With `approved: false` the
   * app acts as another adult, who must still turn it on (§2 step 4). Returns the connection code and the app's id.
   */
  register(
    publicKey: string,
    opts?: { approved?: boolean; kinds?: string[]; scopes?: string[] },
  ): Promise<{ code: string; appId: string }>;
  /** The code the vault's Settings shows for an app now: for its newest key. */
  codeFor(appId: string): Promise<string>;
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
    vault.state.ownerTwoStep = true;
    vault.state.members.push({ id: OTHER_ADULT, display_name: 'Alex', role: 'adult', is_me: false });
    owner = { token: made.access_token, memberId: made.member_id };
    return owner;
  };

  const fake: FakeVaultHandle = {
    vault,
    async register(publicKey, opts = {}) {
      const o = await signIn();
      const made = await api.connectedApps.create(o.token, {
        name: 'Montra',
        member_id: opts.approved === false ? OTHER_ADULT : o.memberId,
        public_key: publicKey,
        allowed_kinds: opts.kinds ?? ['utility_bill'],
        ...(opts.scopes ? { scopes: opts.scopes as never } : {}),
      });
      return { code: made.connection_string, appId: made.id };
    },
    async codeFor(appId) {
      const o = await signIn();
      const app = (await api.connectedApps.list(o.token)).items.find((a) => a.id === appId);
      if (!app) throw new Error('no such app in the fake vault');
      return app.connection_string;
    },
  };
  return { fetch: vault.fetch, refused: () => null, fake };
}
