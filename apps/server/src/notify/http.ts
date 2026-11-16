/** How long one delivery attempt may take before it counts as a timeout. */
const ATTEMPT_TIMEOUT_MS = 5_000;

/** What one POST came to: the status and any `Retry-After`, or no answer at all. */
export type PostOutcome =
  | { status: number; retryAfter: number | undefined }
  | { status: null; code: "timeout" | "network" };

/**
 * POST once, without following redirects (a 3xx is an answer, not a new destination). The
 * response body is never read: nothing a receiver says is stored or logged.
 */
export async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: string | Uint8Array<ArrayBuffer>,
  now: number,
): Promise<PostOutcome> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });

    await response.body?.cancel();

    return { status: response.status, retryAfter: retryAfter(response.headers, now) };
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

    return { status: null, code: timedOut ? "timeout" : "network" };
  }
}

/** Statuses worth trying again: the receiver is busy, slow or broken for now. */
export function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** `Retry-After` as seconds from `now`: delay-seconds or an HTTP date; absent when unusable. */
function retryAfter(headers: Headers, now: number): number | undefined {
  const value = headers.get("retry-after")?.trim();

  if (value === undefined || value === "") return undefined;

  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);

  if (Number.isNaN(at)) return undefined;

  return Math.max(0, Math.ceil(at / 1000 - now));
}
