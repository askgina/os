# Build context: the repository root.
#   docker build -f examples/ntfy-sidecar/Dockerfile -t os-ntfy-sidecar .
# The sidecar has no dependencies (Node's own http, crypto and fetch are all it uses), so unlike
# the other examples there is no install stage: the pinned runtime image and the source suffice.
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
ENV NODE_ENV=production
WORKDIR /repo/examples/ntfy-sidecar
COPY examples/ntfy-sidecar/package.json ./
COPY examples/ntfy-sidecar/src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
