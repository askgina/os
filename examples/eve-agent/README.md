# eve agent example

An example agent for this repository: a real agent runtime, [vercel/eve](https://github.com/vercel/eve)
`1.0.0-rc.17`, running with no Vercel service, whose one consequential ability is to **propose** a
payment through the control plane's MCP gateway (`agent-gateway` in the root `compose.yaml`). A
person approves the proposal with a passkey on the signer's confirmation page, or approved it in
advance with a mandate; the signer verifies the passkey and enforces the mandate itself. The agent
holds no key and cannot approve anything. It runs next to the stack, in a Compose project of its
own with its own Postgres, and is not part of the stack itself.

**Status.** Proven in CI: `test/smoke.test.ts` (job `test`) builds the agent with `eve build`,
runs it as a plain process against a stand-in MCP gateway with the offline model, checks that it
proposes the transfer it was asked for, and scans its database for the conversation in
plaintext; the same job builds the image. Unproven: this directory's `compose.yaml` has never
been started, and the agent has never talked to a real gateway or a real model in CI.

What it shows:

- **The encrypting World.** eve's durable state runs on `@askgina/os-world/target` (selected in
  `agent/agent.ts` through `experimental.workflow.world`). What the agent is told, what it says
  and what it passes to tools is stored as AES-256-GCM ciphertext, under a per-run key wrapped by
  a keyring file kept outside the database.
- **No conversation in the session title.** eve stores a session's title as a run attribute,
  and by default the title is the first user message. Run attributes cannot be encrypted. Two
  things keep the message out of the database: `agent/channels/eve.ts` gives every session the
  fixed title "Agent session", and the World stores `[withheld]` for every attribute that is
  not on the list in `compose.yaml` (`WORLD_READABLE_ATTRIBUTE_KEYS`: the ids, kinds and
  version eve reads back).
- **No Vercel service.** The model is an AI SDK provider object (never a string, which eve would
  resolve through Vercel's AI Gateway); route auth is HTTP Basic; telemetry is off
  (`EVE_TELEMETRY_DISABLED=1`); no sandbox, Blob memory, OIDC or schedules are used.
- **eve's own approval is not the control.** The tools carry no eve `approval`: that is consent
  inside eve's chat and proves nothing to the signer. See `agent/tools/propose_transfer.ts`.

## Files

| Path                                                 | What                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `agent/agent.ts`                                     | The agent: model, context window, World                                                                                 |
| `agent/instructions.md`                              | What the agent is told it may do                                                                                        |
| `agent/tools/propose_transfer.ts`, `check_intent.ts` | The only tools; they call the gateway's `propose_transfer` and `get_intent`                                             |
| `agent/channels/eve.ts`                              | Who may talk to the agent (HTTP Basic)                                                                                  |
| `lib/gateway.ts`                                     | MCP client using `MCP_URL` and `AGENT_TOKEN`                                                                            |
| `lib/model.ts`                                       | Picks the model from the environment when the agent starts                                                              |
| `lib/offline-model.ts`                               | **For the smoke test only**: a deterministic model that proposes one transfer when asked to "pay <amount> to <address>" |
| `compose.yaml`, `Dockerfile`                         | The agent with its own Postgres                                                                                         |
| `test/smoke.test.ts`                                 | Builds and runs the agent against a stand-in gateway and scans its database for plaintext                               |

## Run it against a running stack

1. Start the stack from the repository root (`docker compose up -d`) and sign in.
2. In the UI, create an agent and approve limits for its wallet. Copy the token the UI shows once
   (`osa_…`).
3. Start the example (the stack's `agents` network must exist; set `AGENTS_NETWORK` if your
   stack's Compose project is not named `os`, in which case the network is `<project>_agents`):

   ```sh
   export AGENT_TOKEN=osa_… EVE_CHAT_PASSWORD=$(openssl rand -base64 18)
   MODEL_BASE_URL=https://your-endpoint/v1 MODEL_API_KEY=… MODEL_ID=your-model \
   docker compose -f examples/eve-agent/compose.yaml up -d --build
   ```

   Use `OFFLINE_MODEL=1` instead of the three `MODEL_*` variables to try it without a model.
   `docker compose -f examples/eve-agent/compose.yaml logs -f agent`, in the same shell (the
   file needs both exported variables), follows its log.
4. Talk to it:

   ```sh
   curl -u operator:$EVE_CHAT_PASSWORD -H 'content-type: application/json' \
     -d '{"message":"pay 0.001 to 0x… for the March invoice"}' \
     http://127.0.0.1:55810/eve/v1/session
   ```

   Read its replies at `/eve/v1/session/<sessionId>/stream`. The port is 55810 on 127.0.0.1
   unless `EVE_AGENT_PORT` names another.
5. Open the `approvalUrl` the agent replies with (or the request in the UI's approval inbox),
   follow its link to the signer's confirmation page and approve there with your passkey. The
   agent's `check_intent` reports the outcome.

### The model

Any OpenAI-compatible chat completions endpoint: set `MODEL_BASE_URL`, `MODEL_API_KEY` and
`MODEL_ID`. Nothing is tied to a vendor. eve needs the context window stated because it would
otherwise look the model up in the AI Gateway's catalog: `agent/agent.ts` reads it from
`MODEL_CONTEXT_WINDOW_TOKENS`, which `compose.yaml` passes through; unset or empty means 64000.

## Limits

- **An eve upgrade strands in-flight sessions** on a self-hosted World: a conversation waiting on
  something does not survive an eve version change. Proposals already made are unaffected (they
  live in the control plane); ask the agent again after upgrading.
- **eve's own approval is not the control here**, and must not become it: an `answers` POST to
  eve authorizes nothing in the control plane or the signer.
- Metadata (run ids, timestamps, step names, event types, attribute keys) is stored in
  plaintext; payloads are not, and attribute values are withheld unless listed as readable.
- **This Compose file has never been started** (see "Status"). Expect to fix something the
  first time you run it.
- The agent's container can reach the internet, because it has to reach its model. The scripted
  example (`examples/scripted-agent`) cannot. What it can reach inside the stack is still only
  the MCP gateway.
- eve's invocation API will not work: it reads back the run attribute `$eve.invocation_token`,
  which is not on the readable list because it is a token.
- Only eve's own HTTP channel and one session were tested. Other channels (Slack, Discord and
  so on), subagents and schedules were not. The World withholds their attributes too, but an
  attribute eve needs to read back and that is not on the list would stop that feature working.
- One replica. Several replicas on one database are untested.
- Never set `EVE_WORKFLOW_WORLD`: it exists only so the smoke test can build the same agent on
  the stock World as a control for its scanner.

## Checking a change

From the repository root, after `bun install`: `bun run check` (Biome), `bun run lint:slop`
(Oxlint with the repository's anti-slop rules), and
`cd examples/eve-agent && ../../node_modules/.bin/tsc --noEmit`. The smoke test needs Postgres:
start it with `bun run services:up` (127.0.0.1:55432; `bun run services:down` removes it), then
run `node_modules/.bin/vitest run examples/eve-agent/test/smoke.test.ts` from the repository
root. It builds and runs the agent on this World and, as the scanner's control, on the stock
World, so it takes minutes.

CI runs the smoke test in job `test`, the type-check in job `check`, and builds the image
(`docker build -f examples/eve-agent/Dockerfile .`) in job `test`. Leave the image build to CI.
