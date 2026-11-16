import { z } from "zod";

/** Any JSON value, as `JSON.parse` gives it. */
export const JsonValue = z.json();

export type JsonValue = z.infer<typeof JsonValue>;

/** A JSON object: a log line, a command's answer, a webhook body, a tool's result. */
export const JsonObject = z.record(z.string(), JsonValue);

export type JsonObject = z.infer<typeof JsonObject>;

/** The JSON object `text` holds, or null when it holds no JSON or JSON that is no object. */
export function jsonObjectIn(text: string): JsonObject | null {
  try {
    const parsed = JsonObject.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The lines of `text` that hold a JSON object, each parsed, in order: a log's JSON lines. */
export function jsonObjectLines(text: string): JsonObject[] {
  return text.split("\n").flatMap((line) => {
    const parsed = jsonObjectIn(line);

    return parsed === null ? [] : [parsed];
  });
}
