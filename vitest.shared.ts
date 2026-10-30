import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/** Resolve workspace packages to their TypeScript sources in tests (no build step needed). */
export const sourceAliases = {
  '@montra/domain': pkg('domain'),
  '@montra/db': pkg('db'),
  '@montra/schemas': pkg('schemas'),
  '@montra/i18n': pkg('i18n'),
  '@montra/importers': pkg('importers'),
  '@montra/api-client': pkg('api-client'),
};
