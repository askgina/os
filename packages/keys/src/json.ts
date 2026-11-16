/** A value as `JSON.parse` returns it and `JSON.stringify` writes it. */
export type JsonValue =
  | string
  | boolean
  | null
  | number
  | JsonValue[]
  | { [key: string]: JsonValue };
