/** Where a person lands after signing in when they asked for no page, or for an unsafe one. */
export const DEFAULT_LANDING = "/";

/** Longer than any page in this app; a longer value is not a link someone followed. */
const MAX_LENGTH = 2048;

/** Only used to resolve a path; never contacted. */
const BASE = "https://return-path.invalid";

/** True if the text holds a C0 control character or DEL, which browsers strip or reinterpret. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The page to open after signing in, if `value` names a page on this site; the default landing
 * page otherwise. Accepted: a path with exactly one leading `/`. Refused: `//host` and `/\host`
 * (browsers read both as another origin), any backslash, any scheme or absolute URL, control
 * characters, and a path whose dot segments resolve to `//`. The result is the resolved path,
 * search and hash, so what was checked is what is opened.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return DEFAULT_LANDING;
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_LANDING;
  if (value.includes("\\") || hasControlCharacter(value)) return DEFAULT_LANDING;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return DEFAULT_LANDING;
  }
  if (url.origin !== BASE || url.pathname.startsWith("//")) return DEFAULT_LANDING;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in page, asked to return to `requested` afterwards when that is a safe path. */
export function signInHref(requested: string): string {
  const next = safeReturnPath(requested);
  return next === DEFAULT_LANDING ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
