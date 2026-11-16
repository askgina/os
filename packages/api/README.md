# @askgina/os-api

This package is the control plane's HTTP contract: every route of the API under `/api/v1`, the shape of each request and response, the error codes, and a typed client derived from the same definitions. The server and the web UI both import it, so they cannot drift apart. It holds no handler and makes no request on its own.

The MCP gateway an agent talks to (`/mcp`) is not part of this contract; its tools are defined in [`apps/server/src/mcp/gateway.ts`](../../apps/server/src/mcp/gateway.ts). Neither is the signer's API, which lives in [`packages/protocol`](../protocol/README.md).

## How it fits

- `apps/server` registers one handler per entry of `routes` (`apps/server/src/http/route.ts`) and checks each request and response against the entry's schemas. It sends `CONTENT_SECURITY_POLICY` on every response.
- `apps/web` calls the API through `createApiClient` and uses the DTOs as its types. Its Vite development server sends the same `CONTENT_SECURITY_POLICY`, so a page that would break under it breaks during development.
- `e2e` drives people through the real API with the same client.

The DTOs build on the schemas of `@askgina/os-protocol` (identifiers, intents, policies, mandates), its only workspace dependency.

## Layout

| Path            | What it holds                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes.ts` | `routes`: one `RouteDefinition` per endpoint, with its method, path, whether it needs a session (`public` or `session`), and its body, query and response schemas.                |
| `src/dto.ts`    | The request and response shapes, `ApiErrorCode` with its HTTP status in `apiErrorStatus`, and `ApiErrorBody`.                                                                     |
| `src/client.ts` | `createApiClient`: call an endpoint by its name in `routes`; the answer is parsed with the route's response schema, and a refusal rejects with `ApiError` (code, status, detail). |
| `src/csp.ts`    | `CONTENT_SECURITY_POLICY`, the control plane's one Content-Security-Policy.                                                                                                       |
| `src/index.ts`  | Re-exports all four. The package has this one export.                                                                                                                             |

The confirmation page (`apps/approve`) is a separate origin with its own, stricter policy; see [`apps/approve/README.md`](../../apps/approve/README.md).

## Changing it

Add an endpoint by adding an entry to `routes`. The server then needs its handler, and `test/api.test.ts` needs one example request and response for it: a coverage test fails for any route without one. A GET or DELETE route carries no body.

Changing a DTO changes what the server accepts and returns and what the UI renders. Most schemas are strict: an unknown field is refused, not ignored.

## Checking a change

From the repository root, after `bun install`:

```sh
cd packages/api && ../../node_modules/.bin/tsc --noEmit
```

```sh
node_modules/.bin/vitest run packages/api/test/api.test.ts
```

The test needs no services. Type-check `apps/server` and `apps/web` too, since both compile against this package:

```sh
cd apps/server && ../../node_modules/.bin/tsc --noEmit
cd apps/web && ../../node_modules/.bin/tsc --noEmit
```

CI runs the rest on every push and pull request: Biome, Oxlint and every workspace's type check in job `check`, every test file in job `test`, and the UI journeys against the fixture API in job `ui`.
