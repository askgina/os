# Build context: the repository root.
#   docker build -f examples/scripted-agent/Dockerfile -t os-scripted-agent .
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
RUN bun install --frozen-lockfile --production --filter @askgina/os-example-scripted-agent

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
ENV NODE_ENV=production
WORKDIR /repo/examples/scripted-agent
COPY --from=deps /repo/node_modules /repo/node_modules
COPY --from=deps /repo/examples/scripted-agent/node_modules ./node_modules
COPY examples/scripted-agent/package.json ./
COPY examples/scripted-agent/src ./src
USER node
CMD ["node", "src/agent.ts"]
