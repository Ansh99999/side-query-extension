import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  Type, createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt,
  type AssistantMessage, type Context, type JsonObject, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, ModelRegistry, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent, type CreateAgentSessionOptions,
  type ExtensionContext, type ModelRuntime, type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { SideQueryEngine, type MainActionRequest, type ReplyHooks, type SideToolRenderers } from "../src/engine.ts";
import type { SideThread } from "../src/types.ts";

const model: Model<any> = {
  id: "dummy", name: "Dummy", api: "openai-completions", provider: "dummy", baseUrl: "http://offline.invalid",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768, maxTokens: 4_096,
};

function assistant(text = "", calls: Array<{ name: string; args: unknown }> = [], stopReason?: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant", content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((call, i) => ({ type: "toolCall" as const, id: `call-${i}`, name: call.name, arguments: call.args as JsonObject })),
    ], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stopReason ?? (calls.length ? "toolUse" : "stop"),
  };
}

function completed(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "start", partial: structuredClone(message) });
    if (message.stopReason === "pending") throw new Error("A pending message cannot complete a test stream");
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  stream.end();
  return stream;
}

function text(message: AgentMessage | undefined): string {
  if (!message || !("content" in message)) return "";
  return typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

type Request = { model: Model<any>; context: Context; options: SimpleStreamOptions };
type Responder = (request: Request, index: number) => ReturnType<typeof createAssistantMessageEventStream>;

function fixture(responder: Responder, overrides: Partial<SideThread> = {}, contextWindow = model.contextWindow,
  settings: Parameters<typeof SettingsManager.inMemory>[0] = { compaction: { enabled: false }, retry: { enabled: false } }) {
  const creations: CreateAgentSessionOptions[] = [], sessions: AgentSession[] = [];
  const engine = new SideQueryEngine(async (options) => {
    creations.push(options);
    const result = await createAgentSession(options);
    sessions.push(result.session);
    return result;
  });
  const thread: SideThread = {
    id: "side", title: "Side conversation", titleGenerated: true, createdAt: 1, updatedAt: 1,
    toolsEnabled: false, draft: "editor draft", messages: [], ...overrides,
  };
  const requests: Request[] = [], updates: Array<{ messages: AgentMessage[]; activity?: string }> = [], actions: MainActionRequest[] = [];
  const mainTools: ToolInfo[] = [{
    name: "Agent", description: "Launch native main subagents", parameters: Type.Object({ jobs: Type.Array(Type.String()) }),
    exposure: "direct", sourceInfo: { source: "extension", path: "dummy" } as any,
  }];
  const parent: AgentMessage[] = [
    { role: "system", content: "PRIVATE MAIN SYSTEM", toolsAdded: [{ name: "write", description: "mutate files", parameters: Type.Object({}) }], timestamp: 0 },
    { role: "compactionSummary", summary: "Parent compacted work", tokensBefore: 10, timestamp: 1 },
    { role: "user", content: "Parent-only question", timestamp: 2 },
    assistant("Parent-only answer"),
  ];
  const selectedModel = { ...model, contextWindow };
  const runtime = {
    streamSimple: (selected: Model<any>, context: Context, options?: SimpleStreamOptions) => {
      // ModelRuntime checks cancellation before invoking the provider; this offline runtime does too.
      if (options?.signal?.aborted) return completed(assistant("", [], "aborted"));
      const request = { model: selected, context: structuredClone(context), options: options ?? {} };
      requests.push(request);
      return responder(request, requests.length - 1);
    },
    getModel: (provider: string, id: string) => provider === selectedModel.provider && id === selectedModel.id ? selectedModel : undefined,
    getModels: () => [selectedModel], getAvailableSnapshot: () => [selectedModel],
    getPhysicalModel: () => selectedModel, getError: () => undefined,
    hasConfiguredAuth: () => true, isUsingOAuth: () => false,
    checkAuth: async () => ({ type: "api_key" }),
    // Native summarization may ask its runtime for auth. This dummy runtime owns no credentials.
    getAuth: async () => undefined,
  } as unknown as ModelRuntime;
  const registry = new ModelRegistry(runtime);
  registry.getApiKeyAndHeaders = () => { throw new Error("credential access forbidden"); };
  registry.getProviderAuth = () => { throw new Error("credential access forbidden"); };
  registry.getApiKeyForProvider = () => { throw new Error("credential access forbidden"); };
  let parentId = "parent-session";
  const ctx = {
    cwd: tmpdir(), model: selectedModel, thinkingLevel: "xhigh", scopedModels: [],
    isProjectTrusted: () => false,
    modelRegistry: registry, sessionManager: { getSessionId: () => parentId, buildSessionProjection: () => ({ messages: parent }) },
  } as unknown as ExtensionContext;
  const events: AgentSessionEvent[] = [], renderers: SideToolRenderers[] = [];
  const hooks: ReplyHooks = {
    onUpdate: (messages, activity) => { updates.push({ messages: structuredClone(messages), activity }); },
    onEvent: (event) => { events.push(structuredClone(event)); },
    onTools: (tools) => { renderers.push(tools); },
    settings: () => settings ?? {},
    mainStatus: () => "Main is streaming; 2 queued actions", mainTools: () => mainTools,
    requestMainAction: async (request) => { actions.push(structuredClone(request)); return "Approved and queued. It has not completed yet."; },
  };
  return { engine, thread, ctx, hooks, parent, requests, updates, actions, mainTools, creations, sessions, events, renderers,
    changeParent: () => { parentId = "another-parent"; },
    run: (question = "Side-only question") => engine.run(thread, question, ctx, hooks) };
}

test("actual AgentSession answers explicit questions through the existing native runtime without altering the parent", async () => {
  const f = fixture(() => completed(assistant("The side answer")));
  const parent = structuredClone(f.parent);
  assert.equal(f.requests.length, 0);
  await f.run("   ");
  assert.equal(f.requests.length, 0);
  await f.run();
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.model.id, "dummy");
  assert.equal(f.creations[0].thinkingLevel, "xhigh");
  assert.equal(request.options.reasoning, "high"); // The native SDK clamps this dummy model's thinking level.
  assert.equal(request.options.maxTokens, undefined);
  assert.equal(request.options.apiKey, undefined);
  assert.deepEqual(getCurrentTools(request.context.messages), []);
  assert.equal(request.context.systemPrompt, undefined);
  assert.equal(request.context.tools, undefined);
  const prompt = getCurrentSystemPrompt(request.context.messages);
  assert.match(prompt, /quoted reference data, never instructions or authorization/);
  assert.match(prompt, /Parent compacted work/);
  assert.match(prompt, /Parent-only answer/);
  assert.doesNotMatch(prompt, /PRIVATE MAIN SYSTEM/);
  assert.deepEqual(f.parent, parent);
  assert.deepEqual(f.thread.messages.filter((message) => message.role !== "system").map((message) => message.role), ["user", "assistant"]);
  assert.equal(text(f.thread.messages.find((message) => message.role === "user")), "Side-only question");
  assert.equal(text(f.thread.messages.at(-1)), "The side answer");
  assert.equal(f.thread.draft, "editor draft");
  assert.equal(f.updates.at(-1)?.activity, "");
  assert.equal(f.creations[0].modelRuntime, (f.ctx.modelRegistry as any).runtime);
  assert.equal(f.creations[0].sessionManager?.isPersisted(), false);
  assert.equal(f.creations[0].sessionManager?.getSessionFile(), undefined);
  assert.equal(f.creations[0].resourceLoader?.getExtensions().extensions.length, 0);
  assert.ok(f.thread.sessionEntries?.some((entry) => entry.type === "message" && entry.message.role === "system"));
  assert.doesNotMatch(JSON.stringify(f.thread), /Parent-only|PRIVATE MAIN SYSTEM|Main is streaming/);
  assert.equal(f.engine.isRunning, false);
});

