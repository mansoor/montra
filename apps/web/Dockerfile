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
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_AUTH_MODE=$NEXT_PUBLIC_AUTH_MODE \
    NEXT_PUBLIC_KRATOS_URL=$NEXT_PUBLIC_KRATOS_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_API_WS_URL=$NEXT_PUBLIC_API_WS_URL
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
# so the image could differ from what CI tested.
RUN rm -rf node_modules apps/web/node_modules packages/*/node_modules apps/web/.next/cache \
 && pnpm install --frozen-lockfile --prod --filter "@montra/web..." \
 && rm -rf vitest.shared.ts apps/web/app apps/web/components apps/web/e2e apps/web/lib apps/web/middleware.ts \
    apps/web/playwright.config.ts apps/web/vitest.config.ts apps/web/tsconfig.json apps/web/postcss.config.mjs \
    apps/web/next-env.d.ts packages/*/src packages/*/test packages/*/tsconfig*.json packages/*/vitest.config.ts \
 && rm -rf node_modules/.pnpm/@next+swc-*musl* node_modules/.pnpm/@img+sharp-*musl* \
 && test -f apps/web/.next/BUILD_ID

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
# npm, npx, corepack and yarn are not used at runtime. Removing them also removes their dependencies from image scans.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=build --chown=node:node /repo ./
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000"]
