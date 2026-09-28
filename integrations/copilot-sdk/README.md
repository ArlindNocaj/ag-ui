# AG-UI ⨯ GitHub Copilot SDK

Implementation of the [AG-UI protocol](https://docs.ag-ui.com) for the native
[GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk), in
Python and TypeScript.

| SDK | Package | Port |
|-----|---------|------|
| Python | [`python/`](./python) — `ag_ui_copilot_sdk` | 8027 |
| TypeScript | [`typescript/`](./typescript) — `@ag-ui/copilot-sdk` | 8028 |

Both expose the same surface: one native Copilot session per AG-UI thread, with
`agent.run(input)` streaming AG-UI events.

## Session retention and recovery

`maxThreads` (TypeScript) / `max_threads` (Python) optionally sets the
live-session retention target, default **1000**. It must be a positive integer.
The limit is per agent instance; TypeScript request clones share one registry.
It is a soft limit, not a concurrency ceiling: active runs and sessions waiting
for frontend-tool or interrupt results are never evicted to make room.
If all sessions are protected, the registry temporarily exceeds the target and
trims eligible idle sessions as runs finish.

Capacity eviction disconnects the oldest eligible session without aborting it.
The adapter releases its cached output and keeps the native session ID and
already-sent message IDs. A later run on that thread resumes the original native
session, restoring its SDK-persisted conversation without resending old user
messages or completed tool results. Recovery requires the native session history
to remain available; missing history or a failed resume produces `RUN_ERROR`,
not a silent replacement conversation. Custom clients must implement
`resumeSession` / `resume_session` to support recovery.

Recovery records remain in memory until `close()` and grow with the conversations
and message IDs seen; `maxThreads` does not bound that metadata or native disk
storage. Recovery is limited to the same process and agent (or clone family).
It does not survive a restart or route a continuation to another pod. Closing
the agent clears its records and disconnects live sessions, but does not delete
the native SDK's on-disk history.

## Frontend tools and the pending-tool mechanism

This is the piece worth understanding. A tool registered with the Copilot SDK
**without a handler** is not executed by the runtime — the call is suspended and
surfaced as an `external_tool.requested` event carrying a native `requestId`.

That maps onto AG-UI's browser-executed tools as follows:

1. The model calls a frontend tool. The adapter emits `TOOL_CALL_START` /
   `TOOL_CALL_ARGS` / `TOOL_CALL_END` and then `RUN_FINISHED`, leaving the
   native call suspended.
2. The browser executes the tool and sends the next `RunAgentInput`, which
   carries a `role: "tool"` message.
3. The adapter resolves the **original** suspended RPC with
   `session.rpc.tools.handlePendingToolCall({ requestId, result })`
   (`handle_pending_tool_call` in Python). The result is never re-prompted as
   user text, so the model continues the same turn.

The native `requestId` and the AG-UI `toolCallId` are distinct identifiers; the
adapter keeps the mapping between them.

**Known limitation:** that mapping lives in an in-process registry. A server
restart between the handoff and the browser's answer drops the suspended call,
and the affected run ends with `RUN_ERROR`. There is no durable recovery.

## Model access

By default the SDK uses the machine's logged-in Copilot account. Set
`OPENAI_BASE_URL` (and `OPENAI_API_KEY`) to route inference at any
OpenAI-compatible endpoint through the SDK's BYOK provider instead — this is how
the Dojo e2e suites drive both servers against the repository's pinned mock model
server. `OPENAI_CHAT_MODEL_ID` selects the wire model (default `gpt-4o`).

## Dojo

Both languages expose the same feature routes:

| Feature | Protocol path |
|---------|---------------|
| `agentic_chat` | Text streaming and frontend tools |
| `backend_tool_rendering` | Backend `get_weather` tool (sample weather data) |
| `human_in_the_loop` | Pending `generate_task_steps` frontend call |
| `tool_based_generative_ui` | Frontend `generate_haiku` rendering |
| `shared_state` | `generate_recipe` commits `STATE_SNAPSHOT` |
| `agentic_generative_ui` | Streamed steps and committed progress snapshots |
| `predictive_state_updates` | `PredictState` mirrors `write_document` arguments |
| `agentic_chat_reasoning` | Native reasoning deltas |
| `agentic_chat_multimodal` | Inline image/blob attachments |
| `subgraphs` | Native specialist agents and travel selections |
| `interrupt` | Suspended `schedule_meeting` with a time picker |
| `deepagents_subagents` | Native research subagent with human approval |

Tool arguments stream as `TOOL_CALL_ARGS`; providers without deltas fall back to
one complete argument chunk. `PredictState` delegates partial-JSON handling to
CopilotKit. Tool handlers commit complete state with `setState` / `set_state`.
Subagent lifecycle and message attribution come from native SDK events, not
synthetic activity snapshots. Reasoning and image support depend on the provider.

The examples are loopback-only and unauthenticated. Their safe sample backend
tools explicitly opt out of native permission prompts; application tools do not
opt out by default.

```bash
node apps/dojo/scripts/run-dojo-everything.js --only dojo,copilot-sdk-python
node apps/dojo/scripts/run-dojo-everything.js --only dojo,copilot-sdk-typescript
```

Browser specs live in `apps/dojo/e2e/tests/copilotSdkTests`. Set
`PLAYWRIGHT_SUITE` to either integration id; optional `DOJO_SCREENSHOT_DIR`
captures each feature after its test. Keep that directory outside the repository.
