import { MsgpackMap, type MsgpackValue } from "../src/venues/msgpack.ts";

/**
 * An action as the SDK wrote it in JSON (`vectors/hyperliquid-python-sdk.json`), as a
 * `MsgpackMap` tree with the SDK's key order.
 */
export function mapFromJson(value: object): MsgpackMap {
  return new MsgpackMap(Object.entries(value).map(([key, entry]) => [key, fromJson(entry)]));
}

function fromJson(value: unknown): MsgpackValue {
  if (Array.isArray(value)) return value.map(fromJson);

  if (value !== null && typeof value === "object") return mapFromJson(value);

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  throw new TypeError(`not JSON: ${typeof value}`);
}
