# Build context: the repository root.
#   docker build -f examples/eve-agent/Dockerfile -t os-eve-agent .
# The build sets no model, gateway or chat credentials: they are read when the agent starts.
#
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

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS deps
WORKDIR /repo
COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile --filter @askgina/os-example-eve-agent

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /repo
COPY --from=deps /repo ./
COPY packages/keys/src ./packages/keys/src
COPY packages/world/src ./packages/world/src
COPY examples/eve-agent ./examples/eve-agent
WORKDIR /repo/examples/eve-agent
ENV EVE_TELEMETRY_DISABLED=1
RUN ./node_modules/.bin/eve build

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
ENV NODE_ENV=production EVE_TELEMETRY_DISABLED=1
WORKDIR /repo/examples/eve-agent
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/examples/eve-agent /repo/examples/eve-agent
USER node
EXPOSE 3000
CMD ["./node_modules/.bin/eve", "start", "--host", "0.0.0.0", "--port", "3000"]
