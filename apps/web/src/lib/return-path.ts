import { z } from "zod";

/** Where a person lands after signing in when they asked for no page, or for an unsafe one. */
export const DEFAULT_LANDING = "/";

/** Longer than any page in this app; a longer value is not a link someone followed. */
const MAX_LENGTH = 2048;

/** Only used to resolve a path; never contacted. */
const BASE = "https://return-path.invalid";

/** A requested page as the query string can carry one: text, no longer than any page here. */
const RequestedPath = z.string().max(MAX_LENGTH);

/** True if the text holds a C0 control character or DEL, which browsers strip or reinterpret. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code < 0x20 || code === 0x7f) return true;
  }

  return false;
}

/**
 * The page to open after signing in, if `requested` names a page on this site; the default
 * landing page otherwise. Accepted: a path with exactly one leading `/`. Refused: `//host` and
 * `/\host` (browsers read both as another origin), any backslash, any scheme or absolute URL, control
 * characters, a path whose dot segments resolve to `//`, and a path with an encoded `/`, `\` or
 * control character (`%2F`, `%5C`, `%09`), which no page here has and which a later decoding
 * could turn into `//host`.
 * The result is the resolved path, search and hash, so what was checked is what is opened.
 * `requested` is whatever the query string held, so it is decoded here, where it enters.
 */
export function safeReturnPath<Requested>(requested: Requested): string {
  const decoded = RequestedPath.safeParse(requested);

  if (!decoded.success) return DEFAULT_LANDING;
  const value = decoded.data;

  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_LANDING;

  if (value.includes("\\") || hasControlCharacter(value)) return DEFAULT_LANDING;
  let url: URL;

  try {
    url = new URL(value, BASE);
  } catch {
    return DEFAULT_LANDING;
  }

  if (url.origin !== BASE || url.pathname.startsWith("//")) return DEFAULT_LANDING;

  if (/%(?:2f|5c|[01][0-9a-f]|7f)/i.test(url.pathname)) return DEFAULT_LANDING;

  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in page, asked to return to `requested` afterwards when that is a safe path. */
export function signInHref(requested: string): string {
  const next = safeReturnPath(requested);

  return next === DEFAULT_LANDING ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
