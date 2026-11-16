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

/** How long a waiting run sleeps before it looks at the request again: doubling, up to the cap. */
const FIRST_LOOK_SECONDS = 5;

const MAX_LOOK_SECONDS = 120;

export interface ApprovalRunInput {
  approvalId: string;
  /** Seconds since the Unix epoch. */
  expiresAt: number;
}

export async function approval(input: ApprovalRunInput): Promise<SettledStatus> {
  "use workflow";
  const { approvalId } = input;

  // The token names this run, not just the request. A start can be repeated (a crash between
  // starting a run and recording it), and two runs asking for one token would leave the second
  // with a HookConflictError: if that one had recorded itself as the owner first, every wake-up
  // would go to the other run and the request would never move. With its own token, a run that
  // is not the owner simply reads `superseded` below and ends.
  const hook = createHook<{ approvalId: string }>({
    token: `apr:${approvalId}:${getWorkflowMetadata().workflowRunId}`,
  });

  const wakeUps = hook[Symbol.asyncIterator]();
  const expiry = sleep(new Date(input.expiresAt * 1000));

  // A wake-up only means "look again": the database row is the authority, never the payload.
  // The run also looks on its own, soon at first and then every two minutes: an approval made
  // on the signer's page counts when the server asks the signer for it, and the person who made
  // it may never come back to a page of ours that would ask.
  let status = await settleStep(approvalId);
  let wakeUp = wakeUps.next().then(() => true);
  let lookSeconds = FIRST_LOOK_SECONDS;

  while (status === "pending") {
    const woken = await Promise.race([
      wakeUp,
      expiry.then(() => false),
      sleep(lookSeconds * 1000).then(() => false),
    ]);

    if (woken) wakeUp = wakeUps.next().then(() => true);
    lookSeconds = Math.min(lookSeconds * 2, MAX_LOOK_SECONDS);
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
