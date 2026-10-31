// Metro for a pnpm monorepo (ADR-0001, ADR-0009). Expo's default config already watches the workspace root
// and resolves symlinked packages; we add the `@montra/source` export condition so workspace packages resolve
// to their TypeScript sources (no build step), and map NodeNext-style `./x.js` specifiers to `./x.ts`.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['@montra/source', 'react-native', 'require', 'import', 'default'];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (err) {
    // Workspace sources import siblings as `./file.js` (TypeScript NodeNext); the file on disk is `.ts`.
    if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
      const base = moduleName.slice(0, -3);
      for (const ext of ['.ts', '.tsx']) {
        try {
          return resolve(context, base + ext, platform);
        } catch {
          // try the next extension
        }
      }
    }
    throw err;
  }
};

module.exports = config;
