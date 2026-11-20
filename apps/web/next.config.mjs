import { fileURLToPath } from 'node:url';
import { securityHeaders } from './lib/csp.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The monorepo root (one lockfile); stops Next from guessing when agent worktrees sit inside the repo.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // Lint runs as its own Turbo task with the repo's flat config.
  eslint: { ignoreDuringBuilds: true },
  // NFR-01. Evaluated when the app is built.
  // Responses under /api (the files the viewers show in an <iframe>) may be framed by Montra's own pages; the later rule
  // overrides the same header keys for those paths. Pages are never framed.
  async headers() {
    const options = {
      kratosUrl: process.env.NEXT_PUBLIC_KRATOS_URL,
      dev: process.env.NODE_ENV !== 'production',
    };
    return [
      { source: '/:path*', headers: securityHeaders(options) },
      { source: '/api/:path*', headers: securityHeaders({ ...options, frameable: true }) },
    ];
  },
  // Workspace packages ship ESM in dist/ (built first by Turbo's ^build).
  transpilePackages: [
    '@montra/api-client',
    '@montra/domain',
    '@montra/i18n',
    '@montra/password',
    '@montra/schemas',
  ],
};

export default nextConfig;
