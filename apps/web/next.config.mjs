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
  // NFR-01. Scripts stay 'unsafe-inline' because the theme script and Next's own bootstrap are inline. connect-src stays wide because
  // local AI mode calls an endpoint on the person's own network, whatever they've named it.
  async headers() {
    const kratos = process.env.NEXT_PUBLIC_KRATOS_URL ?? 'http://localhost:4433';
    const dev = process.env.NODE_ENV !== 'production';
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      'connect-src * ws: wss:',
      "frame-ancestors 'none'",
      "base-uri 'self'",
      `form-action 'self' ${kratos}`,
      "object-src 'none'",
    ].join('; ');
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
  transpilePackages: ['@montra/api-client', '@montra/domain', '@montra/i18n', '@montra/schemas'],
};

export default nextConfig;