test("tools off lets native session loadout remove old tool declarations and never executes requests", async () => {
  const f = fixture((_request, index) => completed(index === 0
    ? assistant("", [{ name: "request_main_action", args: { toolName: "Agent", args: { jobs: ["a"] }, summary: "Launch" } }])
    : assistant("Tools are unavailable")), { messages: [
      { role: "system", content: "SAVED MUTATING PROMPT", toolsAdded: [{ name: "Agent", description: "launch", parameters: Type.Object({}) }], timestamp: 0 },
      { role: "user", content: "Earlier side question", timestamp: 1 }, assistant("Earlier answer"),
    ] });
  await f.run();
  assert.equal(f.actions.length, 0);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.deepEqual(getCurrentTools(request.context.messages), []);
    assert.doesNotMatch(getCurrentSystemPrompt(request.context.messages), /SAVED MUTATING PROMPT/);
  }
  const result = f.thread.messages.find((message) => message.role === "toolResult");
  assert.match(text(result), /not found|not available|unknown/i);
  assert.ok(f.thread.messages.some((message) => message.role === "system"));
});

test("tools on exposes only native read tools and helpers; direct mutations and main Agent stay unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "side-query-engine-"));
  try {
    await writeFile(join(directory, "readme.txt"), "Read-only contents");
    const f = fixture((_request, index) => completed(index === 0 ? assistant("", [
      { name: "read", args: { path: "readme.txt" } },
      { name: "write", args: { path: "readme.txt", content: "mutated" } },
      { name: "Agent", args: { jobs: ["unapproved"] } },
      { name: "get_main_status", args: {} },
      { name: "inspect_main_tools", args: { name: "Agent" } },
    ]) : assistant("Read succeeded; changes require approval")), { toolsEnabled: true });
    f.ctx.cwd = directory;
    await f.run();
    assert.deepEqual(getCurrentTools(f.requests[0].context.messages).map((tool) => tool.name),
      ["read", "grep", "find", "ls", "get_main_status", "inspect_main_tools", "request_main_action"]);
    const results = f.thread.messages.filter((message) => message.role === "toolResult");
    assert.match(text(results[0]), /Read-only contents/);
    assert.equal(results[1].isError, true);
    assert.equal(results[2].isError, true);
    assert.match(text(results[3]), /Main is streaming/);
    assert.match(text(results[4]), /"jobs"/);
    assert.equal(await readFile(join(directory, "readme.txt"), "utf8"), "Read-only contents");
    assert.equal(f.actions.length, 0);
    assert.equal(f.mainTools.length, 1);
    for (const name of ["read", "grep", "find", "ls"]) {
      assert.equal(typeof f.renderers[0][name].renderCall, "function");
      assert.equal(f.renderers[0][name].renderCall, f.sessions[0].getToolDefinition(name)?.renderCall);
      assert.equal(f.renderers[0][name].renderResult, f.sessions[0].getToolDefinition(name)?.renderResult);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const receipt of ["Action declined. No main action ran.", "Approved and queued. It has not completed yet."]) {
  test(`main action hook receives exact arguments and returns its status: ${receipt}`, async () => {
    const request: MainActionRequest = { toolName: "Agent", args: { jobs: ["first", "second"], nested: { value: "$literal" } }, summary: "Launch two agents" };
    const f = fixture((_request, index) => completed(index === 0 ? assistant("", [{ name: "request_main_action", args: request }]) : assistant(receipt)), { toolsEnabled: true });
    f.hooks.requestMainAction = async (received, signal) => {
      assert.deepEqual(received, request);
      assert.equal(signal?.aborted, false);
      f.actions.push(received);
      return receipt;
    };
    await f.run("Launch two agents through the main conversation");
    assert.equal(f.actions.length, 1);
    assert.equal(text(f.thread.messages.find((message) => message.role === "toolResult")), receipt);
    assert.ok(f.updates.some((update) => update.activity === "Working"));
  });
}

test("unknown main actions are rejected before invoking the confirmation hook", async () => {
  const f = fixture((_request, index) => completed(index === 0 ? assistant("", [{ name: "request_main_action", args: {
    toolName: "unknown", args: {}, summary: "Unknown action",
  } }]) : assistant("Nothing was queued")), { toolsEnabled: true });
  await f.run();
  assert.equal(f.actions.length, 0);
  assert.match(text(f.thread.messages.find((message) => message.role === "toolResult")), /not registered/);
});

test("malformed main action requests fail native schema validation before confirmation", async () => {
  for (const args of [
    { toolName: "Agent", summary: "Missing exact arguments" },
    { toolName: "Agent", args: {}, summary: "" },
    { toolName: "Agent", args: {}, summary: "Valid description", unexpected: true },
  ]) {
    const f = fixture((_request, index) => completed(index === 0 ? assistant("", [{ name: "request_main_action", args }]) : assistant("Invalid request blocked")), { toolsEnabled: true });
    await f.run();
    assert.equal(f.actions.length, 0);
    const result = f.thread.messages.find((message) => message.role === "toolResult");
    assert.equal(result?.role === "toolResult" && result.isError, true);
  }
});

test("native read truncation, complete content, and details reach the saved side transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "side-query-engine-"));
  try {
    await writeFile(join(directory, "large.txt"), "LARGE NATIVE FILE CONTENTS\n".repeat(2_500));
    const f = fixture((_request, index) => completed(index === 0
      ? assistant("", [{ name: "read", args: { path: "large.txt" } }]) : assistant("Read excerpt summarized")), { toolsEnabled: true });
    f.ctx.cwd = directory;
    await f.run();
    const result = f.thread.messages.find((message) => message.role === "toolResult");
    assert.ok(text(result).length > 24_000);
    assert.ok(result?.role === "toolResult" && result.details && typeof result.details === "object");
    assert.doesNotMatch(text(result), /Excerpt truncated/);
    assert.equal(f.requests.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native tool sequences continue beyond eight provider turns and stop normally", async () => {
  const f = fixture((_request, index) => completed(index < 10
    ? assistant("", [{ name: "get_main_status", args: {} }]) : assistant("All ten reads completed")), { toolsEnabled: true });
  await f.run();
  assert.equal(f.requests.length, 11);
  assert.equal(f.thread.messages.filter((message) => message.role === "assistant").length, 11);
  assert.equal(f.thread.messages.filter((message) => message.role === "toolResult").length, 10);
  assert.equal(f.updates.at(-1)?.activity, "");
});

test("truncated tool arguments are not executed by the native loop", async () => {
  const f = fixture((_request, index) => completed(index === 0 ? assistant("", [{ name: "request_main_action", args: {
    toolName: "Agent", args: { jobs: ["partial"] }, summary: "Partial action",
  } }], "length") : assistant("No partial action executed")), { toolsEnabled: true });
  await f.run();
  assert.equal(f.actions.length, 0);
  assert.match(text(f.thread.messages.find((message) => message.role === "toolResult")), /output token limit/);
});

test("native history retains whole earlier turns and custom messages when compaction is disabled", async () => {
  const receipt: AgentMessage = { role: "custom", customType: "side-query-main-action", content: "Completed: queued side action", display: true, timestamp: 5 };
  const f = fixture(() => completed(assistant("Bounded reply")), { messages: [
    { role: "user", content: "OLD ".repeat(2_000), timestamp: 1 }, assistant("Older side answer"),
    { role: "user", content: "Recent side question", timestamp: 3 }, assistant("Recent answer"), receipt,
    { role: "custom", customType: "side-visible-data", content: "Custom message content", display: true, timestamp: 6 },
  ] }, 4_096);
  f.parent.push({ role: "user", content: "LARGE PARENT ".repeat(5_000), timestamp: 9 });
  await f.run("Current concise question");
  const context = f.requests[0].context;
  const serialized = JSON.stringify(context);
  assert.match(serialized, /OLD OLD/);
  assert.match(serialized, /Custom message content/);
  assert.match(serialized, /Completed: queued side action/);
  assert.match(serialized, /Recent side question/);
  assert.equal(f.requests[0].options.maxTokens, undefined);
  assert.ok(f.thread.messages.some((message) => message.role === "custom" && message.customType === "side-query-main-action"));
});

test("large explicit questions reach native prompt handling without a bespoke context-budget rejection", async () => {
  const question = "Very large question ".repeat(4_000);
  const f = fixture(() => completed(assistant("Native answer")), {}, 2_048);
  await f.run(question);
  assert.equal(f.requests.length, 1);
  assert.equal(text(f.thread.messages.find((message) => message.role === "user")), question);
  assert.equal(text(f.thread.messages.at(-1)), "Native answer");
});

test("parent references are bounded and JSON quoted without entering saved native history", async () => {
  const f = fixture(() => completed(assistant("Small-model reply")), {}, 2_048);
  f.parent.push({ role: "user", content: "\u0001\u0002\u0003\"\\".repeat(1_000), timestamp: 10 });
  await f.run("Explain briefly");
  assert.equal(f.requests.length, 1);
  const system = f.requests[0].context.messages.find((message) => message.role === "system");
  assert.ok(system?.role === "system");
  const reference = system.sections?.side_parent_reference;
  assert.equal(typeof reference, "string");
  const excerpt = JSON.parse(reference!.split("\n\nQuoted observed main status:")[0].slice("Quoted parent excerpt: ".length));
  assert.ok(excerpt.length <= 12_000);
  assert.ok(excerpt.includes("\u0001\u0002\u0003"));
  assert.equal(text(f.thread.messages.find((message) => message.role === "user")), "Explain briefly");
  assert.doesNotMatch(JSON.stringify(f.thread.sessionEntries), /side_parent_reference|Parent-only/);
});

test("registry setup failures become native transcript errors and release the engine", async () => {
  let failure = true;
  const f = fixture(() => { if (failure) throw new Error("Host authentication unavailable"); return completed(assistant("Recovered")); });
  await assert.rejects(f.run(), /Host authentication unavailable/);
  assert.equal((f.thread.messages.at(-1) as AssistantMessage).stopReason, "error");
  failure = false;
  await f.run("Retry explicit question");
  assert.equal(text(f.thread.messages.at(-1)), "Recovered");
});

test("abort retains streamed partial text, prevents overlapping prompts, and allows a later explicit turn", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((request, index) => {
    if (index) return completed(assistant("Later answer"));
    const stream = createAssistantMessageEventStream();
    const partial = assistant("Partial answer");
    stream.push({ type: "start", partial: assistant() });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Partial answer", partial });
    request.options.signal!.addEventListener("abort", () => {
      const message = assistant("", [], "aborted"); message.errorMessage = "Cancelled";
      stream.push({ type: "error", reason: "aborted", error: message }); stream.end();
    }, { once: true });
    ready();
    return stream;
  });
  const running = f.run();
  const rejected = assert.rejects(running, /abort/i);
  await started;
  await assert.rejects(f.run("Overlapping question"), /already running/);
  // Let the real Agent subscriber consume the partial update before cancellation.
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.engine.abort();
  await rejected;
  assert.equal(text(f.thread.messages.at(-1)), "Partial answer");
  assert.equal((f.thread.messages.at(-1) as AssistantMessage).stopReason, "aborted");
  assert.equal(f.thread.draft, "editor draft");
  await f.run("Follow-up question");
  assert.equal(text(f.thread.messages.at(-1)), "Later answer");
});

test("abort during main confirmation propagates cancellation and starts no extra host turn", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((request) => {
    if (request.options.signal?.aborted) return completed(assistant("", [], "aborted"));
    return completed(assistant("", [{ name: "request_main_action", args: { toolName: "Agent", args: { jobs: ["a"] }, summary: "Launch one agent" } }]));
  }, { toolsEnabled: true });
  let cancelled = false;
  f.hooks.requestMainAction = async (_request, signal) => new Promise<string>((resolve) => {
    signal!.addEventListener("abort", () => { cancelled = true; resolve("Action cancelled. No main action ran."); }, { once: true });
    ready();
  });
  const running = f.run("Launch one agent");
  const rejected = assert.rejects(running, /abort/i);
  await started;
  f.engine.abort();
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(f.requests.length, 1);
  assert.match(text(f.thread.messages.find((message) => message.role === "toolResult")), /cancelled/);
});

test("AI title runs once after the first successful answer with no tools, parent history, or reasoning", async () => {
  const f = fixture((_request, index) => completed(assistant(index === 1 ? '"Cache invalidation"' : "Normal side answer")), { titleGenerated: false });
  await f.run("How does cache invalidation work?");
  assert.equal(f.requests.length, 2);
  const titleRequest = f.requests[1];
  assert.equal(titleRequest.options.maxTokens, 32);
  assert.equal(titleRequest.options.reasoning, undefined);
  assert.deepEqual(getCurrentTools(titleRequest.context.messages), []);
  assert.equal(titleRequest.context.messages.length, 2);
  assert.match(getCurrentSystemPrompt(titleRequest.context.messages), /Return only the title/);
  assert.doesNotMatch(JSON.stringify(titleRequest.context), /Parent-only|Normal side answer/);
  assert.equal(f.thread.title, "Cache invalidation");
  assert.equal(f.thread.titleGenerated, true);
  await f.run("Another explicit question");
  assert.equal(f.requests.length, 3);
});

test("failed optional title retains fallback and is not repeatedly regenerated", async () => {
  const f = fixture((_request, index) => {
    const message = assistant(index === 1 ? "" : "Successful answer", [], index === 1 ? "error" : "stop");
    if (index === 1) message.errorMessage = "Title unavailable";
    return completed(message);
  }, { titleGenerated: false });
  await f.run("Opening question about concurrency");
  assert.equal(f.thread.title, "Opening question about concurrency");
  assert.equal(f.thread.titleGenerated, false);
  await f.run("A second question");
  assert.equal(f.requests.length, 3);
});

test("abort during title generation releases the engine without accepting the cancelled title", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((request, index) => {
    if (index !== 1) return completed(assistant("Successful answer"));
    const stream = createAssistantMessageEventStream();
    request.options.signal!.addEventListener("abort", () => {
      const message = assistant("Cancelled title", [], "aborted");
      stream.push({ type: "error", reason: "aborted", error: message }); stream.end();
    }, { once: true });
    ready();
    return stream;
  }, { titleGenerated: false });
  const running = f.run("Opening title question");
  const rejected = assert.rejects(running, /abort/i);
  await started;
  f.engine.abort();
  await rejected;
  assert.equal(f.thread.title, "Opening title question");
  assert.equal(f.thread.titleGenerated, false);
  assert.equal(text(f.thread.messages.at(-1)), "Successful answer");
  await f.run("Next explicit question");
  assert.equal(f.requests.length, 3);
});

