# Montra API and Node job worker. Same image, different command:
#   API (default):  node dist/main.js
#   Worker:         node dist/worker-main.js
#   Migrations:     node node_modules/@montra/db/dist/cli.js migrate   (needs DATABASE_ADMIN_URL)
# Build from the repository root:
#   docker build -f apps/api/Dockerfile -t montra/api .
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# `--filter .` keeps the root dev dependencies (TypeScript) available to the package builds.
RUN pnpm install --frozen-lockfile --filter "@montra/api..." --filter .
RUN pnpm --filter "@montra/api..." run build
# Reinstall without the root tooling, from the same lockfile. `pnpm deploy --legacy` resolves versions afresh, so
# the image could differ from what CI tested.
RUN rm -rf node_modules apps/api/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@montra/api..." \
 && rm -rf apps/api/src apps/api/test apps/api/tsconfig*.json apps/api/vitest.config.ts \
    packages/*/src packages/*/test packages/*/tsconfig*.json packages/*/vitest.config.ts \
 && test -f apps/api/dist/main.js \
 && test -f apps/api/dist/worker-main.js \
 && test -f packages/db/dist/cli.js \
 && test -d packages/db/migrations

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
# npm, npx, corepack and yarn are not used at runtime. Removing them also removes their dependencies from image scans.
# Aurora requires TLS and its CA is not in Node's trust store. Create the directory first: with --chmod, ADD gives any
# parent directory it has to create the same mode, which locks non-root users out of /etc/ssl.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && install -d -m 755 /etc/ssl/certs
# When AWS changes this bundle the build fails on the checksum, on purpose: check the new one came from AWS, then update it here
# and in the other Dockerfiles that download it.
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
WORKDIR /app
COPY --from=build --chown=node:node /repo ./
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
