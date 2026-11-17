// pnpm hooks for the whole workspace.
//
// `@fdv/client` (the Family Document Vault's MIT client, ADR-0054) lists vitest as an optional peer, for its contract
// scenarios (`@fdv/client/testing/contract`), which hold a vault's own API to the client. Montra has no vault API and
// doesn't use them. Left as it is, pnpm links that peer to the workspace's vitest, and the API's production install
// (`apps/api/Dockerfile`, `--prod`) then carries vitest, vite and esbuild. Dropping the peer here keeps them out.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === '@fdv/client') {
        if (pkg.peerDependencies) delete pkg.peerDependencies.vitest;
        if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.vitest;
      }
      return pkg;
    },
  },
};
