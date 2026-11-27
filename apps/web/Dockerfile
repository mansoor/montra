# Montra web (Next.js, `next start`). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t montra/web \
#     --build-arg NEXT_PUBLIC_AUTH_MODE=kratos \
#     --build-arg NEXT_PUBLIC_KRATOS_URL=https://auth.example.com \
#     --build-arg NEXT_PUBLIC_APP_URL=https://app.example.com \
#     --build-arg NEXT_PUBLIC_API_WS_URL=wss://api.example.com/v1/ws .
# NEXT_PUBLIC_* values are compiled into the browser bundle, so each environment needs its own image.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
ARG NEXT_PUBLIC_AUTH_MODE=kratos
ARG NEXT_PUBLIC_KRATOS_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_API_WS_URL
# Optional: Cloudflare Turnstile's site key, for the CAPTCHA after repeated failures (ADR-0056). Empty: off.
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_AUTH_MODE=$NEXT_PUBLIC_AUTH_MODE \
    NEXT_PUBLIC_KRATOS_URL=$NEXT_PUBLIC_KRATOS_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_API_WS_URL=$NEXT_PUBLIC_API_WS_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
RUN corepack enable
WORKDIR /repo
# `next build` type-checks everything in tsconfig.json, including vitest.config.ts, which imports vitest.shared.ts.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.shared.ts ./
COPY packages ./packages
COPY apps/web ./apps/web
# `--filter .` keeps the root dev dependencies (TypeScript) available to the package builds.
RUN pnpm install --frozen-lockfile --filter "@montra/web..." --filter .
RUN pnpm --filter "@montra/web..." run build
# Reinstall production dependencies from the same lockfile. `pnpm deploy --legacy` resolves versions afresh,
# so the image could differ from what CI tested. `next start` loads next.config.mjs, which imports lib/csp.mjs, so that
# file stays; the build fails here if the config can't load.
RUN rm -rf node_modules apps/web/node_modules packages/*/node_modules apps/web/.next/cache \
 && pnpm install --frozen-lockfile --prod --filter "@montra/web..." \
 && find apps/web/lib -type f ! -name csp.mjs -delete \
 && rm -rf vitest.shared.ts apps/web/app apps/web/components apps/web/e2e apps/web/middleware.ts \
    apps/web/playwright.config.ts apps/web/vitest.config.ts apps/web/tsconfig.json apps/web/postcss.config.mjs \
    apps/web/next-env.d.ts packages/*/src packages/*/test packages/*/tsconfig*.json packages/*/vitest.config.ts \
 && rm -rf node_modules/.pnpm/@next+swc-*musl* node_modules/.pnpm/@img+sharp-*musl* \
 && test -f apps/web/.next/BUILD_ID \
 && (cd apps/web && node --input-type=module -e "await import('./next.config.mjs')")

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
# The base image still has apt 2.6.1 (CVE-2026-109518, fixed in 2.6.2) and Linux-PAM 1.5.2-6+deb12u2 (CVE-2025-6020, fixed
# in deb12u3). Nothing here runs apt or PAM, but they ship in the image. Delete this once the base image has the fixes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade apt libapt-pkg6.0 libpam-modules libpam-modules-bin \
    libpam-runtime libpam0g \
 && rm -rf /var/lib/apt/lists/*
# npm, npx, corepack and yarn are not used at runtime. Removing them also removes their dependencies from image scans.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=build --chown=node:node /repo ./
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000"]
