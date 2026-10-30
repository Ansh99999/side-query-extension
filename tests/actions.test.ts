import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { MainActionBridge, ACTION_TOOL } from "../src/actions.ts";

function fixture() {
  let parentId = "parent", active = ["Agent", "read"];
  const tools = new Map<string, ToolDefinition>();
  const sent: Array<{ content: string; options: unknown }> = [];
  const messages: unknown[] = [];
  const receipts: string[] = [];
  const invocations: Array<{ name: string; args: any }> = [];
  const mainTools: ToolInfo[] = [{ name: "Agent", description: "Launch native subagents", exposure: "direct",
    parameters: Type.Object({ agents: Type.Array(Type.String()), count: Type.Integer({ minimum: 1, maximum: 3 }) }),
    sourceInfo: { path: "test", source: "extension" } as any }];
  const pi = {
    getAllTools: () => [...mainTools, ...[...tools.values()].map((tool) => ({ ...tool, exposure: tool.exposure ?? "direct", sourceInfo: {} }))],
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
    sendUserMessage: (content: string, options: unknown) => { sent.push({ content, options }); },
    sendMessage: (message: unknown) => { messages.push(message); },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getSessionId: () => parentId },
    executeTool: async (name: string, args: unknown) => {
      invocations.push({ name, args });
      return { toolCall: { type: "toolCall", id: "native", name, arguments: args }, isError: false,
        result: { content: [{ type: "text", text: "Launched 2 subagents" }], details: { ids: ["one", "two"] } } };
    },
  } as unknown as ExtensionToolContext;
  const bridge = new MainActionBridge(pi);
  const origin = (confirm: () => Promise<boolean>, signal?: AbortSignal) => ({
    threadId: "thread", threadTitle: "Status side thread", ctx: ctx as ExtensionContext, confirm,
    receipt: async (text: string) => { receipts.push(text); }, signal,
  });
  return { pi, bridge, ctx, origin, tools, sent, messages, receipts, invocations, mainTools,
    parent: (id: string) => { parentId = id; }, active: () => active,
    approvalId: () => /approvalId "([\da-f-]+)"/.exec(sent.at(-1)!.content)![1] };
}

test("a declined action neither registers a bridge, starts a main turn, nor executes a tool", async () => {
  const f = fixture();
  const result = await f.bridge.request({ toolName: "Agent", args: { agents: ["a", "b"], count: 2 }, summary: "Launch 2 subagents" }, f.origin(async () => false));
  assert.match(result, /declined/);
  assert.equal(f.tools.size, 0);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.invocations, []);
  assert.deepEqual(f.active(), ["Agent", "read"]);
});

test("approval queues one immutable native main call, retains existing tools, and records real outcome once", async () => {
  const f = fixture();
  const args = { agents: ["a", "b"], count: 2 };
  let displayed = "";
  const result = await f.bridge.request({ toolName: "Agent", args, summary: "Launch 2 subagents" }, {
    ...f.origin(async () => true), confirm: async (request) => { displayed = request.message; return true; },
  });
  args.agents[0] = "different";
  assert.match(displayed, /"a"/);
  assert.match(displayed, /Main tool: Agent/);
  assert.match(result, /not completed yet/);
  assert.deepEqual(f.invocations, []);
  assert.deepEqual(f.active(), ["Agent", "read", ACTION_TOOL]);
  assert.deepEqual(f.sent[0].options, { deliverAs: "steer" });
  const approvalId = f.approvalId();
  const tool = f.tools.get(ACTION_TOOL)!;
  assert.deepEqual(tool.reachesTools!({ approvalId }), ["Agent"]);
  const outcome = await tool.execute("bridge", { approvalId }, undefined, undefined, f.ctx);
  assert.deepEqual(f.invocations, [{ name: "Agent", args: { agents: ["a", "b"], count: 2 } }]);
  assert.match(outcome.content[0].type === "text" ? outcome.content[0].text : "", /Completed: Launch 2 subagents.*Status side thread/);
  assert.equal(f.receipts.length, 1);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.active(), ["Agent", "read"]);
  await tool.execute("duplicate", { approvalId }, undefined, undefined, f.ctx);
  assert.equal(f.invocations.length, 1);
});

