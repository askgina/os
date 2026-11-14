# Control-plane image. Build context is the repository root:
#   docker build -f apps/server/Dockerfile .
# Node runs the TypeScript sources directly, so the image holds sources, not a bundle.

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun

# Build stage: the full install, the generated Workflow routes and the UI.
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/server && bun run build:workflows
RUN cd apps/web && bun run build

# Every workspace's package.json is needed for the lockfile to resolve. This stage picks them out
# of the build context, so the install below is re-run only when a manifest or the lockfile
# changes, not on every source edit.
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS manifests
WORKDIR /repo
COPY . .
RUN mkdir /manifests \
  && cp package.json bun.lock bunfig.toml /manifests/ \
  && find apps packages examples e2e -name package.json -not -path "*/node_modules/*" \
    -exec cp --parents {} /manifests/ \;

# Runtime dependencies only, for the server and the workspace packages it imports. A separate
# install keeps compilers, test tools and the UI's build chain out of the final image.
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile --production --filter @askgina/os-server
COPY packages packages

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=root:root /app/package.json ./package.json
# Workspace packages are symlinks from node_modules into packages/*; Node follows them to the
# real path, which is outside node_modules, so it is allowed to strip their types.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/src ./apps/server/src
COPY apps/server/workflows ./apps/server/workflows
# The runtime finds the generated routes relative to its own source files.
COPY --from=build /app/apps/server/.well-known ./apps/server/.well-known
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/src/main.ts"]
