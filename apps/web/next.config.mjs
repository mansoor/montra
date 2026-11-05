import { fileURLToPath } from 'node:url';
import { contentSecurityPolicy } from './lib/csp.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The monorepo root (one lockfile); stops Next from guessing when agent worktrees sit inside the repo.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // Lint runs as its own Turbo task with the repo's flat config.
  eslint: { ignoreDuringBuilds: true },
  // NFR-01. Evaluated when the app is built.
  async headers() {
    const csp = contentSecurityPolicy({
      kratosUrl: process.env.NEXT_PUBLIC_KRATOS_URL,
      dev: process.env.NODE_ENV !== 'production',
    });
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  // Workspace packages ship ESM in dist/ (built first by Turbo's ^build).
  transpilePackages: ['@montra/api-client', '@montra/domain', '@montra/i18n', '@montra/schemas'],
};

export default nextConfig;