test("parallel calls cannot reuse one approval", async () => {
  const f = fixture();
  await f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "Launch one agent" }, f.origin(async () => true));
  const tool = f.tools.get(ACTION_TOOL)!, approvalId = f.approvalId();
  await Promise.all([tool.execute("one", { approvalId }, undefined, undefined, f.ctx), tool.execute("two", { approvalId }, undefined, undefined, f.ctx)]);
  assert.equal(f.invocations.length, 1);
});

test("original parent, cancellation, availability, and schema validation are enforced before main execution", async () => {
  const f = fixture();
  await assert.rejects(f.bridge.request({ toolName: "unknown", args: {}, summary: "bad" }, f.origin(async () => true)), /unavailable/);
  await assert.rejects(f.bridge.request({ toolName: "Agent", args: { agents: [], count: 100 }, summary: "bad" }, f.origin(async () => true)));
  assert.equal(f.sent.length, 0);
  const cancelled = new AbortController(); cancelled.abort();
  assert.match(await f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "one" }, f.origin(async () => true, cancelled.signal)), /cancelled/);
  const switched = await f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "one" }, f.origin(async () => { f.parent("different"); return true; }));
  assert.match(switched, /session changed/);
  assert.equal(f.sent.length, 0);
  f.parent("parent");
  await f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "one" }, f.origin(async () => true));
  const approvalId = f.approvalId();
  f.parent("different");
  const outcome = await f.tools.get(ACTION_TOOL)!.execute("wrong-parent", { approvalId }, undefined, undefined, f.ctx);
  assert.match(outcome.content[0].type === "text" ? outcome.content[0].text : "", /No action ran/);
  assert.equal(f.invocations.length, 0);
});

test("disabled tools and model-only main UI tools cannot be re-enabled by side approval", async () => {
  const f = fixture();
  f.pi.setActiveTools(["read"]);
  await assert.rejects(f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "one" }, f.origin(async () => true)), /disabled/);
  f.mainTools[0].exposure = "model-only";
  f.pi.setActiveTools(["Agent", "read"]);
  await assert.rejects(f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "one" }, f.origin(async () => true)), /direct UI/);
  assert.equal(f.sent.length, 0);
});

test("turning side tools off or deleting the thread cancels queued approval", async () => {
  const f = fixture();
  await f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "one" }, f.origin(async () => true));
  const approvalId = f.approvalId();
  await f.bridge.cancelThread("thread");
  await f.tools.get(ACTION_TOOL)!.execute("cancelled", { approvalId }, undefined, undefined, f.ctx);
  assert.equal(f.invocations.length, 0);
  assert.match(f.receipts[0], /Cancelled.*No action ran/);
  assert.deepEqual(f.active(), ["Agent", "read"]);
});

test("host loadout failure discards the approval and restores only the bridge addition", async () => {
  const f = fixture();
  const setActive = f.pi.setActiveTools;
  f.pi.setActiveTools = (names) => {
    setActive(names);
    if (names.includes(ACTION_TOOL)) throw new Error("Host policy rejected this addition");
  };
  await assert.rejects(f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "one" }, f.origin(async () => true)), /Host policy/);
  assert.equal(f.bridge.status(), "");
  assert.equal(f.sent.length, 0);
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(f.active(), ["Agent", "read"]);
});

test("main queue failure discards the approval while retaining a changed main loadout", async () => {
  const f = fixture();
  f.pi.sendUserMessage = () => {
    f.pi.setActiveTools(["read", "extra", ACTION_TOOL]);
    throw new Error("Main queue unavailable");
  };
  await assert.rejects(f.bridge.request({ toolName: "Agent", args: { agents: ["a"], count: 1 }, summary: "one" }, f.origin(async () => true)), /Main queue/);
  assert.equal(f.bridge.status(), "");
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(f.active(), ["read", "extra"]);
});
