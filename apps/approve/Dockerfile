# The `approve` image: the confirmation page and its relay to the signer. It holds no key. Build
# from the repository root:
#   docker build -f apps/approve/Dockerfile -t askgina/os-approve .

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
WORKDIR /app
COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @askgina/os-approve

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
  PORT=8788
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/approve/node_modules ./apps/approve/node_modules
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY apps/approve/package.json apps/approve/
COPY apps/approve/src apps/approve/src
COPY apps/approve/public apps/approve/public
USER node
EXPOSE 8788
WORKDIR /app/apps/approve
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/main.ts"]
