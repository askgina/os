# eve agent example

A real agent runtime, [vercel/eve](https://github.com/vercel/eve) `1.0.0-rc.17`, running with no
Vercel service, whose one consequential ability is to **propose** a payment through the askgina/os
MCP gateway. A person approves the proposal with a passkey in the askgina/os inbox; the signer
verifies that passkey itself. The agent holds no key and cannot approve anything.

What it shows:

- **Our encrypting World.** eve's durable state runs on `@askgina/os-world/target` (selected in
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
2. In the UI, create an agent. Copy the token it shows once (`osa_…`).
3. Start the example (the stack's `agents` network must exist; set `AGENTS_NETWORK` if your
   stack's project name is not `askgina-os`):

   ```sh
   AGENT_TOKEN=osa_… EVE_CHAT_PASSWORD=$(openssl rand -base64 18) \
   MODEL_BASE_URL=https://your-endpoint/v1 MODEL_API_KEY=… MODEL_ID=your-model \
   docker compose -f examples/eve-agent/compose.yaml up --build
   ```

   Use `OFFLINE_MODEL=1` instead of the three `MODEL_*` variables to try it without a model.
4. Talk to it:

   ```sh
   curl -u operator:$EVE_CHAT_PASSWORD -H 'content-type: application/json' \
     -d '{"message":"pay 0.001 to 0x… for the March invoice"}' \
     http://127.0.0.1:55810/eve/v1/session
   ```

   Read its replies at `/eve/v1/session/<sessionId>/stream`.
5. Approve the proposal with your passkey in the inbox. The agent's `check_intent` reports the
   outcome.

### The model

Any OpenAI-compatible chat completions endpoint: set `MODEL_BASE_URL`, `MODEL_API_KEY` and
`MODEL_ID`, and `MODEL_CONTEXT_WINDOW_TOKENS` if it is not 64000. Nothing is tied to a vendor.
eve needs the context window stated because it would otherwise look the model up in the AI
Gateway's catalog.

## Limits

- **An eve upgrade strands in-flight sessions** on a self-hosted World: a conversation waiting on
  something does not survive an eve version change. Proposals already made are unaffected (they
  live in askgina/os); ask the agent again after upgrading.
- **eve's own approval is not the control here**, and must not become it: an `answers` POST to
  eve authorizes nothing in askgina/os.
- Metadata (run ids, timestamps, step names, event types, attribute keys) is stored in
  plaintext; payloads are not, and attribute values are withheld unless listed as readable.
- Only eve's own HTTP channel and one session were tested. Other channels (Slack, Discord and
  so on), subagents and schedules were not. The World withholds their attributes too, but an
  attribute eve needs to read back and that is not on the list would stop that feature working.
- One replica. Several replicas on one database are untested.
- Never set `EVE_WORKFLOW_WORLD`: it exists only so the smoke test can build the same agent on
  the stock World as a control for its scanner.