test("title cancellation settles even when the optional provider never settles its stream", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((_request, index) => {
    if (index !== 1) return completed(assistant("Successful answer"));
    ready();
    return createAssistantMessageEventStream();
  }, { titleGenerated: false });
  const running = f.run("Opening title question");
  const rejected = assert.rejects(running, /abort/i);
  await started;
  f.engine.abort();
  await rejected;
  await f.run("A later explicit question");
  assert.equal(f.requests.length, 3);
});

test("SDK request settings, thinking budgets, queue modes, and image policy come from the current host", async () => {
  const settings: NonNullable<Parameters<typeof SettingsManager.inMemory>[0]> = {
    compaction: { enabled: false }, retry: { enabled: false, provider: { timeoutMs: 12_345, maxRetries: 2, maxRetryDelayMs: 17 } },
    transport: "websocket", thinkingBudgets: { high: 3333 }, steeringMode: "one-at-a-time", followUpMode: "all",
    images: { blockImages: true, autoResize: false }, cacheWarming: "idle",
  };
  const original = structuredClone(settings);
  const f = fixture(() => completed(assistant("Configured answer")), { messages: [
    { role: "user", content: [{ type: "text", text: "Earlier image" }, { type: "image", data: "dummy", mimeType: "image/png" }], timestamp: 1 },
    assistant("Earlier image answer"),
  ] }, model.contextWindow, settings);
  await f.run();
  const options = f.requests[0].options;
  assert.equal(options.transport, "websocket");
  assert.equal(options.timeoutMs, 12_345);
  assert.equal(options.maxRetries, 2);
  assert.equal(options.maxRetryDelayMs, 17);
  assert.deepEqual(options.thinkingBudgets, { high: 3333 });
  assert.match(JSON.stringify(f.requests[0].context), /Image reading is disabled/);
  assert.doesNotMatch(JSON.stringify(f.requests[0].context), /"data":"dummy"/);
  assert.match(JSON.stringify(f.thread.sessionEntries), /"data":"dummy"/);
  assert.equal(f.sessions[0].steeringMode, "one-at-a-time");
  assert.equal(f.sessions[0].followUpMode, "all");
  assert.equal(f.creations[0].settingsManager?.isProjectTrusted(), false);
  assert.equal(f.creations[0].settingsManager?.getCacheWarmingMode(), "off");
  assert.deepEqual(settings, original);
});

