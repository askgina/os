import type { z } from "zod";
import type { JsonValue } from "./sealed.ts";

/**
 * A value this server stored earlier no longer matches the schema it was written with: a damaged
 * row, or one written by an older version. It is the server's fault, not the caller's, so it is
 * answered as an internal error and logged. The message names what was read and never quotes
 * the value or the schema's issues.
 */
export class StoredDataError extends Error {
  override readonly name = "StoredDataError";
}

/**
 * Decode a value read back from the database (a column, or a sealed column once opened) with the
 * schema it was written with. `what` names it in the error, for example
 * `approval detail (sweep-wallet)`.
 */
export function stored<S extends z.ZodType>(
  schema: S,
  value: JsonValue,
  what: string,
): z.output<S> {
  const parsed = schema.safeParse(value);

  if (!parsed.success) throw new StoredDataError(`stored ${what} does not match its schema`);

  return parsed.data;
}
