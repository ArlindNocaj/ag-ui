# @ag-ui/copilot-sdk

Implementation of the AG-UI protocol for the native GitHub Copilot SDK (TypeScript).

## Installation

```bash
pnpm add @ag-ui/copilot-sdk
```

## Usage

`CopilotAgent` is an `AbstractAgent` from `@ag-ui/client`, so it plugs into any
AG-UI host:

```ts
import { CopilotClient } from "@github/copilot-sdk";
import { CopilotAgent } from "@ag-ui/copilot-sdk";

const client = new CopilotClient({ mode: "empty", baseDirectory });
await client.start();

const agent = new CopilotAgent({ client, model: "gpt-5.4-mini" });
agent.run(input).subscribe({ next: (event) => res.write(encoder.encode(event)) });
```

Register and reuse a long-lived `CopilotAgent` when hosting directly in CopilotKit.
Per-request `clone()` instances share its native sessions and pending tool calls,
while separately constructed agents remain independent. Call `close()` at host
shutdown, not after each request: closing any clone closes the family's sessions.
Recovery records and pending calls remain process-local; cloning does not provide
recovery after a restart or continuation on another server process.

## Features

- **One native session per thread** — reused across runs, so the model keeps its turn context
- **Frontend tool handoff** — suspended tool calls are resolved through the original pending RPC, not replayed as text (see the [integration README](../README.md))
- **Tool errors** — a `role: "tool"` message carrying `error` is forwarded to the model as a failure result
- **Context injection** — `RunAgentInput.context` and `state` are injected into the prompt preamble
- **BYOK provider** — set `OPENAI_BASE_URL` / `OPENAI_API_KEY` to use any OpenAI-compatible endpoint

## Configuration

| Option | Default | Purpose |
|--------|---------|---------|
| `client` | — | Copilot SDK client |
| `model` | `gpt-5.4-mini` | Copilot model id |
| `instructions` | — | Appended to the system message |
| `tools` | `[]` | Server-side tools the model may call directly |
| `sessionConfig` | `{}` | Passed through to create and resume (excluding create-only options on resume) |
| `predictState` | — | `[{state_key, tool, tool_argument}]` emitted as `CUSTOM PredictState` |
| `interrupts` | `{}` | Maps a handler-less tool's browser answer into the original pending RPC result |
| `runTimeoutMs` | `120000` | Wall-clock budget per run; on expiry the native work is abandoned and the run ends with `RUN_ERROR` |
| `maxPendingTools` | `32` | Bounds the in-process pending-tool registry |
| `maxThreads` | `1000` | Positive-integer live-session retention target; active runs and pending tools may exceed it |

Idle sessions above `maxThreads` are disconnected without aborting their work.
Returning threads use the native SDK's `resumeSession` with the original
session ID; old user messages and completed tool results are not sent again.
If all sessions are active or awaiting a frontend-tool/interrupt answer, new
runs are accepted and idle sessions are trimmed later.

The adapter retains recovery IDs until `close()`, separately from live-session
resources. Those records grow with the number of conversations and sent-message
IDs. Recovery is same-process only and requires available native session
history; a failed resume emits `RUN_ERROR` rather than starting fresh.
Custom `CopilotClientPort` implementations need `resumeSession` for recovery.
See [session retention and recovery](../README.md#session-retention-and-recovery).

## Examples

| Route | Description |
|-------|-------------|
| `/agentic_chat` | Basic conversational assistant |
| `/backend_tool_rendering` | Sample weather tool |
| `/human_in_the_loop` | Frontend task approval |
| `/tool_based_generative_ui` | Haiku cards |
| `/shared_state` | Recipe snapshots |
| `/agentic_generative_ui` | Streamed steps and committed progress |
| `/predictive_state_updates` | Document edits with accept/reject |
| `/agentic_chat_reasoning` | Native reasoning stream |
| `/agentic_chat_multimodal` | Inline images as blob attachments |
| `/subgraphs` | Native travel specialist agents |
| `/interrupt` | Meeting-time selection suspends the tool |
| `/deepagents_subagents` | Research subagent with approval |

Server-side `AGUITool` handlers receive a `ToolContext` with `state`, `emit`,
and `setState(snapshot)`. Set `skipPermission: true` only for tools the application
explicitly authorizes (such as these safe sample tools). Configure native
specialists with `sessionConfig.customAgents`. Unsupported media retains a
text placeholder and logs a warning.

For the repository's pinned aimock, set `OPENAI_BASE_URL=http://localhost:5555/v1`,
`OPENAI_API_KEY=sk-mock`, and `OPENAI_CHAT_MODEL_ID=gpt-4o`. Without BYOK the
SDK uses the logged-in Copilot account. Pending calls remain process-local.

```bash
pnpm nx run @ag-ui/copilot-sdk:build-example
node dist-example/server.js   # port 8028
```

The example server binds to loopback and is unauthenticated — it is a demo, not
a deployment template.

## Tests

```bash
pnpm nx run @ag-ui/copilot-sdk:test
```

The tests drive the agent with a scripted fake client: no native runtime, no
model, no network.
