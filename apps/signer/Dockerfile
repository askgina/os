# The signer image. Build from the repository root:
#   docker build -f apps/signer/Dockerfile -t askgina/os-signer .
#
# node:26-slim (glibc) because the Open Wallet Standard native module has no musl build.

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS deps
WORKDIR /app
# Every workspace manifest is needed for the lockfile to resolve; only the signer's production
# dependency tree is installed.
COPY package.json bun.lock bunfig.toml ./
COPY apps/server/package.json apps/server/
COPY apps/signer/package.json apps/signer/
COPY apps/web/package.json apps/web/
COPY packages/api/package.json packages/api/
COPY packages/keys/package.json packages/keys/
COPY packages/protocol/package.json packages/protocol/
COPY packages/testkit/package.json packages/testkit/
COPY packages/world/package.json packages/world/
COPY examples/scripted-agent/package.json examples/scripted-agent/
COPY examples/eve-agent/package.json examples/eve-agent/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @askgina/os-signer

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
  SIGNER_PORT=8787 \
  SIGNER_DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/signer/node_modules ./apps/signer/node_modules
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=deps /app/packages/keys/node_modules ./packages/keys/node_modules
COPY package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY packages/keys/package.json packages/keys/
COPY packages/keys/src packages/keys/src
COPY apps/signer/package.json apps/signer/
COPY apps/signer/src apps/signer/src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
WORKDIR /app/apps/signer
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.SIGNER_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/main.ts"]
