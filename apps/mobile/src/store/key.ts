/**
 * The database key (BAK-10): 256 random bits, hex-encoded, kept in the iOS Keychain / Android Keystore through
 * expo-secure-store with "when unlocked, this device only" — never in backups, never on another device.
 * Pure over injected ports so it is testable; expo bindings live in expo-driver.ts.
 */
export interface SecretPort {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export type RandomBytes = (n: number) => Uint8Array;

export const keyName = (workspaceId: string) => `montra.dbkey.v1.${workspaceId}`;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function getOrCreateKey(
  secrets: SecretPort,
  random: RandomBytes,
  workspaceId: string,
): Promise<string> {
  const name = keyName(workspaceId);
  const existing = await secrets.get(name);
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const fresh = hex(random(32));
  await secrets.set(name, fresh);
  return fresh;
}

export async function deleteKey(secrets: SecretPort, workspaceId: string): Promise<void> {
  await secrets.remove(keyName(workspaceId));
}
