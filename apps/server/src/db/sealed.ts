import { type DataKeyStore, openJson, sealJson } from "@askgina/os-keys";
import type { WorkspaceId } from "@askgina/os-protocol";

/**
 * Seals and opens the columns marked "sealed" in `schema.ts`, with the workspace's data key.
 *
 * `location` says where the value lives, as `table.column:rowId`, for example
 * `intents.payload:int_01k…`. It is authenticated with the ciphertext, so a sealed value copied
 * into another row or column does not open.
 */
export interface Sealer {
  seal(workspaceId: WorkspaceId, location: string, value: unknown): Promise<Buffer>;
  open(workspaceId: WorkspaceId, location: string, sealed: Uint8Array): Promise<unknown>;
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