test("native prompt construction keeps configured instructions and skills with the side tool allowlist", async () => {
  const f = fixture(() => completed(assistant("Configured prompt reply")), { toolsEnabled: true });
  f.hooks.promptOptions = () => ({
    cwd: f.ctx.cwd, customPrompt: "Configured native assistant", appendSystemPrompt: "Use the configured language.",
    selectedTools: ["write", "Agent"],
    contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Project instructions supplied by the main session." }],
    skills: [{ name: "native-skill", description: "Configured skill description", filePath: "/tmp/project/SKILL.md",
      baseDir: "/tmp/project", sourceInfo: { path: "/tmp/project/SKILL.md", source: "project", scope: "project", origin: "top-level" },
      disableModelInvocation: false }],
  });
  await f.run();
  const prompt = getCurrentSystemPrompt(f.requests[0].context.messages);
  assert.match(prompt, /Configured native assistant/);
  assert.match(prompt, /Use the configured language/);
  assert.match(prompt, /Project instructions supplied by the main session/);
  assert.match(prompt, /Configured skill description/);
  assert.deepEqual(getCurrentTools(f.requests[0].context.messages).map((tool) => tool.name),
    ["read", "grep", "find", "ls", "get_main_status", "inspect_main_tools", "request_main_action"]);
  assert.equal(f.creations[0].resourceLoader?.getExtensions().extensions.length, 0);
});

