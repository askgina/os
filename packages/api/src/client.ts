import { ApiErrorBody, type ApiErrorCode } from "./dto.ts";
import {
  type RouteDefinition,
  type RouteInput,
  type RouteName,
  type RouteOutput,
  routes,
} from "./routes.ts";

/** The control plane understood the request and answered with an error. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(code: ApiErrorCode, message: string, status: number, detail?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface ApiClientOptions {
  /** Empty in the browser, where requests go to the page's own origin. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request, for example a `cookie` when calling from a script. */
  headers?: Record<string, string>;
}

type LooseInput = {
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
};

/** The input after a route's name: optional exactly when the route needs nothing. */
type CallInput<N extends RouteName> =
  Record<never, never> extends RouteInput<N> ? [RouteInput<N>?] : [RouteInput<N>];

export interface ApiClient {
  /** Call an endpoint by its name in {@link routes}. Rejects with {@link ApiError} on a refusal. */
  call<N extends RouteName>(name: N, ...input: CallInput<N>): Promise<RouteOutput<N>>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");

  return {
    async call<N extends RouteName>(name: N, ...rest: CallInput<N>): Promise<RouteOutput<N>> {
      const route: RouteDefinition = routes[name];
      // SAFETY: `rest[0]` is the `RouteInput` of `routes[name]`: `PathParams` maps each path
      // parameter to a string, every route's query schema is an object of optional strings, and
      // the body is only stringified, so it fits `LooseInput`; TypeScript cannot resolve
      // `RouteInput<N>` for the generic `N`.
      const input = (rest[0] ?? {}) as LooseInput;
      let path = route.path;

      for (const [key, value] of Object.entries(input.params ?? {})) {
        path = path.replace(`:${key}`, encodeURIComponent(value));
      }

      const query = new URLSearchParams();

      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined) query.set(key, value);
      }

      const url = `${baseUrl}${path}${query.size === 0 ? "" : `?${query}`}`;

      const headers: Record<string, string> = {};

      if (route.body !== null) headers["content-type"] = "application/json";

      const init: RequestInit = {
        method: route.method,
        credentials: "same-origin",
        headers: { ...headers, ...options.headers },
      };

      if (route.body !== null) init.body = JSON.stringify(input.body ?? {});
      const response = await doFetch(url, init);

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const parsed = ApiErrorBody.safeParse(payload);

        if (parsed.success) {
          const { code, message, detail } = parsed.data.error;
          throw new ApiError(code, message, response.status, detail);
        }

        throw new ApiError("internal", `server answered HTTP ${response.status}`, response.status);
      }

      // SAFETY: `route` is `routes[name]`, so `route.response` is the schema `RouteOutput<N>` is
      // inferred from, and `parse` returned that schema's output or threw.
      return route.response.parse(payload) as RouteOutput<N>;
    },
  };
}
