import { type DataKeyStore, type JsonValue, openJson, sealJson } from "@askgina/os-keys";
import type { WorkspaceId } from "@askgina/os-protocol";

export type { JsonValue } from "@askgina/os-keys";

/**
 * Seals and opens the columns marked "sealed" in `schema.ts`, with the workspace's data key.
 *
 * `location` says where the value lives, as `table.column:rowId`, for example
 * `intents.payload:int_01k…`. It is authenticated with the ciphertext, so a sealed value copied
 * into another row or column does not open.
 *
 * `seal` takes any value `JSON.stringify` writes; `open` returns what `JSON.parse` read back, for
 * the caller to decode with the column's schema.
 */
export interface Sealer {
  seal<T>(workspaceId: WorkspaceId, location: string, value: T): Promise<Buffer>;
  open(workspaceId: WorkspaceId, location: string, sealed: Uint8Array): Promise<JsonValue>;
}

export function createSealer(keys: DataKeyStore): Sealer {
  return {
    async seal(workspaceId, location, value) {
      const key = await keys.getOrCreate("workspace", workspaceId, workspaceId);

      return sealJson(key, value, location);
    },
    async open(workspaceId, location, sealed) {
      const key = await keys.getOrCreate("workspace", workspaceId, workspaceId);

      return openJson(key, sealed, location);
    },
  };
}