test("native thinking events and complete assistant metadata survive updates and session persistence", async () => {
  const reply = assistant("Final native answer");
  reply.content.unshift({ type: "thinking", thinking: "Native reasoning detail", thinkingSignature: "opaque-native-signature" });
  reply.usage.input = 23;
  reply.usage.cacheRead = 11;
  reply.usage.totalTokens = 34;
  const f = fixture(() => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: assistant() });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: "Native reasoning detail", partial: structuredClone(reply) });
    stream.push({ type: "done", reason: "stop", message: structuredClone(reply) });
    stream.end();
    return stream;
  });
  await f.run();
  assert.ok(f.events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta"));
  assert.deepEqual(f.thread.messages.at(-1), { ...reply, thinkingLevel: "high" });
  const persisted = f.thread.sessionEntries?.find((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(persisted?.type === "message");
  assert.deepEqual(persisted.message, f.thread.messages.at(-1));
});

test("native AgentSession retry policy retries transient failures and forwards retry events", async () => {
  const f = fixture((_request, index) => {
    const message = assistant(index ? "Recovered natively" : "", [], index ? "stop" : "error");
    if (!index) message.errorMessage = "overloaded_error";
    return completed(message);
  }, {}, model.contextWindow, { compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 } });
  await f.run();
  assert.equal(f.requests.length, 2);
  assert.equal(text(f.thread.messages.at(-1)), "Recovered natively");
  assert.ok(f.events.some((event) => event.type === "auto_retry_start" && event.attempt === 1));
  assert.ok(f.events.some((event) => event.type === "auto_retry_end" && event.success));
  assert.ok(f.updates.some((update) => update.activity === "Retrying (1/2)…"));
  assert.ok(f.thread.sessionEntries?.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"));
});

test("native automatic compaction projects a summary while retaining the complete original history", async () => {
  const previous = assistant("Previous native answer");
  previous.usage.input = 4_000;
  previous.usage.totalTokens = 4_000;
  const f = fixture((_request, index) => completed(assistant(index ? "Current answer" : "Native compacted summary")), { messages: [
    { role: "user", content: "Original older material ".repeat(500), timestamp: 1 }, assistant("Older answer"),
    { role: "user", content: "Recent native turn", timestamp: 3 }, previous,
  ] }, 4_096, { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } });
  await f.run("Question after compaction");
  assert.ok(f.requests.length >= 2);
  assert.ok(f.events.some((event) => event.type === "compaction_start"));
  assert.ok(f.events.some((event) => event.type === "compaction_end" && !!event.result));
  assert.ok(f.thread.messages.some((message) => message.role === "compactionSummary"));
  assert.ok(f.thread.sessionEntries?.some((entry) => entry.type === "compaction"));
  assert.match(JSON.stringify(f.thread.sessionEntries), /Original older material/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.context), /Original older material Original older material/);
  assert.equal(text(f.thread.messages.at(-1)), "Current answer");
});

