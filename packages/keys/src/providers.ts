import { CompositeKeyProvider } from "./composite.ts";
import { type KeyProvider, KeyProviderConfigError, LocalKeyring } from "./keyring.ts";
import {
  type KeyProviderEvent,
  type TransitAuth,
  TransitKeyProvider,
  type TransitKeyProviderOptions,
} from "./transit.ts";

export interface KeyProviderFromEnvOptions {
  /** The variable that names the keyring file: `KEYRING_FILE`, or `WORLD_KEYRING_FILE` for the World. */
  keyringFileVariable: string;
  onEvent?: (event: KeyProviderEvent) => void;
}

const KUBERNETES_JWT_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/** The option of `TransitKeyProviderOptions` each variable sets, to name the variable at fault. */
const VARIABLE_OF_OPTION: Record<string, string> = {
  address: "OPENBAO_ADDR",
  mount: "OPENBAO_TRANSIT_MOUNT",
  key: "OPENBAO_TRANSIT_KEY",
  caFile: "OPENBAO_CA_FILE",
  timeoutMs: "OPENBAO_TIMEOUT_MS",
};

function required(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable];

  if (value === undefined || value === "") {
    throw new KeyProviderConfigError(`${variable} is not set`, variable);
  }

  return value;
}

function transitAuth(env: NodeJS.ProcessEnv): TransitAuth {
  switch (env.OPENBAO_AUTH) {
    case "token":
      return { kind: "token", tokenFile: required(env, "OPENBAO_TOKEN_FILE") };
    case "approle":
      return {
        kind: "approle",
        roleIdFile: required(env, "OPENBAO_ROLE_ID_FILE"),
        secretIdFile: required(env, "OPENBAO_SECRET_ID_FILE"),
      };
    case "kubernetes":
      return {
        kind: "kubernetes",
        role: required(env, "OPENBAO_KUBERNETES_ROLE"),
        jwtFile: env.OPENBAO_KUBERNETES_JWT_FILE || KUBERNETES_JWT_FILE,
      };
    default:
      throw new KeyProviderConfigError(
        "OPENBAO_AUTH must be token, approle or kubernetes",
        "OPENBAO_AUTH",
      );
  }
}

function transitOptions(
  env: NodeJS.ProcessEnv,
  onEvent: KeyProviderFromEnvOptions["onEvent"],
): TransitKeyProviderOptions {
  let address: URL;

  try {
    address = new URL(required(env, "OPENBAO_ADDR"));
  } catch (error) {
    if (error instanceof KeyProviderConfigError) throw error;
    throw new KeyProviderConfigError("OPENBAO_ADDR is not a URL", "OPENBAO_ADDR");
  }

  let timeoutMs: number | undefined;

  if (env.OPENBAO_TIMEOUT_MS) {
    timeoutMs = Number(env.OPENBAO_TIMEOUT_MS);

    if (!Number.isInteger(timeoutMs)) {
      throw new KeyProviderConfigError(
        "OPENBAO_TIMEOUT_MS must be an integer",
        "OPENBAO_TIMEOUT_MS",
      );
    }
  }

  return {
    address,
    auth: transitAuth(env),
    ...(env.OPENBAO_TRANSIT_MOUNT ? { mount: env.OPENBAO_TRANSIT_MOUNT } : {}),
    ...(env.OPENBAO_TRANSIT_KEY ? { key: env.OPENBAO_TRANSIT_KEY } : {}),
    ...(env.OPENBAO_CA_FILE ? { caFile: env.OPENBAO_CA_FILE } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(onEvent ? { onEvent } : {}),
  };
}

/**
 * The key provider the environment selects. Builds it without contacting anything; `ready()`
 * connects.
 *
 * - `KEY_PROVIDER=file` (the default): the keyring file named by `keyringFileVariable`.
 * - `KEY_PROVIDER=openbao`: OpenBao Transit at `OPENBAO_ADDR`, signed in by `OPENBAO_AUTH`
 *   (`token` with `OPENBAO_TOKEN_FILE`; `approle` with `OPENBAO_ROLE_ID_FILE` and
 *   `OPENBAO_SECRET_ID_FILE`; `kubernetes` with `OPENBAO_KUBERNETES_ROLE` and optionally
 *   `OPENBAO_KUBERNETES_JWT_FILE`), with `OPENBAO_TRANSIT_MOUNT` (default `transit`),
 *   `OPENBAO_TRANSIT_KEY` (default `os-kek`), `OPENBAO_CA_FILE` and `OPENBAO_TIMEOUT_MS`
 *   (default 2000). When the keyring file variable is set as well, keys wrapped under the file
 *   still unwrap with it while new ones go to Transit, until `rewrap` has moved them all.
 *
 * Settings that do not fit throw {@link KeyProviderConfigError} naming the variable.
 */
export function keyProviderFromEnv(
  env: NodeJS.ProcessEnv,
  options: KeyProviderFromEnvOptions,
): KeyProvider {
  const kind = env.KEY_PROVIDER || "file";
  const keyringFile = env[options.keyringFileVariable] || undefined;

  if (kind === "file") {
    // Someone who set up OpenBao and forgot this switch would otherwise run on the file unawares.
    if (env.OPENBAO_ADDR) {
      throw new KeyProviderConfigError(
        "OPENBAO_ADDR is set but KEY_PROVIDER is not openbao",
        "KEY_PROVIDER",
      );
    }

    return LocalKeyring.fromFile(required(env, options.keyringFileVariable));
  }

  if (kind !== "openbao") {
    throw new KeyProviderConfigError("KEY_PROVIDER must be file or openbao", "KEY_PROVIDER");
  }

  const legacy = keyringFile === undefined ? undefined : LocalKeyring.fromFile(keyringFile);
  let active: TransitKeyProvider;

  try {
    active = new TransitKeyProvider(transitOptions(env, options.onEvent));
  } catch (error) {
    if (error instanceof KeyProviderConfigError && VARIABLE_OF_OPTION[error.code] !== undefined) {
      throw new KeyProviderConfigError(error.message, VARIABLE_OF_OPTION[error.code] ?? error.code);
    }

    throw error;
  }

  return legacy === undefined ? active : new CompositeKeyProvider({ active, legacy });
}
