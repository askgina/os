/**
 * The bridge between the bundled workflow (`workflows/approval.ts`) and this server.
 *
 * `workflow build` bundles workflow and step code into `.well-known/workflow/v1/flow.mjs` with
 * its own copies of every module it imports. If steps imported the application they would get a
 * second pool, a second signer client and a second configuration. So steps import nothing: at
 * boot the server puts these implementations on `globalThis` under a well-known symbol, and each
 * step is one line that calls into them.
 */
export type SettledStatus =
  | "pending"
  | "approved"
  | "executed"
  | "rejected"
  | "expired"
  | "cancelled"
  | "failed"
  /** Another workflow run owns this request. */
  | "superseded";

export interface StepImplementations {
  /**
   * Read the request's status; a pending request past its expiry becomes `expired`. The first
   * run to settle a request records itself as its run; any other run gets `superseded`.
   */
  settle(approvalId: string, runId: string): Promise<SettledStatus>;
  /** Apply the approved effect. A refusal comes back as a code; other errors throw (retry). */
  execute(approvalId: string): Promise<{ ok: true } | { ok: false; code: string }>;
  /** End an approved request as `failed` with a code, and undo what opening it set up. */
  fail(approvalId: string, code: string): Promise<void>;
  /** The request ended without effect: let the kind undo what opening it set up. */
  abandon(approvalId: string, status: SettledStatus): Promise<void>;
  /** Work after the effect (broadcast, confirmation). `done` ends the run. */
  followUp(approvalId: string): Promise<{ done: boolean; waitSeconds: number }>;
}

export const STEPS_KEY = Symbol.for("askgina.os.steps");

export function registerSteps(implementations: StepImplementations): void {
  (globalThis as Record<symbol, unknown>)[STEPS_KEY] = implementations;
}

export function unregisterSteps(implementations: StepImplementations): void {
  const store = globalThis as Record<symbol, unknown>;

  if (store[STEPS_KEY] === implementations) delete store[STEPS_KEY];
}