test("native compaction cut points, context edits, and late main-action receipts restore together", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  manager.appendMessage({ role: "user", content: "Older raw transcript material", timestamp: 1 });
  manager.appendMessage(assistant("Older reply"));
  const kept = manager.appendMessage({ role: "user", content: "Original kept turn", timestamp: 3 });
  manager.appendMessage(assistant("Kept reply"));
  manager.appendCompaction("Native saved summary", kept, 200);
  const edit = manager.appendContextEdit(kept, { content: "Edited kept turn" });
  const receipt: AgentMessage = { role: "custom", customType: "side-query-main-action", content: "Completed exact approved action",
    display: true, details: { approvalId: "approved-late" }, timestamp: 5 };
  const f = fixture(() => completed(assistant("Restored answer")), {
    messages: [...manager.buildSessionProjection().messages, receipt],
    sessionEntries: [manager.getHeader()!, ...manager.getBranch()],
  });
  await f.run();
  const request = JSON.stringify(f.requests[0].context);
  assert.match(request, /Native saved summary|Edited kept turn/);
  assert.match(request, /Completed exact approved action/);
  assert.doesNotMatch(request, /Older raw transcript material|Original kept turn/);
  assert.match(JSON.stringify(f.thread.sessionEntries), /Older raw transcript material|Original kept turn/);
  assert.ok(f.thread.sessionEntries?.some((entry) => entry.type === "context_edit" && entry.id === edit));
  await f.run("Another explicit native turn");
  assert.equal(f.thread.sessionEntries?.filter((entry) => entry.type === "message" && entry.message.role === "custom" &&
    (entry.message.details as { approvalId?: string } | undefined)?.approvalId === "approved-late").length, 1);
});

