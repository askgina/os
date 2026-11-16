/**
 * A JSON value as `JSON.parse` returns it and a request body or file carries it: objects keep
 * their keys in insertion order. The signer's one JSON type.
 */
export type JsonValue = string | boolean | null | number | JsonValue[] | JsonObject;

/** A JSON object: every value is JSON again. */
export type JsonObject = { [key: string]: JsonValue };
