/**
 * Device bindings for the store: expo-sqlite built with SQLCipher (app.config.ts `useSQLCipher: true`) and the
 * key in expo-secure-store. One encrypted database per workspace.
 */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { deleteKey, getOrCreateKey, type SecretPort } from './key';
import { keyPragma, type SqlDriver, type SqlParam } from './sql';
import { SqliteStore } from './sqlite-store';

export const secureSecrets: SecretPort = {
  get: (name) => SecureStore.getItemAsync(name),
  set: (name, value) =>
    SecureStore.setItemAsync(name, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: (name) => SecureStore.deleteItemAsync(name),
};

const dbName = (workspaceId: string) => `montra-${workspaceId}.db`;

class ExpoDriver implements SqlDriver {
  constructor(
    private db: SQLite.SQLiteDatabase,
    private readonly name: string,
  ) {}

  exec(sql: string): Promise<void> {
    return this.db.execAsync(sql);
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    await this.db.runAsync(sql, params as SqlParam[]);
  }

  all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params as SqlParam[]);
  }

  async destroy(): Promise<void> {
    await this.db.closeAsync();
    await SQLite.deleteDatabaseAsync(this.name);
  }
}

/** Opens the workspace's encrypted store, creating the key on first use. */
export async function openDeviceStore(workspaceId: string): Promise<SqliteStore> {
  const key = await getOrCreateKey(secureSecrets, (n) => Crypto.getRandomBytes(n), workspaceId);
  const name = dbName(workspaceId);
  const db = await SQLite.openDatabaseAsync(name);
  // Must be the first statement on the connection; SQLCipher then encrypts every page with this key.
  await db.execAsync(keyPragma(key));
  await db.execAsync('pragma journal_mode = wal;');
  return SqliteStore.open(new ExpoDriver(db, name), () => deleteKey(secureSecrets, workspaceId));
}
