import { type KeyProvider, KeyProviderRefusedError, type LocalKeyring } from "./keyring.ts";
import { isTransitKekId, type TransitKeyProvider } from "./transit.ts";

/**
 * For moving from the keyring file to OpenBao Transit: new keys are wrapped only under the
 * Transit key; keys already wrapped under a file KEK still unwrap with the keyring. Each KEK id
 * goes to the one provider it names (`bao:` ids to Transit, bare ids to the keyring), so a
 * Transit failure is never answered from the file. `rewrap` then moves every row to `bao:`, and
 * the keyring file can go.
 */
export class CompositeKeyProvider implements KeyProvider {
  readonly #active: TransitKeyProvider;
  readonly #legacy: LocalKeyring;

  constructor(providers: { active: TransitKeyProvider; legacy: LocalKeyring }) {
    this.#active = providers.active;
    this.#legacy = providers.legacy;
  }

  async ready(): Promise<void> {
    await Promise.all([this.#active.ready(), this.#legacy.ready()]);
  }

  activeKekId(): string {
    return this.#active.activeKekId();
  }

  wrap(kekId: string, dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    if (!isTransitKekId(kekId)) {
      return Promise.reject(
        new KeyProviderRefusedError(
          `keys: new keys are wrapped only under the Transit key, not ${kekId}`,
          { kekId },
        ),
      );
    }
    return this.#active.wrap(kekId, dataKey, aad);
  }

  unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    return isTransitKekId(kekId)
      ? this.#active.unwrap(kekId, wrapped, aad)
      : this.#legacy.unwrap(kekId, wrapped, aad);
  }

  async close(): Promise<void> {
    await Promise.all([this.#active.close(), this.#legacy.close()]);
  }
}
