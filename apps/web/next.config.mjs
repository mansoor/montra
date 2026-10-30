import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The monorepo root (one lockfile); stops Next from guessing when agent worktrees sit inside the repo.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // Lint runs as its own Turbo task with the repo's flat config.
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages ship ESM in dist/ (built first by Turbo's ^build).
  transpilePackages: ['@montra/api-client', '@montra/domain', '@montra/i18n', '@montra/schemas'],
};

export default nextConfig;
