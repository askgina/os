import { createHook, getWorkflowMetadata, sleep } from "workflow";
import type { SettledStatus, StepImplementations } from "../src/execution/steps.ts";

/**
 * One run per approval request, for every kind. It waits for a decision or the expiry, then
 * applies the effect and, for kinds that have one (transactions), follows it up until it is final.
 *
 * Everything that crosses this file carries ids, statuses and codes only: the runtime stores
 * workflow and step inputs and outputs, and the less it stores the less there is to protect.
 *
 * Steps never import application code. `workflow build` bundles this file and everything it
 * imports into its own copy of each module, which would give steps a second database pool and a
 * second signer client. Instead each step calls the implementation the server put on
 * `globalThis` at boot (see `src/execution/steps.ts`). The type import below is erased.
 */
const STEPS = Symbol.for("askgina.os.steps");

function steps(): StepImplementations {
  const registered = (globalThis as Record<symbol, StepImplementations | undefined>)[STEPS];
  if (registered === undefined) throw new Error("step implementations are not registered");
  return registered;
}

export interface ApprovalRunInput {
  approvalId: string;
  /** Seconds since the Unix epoch. */
  expiresAt: number;
}

export async function approval(input: ApprovalRunInput): Promise<SettledStatus> {
  "use workflow";
  const { approvalId } = input;
  const hook = createHook<{ approvalId: string }>({ token: `apr:${approvalId}` });
  const wakeUps = hook[Symbol.asyncIterator]();
  const deadline = new Date(input.expiresAt * 1000);

  // A wake-up only means "look again": the database row is the authority, never the payload.
  let status = await settleStep(approvalId);
  while (status === "pending") {
    await Promise.race([wakeUps.next(), sleep(deadline)]);
    status = await settleStep(approvalId);
  }
  // Another run was recorded for this request first (a start was retried); that run owns it.
  if (status === "superseded") return status;

  if (status === "approved") {
    let outcome: { ok: true } | { ok: false; code: string };
    try {
      outcome = await executeStep(approvalId);
    } catch {
      // Retries ran out on an error that is not a refusal (signer or database unreachable).
      outcome = { ok: false, code: "execution_error" };
    }
    if (!outcome.ok) {
      await failStep(approvalId, outcome.code);
      return "failed";
    }
    status = "executed";
  }

  if (status === "executed") {
    for (;;) {
      const next = await followUpStep(approvalId);
      if (next.done) break;
      await sleep(next.waitSeconds * 1000);
    }
    return "executed";
  }

  await abandonStep(approvalId, status);
  return status;
}

async function settleStep(approvalId: string): Promise<SettledStatus> {
  "use step";
  return steps().settle(approvalId, getWorkflowMetadata().workflowRunId);
}

async function executeStep(
  approvalId: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  "use step";
  return steps().execute(approvalId);
}
// A signer or chain outage should not end an approved request; keep trying for a while.
executeStep.maxRetries = 12;

async function failStep(approvalId: string, code: string): Promise<void> {
  "use step";
  return steps().fail(approvalId, code);
}

async function abandonStep(approvalId: string, status: SettledStatus): Promise<void> {
  "use step";
  return steps().abandon(approvalId, status);
}

async function followUpStep(approvalId: string): Promise<{ done: boolean; waitSeconds: number }> {
  "use step";
  return steps().followUp(approvalId);
}
followUpStep.maxRetries = 12;
