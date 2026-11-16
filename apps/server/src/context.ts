import type { AssetBalance, ChainInfo } from "@askgina/os-api";
import type { DataKeyStore } from "@askgina/os-keys";
import type { Address, AssetRef, ChainId, UserId } from "@askgina/os-protocol";
import type { SignerClient } from "@askgina/os-protocol/signer";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import type { ApprovalEngine } from "./approvals/kinds.ts";
import type { Config } from "./config.ts";
import type * as schema from "./db/schema.ts";
import type { Sealer } from "./db/sealed.ts";
import type { Logger } from "./log.ts";

export type Database = NodePgDatabase<typeof schema>;

export type Transaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Either the pool-backed database or a transaction on it. */
export type Executor = Database | Transaction;

/** A signed-in person. */
export interface Session {
  user: { id: UserId; displayName: string };
  /** The passkey that signed this session in. */
  credentialId: string;
  /** Primary key of the session row. */
  idHash: string;
}

/** Owned by the identity module (`src/identity`). */
export interface Sessions {
  /** The session a request's cookie names, or null when it is missing, expired or revoked. */
  resolve(request: Request): Promise<Session | null>;
}

/** Owned by the execution module (`src/execution/chains.ts`). */
export interface Chains {
  list(): ChainInfo[];
  /** Current balances of `address`; one entry per requested asset, in request order. */
  balances(
    address: Address,
    assets: readonly { chainId: ChainId; asset: AssetRef }[],
  ): Promise<AssetBalance[]>;
}

/**
 * Everything a request handler or a workflow step can reach. Built once at boot in `main.ts`
 * and passed explicitly; nothing reads global state.
 */
export interface AppContext {
  config: Config;
  pool: Pool;
  db: Database;
  keys: DataKeyStore;
  sealer: Sealer;
  signer: SignerClient;
  sessions: Sessions;
  chains: Chains;
  approvals: ApprovalEngine;
  log: Logger;
  /** Seconds since the Unix epoch. Tests inject a clock. */
  now(): number;
}
