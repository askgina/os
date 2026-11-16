# Scripted agent

The smallest complete agent: a script with no model in it. It connects to the MCP gateway with an agent token, proposes one payment from its own wallet, and waits until the payment is final. It shows everything an agent can do here: read its own state and propose. It holds no key, cannot approve, and never reaches the signer.

Use it to try the stack, or as a starting point for your own agent. For an agent with a real model, see [`examples/eve-agent`](../eve-agent/README.md).

## What it does

`src/agent.ts`, in order:

1. Reads its settings from the environment and stops with an error if one is missing or malformed.
2. Connects to `MCP_URL` over Streamable HTTP, sending `AGENT_TOKEN` as a bearer token.
3. Calls `whoami` and prints the answer: the agent, its workspace, the wallets it may propose from with their limits, and its live mandates.
4. Calls `propose_transfer` with `CHAIN_ID`, `TRANSFER_TO`, `AMOUNT` and `MEMO`, and prints the intent's id and status.
5. If a mandate covers the payment (`authorizedBy: "mandate"`), it says so: the payment is signed with no person asked. Otherwise (`authorizedBy: "person"`) it prints the link where a person must approve it.
6. Calls `get_intent` again and again, each call waiting up to 50 seconds for a change, and prints every status.
7. Stops at a final status: `confirmed`, `reverted`, `stuck`, `rejected`, `expired`, `cancelled`, `denied` or `failed`. It prints the transaction link or the failure code, and exits 0 only for `confirmed`.

A tool that refuses the call (for example a payment over the wallet's limits) ends the script with that refusal and a non-zero exit.

## Settings

| Variable      | Default                                   | Meaning                                                                               |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `MCP_URL`     | none                                      | The MCP gateway, for example `http://localhost:8080/mcp`.                             |
| `AGENT_TOKEN` | none                                      | The agent's token, shown once when the agent was created. It starts with `osa_`.      |
| `TRANSFER_TO` | none                                      | The recipient, a `0x` address.                                                        |
| `AMOUNT`      | `0.001`                                   | In whole units of the chain's native coin.                                            |
| `CHAIN_ID`    | `eip155:31337`                            | A CAIP-2 chain id. The default is the local chain the stack runs under profile `dev`. |
| `MEMO`        | `Example payment from the scripted agent` | The agent's stated reason, shown to the approver. At most 280 characters.             |

The wallet's policy decides what passes: the recipient, the amount and the chain must be within the limits people approved. A wallet with no approved limits signs nothing.

## Run it with Compose

`compose.yaml` defines the service `scripted-agent` under profile `agent`, so `up` does not start it; naming it in `docker compose run` does. It runs on the internal `agents` network, whose only reachable host is the agent gateway; `MCP_URL` is preset to that gateway. With the stack running (`docker compose --profile dev up --build`, see the [README](../../README.md)):

```sh
docker compose run --rm \
  -e AGENT_TOKEN=<the agent's token> \
  -e TRANSFER_TO=0x00000000000000000000000000000000000a11ce \
  scripted-agent
```

Add `-e AMOUNT=…`, `-e CHAIN_ID=…` or `-e MEMO=…` to change the others. The image is built from `Dockerfile` with the repository root as its context.

## Run it directly

From the repository root, after `bun install`, with Node 26 or later and the stack running:

```sh
MCP_URL=http://localhost:8080/mcp \
AGENT_TOKEN=<the agent's token> \
TRANSFER_TO=0x00000000000000000000000000000000000a11ce \
node examples/scripted-agent/src/agent.ts
```

Node runs the TypeScript source as it is; there is no build step.

## Checking a change

```sh
cd examples/scripted-agent && ../../node_modules/.bin/tsc --noEmit
```

This directory has no tests of its own. The release gates run its image against the whole stack: `e2e/test/release-gates.spec.ts` has it propose a payment that a person approves on the confirmation page and checks that it prints `status: confirmed` and exits 0, and uses it again for a payment under a mandate, which confirms with no person asked. That file runs in CI jobs `stack (amd64)`, `stack (arm64)`, `stack (split)`, `stack (replicas)` and `stack (openbao)` (see [`e2e/README.md`](../../e2e/README.md)); job `check` type-checks this directory. CI runs both on every push to `main` and every pull request.
