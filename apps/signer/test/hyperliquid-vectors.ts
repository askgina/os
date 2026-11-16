import { z } from "zod";
import { MsgpackMap, type MsgpackValue } from "../src/venues/msgpack.ts";
import vectors from "./vectors/hyperliquid-python-sdk.json" with { type: "json" };

/** An action as the SDK wrote it in JSON (`vectors/hyperliquid-python-sdk.json`). */
export type SdkAction =
  | (typeof vectors.sdkTests.signatures)[number]["action"]
  | typeof vectors.sdkTests.connectionId.action;

/** A JSON value as a `MsgpackValue`; each object becomes a `MsgpackMap` in its key order. */
const jsonAsMsgpack: z.ZodType<MsgpackValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonAsMsgpack),
    jsonMapAsMsgpack,
  ]),
);

const jsonMapAsMsgpack = z
  .record(z.string(), jsonAsMsgpack)
  .transform((object) => new MsgpackMap(Object.entries(object)));

/** `action` as a `MsgpackMap` tree with the SDK's key order. */
export function mapFromJson(action: SdkAction): MsgpackMap {
  return jsonMapAsMsgpack.parse(action);
}