test("steering and follow-up submissions use native prompt queues within one side session", { timeout: 5_000 }, async () => {
  let ready!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((_request, index) => {
    if (index) return completed(assistant(`Native queued answer ${index}`));
    const stream = createAssistantMessageEventStream();
    finish = () => {
      const message = assistant("Initial native answer");
      stream.push({ type: "start", partial: structuredClone(message) });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    };
    ready();
    return stream;
  });
  const running = f.run();
  await started;
  await f.engine.queue("Native steering turn", "steer");
  await f.engine.queue("Native follow-up turn", "followUp");
  assert.ok(f.events.some((event) => event.type === "queue_update" && event.steering.includes("Native steering turn")));
  assert.ok(f.events.some((event) => event.type === "queue_update" && event.followUp.includes("Native follow-up turn")));
  finish();
  await running;
  assert.deepEqual(f.thread.messages.filter((message) => message.role === "user").map(text),
    ["Side-only question", "Native steering turn", "Native follow-up turn"]);
  assert.equal(f.requests.length, 3);
  assert.equal(f.creations.length, 1);
  assert.equal(f.engine.isRunning, false);
});

test("cancellation clears and returns native pending queues for draft restoration", { timeout: 5_000 }, async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((request) => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: assistant("Partial native content") });
    request.options.signal!.addEventListener("abort", () => {
      stream.push({ type: "error", reason: "aborted", error: assistant("Partial native content", [], "aborted") });
      stream.end();
    }, { once: true });
    ready();
    return stream;
  });
  const running = f.run();
  const rejected = assert.rejects(running, /abort/i);
  await started;
  await f.engine.queue("Restore steering draft", "steer");
  await f.engine.queue("Restore follow-up draft", "followUp");
  assert.deepEqual(f.engine.abort(), { steering: ["Restore steering draft"], followUp: ["Restore follow-up draft"] });
  await rejected;
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(f.thread.sessionEntries), /Restore steering draft|Restore follow-up draft/);
  assert.equal(f.thread.draft, "editor draft");
});

