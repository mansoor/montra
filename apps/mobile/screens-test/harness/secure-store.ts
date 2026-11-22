/** expo-secure-store in memory: where the session keeps its token and the last workspace. */
const items = new Map<string, string>();

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

export async function getItemAsync(key: string): Promise<string | null> {
  return items.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  items.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  items.delete(key);
}

/** Start each test signed out, with nothing saved. */
export function resetSecureStore(): void {
  items.clear();
}
