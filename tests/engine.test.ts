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
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { SideQueryEngine, type MainActionRequest, type ReplyHooks } from "../src/engine.ts";
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

function fixture(responder: Responder, overrides: Partial<SideThread> = {}, contextWindow = model.contextWindow) {
  const engine = new SideQueryEngine();
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
  const registry = {
    streamSimple: (selected: Model<any>, context: Context, options?: SimpleStreamOptions) => {
      const request = { model: selected, context: structuredClone(context), options: options ?? {} };
      requests.push(request);
      return responder(request, requests.length - 1);
    },
    getApiKey: () => { throw new Error("credential access forbidden"); },
    getApiKeyAndHeaders: () => { throw new Error("credential access forbidden"); },
    getProviderAuth: () => { throw new Error("credential access forbidden"); },
  };
  const ctx = {
    cwd: tmpdir(), model: { ...model, contextWindow }, thinkingLevel: "xhigh",
    modelRegistry: registry, sessionManager: { buildSessionProjection: () => ({ messages: parent }) },
  } as unknown as ExtensionContext;
  const hooks: ReplyHooks = {
    onUpdate: (messages, activity) => { updates.push({ messages: structuredClone(messages), activity }); },
    mainStatus: () => "Main is streaming; 2 queued actions", mainTools: () => mainTools,
    requestMainAction: async (request) => { actions.push(structuredClone(request)); return "Approved and queued. It has not completed yet."; },
  };
  return { engine, thread, ctx, hooks, parent, requests, updates, actions, mainTools,
    run: (question = "Side-only question") => engine.run(thread, question, ctx, hooks) };
}

test("native Agent answers explicit questions through the host registry without altering the parent", async () => {
  const f = fixture(() => completed(assistant("The side answer")));
  const parent = structuredClone(f.parent);
  assert.equal(f.requests.length, 0);
  await f.run("   ");
  assert.equal(f.requests.length, 0);
  await f.run();
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.model.id, "dummy");
  assert.equal(request.options.reasoning, "xhigh");
  assert.equal(request.options.maxTokens, 4_096);
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
  assert.deepEqual(f.thread.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(text(f.thread.messages[0]), "Side-only question");
  assert.equal(text(f.thread.messages[1]), "The side answer");
  assert.equal(f.thread.draft, "editor draft");
  assert.equal(f.updates.at(-1)?.activity, "");
});

test("tools off erases inherited system declarations and never executes tool requests", async () => {
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
  assert.equal(f.thread.messages.some((message) => message.role === "system"), false);
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
    assert.ok(f.updates.some((update) => update.activity === "Waiting for confirmation…"));
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

test("native read results are bounded before they enter the saved side transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "side-query-engine-"));
  try {
    await writeFile(join(directory, "large.txt"), "LARGE NATIVE FILE ".repeat(2_500));
    const f = fixture((_request, index) => completed(index === 0
      ? assistant("", [{ name: "read", args: { path: "large.txt" } }]) : assistant("Read excerpt summarized")), { toolsEnabled: true });
    f.ctx.cwd = directory;
    await f.run();
    const result = f.thread.messages.find((message) => message.role === "toolResult");
    assert.ok(text(result).length <= 24_000);
    assert.match(text(result), /Excerpt truncated/);
    assert.equal(f.requests.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unending native tool sequence is bounded to eight provider requests", async () => {
  const f = fixture(() => completed(assistant("", [{ name: "get_main_status", args: {} }])), { toolsEnabled: true });
  await assert.rejects(f.run(), /stopped after 8 model turns/);
  assert.equal(f.requests.length, 8);
  assert.equal(f.thread.messages.filter((message) => message.role === "assistant").length, 8);
  assert.equal(f.thread.messages.filter((message) => message.role === "toolResult").length, 8);
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

test("bounded context prunes whole old turns, preserves trusted receipts, and clips parent text", async () => {
  const receipt: AgentMessage = { role: "custom", customType: "side-query-main-action", content: "Completed: queued side action", display: true, timestamp: 5 };
  const f = fixture(() => completed(assistant("Bounded reply")), { messages: [
    { role: "user", content: "OLD ".repeat(2_000), timestamp: 1 }, assistant("Older side answer"),
    { role: "user", content: "Recent side question", timestamp: 3 }, assistant("Recent answer"), receipt,
    { role: "custom", customType: "untrusted-other", content: "OTHER ROLE MUST DROP", display: true, timestamp: 6 },
  ] }, 4_096);
  f.parent.push({ role: "user", content: "LARGE PARENT ".repeat(5_000), timestamp: 9 });
  await f.run("Current concise question");
  const context = f.requests[0].context;
  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /OLD OLD/);
  assert.doesNotMatch(serialized, /OTHER ROLE MUST DROP/);
  assert.match(serialized, /Completed: queued side action/);
  assert.match(serialized, /Recent side question/);
  assert.equal(f.requests[0].options.maxTokens, 1_024);
  assert.ok(serialized.length / 2 + f.requests[0].options.maxTokens! < 4_096);
  assert.ok(f.thread.messages.some((message) => message.role === "custom" && message.customType === "side-query-main-action"));
});

test("oversized questions stop before host requests and preserve the explicit user turn", async () => {
  const f = fixture(() => completed(assistant("Must not stream")), {}, 2_048);
  await assert.rejects(f.run("Very large question ".repeat(4_000)), /context budget/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.thread.messages[0].role, "user");
  assert.equal(f.thread.messages.at(-1)?.role, "assistant");
  assert.equal((f.thread.messages.at(-1) as AssistantMessage).stopReason, "error");
});

test("JSON expansion in quoted parent text cannot crowd out a small-model side question", async () => {
  const f = fixture(() => completed(assistant("Small-model reply")), {}, 2_048);
  f.parent.push({ role: "user", content: "\u0001\u0002\u0003\"\\".repeat(1_000), timestamp: 10 });
  await f.run("Explain briefly");
  assert.equal(f.requests.length, 1);
  const estimatedInput = f.requests[0].context.messages.reduce((sum, message) => sum + Math.ceil(JSON.stringify(message).length / 2) + 8, 0);
  assert.ok(estimatedInput + f.requests[0].options.maxTokens! < 2_048);
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