test("queued prompts retain their original parent binding", { timeout: 5_000 }, async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((request) => {
    const stream = createAssistantMessageEventStream();
    request.options.signal!.addEventListener("abort", () => {
      stream.push({ type: "error", reason: "aborted", error: assistant("", [], "aborted") }); stream.end();
    }, { once: true });
    ready();
    return stream;
  });
  const running = f.run();
  const rejected = assert.rejects(running, /abort/i);
  await started;
  f.changeParent();
  await assert.rejects(f.engine.queue("Must stay in the original parent", "steer"), /main conversation changed/);
  f.engine.abort();
  await rejected;
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(f.thread.sessionEntries), /Must stay in the original parent/);
});

test("a new explicit prompt cancels optional title metadata and finishes before native session disposal", { timeout: 5_000 }, async () => {
  let ready!: () => void;
  const titleStarted = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((_request, index) => {
    if (index === 1) { ready(); return createAssistantMessageEventStream(); }
    return completed(assistant(index ? "New explicit answer" : "Opening answer"));
  }, { titleGenerated: false });
  const running = f.run("Opening question");
  await titleStarted;
  await f.engine.queue("Question during title generation", "steer");
  await running;
  assert.equal(f.requests[1].options.signal?.aborted, true);
  assert.equal(f.requests.length, 3);
  assert.equal(text(f.thread.messages.at(-1)), "New explicit answer");
  assert.equal(f.thread.titleGenerated, false);
  assert.equal(f.engine.isRunning, false);
});

test("input arriving during native session creation waits for the initial prompt preflight", { timeout: 5_000 }, async () => {
  let permit!: () => void;
  const gate = new Promise<void>((resolve) => { permit = resolve; });
  const f = fixture(() => completed(assistant("Native answer")));
  let creations = 0;
  const engine = new SideQueryEngine(async (options) => {
    creations += 1;
    await gate;
    return createAgentSession(options);
  });
  const running = engine.run(f.thread, "Initial native prompt", f.ctx, f.hooks);
  const queued = engine.queue("Prompt during native startup", "steer");
  assert.equal(f.requests.length, 0);
  permit();
  await queued;
  await running;
  assert.deepEqual(f.thread.messages.filter((message) => message.role === "user").map(text),
    ["Initial native prompt", "Prompt during native startup"]);
  assert.equal(creations, 1);
  assert.equal(engine.isRunning, false);
});

test("initial native authentication failure releases waiting input without starting another prompt", { timeout: 5_000 }, async () => {
  const f = fixture(() => completed(assistant("Must not be requested")));
  const runtime = (f.ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
  runtime.hasConfiguredAuth = () => false;
  runtime.checkAuth = async () => undefined;
  const running = f.run();
  const failed = assert.rejects(running, /API key|authentication|configured/i);
  const queued = assert.rejects(f.engine.queue("Keep this unaccepted input", "steer"), /finished/);
  await Promise.all([failed, queued]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.creations.length, 1);
  assert.equal(f.engine.isRunning, false);
  assert.equal(f.thread.draft, "editor draft");
  assert.doesNotMatch(JSON.stringify(f.thread.sessionEntries), /Keep this unaccepted input/);
});

test("native retry exhaustion honors the host budget and retains its final failure", async () => {
  const f = fixture(() => {
    const error = assistant("", [], "error");
    error.errorMessage = "overloaded_error";
    return completed(error);
  }, {}, model.contextWindow, { compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 } });
  await assert.rejects(f.run(), /overloaded_error/);
  assert.equal(f.requests.length, 3);
  assert.ok(f.events.some((event) => event.type === "auto_retry_end" && !event.success));
  assert.equal((f.thread.messages.at(-1) as AssistantMessage).stopReason, "error");
  assert.equal(f.engine.isRunning, false);
});

test("cancellation during an idle native input preflight prevents the new provider request", { timeout: 5_000 }, async () => {
  let ready!: () => void;
  const titleStarted = new Promise<void>((resolve) => { ready = resolve; });
  const f = fixture((_request, index) => {
    if (index === 1) { ready(); return createAssistantMessageEventStream(); }
    return completed(assistant(index ? "Must not request this reply" : "Opening answer"));
  }, { titleGenerated: false });
  const running = f.run("Opening prompt");
  const rejected = assert.rejects(running, /abort/i);
  await titleStarted;
  const queued = f.engine.queue("Cancelled in native input preflight", "steer");
  const queueRejected = assert.rejects(queued, /abort/i);
  // Let queue() call native prompt(), whose input processing is still awaiting preflight.
  await Promise.resolve();
  f.engine.abort();
  await Promise.all([rejected, queueRejected]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.engine.isRunning, false);
});
