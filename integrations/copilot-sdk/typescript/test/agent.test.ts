import { describe, expect, it, vi } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { CopilotAgent, type CopilotClientPort, type CopilotSessionPort, type ToolContext } from "../src/index.js";
import { CopilotEventMapper } from "../src/mapper.js";

type Payload = { id: string; type: string; agentId?: string; data?: Record<string, unknown> };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const TEXT_TURN: Payload[] = [
  { id: "1", type: "assistant.message_start", data: { messageId: "m1" } },
  { id: "2", type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hello" } },
  { id: "3", type: "assistant.message", data: { messageId: "m1", content: "Hello there", toolRequests: [] } },
  { id: "4", type: "session.idle", data: {} },
];

const FRONTEND_TOOL_TURN: Payload[] = [
  {
    id: "1",
    type: "external_tool.requested",
    data: {
      toolCallId: "call-1",
      requestId: "req-1",
      toolName: "change_background",
      arguments: { color: "red" },
    },
  },
];

class FakeClient implements CopilotClientPort {
  session?: FakeSession;
  config?: SessionConfig;
  sessions: FakeSession[] = [];
  history = new Map<string, string[]>();
  resumedIds: string[] = [];
  constructor(
    private readonly script: Payload[],
    private readonly stall = false,
  ) {}
  async createSession(config: SessionConfig): Promise<CopilotSessionPort> {
    this.config = config;
    this.session = new FakeSession(config.onEvent!, this.script, this.stall);
    this.session.sessionId = `session-${this.history.size + 1}`;
    this.history.set(this.session.sessionId, this.session.prompts);
    this.sessions.push(this.session);
    return this.session as unknown as CopilotSessionPort;
  }
  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSessionPort> {
    const history = this.history.get(sessionId);
    if (!history) throw new Error("Session not found");
    if (this.sessions.some((s) => s.sessionId === sessionId && !s.disconnected)) {
      throw new Error("Session is still attached");
    }
    this.config = config;
    this.resumedIds.push(sessionId);
    this.session = new FakeSession(config.onEvent!, this.script, this.stall);
    this.session.sessionId = sessionId;
    this.session.prompts = history;
    this.sessions.push(this.session);
    return this.session as unknown as CopilotSessionPort;
  }
}

class FakeSession {
  sessionId = "fake-session";
  prompts: string[] = [];
  sent: Parameters<CopilotSessionPort["send"]>[0][] = [];
  resolved: string[] = [];
  aborted = false;
  disconnected = false;
  sendStarted = deferred();
  rpc = {
    tools: {
      handlePendingToolCall: async ({ requestId, result }: { requestId: string; result: unknown }) => {
        this.resolved.push(requestId);
        this.lastResult = result;
        this.emit({ id: `done-${requestId}`, type: "session.idle", data: {} });
        return { success: true };
      },
    },
  };
  lastResult: unknown;
  constructor(
    private readonly onEvent: (event: never) => void,
    private readonly script: Payload[],
    private readonly stall: boolean,
  ) {}
  emit(payload: Payload): void {
    this.onEvent(payload as never);
  }
  async send(options: Parameters<CopilotSessionPort["send"]>[0]): Promise<void> {
    if (this.disconnected) throw new Error("Session is disconnected");
    this.prompts.push(options.prompt);
    this.sent.push(options);
    this.sendStarted.resolve();
    if (this.stall) await new Promise(() => {});
    for (const payload of this.script) this.emit(payload);
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    messages: [{ id: "u1", role: "user", content: "Say hello." }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...overrides,
  } as RunAgentInput;
}

const run = (agent: CopilotAgent, input: RunAgentInput): Promise<BaseEvent[]> =>
  firstValueFrom(agent.run(input).pipe(toArray()));

async function startHeld(agent: CopilotAgent, client: FakeClient, input = makeInput()) {
  const created = deferred();
  const create = client.createSession.bind(client);
  const spy = vi.spyOn(client, "createSession").mockImplementationOnce(async (config) => {
    const session = await create(config);
    created.resolve();
    return session;
  });
  const result = run(agent, input);
  await created.promise;
  const session = client.session!;
  await session.sendStarted.promise;
  spy.mockRestore();
  return { result, session };
}

const TOOLS = [
  { name: "change_background", description: "change it", parameters: { type: "object", properties: {} } },
];

describe("CopilotAgent", () => {
  it("does not evict the oldest thread while its run is streaming", async () => {
    const client = new FakeClient([]);
    const agent = new CopilotAgent({ client, maxThreads: 2, runTimeoutMs: 5_000 });
    const { result: first, session: active } = await startHeld(agent, client);
    try {
      for (let i = 2; i <= 3; i++) {
        await run(agent, makeInput({ threadId: `t${i}`, messages: [] }));
      }
      expect(active.aborted).toBe(false);
      expect(active.disconnected).toBe(false);
      expect(client.sessions[1]!.disconnected).toBe(true);
      expect(client.sessions[1]!.aborted).toBe(false);
    } finally {
      for (const event of TEXT_TURN) active.emit(event);
      const events = await first;
      expect(events.at(-1)!.type).toBe("RUN_FINISHED");
      expect(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
      await agent.close();
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid maxThreads %s", (maxThreads) => {
    expect(() => new CopilotAgent({ client: new FakeClient([]), maxThreads })).toThrow(
      "maxThreads must be a positive integer",
    );
  });

  it("defaults to exactly 1000 resident sessions", async () => {
    const client = new FakeClient([]);
    const agent = new CopilotAgent({ client });
    try {
      for (let i = 0; i < 1000; i++) {
        await run(agent, makeInput({ threadId: `thread-${i}`, messages: [] }));
      }
      expect(client.sessions.every((s) => !s.disconnected)).toBe(true);
      await run(agent, makeInput({ threadId: "thread-1000", messages: [] }));
      expect(client.sessions.filter((s) => !s.disconnected)).toHaveLength(1000);
      expect(client.sessions[0]!.disconnected).toBe(true);
      expect(client.sessions.every((s) => !s.aborted)).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("allows protected overflow across clones and trims when runs finish", async () => {
    const client = new FakeClient([]);
    const agent = new CopilotAgent({ client, maxThreads: 1 });
    const first = await startHeld(agent, client);
    const second = await startHeld(agent.clone(), client, makeInput({ threadId: "t2" }));
    expect(client.sessions.every((s) => !s.disconnected && !s.aborted)).toBe(true);
    first.session.emit({ id: "first-idle", type: "session.idle", data: {} });
    expect((await first.result).at(-1)!.type).toBe("RUN_FINISHED");
    expect(first.session.disconnected).toBe(true);
    expect(second.session.disconnected).toBe(false);
    second.session.emit({ id: "second-idle", type: "session.idle", data: {} });
    expect((await second.result).at(-1)!.type).toBe("RUN_FINISHED");
    expect(client.sessions.filter((s) => !s.disconnected)).toHaveLength(1);
    await agent.close();
  });

  it.each(["frontend", "interrupt"])("protects pending %s work under cache pressure", async (kind) => {
    const client = new FakeClient(FRONTEND_TOOL_TURN);
    const agent = new CopilotAgent({
      client, maxThreads: 1, tools: kind === "interrupt" ? TOOLS : [],
      interrupts: kind === "interrupt" ? { change_background: (payload) => payload } : undefined,
    });
    const input = makeInput({ tools: kind === "frontend" ? TOOLS : [] });
    await run(agent, input);
    const protectedSession = client.session!;
    await run(agent, makeInput({ threadId: "t2", messages: [] }));
    expect(protectedSession.disconnected).toBe(false);
    expect(protectedSession.aborted).toBe(false);
    const events = await run(agent, {
      ...input, runId: "r2",
      ...(kind === "interrupt"
        ? { resume: [{ interruptId: "call-1", status: "resolved", payload: "ok" }] }
        : { messages: [...input.messages, { id: "answer", role: "tool", toolCallId: "call-1", content: "ok" }] }),
    } as RunAgentInput);
    expect(events.at(-1)!.type).toBe("RUN_FINISHED");
    expect(protectedSession.resolved).toEqual(["req-1"]);
    expect(client.resumedIds).toEqual([]);
    await agent.close();
  });

  it("recovers native history across clones without replaying user or completed tool messages", async () => {
    const client = new FakeClient(TEXT_TURN);
    const create = vi.spyOn(client, "createSession");
    const agent = new CopilotAgent({ client, maxThreads: 1 });
    const firstInput = makeInput();
    await run(agent, firstInput);
    const original = client.session!;
    const oldTool = { id: "old-result", role: "tool", toolCallId: "old-call", content: "done" } as const;
    for (let i = 0; i < 2; i++) {
      await run(agent.clone(), makeInput({ threadId: `other-${i}`, messages: [] }));
      expect(original.disconnected).toBe(true);
      const replay = await run(agent.clone(), {
        ...firstInput, runId: `replay-${i}`, messages: [...firstInput.messages, oldTool],
      });
      expect(replay.at(-1)!.type).toBe("RUN_FINISHED");
      expect(client.session!.sessionId).toBe(original.sessionId);
      expect(client.session).not.toBe(original);
      expect(client.session!.prompts).toEqual(["Say hello."]);
      expect(client.session!.resolved).toEqual([]);
    }
    const next = await run(agent.clone(), makeInput({
      runId: "next", state: { answer: 42 },
      messages: [...firstInput.messages, oldTool, { id: "u2", role: "user", content: "Continue." }],
    }));
    expect(next.at(-1)!.type).toBe("RUN_FINISHED");
    expect(next.some((event) => event.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
    expect(client.history.get(original.sessionId)).toHaveLength(2);
    expect(client.history.get(original.sessionId)![1]).toContain("Continue.");
    expect(client.resumedIds).toEqual([original.sessionId, original.sessionId]);
    expect(create).toHaveBeenCalledTimes(3);
    await agent.close();
    await run(agent.clone(), makeInput({ messages: [] }));
    expect(create).toHaveBeenCalledTimes(4);
    expect(client.session!.sessionId).not.toBe(original.sessionId);
    await agent.close();
  });

  it("waits for eviction before restoring, without duplicate detach or same-thread runs", async () => {
    const client = new FakeClient(TEXT_TURN);
    const agent = new CopilotAgent({ client, maxThreads: 1 });
    await run(agent, makeInput());
    const original = client.session!;
    const entered = deferred();
    const release = deferred();
    const disconnect = original.disconnect.bind(original);
    const spy = vi.spyOn(original, "disconnect").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      await disconnect();
    });
    const other = run(agent, makeInput({ threadId: "other", messages: [] }));
    await entered.promise;
    const recovered = run(agent.clone(), makeInput({ runId: "return" }));
    await expect(run(agent.clone(), makeInput({ runId: "overlap" }))).rejects.toThrow(
      "Thread already has an active run",
    );
    const third = run(agent, makeInput({ threadId: "third", messages: [] }));
    expect(client.resumedIds).toEqual([]);
    release.resolve();
    const events = await Promise.all([other, recovered, third]);
    expect(events.every((e) => e.at(-1)!.type === "RUN_FINISHED")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(client.resumedIds).toEqual([original.sessionId]);
    await agent.close();
  });

  it("reports failed recovery without creating fresh history and can retry", async () => {
    const client = new FakeClient(TEXT_TURN);
    const agent = new CopilotAgent({ client, maxThreads: 1 });
    await run(agent, makeInput());
    const sessionId = client.session!.sessionId;
    await run(agent, makeInput({ threadId: "other", messages: [] }));
    const create = vi.spyOn(client, "createSession");
    vi.spyOn(client, "resumeSession").mockRejectedValueOnce(new Error("Native resume unavailable"));
    const failed = await run(agent, makeInput({ runId: "failed" }));
    expect(failed.at(-1)).toMatchObject({ type: "RUN_ERROR", message: "Native resume unavailable" });
    expect(create).not.toHaveBeenCalled();
    expect((await run(agent, makeInput({ runId: "retry" }))).at(-1)!.type).toBe("RUN_FINISHED");
    expect(client.resumedIds).toEqual([sessionId]);
    await agent.close();
  });

  it("logs failed eviction and keeps its session usable", async () => {
    const client = new FakeClient(TEXT_TURN);
    const agent = new CopilotAgent({ client, maxThreads: 1 });
    await run(agent, makeInput());
    const original = client.session!;
    const disconnect = vi.spyOn(original, "disconnect").mockRejectedValue(new Error("Detach unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run(agent, makeInput({ threadId: "other", messages: [] }));
      expect(original.aborted).toBe(false);
      expect(original.disconnected).toBe(false);
      expect(warning).toHaveBeenCalledWith("[copilot-sdk] Session eviction failed", expect.any(Error));
      expect((await run(agent, makeInput({ runId: "same" }))).at(-1)!.type).toBe("RUN_FINISHED");
      expect(client.resumedIds).toEqual([]);
    } finally {
      disconnect.mockRestore();
      warning.mockRestore();
      await agent.close();
    }
  });

  it("closing a clone during recovery cannot restore cleared records", async () => {
    const client = new FakeClient(TEXT_TURN);
    const agent = new CopilotAgent({ client, maxThreads: 1 });
    await run(agent, makeInput());
    const originalId = client.session!.sessionId;
    await run(agent, makeInput({ threadId: "other", messages: [] }));
    const entered = deferred();
    const release = deferred();
    const resume = client.resumeSession.bind(client);
    vi.spyOn(client, "resumeSession").mockImplementationOnce(async (id, config) => {
      entered.resolve();
      await release.promise;
      return resume(id, config);
    });
    const pending = run(agent, makeInput({ runId: "return" }));
    await entered.promise;
    const closing = agent.clone().close();
    release.resolve();
    await closing;
    expect((await pending).at(-1)!.type).toBe("RUN_ERROR");
    expect(client.sessions.every((s) => s.disconnected)).toBe(true);
    await run(agent.clone(), makeInput({ messages: [] }));
    expect(client.session!.sessionId).not.toBe(originalId);
    expect(client.resumedIds).toEqual([originalId]);
    await agent.close();
  });

  it("reports missing recovery support for create-only clients", async () => {
    const native = new FakeClient(TEXT_TURN);
    const client = { createSession: vi.fn(native.createSession.bind(native)) };
    const agent = new CopilotAgent({ client, maxThreads: 1 });
    await run(agent, makeInput());
    await run(agent, makeInput({ threadId: "other", messages: [] }));
    const events = await run(agent, makeInput({ runId: "return" }));
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR", message: "Copilot client does not support session recovery",
    });
    expect(client.createSession).toHaveBeenCalledTimes(2);
    await agent.close();
  });

  it("rebinds tools and session options on resume without create-only fields", async () => {
    const client = new FakeClient(TEXT_TURN);
    const onPermissionRequest = vi.fn(() => ({ kind: "denied-no-approval-rule" as const }));
    const handler = vi.fn((_args: unknown, context: ToolContext) => {
      context.setState({ recovered: true });
      return "ok";
    });
    const agent = new CopilotAgent({
      client, maxThreads: 1, tools: [{ name: "backend", handler }],
      sessionConfig: { sessionId: "custom-create-id", onPermissionRequest, workingDirectory: "C:\\example" },
    });
    await run(agent, makeInput());
    const originalHandler = client.config!.tools![0]!.handler;
    await run(agent, makeInput({ threadId: "other", messages: [] }));
    await run(agent, makeInput({ runId: "return" }));
    expect(client.config!.sessionId).toBeUndefined();
    expect(client.config!.onPermissionRequest).toBe(onPermissionRequest);
    expect(client.config!.workingDirectory).toBe("C:\\example");
    expect(client.config!.tools![0]!.handler).not.toBe(originalHandler);
    expect(client.config!.onEvent).toBeTypeOf("function");
    await agent.close();
  });

  it("cleans late recovery handles before retrying a timed-out resume", async () => {
    vi.useFakeTimers();
    const client = new FakeClient(TEXT_TURN);
    const agent = new CopilotAgent({ client, maxThreads: 1, runTimeoutMs: 100 });
    try {
      await run(agent, makeInput());
      const sessionId = client.session!.sessionId;
      await run(agent, makeInput({ threadId: "other", messages: [] }));
      const entered = deferred();
      const release = deferred();
      const resume = client.resumeSession.bind(client);
      vi.spyOn(client, "resumeSession").mockImplementationOnce(async (id, config) => {
        entered.resolve();
        await release.promise;
        return resume(id, config);
      });
      const pending = run(agent, makeInput({ runId: "slow" }));
      await entered.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending).at(-1)).toMatchObject({
        type: "RUN_ERROR", message: "Session recovery timed out",
      });
      const retry = run(agent, makeInput({ runId: "retry" }));
      release.resolve();
      expect((await retry).at(-1)!.type).toBe("RUN_FINISHED");
      const resumed = client.sessions.filter((s) => s.sessionId === sessionId);
      expect(resumed).toHaveLength(3);
      expect(resumed[1]!.disconnected).toBe(true);
      expect(resumed[2]!.disconnected).toBe(false);
    } finally {
      await agent.close();
      vi.useRealTimers();
    }
  });

  it("streams assistant text", async () => {
    const events = await run(new CopilotAgent({ client: new FakeClient(TEXT_TURN), runTimeoutMs: 1_000 }), makeInput());
    expect(events[0]!.type).toBe("RUN_STARTED");
    expect(events.at(-1)!.type).toBe("RUN_FINISHED");
    const text = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => (event as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hello there");
  });

  it("forwards RunAgentInput.context and state into the prompt", async () => {
    const client = new FakeClient(TEXT_TURN);
    let prompt = "";
    const agent = new CopilotAgent({ client, runTimeoutMs: 1_000 });
    const original = client.createSession.bind(client);
    client.createSession = async (config) => {
      const session = (await original(config)) as unknown as FakeSession;
      session.send = async ({ prompt: value }: { prompt: string }) => {
        prompt = value;
        for (const payload of TEXT_TURN) session.emit(payload);
      };
      return session as unknown as CopilotSessionPort;
    };
    await run(
      agent,
      makeInput({
        context: [{ description: "user name", value: "Ada" }],
        state: { theme: "dark" },
      }),
    );
    expect(prompt).toContain("user name: Ada");
    expect(prompt).toContain('"theme": "dark"');
    expect(prompt.endsWith("Say hello.")).toBe(true);
  });

  it.each(["same instance", "request clones"])("hands off a frontend tool and resolves the original pending request (%s)", async (mode) => {
    const client = new FakeClient(FRONTEND_TOOL_TURN);
    const createSession = vi.spyOn(client, "createSession");
    const agent = new CopilotAgent({ client, runTimeoutMs: 5_000 });
    const firstAgent = mode === "request clones" ? agent.clone() : agent;
    const secondAgent = mode === "request clones" ? agent.clone().clone() : agent;
    try {
      const first = await run(firstAgent, makeInput({ tools: TOOLS }));
      const session = client.session!;
      expect(first.at(-1)!.type).toBe("RUN_FINISHED");
      expect(first.some((event) => event.type === "TOOL_CALL_START")).toBe(true);
      expect(session.aborted).toBe(false);
      expect(session.disconnected).toBe(false);

      const continuation = makeInput({
        runId: "r2", tools: TOOLS,
        messages: [
          { id: "u1", role: "user", content: "Say hello." },
          { id: "t-1", role: "tool", toolCallId: "call-1", content: "ok" },
        ],
      });
      const second = await run(secondAgent, continuation);
      expect(second.at(-1)!.type).toBe("RUN_FINISHED");
      const replay = await run(mode === "request clones" ? agent.clone() : agent, { ...continuation, runId: "r3" });
      expect(replay.at(-1)!.type).toBe("RUN_FINISHED");
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(client.session).toBe(session);
      // Resolved by native requestId, never re-prompted as user text.
      expect(session.resolved).toEqual(["req-1"]);
      expect(session.prompts).toHaveLength(1);
    } finally {
      await Promise.all([agent.close(), firstAgent.close(), secondAgent.close()]);
    }
  });

  it("clones current base state without sharing mutable collections", () => {
    const agent = new CopilotAgent({ client: new FakeClient(TEXT_TURN) });
    agent.agentId = "registered-agent";
    agent.description = "Registered agent";
    agent.threadId = "updated-thread";
    agent.messages = makeInput().messages;
    agent.state = { counter: { value: 1 } };
    agent.subscribe({ onEvent: () => {} });

    const cloned = agent.clone();
    expect(cloned).toBeInstanceOf(CopilotAgent);
    expect(cloned).not.toBe(agent);
    expect(cloned.agentId).toBe(agent.agentId);
    expect(cloned.description).toBe(agent.description);
    expect(cloned.threadId).toBe(agent.threadId);
    expect(cloned.messages).toEqual(agent.messages);
    expect(cloned.state).toEqual(agent.state);
    expect(cloned.subscribers).toEqual(agent.subscribers);

    cloned.messages.push({ id: "clone-message", role: "user", content: "Only in the clone" });
    cloned.state.counter.value = 2;
    cloned.subscribe({ onEvent: () => {} });
    expect(agent.messages).toHaveLength(1);
    expect(agent.state).toEqual({ counter: { value: 1 } });
    expect(agent.subscribers).toHaveLength(1);
  });

  it("rejects overlapping same-thread runs across clones without aborting the first", async () => {
    const client = new FakeClient(TEXT_TURN);
    const createSession = vi.spyOn(client, "createSession");
    const agent = new CopilotAgent({ client, runTimeoutMs: 1_000 });
    const firstAgent = agent.clone();
    const secondAgent = agent.clone();
    const first = run(firstAgent, makeInput());
    try {
      await expect(run(secondAgent, makeInput({ runId: "overlap" }))).rejects.toThrow("Thread already has an active run");
      expect((await first).at(-1)!.type).toBe("RUN_FINISHED");
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(client.session!.aborted).toBe(false);
      expect(client.session!.disconnected).toBe(false);
    } finally {
      await first;
      await Promise.all([agent.close(), firstAgent.close(), secondAgent.close()]);
    }
  });

  it.each(["original", "clone"])("closes the clone family through the %s without closing an independent agent", async (owner) => {
    const client = new FakeClient(TEXT_TURN);
    const createSession = vi.spyOn(client, "createSession");
    const config = { client, runTimeoutMs: 1_000 };
    const agent = new CopilotAgent(config);
    const cloned = agent.clone();
    const independent = new CopilotAgent(config);
    try {
      await run(cloned, makeInput());
      const sharedSession = client.session!;
      const abort = vi.spyOn(sharedSession, "abort");
      const disconnect = vi.spyOn(sharedSession, "disconnect");
      await run(independent, makeInput());
      const independentSession = client.session!;
      expect(independentSession).not.toBe(sharedSession);
      expect(createSession).toHaveBeenCalledTimes(2);

      await (owner === "original" ? agent : cloned).close();
      expect(abort).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(independentSession.aborted).toBe(false);
      expect(independentSession.disconnected).toBe(false);
      await agent.close();
      await cloned.close();
      expect(abort).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);

      const fresh = await run(cloned.clone(), makeInput({ runId: "fresh" }));
      expect(fresh.at(-1)!.type).toBe("RUN_FINISHED");
      expect(createSession).toHaveBeenCalledTimes(3);
      expect(client.session).not.toBe(sharedSession);
      expect(client.session).not.toBe(independentSession);
    } finally {
      await Promise.all([agent.close(), cloned.close(), independent.close()]);
    }
  });

  it("forwards a frontend tool error as a failure result", async () => {
    const client = new FakeClient(FRONTEND_TOOL_TURN);
    const agent = new CopilotAgent({ client, runTimeoutMs: 5_000 });
    await run(agent, makeInput({ tools: TOOLS } as Partial<RunAgentInput>));
    await run(
      agent,
      makeInput({
        runId: "r2",
        tools: TOOLS,
        messages: [
          { id: "u1", role: "user", content: "Say hello." },
          { id: "t-1", role: "tool", toolCallId: "call-1", content: "nope", error: "browser refused" },
        ],
      } as Partial<RunAgentInput>),
    );
    expect(client.session!.lastResult).toMatchObject({
      resultType: "failure",
      error: "browser refused",
    });
  });

  it("ends the run instead of awaiting a wedged native call", async () => {
    const client = new FakeClient(TEXT_TURN, true);
    const agent = new CopilotAgent({ client, runTimeoutMs: 100 });
    const events = await run(agent, makeInput());
    expect(events.at(-1)!.type).toBe("RUN_ERROR");
    expect(client.session!.aborted).toBe(true);
  });

  it.each(["before waiting", "while waiting", "after event wake"])(
    "cancels the event wait and allows a fresh same-thread run (%s)",
    async (timing) => {
      vi.useFakeTimers();
      const client = new FakeClient([]);
      const agent = new CopilotAgent({ client });
      const subscription = agent.run(makeInput()).subscribe();
      try {
        if (timing === "before waiting") subscription.unsubscribe();
        await vi.advanceTimersByTimeAsync(0);
        const cancelledSession = client.session;
        // Cancellation before session acquisition should avoid native work entirely.
        if (timing === "before waiting") expect(cancelledSession).toBeUndefined();
        else expect(cancelledSession!.prompts).toHaveLength(1);

        if (timing !== "before waiting") {
          expect(vi.getTimerCount()).toBe(1);
          if (timing === "after event wake") {
            cancelledSession!.emit({ id: "idle", type: "session.idle", data: {} });
          }
          subscription.unsubscribe();
          await vi.advanceTimersByTimeAsync(0);
        }

        if (cancelledSession) {
          expect(cancelledSession.aborted).toBe(true);
          expect(cancelledSession.disconnected).toBe(true);
        }
        expect(vi.getTimerCount()).toBe(0);

        const retry = run(agent, makeInput({ runId: "r2" }));
        await vi.advanceTimersByTimeAsync(0);
        expect(client.session).not.toBe(cancelledSession);
        client.session!.emit({ id: "retry-idle", type: "session.idle", data: {} });
        expect((await retry).at(-1)!.type).toBe("RUN_FINISHED");
        expect(client.session!.aborted).toBe(false);
        expect(client.session!.disconnected).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        subscription.unsubscribe();
        await vi.runAllTimersAsync();
        await agent.close();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["tool.execution_start", true], ["external_tool.requested", true],
    ["tool.execution_start", false], ["external_tool.requested", false],
  ] as const)(
    "streams args once before %s, with a no-stream fallback (name first: %s)",
    (type, nameFirst) => {
      const mapper = new CopilotEventMapper();
      const chunks = ['{"color":', '"red"}'];
      const streamed = chunks.flatMap((inputDelta, index) => {
        const events = mapper.mapEvent({
          id: `delta-${index}`, type: "assistant.tool_call_delta",
          data: { toolCallId: "call-1", ...(index === (nameFirst ? 0 : 1) ? { toolName: "paint" } : {}), inputDelta },
        } as SessionEvent);
        if (!nameFirst && index === 0) expect(events).toEqual([]);
        return events;
      });
      expect(streamed).toEqual([
        { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "paint" },
        ...(nameFirst ? chunks : [chunks.join("")]).map((delta) => ({ type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta })),
      ]);
      const data = { toolCallId: "call-1", toolName: "paint", requestId: "req-1", arguments: { color: "red" } };
      expect(mapper.mapEvent({ id: "end", type, data } as SessionEvent)).toEqual([
        { type: "TOOL_CALL_END", toolCallId: "call-1" },
      ]);
      expect(mapper.mapEvent({
        id: "final-message", type: "assistant.message",
        data: { messageId: "m1", content: "", toolRequests: [{ toolCallId: "call-1", name: "paint", arguments: data.arguments }] },
      } as SessionEvent)).toEqual([]);
      expect(mapper.mapEvent({
        id: "fallback", type, data: { ...data, toolCallId: "call-2", requestId: "req-2" },
      } as SessionEvent)).toEqual([
        { type: "TOOL_CALL_START", toolCallId: "call-2", toolCallName: "paint" },
        { type: "TOOL_CALL_ARGS", toolCallId: "call-2", delta: '{"color":"red"}' },
        { type: "TOOL_CALL_END", toolCallId: "call-2" },
      ]);
      expect(mapper.finish()).toEqual([]);
    },
  );

  it("maps subagent lifecycle and tags its message and tool events", async () => {
    const child = { toolCallId: "spawn-1", agentName: "research", agentDisplayName: "Research", agentDescription: "Find facts", parentId: "parent-agent" };
    const script: Payload[] = [
      { type: "subagent.started", agentId: "parent-agent", data: { toolCallId: "spawn-parent", agentName: "coordinator", agentDisplayName: "Coordinator", agentDescription: "Coordinate", parentId: "unknown-task-registry-id" } },
      { type: "subagent.started", data: child },
      { type: "session.idle", data: {} },
      { type: "assistant.message_delta", data: { messageId: "child-message", deltaContent: "Found it" } },
      { type: "assistant.message", data: { messageId: "child-message", content: "Found it", toolRequests: [] } },
      { type: "assistant.tool_call_delta", data: { toolCallId: "child-tool", toolName: "lookup", inputDelta: "{}" } },
      { type: "tool.execution_start", data: { toolCallId: "child-tool", toolName: "lookup", arguments: {} } },
      { type: "tool.execution_complete", data: { toolCallId: "child-tool", success: true, result: { content: "found" } } },
      { type: "subagent.completed", data: child },
      { type: "subagent.started", agentId: "child-2", data: { ...child, toolCallId: "spawn-2" } },
      { type: "subagent.failed", agentId: "child-2", data: { ...child, toolCallId: "spawn-2", error: "Lookup failed" } },
      { type: "subagent.completed", agentId: "parent-agent", data: { toolCallId: "spawn-parent", agentName: "coordinator", agentDisplayName: "Coordinator" } },
    ].map((event, index) => ({ id: String(index), agentId: "child-1", ...event }));
    script.push({ id: "root-idle", type: "session.idle", data: {} });
    const events = await run(new CopilotAgent({ client: new FakeClient(script), runTimeoutMs: 1_000 }), makeInput());
    const lifecycle = events.filter((event) => event.type.startsWith("SUBAGENT_"));
    expect(lifecycle).toMatchObject([
      { type: "SUBAGENT_STARTED", subagentRunId: "parent-agent", parentToolCallId: "spawn-parent" },
      { type: "SUBAGENT_STARTED", subagentRunId: "child-1", parentToolCallId: "spawn-1", parentSubagentRunId: "parent-agent", name: "Research" },
      { type: "SUBAGENT_FINISHED", subagentRunId: "child-1", outcome: { type: "success" } },
      { type: "SUBAGENT_STARTED", subagentRunId: "child-2", parentToolCallId: "spawn-2" },
      { type: "SUBAGENT_ERROR", subagentRunId: "child-2", message: "Lookup failed" },
      { type: "SUBAGENT_FINISHED", subagentRunId: "parent-agent", outcome: { type: "success" } },
    ]);
    expect(lifecycle[1]).not.toHaveProperty("toolCallId");
    expect(lifecycle[0]).not.toHaveProperty("parentSubagentRunId", "unknown-task-registry-id");
    const tagged = events.filter((event) => /^(TEXT_MESSAGE_|TOOL_CALL_)/.test(event.type));
    expect(tagged).toHaveLength(7);
    for (const event of tagged) expect(event).toHaveProperty("subagentRunId", "child-1");
    expect(events.at(-1)!.type).toBe("RUN_FINISHED");

    const mapper = new CopilotEventMapper();
    const started = mapper.mapEvent({
      id: "paused-child", type: "subagent.started", agentId: "child-1", data: child,
    } as SessionEvent);
    expect(mapper.suspend()).toEqual([
      { type: "SUBAGENT_FINISHED", subagentRunId: "child-1", outcome: { type: "suspended" } },
    ]);
    expect(mapper.resume()).toEqual(started);
    expect(mapper.resume()).toEqual([]);
    expect(mapper.mapEvent({
      id: "completed-child", type: "subagent.completed", agentId: "child-1", data: child,
    } as SessionEvent)).toEqual([
      { type: "SUBAGENT_FINISHED", subagentRunId: "child-1", outcome: { type: "success" } },
    ]);
    expect(mapper.suspend()).toEqual([]);
  });

  it.each([true, false])("sends inline image and legacy binary blobs (with text: %s)", async (withText) => {
    const client = new FakeClient(TEXT_TURN);
    const events = await run(new CopilotAgent({ client, runTimeoutMs: 1_000 }), makeInput({
      messages: [{
        id: "image-user", role: "user", content: [
          ...(withText ? [{ type: "text" as const, text: "Describe these." }] : []),
          { type: "image", source: { type: "data", value: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" } },
          { type: "binary", data: "d29ybGQ=", mimeType: "image/jpeg" },
        ],
      }],
    }));
    expect(client.session!.sent).toHaveLength(1);
    expect(client.session!.sent[0]!.attachments).toEqual([
      { type: "blob", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "blob", data: "d29ybGQ=", mimeType: "image/jpeg" },
    ]);
    if (withText) expect(client.session!.sent[0]!.prompt).toBe("Describe these.");
    else expect(client.session!.sent[0]!.prompt).toBe("Describe the attached media.");
    expect(events.at(-1)!.type).toBe("RUN_FINISHED");
  });

  it("emits PredictState and immutable snapshots across mutable backend handler steps", async () => {
    const predictState = [{ state_key: "theme", tool: "set_theme", tool_argument: "theme" }];
    const seenStates: unknown[] = [];
    const client = new FakeClient([{ id: "idle", type: "session.idle", data: {} }]);
    const create = client.createSession.bind(client);
    client.createSession = async (config) => {
      const session = await create(config);
      const send = session.send.bind(session);
      session.send = async (options) => {
        for (const theme of ["light", "contrast"]) {
          const args = { theme };
          await config.tools![0]!.handler!(args, {
            sessionId: session.sessionId, toolCallId: `backend-${theme}`, toolName: "set_theme", arguments: args,
          });
        }
        return send(options);
      };
      return session;
    };
    const agent = new CopilotAgent({
      client, predictState, runTimeoutMs: 1_000,
      tools: [{
        name: "set_theme", description: "Update theme", parameters: { type: "object" },
        handler: (args, context) => {
          const state = context.state as { theme: { history: string[] } };
          seenStates.push(structuredClone(state));
          state.theme.history.push(args.theme);
          context.setState(state);
          state.theme.history.push("unpublished");
          return "updated";
        },
      }],
    });
    const events = await run(agent, makeInput({ state: { theme: { history: ["dark"] } } }));
    expect(client.config!.tools![0]!.skipPermission ?? false).toBe(false);
    expect(seenStates).toEqual([
      { theme: { history: ["dark"] } },
      { theme: { history: ["dark", "light"] } },
    ]);
    expect(events).toEqual([
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "CUSTOM", name: "PredictState", value: predictState },
      { type: "STATE_SNAPSHOT", snapshot: { theme: { history: ["dark", "light"] } } },
      { type: "STATE_SNAPSHOT", snapshot: { theme: { history: ["dark", "light", "contrast"] } } },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
    ]);
  });

  it.each(["tool", "resume", "error"])("resumes an interrupt through the original native request (%s)", async (mode) => {
    const client = new FakeClient(FRONTEND_TOOL_TURN.map((event) => ({ ...event, agentId: "approval-agent" })));
    const resume = vi.fn((answer: unknown, args: unknown) => ({ answer, args }));
    const agent = new CopilotAgent({
      client, tools: TOOLS, interrupts: { change_background: resume }, runTimeoutMs: 5_000,
    });
    const first = await run(agent, makeInput());
    expect(client.config!.tools![0]!.handler).toBeUndefined();
    expect(client.config!.tools![0]!.skipPermission).toBe(true);
    expect(first.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "interrupt", interrupts: [{
        id: "call-1", reason: "tool_call", toolCallId: "call-1",
        subagentRunId: "approval-agent", metadata: { reason: { color: "red" } },
      }] },
    });
    const answer = { approved: true };
    const second = await run(agent, makeInput({
      runId: "r2",
      ...(mode === "resume"
        ? { resume: [{ interruptId: "call-1", status: "resolved", payload: answer }] }
        : { messages: [
          ...makeInput().messages,
          { id: "answer", role: "tool", toolCallId: "call-1",
            content: mode === "error" ? "unavailable" : JSON.stringify(answer),
            ...(mode === "error" ? { error: "browser refused" } : {}) },
        ] }),
    }));
    expect(second.at(-1)!.type).toBe("RUN_FINISHED");
    expect(client.session!.resolved).toEqual(["req-1"]);
    expect(client.session!.prompts).toHaveLength(1);
    if (mode === "error") {
      expect(client.session!.lastResult).toEqual({
        textResultForLlm: "unavailable", resultType: "failure", error: "browser refused",
      });
    } else {
      expect(resume).toHaveBeenCalledExactlyOnceWith(answer, { color: "red" });
      expect(JSON.parse(client.session!.lastResult as string)).toEqual({ answer, args: { color: "red" } });
    }
  });
});
