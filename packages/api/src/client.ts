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

export interface ApiClient {
  /** Call an endpoint by its name in {@link routes}. Rejects with {@link ApiError} on a refusal. */
  call<N extends RouteName>(
    name: N,
    ...input: Record<never, never> extends RouteInput<N> ? [RouteInput<N>?] : [RouteInput<N>]
  ): Promise<RouteOutput<N>>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");

  return {
    async call(name, ...rest) {
      const route: RouteDefinition = routes[name];
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

      const response = await doFetch(url, {
        method: route.method,
        credentials: "same-origin",
        headers: {
          ...(route.body === null ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        ...(route.body === null ? {} : { body: JSON.stringify(input.body ?? {}) }),
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const parsed = ApiErrorBody.safeParse(payload);

        if (parsed.success) {
          const { code, message, detail } = parsed.data.error;
          throw new ApiError(code, message, response.status, detail);
        }

        throw new ApiError("internal", `server answered HTTP ${response.status}`, response.status);
      }

      return route.response.parse(payload) as never;
    },
  };
}
