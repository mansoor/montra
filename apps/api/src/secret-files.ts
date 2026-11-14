import { readFileSync, statSync } from 'node:fs';

/**
 * Secrets from files (ADR-0050 §2): any setting `NAME` can be given as `NAME_FILE`, a path to a file holding the value,
 * the way Docker and Kubernetes secrets arrive. Setting both is an error, so nobody wonders which one won.
 */
export interface SecretFileSystem {
  read(path: string): string;
  /** The file's permission bits, or `undefined` where the platform has none worth checking (Windows). */
  mode(path: string): number | undefined;
}

export const realFiles: SecretFileSystem = {
  read: (path) => readFileSync(path, 'utf8'),
  mode: (path) => (process.platform === 'win32' ? undefined : statSync(path).mode & 0o777),
};

/** A file's value: one trailing line break is dropped, since editors and `echo` add one. */
function fileValue(files: SecretFileSystem, name: string, path: string): string {
  let value: string;
  try {
    value = files.read(path);
  } catch (e) {
    throw new Error(`${name}_FILE: can't read ${path} (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  return value.replace(/\r?\n$/, '');
}

/**
 * Returns `env` with each `NAME_FILE` among `names` replaced by `NAME` and the file's contents. Empty values count as
 * not set, as ECS fills every secret it's given.
 */
export function resolveSecretFiles(
  env: Record<string, string | undefined>,
  names: readonly string[],
  files: SecretFileSystem = realFiles,
): { env: Record<string, string>; fromFiles: Map<string, string> } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  const fromFiles = new Map<string, string>();
  for (const name of names) {
    const path = out[`${name}_FILE`];
    if (!path) continue;
    if (out[name] !== undefined) throw new Error(`Set ${name} or ${name}_FILE, not both`);
    out[name] = fileValue(files, name, path);
    fromFiles.set(name, path);
  }
  return { env: out, fromFiles };
}

/**
 * A master key file must be readable by its owner alone (ADR-0050 §3): with the database backup it is everyone's data.
 * Like ssh, any group or other permission is refused.
 */
export function assertPrivateKeyFile(name: string, path: string, files: SecretFileSystem = realFiles): void {
  const mode = files.mode(path);
  if (mode !== undefined && (mode & 0o077) !== 0) {
    throw new Error(
      `${name}_FILE ${path} can be read or changed by others (mode ${mode.toString(8).padStart(3, '0')}). ` +
        `Make it 0400 or 0600, owned by the user the service runs as.`,
    );
  }
}

/** One secret for a command-line tool, from `NAME` or `NAME_FILE`. */
export function secretFromEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
  files: SecretFileSystem = realFiles,
): string | undefined {
  return resolveSecretFiles(env, [name], files).env[name];
}
