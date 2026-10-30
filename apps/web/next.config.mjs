/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Lint runs as its own Turbo task with the repo's flat config.
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages ship ESM in dist/ (built first by Turbo's ^build).
  transpilePackages: ['@montra/api-client', '@montra/domain', '@montra/schemas'],
};

export default nextConfig;
