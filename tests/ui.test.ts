import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  createReadToolDefinition,
  CustomEditor,
  getMarkdownTheme,
  getSelectListTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, getKeybindings, Input, matchesKey, parseKey, ScrollView, stripTerminalSequences, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { relativeTime, SideQueryScreen } from "../src/ui.ts";
import type { ScreenActions, SideScreenState, ThreadSummary } from "../src/types.ts";

// InteractiveMode initializes this before constructing the main conversation.
initTheme("dark", false);

const now = Date.now();
const thread = (id: string, title = `Thread ${id}`): ThreadSummary => ({
  id, title, titleGenerated: true, createdAt: now - 25 * 60_000,
  updatedAt: now - 24 * 60_000, toolsEnabled: false,
});
const gray = (text: string) => `\x1b[90m${text}\x1b[39m`;
const theme = {
  fg: (_token: string, text: string) => gray(text),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
  getThinkingBorderColor: (_level: string) => gray,
} as unknown as Theme;

const screens = new Set<SideQueryScreen>();
afterEach(() => {
  for (const screen of screens) screen.dispose();
  screens.clear();
});

const assistantMessage = (text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "offline",
  model: "dummy", timestamp: now, stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  ...overrides,
});

function nativeBody(screen: SideQueryScreen, width = 80): string[] {
  return (screen as unknown as { renderMessages(width: number): string[] }).renderMessages(width);
}

function harness(overrides: Partial<SideScreenState> = {}, rows = 24) {
  const state: SideScreenState = {
    parentTitle: "Main project conversation", threads: [thread("one"), thread("two")],
    currentId: "one", screen: "list", messages: [], draft: "", busy: false,
    ...overrides,
  };
  const calls: string[] = [];
  const submitted: string[] = [];
  const submitModes: ("steer" | "followUp" | undefined)[] = [];
  const drafts = new Map(state.threads.map((item) => [item.id, item.id === state.currentId ? state.draft : ""]));
  let renders = 0;
  const terminal = { rows, columns: 80 };
  const tui = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
  let screen: SideQueryScreen;
  const actions: ScreenActions = {
    submit: async (text, mode) => { calls.push("submit"); submitted.push(text); submitModes.push(mode); },
    newThread: async () => {
      calls.push("new");
      const id = `new-${state.threads.length}`;
      state.threads.push(thread(id));
      state.currentId = id;
      state.draft = "";
      state.messages = [];
      state.screen = "chat";
    },
    openThread: async (id) => {
      calls.push(`open:${id}`);
      state.currentId = id;
      state.draft = drafts.get(id) ?? "";
      state.screen = "chat";
    },
    deleteThread: async (id) => { calls.push(`delete:${id}`); },
    toggleTools: async (id) => {
      calls.push(`tools:${id}`);
      const selected = state.threads.find((item) => item.id === id)!;
      selected.toolsEnabled = !selected.toolsEnabled;
    },
    saveDraft: (text) => {
      calls.push(`save:${text}`);
      state.draft = text;
      if (state.currentId) drafts.set(state.currentId, text);
    },
    showList: () => { calls.push("list"); state.screen = "list"; },
    close: () => { calls.push("close"); },
    cancel: () => { calls.push("cancel"); state.busy = false; },
  };
  screen = new SideQueryScreen(tui, theme, () => state, actions);
  screens.add(screen);
  screen.focused = true;
  const render = (width = 80) => screen.render(width).map(stripTerminalSequences).join("\n");
  return { screen, state, calls, submitted, submitModes, drafts, tui, terminal, actions, render, get renders() { return renders; } };
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("native components render an ASCII search box and gray relative timestamps", () => {
  const h = harness();
  const output = h.screen.render(80);
  const text = output.map(stripTerminalSequences).join("\n");
  assert.ok(text.startsWith("Main project conversation"));
  assert.match(text, /\+-+\+/);
  assert.match(text, /\| > Search titles/);
  assert.match(text, /Thread one/);
  assert.ok(output.some((line) => line.includes(gray("24 mins ago"))));
  const internal = h.screen as unknown as { search: Input };
  assert.ok(internal.search instanceof Input);
  assert.ok(output.some((line) => line.includes(CURSOR_MARKER)));
  const renders = h.renders;
  h.screen.render(80);
  assert.equal(h.renders, renders, "render must not schedule itself again");
});

test("list and chat fill current terminal height and remain Unicode/resize safe", () => {
  const h = harness({
    parentTitle: "日本語 café e\u0301 🧑‍💻 main title",
    threads: [thread("one", "日本語 🧑‍💻 e\u0301 long thread title"), thread("two", "emoji 🌈")],
    messages: [{ role: "assistant", text: "# 日本語 🧑‍💻\n\n**café** e\u0301\n\n| A | B |\n|---|---|\n|日本語|abcdefghijklmnopqrstuvwxyz|\n\n```ts\nconst example = 'long long long long long long';\n```\n" }],
  });
  for (const view of ["list", "chat"] as const) {
    h.state.screen = view;
    for (const rows of [8, 14, 24, 50]) {
      h.terminal.rows = rows;
      for (const width of [20, 40, 80]) {
        const lines = h.screen.render(width);
        assert.equal(lines.length, rows);
        for (const line of lines) assert.equal(visibleWidth(line), width, `width ${width}, rows ${rows}, ${view}`);
        if (view === "chat") assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)), "keep editor cursor visible");
      }
    }
  }
  const internal = h.screen as unknown as { editors: Map<string, { editor: CustomEditor }>; messageCache: { component: Component }[] };
  assert.ok(internal.editors.get("one")?.editor instanceof CustomEditor);
  assert.ok(internal.messageCache[0].component instanceof AssistantMessageComponent);
});

test("title search, list focus, arrows, paging, and typing after selection work", async () => {
  const h = harness({ threads: Array.from({ length: 25 }, (_, index) => thread(String(index), `${index % 2 ? "Alpha" : "Beta"} ${index}`)), currentId: "0" }, 14);
  h.screen.render(40);
  h.screen.handleInput("Alpha");
  let output = h.render(40);
  assert.match(output, /Alpha 1/);
  assert.doesNotMatch(output, /Beta 0/);
  h.screen.handleInput("\x1b[B"); // Enter list focus with its first result selected.
  h.screen.handleInput("\x1b[B");
  h.screen.handleInput("\r");
  await tick();
  assert.ok(h.calls.includes("open:3"));
  h.screen.handleInput("\x1b");
  h.screen.handleInput("\x1b[6~");
  h.screen.handleInput("\x1b[6~");
  h.screen.handleInput("\r");
  await tick();
  const opens = h.calls.filter((call) => call.startsWith("open:"));
  assert.notEqual(opens.at(-1), "open:3");
  h.screen.handleInput("\x1b");
  h.screen.handleInput(" 23");
  output = h.render(40);
  assert.match(output, /Alpha 23/);
  assert.doesNotMatch(output, /Alpha 21/);
  h.screen.handleInput("\r");
  await tick();
  assert.ok(h.calls.includes("open:23"));
});

test("Escape once goes from chat to searchable list; Escape again closes", () => {
  const h = harness({ screen: "chat", draft: "unfinished question" });
  h.screen.handleInput("\x1b");
  assert.equal(h.state.screen, "list");
  assert.ok(h.calls.includes("save:unfinished question"));
  assert.equal(h.calls.filter((call) => call === "close").length, 0);
  assert.ok(h.screen.render(40).some((line) => line.includes(CURSOR_MARKER)));
  h.screen.handleInput("\x1b");
  assert.equal(h.calls.filter((call) => call === "close").length, 1);
});

test("native editor preserves multiline /btw submissions and saves drafts", async () => {
  const h = harness({ screen: "chat" });
  h.screen.handleInput("/btw Explain the other approach");
  h.screen.handleInput("\n");
  h.screen.handleInput("日本語 🧑‍💻");
  assert.equal(h.state.draft, "/btw Explain the other approach\n日本語 🧑‍💻");
  h.screen.handleInput("\r");
  await tick();
  assert.deepEqual(h.submitted, ["/btw Explain the other approach\n日本語 🧑‍💻"]);
  assert.equal(h.state.draft, "");
  h.screen.handleInput("\x1b[A");
  assert.equal(h.state.draft, h.submitted[0], "native prompt history remains available");
});

test("stream refresh preserves the same editor cursor and undo history", () => {
  const h = harness({ screen: "chat" });
  h.screen.handleInput("abc");
  h.screen.handleInput("\x1b[D");
  h.state.busy = true;
  h.state.messages = [{ role: "assistant", text: "Streaming a **reply**" }];
  h.screen.refresh();
  h.screen.render(20);
  h.screen.handleInput("X");
  assert.equal(h.state.draft, "abXc");
  h.screen.handleInput("\x1f");
  assert.ok(h.calls.includes("save:abXc"));
});

test("per-thread drafts survive list navigation and Ctrl+N opens a fresh thread", async () => {
  const h = harness({ screen: "chat", draft: "one draft" });
  h.drafts.set("two", "two draft");
  h.screen.handleInput("\x1b");
  h.screen.handleInput("\x1b[B");
  h.screen.handleInput("\x1b[B");
  h.screen.handleInput("\r");
  await tick();
  assert.equal(h.state.currentId, "two");
  assert.equal(h.state.draft, "two draft");
  h.screen.handleInput(" plus");
  h.screen.handleInput("\x1b");
  h.screen.handleInput("\x1b[A");
  h.screen.handleInput("\r");
  await tick();
  assert.equal(h.state.currentId, "one");
  assert.equal(h.state.draft, "one draft");
  assert.equal(h.drafts.get("two"), "two draft plus");
  h.screen.handleInput("\x0e");
  await tick();
  assert.equal(h.state.screen, "chat");
  assert.match(h.state.currentId!, /^new-/);
  assert.equal(h.state.draft, "");
  assert.ok(h.calls.includes("save:one draft"));
});

test("tools start off, Alt+T toggles current or selected thread, and Ctrl+C cancels locally", async () => {
  const h = harness({ screen: "chat", busy: true, activity: "Reading side context" });
  assert.doesNotMatch(h.render(), /Tools? (?:on|off)/);
  assert.match(h.render(), /Reading side context/);
  h.screen.handleInput("\x1b[9;3u"); // Kitty Alt+Tab reveals availability without toggling.
  assert.match(h.render(), /Tool off/);
  assert.ok(!h.calls.some((call) => call.startsWith("tools:")));
  h.screen.handleInput("\x1bt");
  await tick();
  assert.match(h.render(), /Tool on/);
  h.screen.handleInput("x");
  assert.doesNotMatch(h.render(), /Tools? (?:on|off)/);
  h.screen.handleInput("\x03");
  assert.ok(h.calls.includes("cancel"));
  assert.ok(!h.calls.includes("close"));
  h.screen.handleInput("\x1b");
  h.screen.handleInput("\x1b[B");
  h.screen.handleInput("\x1b[B");
  h.screen.handleInput("\x1bt");
  await tick();
  assert.ok(h.calls.includes("tools:two"));
});

test("chat has the four requested footer hints and an empty native editor without titles", () => {
  const h = harness({ screen: "chat", nativeMessages: [], ui: { editorPaddingX: 1, autocompleteMaxVisible: 7 } });
  const lines = h.screen.render(80);
  const output = lines.map(stripTerminalSequences).join("\n");
  assert.equal(stripTerminalSequences(lines.at(-1)!).trim(), "^N new · ^D delete · Alt+T tools · ^/ main");
  assert.doesNotMatch(output, /Main project conversation|Thread one|Ask a side question|Enter send|Shift\+Enter|Ctrl\+|Tools? (?:on|off)/);
  const editor = new CustomEditor(h.tui, { borderColor: gray, selectList: getSelectListTheme() },
    getKeybindings() as KeybindingsManager, { paddingX: 1, autocompleteMaxVisible: 7, embedWorkingStatus: true });
  editor.focused = true;
  assert.deepEqual(lines.slice(-4, -1).map(stripTerminalSequences), editor.render(80).map(stripTerminalSequences));
  assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
  h.state.screen = "list";
  assert.equal(h.render().trimEnd().split("\n").at(-1), "^N new · ^D delete · Alt+T tools · ^/ main");
});

test("Alt+Tab availability supports legacy, Kitty, and modifyOtherKeys terminal encodings", () => {
  for (const key of ["\x1b\t", "\x1b[9;3u", "\x1b[27;3;9~"]) {
    const h = harness({ screen: "chat", nativeMessages: [] });
    h.screen.handleInput(key);
    assert.match(h.render(), /Tool off/);
    assert.deepEqual(h.calls, [], "checking availability must not execute an action");
    h.screen.handleInput(key);
    assert.doesNotMatch(h.render(), /Tool off/);
  }
});

test("user, thinking, Markdown, code, and message spacing match Pi's native main components", () => {
  const userText = "1. Keep source numbering\n\n**Question** about `code`";
  const reply = assistantMessage("", { content: [
    { type: "thinking", thinking: "Considering **two options**." },
    { type: "text", text: "# Reply\n\n```ts\nconst answer = 42;\n```\n\n[reference](https://example.invalid)" },
  ] });
  const h = harness({ screen: "chat", nativeMessages: [
    { role: "user", content: userText, timestamp: now - 1 }, reply,
    { role: "user", content: "Next question", timestamp: now + 1 },
  ], messages: [{ role: "assistant", text: "Old flattened display must not be used" }],
  ui: { outputPaddingX: 1, codeBlockIndent: "    " } }, 50);
  const markdownTheme = getMarkdownTheme();
  markdownTheme.codeBlockIndent = "    ";
  for (const width of [20, 40, 80]) {
    const expected = [
      ...new UserMessageComponent(userText, markdownTheme, 1).render(width),
      ...new AssistantMessageComponent(reply, false, markdownTheme, "Thinking...", 1).render(width),
      "", ...new UserMessageComponent("Next question", markdownTheme, 1).render(width),
    ];
    assert.deepEqual(nativeBody(h.screen, width), expected, `native message parity at width ${width}`);
  }
  assert.doesNotMatch(h.render(), /Old flattened display|^You$|^Reply$/m);
  h.state.ui!.hideThinkingBlock = true;
  assert.match(nativeBody(h.screen).map(stripTerminalSequences).join("\n"), /Thinking\.\.\./);
  assert.doesNotMatch(nativeBody(h.screen).map(stripTerminalSequences).join("\n"), /Considering two options/);
});

test("native streaming updates retain the same assistant component and its editor", () => {
  const reply = assistantMessage("first", { stopReason: "pending" });
  const h = harness({ screen: "chat", busy: true, nativeMessages: [reply], streamingAssistantTimestamp: reply.timestamp });
  h.screen.handleInput("abc");
  h.screen.handleInput("\x1b[D");
  h.screen.render(40);
  const internal = h.screen as unknown as { messageCache: { component: Component }[]; editors: Map<string, { editor: CustomEditor }> };
  const component = internal.messageCache[0].component;
  const editor = internal.editors.get("one")!.editor;
  h.state.nativeMessages = [assistantMessage("first **then second**", { stopReason: "pending" })];
  h.screen.refresh();
  h.screen.render(40);
  assert.equal(internal.messageCache[0].component, component);
  assert.equal(internal.editors.get("one")!.editor, editor);
  h.screen.handleInput("X");
  assert.equal(h.state.draft, "abXc");
  const expected = new AssistantMessageComponent();
  expected.updateContent(h.state.nativeMessages[0] as AssistantMessage, true);
  assert.deepEqual(nativeBody(h.screen, 40), expected.render(40));
  h.state.nativeMessages = [assistantMessage("completed answer")];
  h.state.streamingAssistantTimestamp = undefined;
  h.state.busy = false;
  h.screen.refresh();
  h.screen.render(40);
  assert.equal(internal.messageCache[0].component, component, "the native streaming component also survives completion");
});

test("Enter steers and Alt+Enter queues a native follow-up while the side session is busy", async () => {
  const h = harness({ screen: "chat", busy: true });
  h.screen.handleInput("steering question");
  h.screen.handleInput("\r");
  await tick();
  h.screen.handleInput("next question");
  h.screen.handleInput("\x1b[13;3u");
  await tick();
  assert.deepEqual(h.submitted, ["steering question", "next question"]);
  assert.deepEqual(h.submitModes, [undefined, "followUp"]);
  assert.equal(h.state.draft, "");
  assert.equal(h.state.busy, true);
});

test("tool arguments, results, partial updates, and native read formatting match main tool components", () => {
  const cwd = "/tmp/offline-side-ui";
  const definition = createReadToolDefinition(cwd);
  const call = { type: "toolCall" as const, id: "read-1", name: "read", arguments: { path: "example.ts", offset: 2, limit: 3 } };
  const reply = assistantMessage("", { content: [call], stopReason: "toolUse" });
  const final = { role: "toolResult" as const, toolCallId: call.id, toolName: call.name,
    content: [{ type: "text" as const, text: "const a = 1;\nconst b = 2;\nconst c = 3;" }], isError: false,
    timestamp: now + 1, durationMs: 18 };
  const h = harness({ screen: "chat", nativeMessages: [reply, final],
    toolRenderers: { read: definition } as unknown as NonNullable<SideScreenState["toolRenderers"]>,
    ui: { cwd, showImages: false, outputPaddingX: 1 } });
  const expected = new ToolExecutionComponent(call.name, call.id, call.arguments, { showImages: false, outputPad: 1 }, definition, h.tui, cwd);
  expected.setExpanded(false);
  expected.updateResult(final);
  for (const width of [20, 40, 80]) assert.deepEqual(nativeBody(h.screen, width), expected.render(width));
  const internal = h.screen as unknown as { toolCache: Map<string, { component: ToolExecutionComponent }> };
  const original = internal.toolCache.get(call.id)!.component;
  h.state.busy = true;
  h.state.nativeMessages = [reply];
  const partial = { content: [{ type: "text", text: "first partial line" }], isError: false };
  h.state.activeTools = [{ toolCallId: call.id, toolName: call.name, args: call.arguments, result: partial, isPartial: true }];
  h.screen.refresh();
  expected.markExecutionStarted();
  expected.setArgsComplete();
  expected.updateResult(partial, true);
  assert.deepEqual(nativeBody(h.screen), expected.render(80));
  assert.equal(internal.toolCache.get(call.id)!.component, original);
  h.state.activeTools[0] = { ...h.state.activeTools[0], result: final, isPartial: false };
  h.state.nativeMessages = [reply, final];
  h.state.busy = false;
  h.screen.refresh();
  expected.updateResult(final, false);
  assert.deepEqual(nativeBody(h.screen), expected.render(80));
});

test("native user backgrounds and code/thinking colors follow live Pi theme changes", () => {
  initTheme("dark", false);
  const reply = assistantMessage("", { content: [
    { type: "thinking", thinking: "Considering the answer" },
    { type: "text", text: "```ts\nconst value = true;\n```" },
  ] });
  const h = harness({ screen: "chat", nativeMessages: [
    { role: "user", content: "Theme question", timestamp: now - 1 }, reply,
  ] });
  const dark = nativeBody(h.screen);
  try {
    initTheme("light", false);
    h.screen.invalidate();
    const light = nativeBody(h.screen);
    assert.notDeepEqual(light, dark);
    assert.deepEqual(light, [
      ...new UserMessageComponent("Theme question").render(80),
      ...new AssistantMessageComponent(reply).render(80),
    ]);
    assert.equal(light.map(stripTerminalSequences).join("\n"), dark.map(stripTerminalSequences).join("\n"));
  } finally {
    initTheme("dark", false);
  }
});

test("the theme getter updates the list and native editor thinking border without reopening", () => {
  const h = harness({ screen: "chat", ui: { thinkingLevel: "high" }, draft: "draft" });
  const blue = (text: string) => `\x1b[34m${text}\x1b[39m`;
  let currentTheme = theme;
  const live = new SideQueryScreen(h.tui, () => currentTheme, () => h.state, h.actions);
  screens.add(live);
  live.focused = true;
  const original = live.render(80);
  currentTheme = { ...theme, fg: (_token: string, text: string) => blue(text),
    getThinkingBorderColor: (level: string) => { assert.equal(level, "high"); return blue; } } as unknown as Theme;
  live.invalidate();
  const changed = live.render(80);
  assert.notDeepEqual(changed, original);
  assert.ok(changed.some((line) => line.includes(blue("─".repeat(80)))));
  h.state.screen = "list";
  assert.ok(live.render(80)[0].includes(blue("Main project conversation")));
});

test("the native working spinner and message use the editor's thinking border color", () => {
  const h = harness({ screen: "chat", busy: true, ui: { thinkingLevel: "high" } });
  const blue = (text: string) => `\x1b[34m${text}\x1b[39m`;
  const currentTheme = { ...theme, getThinkingBorderColor: (_level: string) => blue } as unknown as Theme;
  const live = new SideQueryScreen(h.tui, currentTheme, () => h.state, h.actions);
  screens.add(live);
  live.focused = true;
  const lines = live.render(80);
  const border = lines.find((line) => stripTerminalSequences(line).includes("Working"))!;
  assert.ok(border.includes(blue("Working")));
  assert.ok(border.includes(blue("⠋")));
  assert.match(stripTerminalSequences(border), /^── /);
  assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /Ctrl\+C|cancel/);
});

test("native thinking clicks are forwarded with transcript coordinates and preserve the draft", () => {
  const reply = assistantMessage("answer", { content: [{ type: "thinking", thinking: "Detailed reasoning" }, { type: "text", text: "answer" }] });
  const h = harness({ screen: "chat", draft: "saved draft", nativeMessages: [reply], ui: { hideThinkingBlock: true } });
  const lines = h.screen.render(80);
  const row = lines.findIndex((line) => stripTerminalSequences(line).includes("Thinking..."));
  const click = { type: "click", button: "left", x: 5, y: row, screenX: 5, screenY: row, width: 80, height: 24,
    shift: false, ctrl: false, alt: false } as TuiMouseEvent;
  assert.equal(h.screen.handleMouse(click)?.handled, true);
  assert.match(h.render(), /Detailed reasoning/);
  assert.equal(h.state.draft, "saved draft");
});

test("exact Ctrl+/ and legacy unit separator close; Kitty Ctrl+- keeps native undo", () => {
  assert.equal(matchesKey("\x1f", "ctrl+/"), false);
  assert.equal(matchesKey("\x1f", "ctrl+-"), true);
  assert.equal(parseKey("\x1f"), "ctrl+-");
  for (const data of ["\x1f", "\x1b[47;5u", "\x1b[27;5;47~"]) {
    const h = harness({ screen: "chat", draft: "keep me" });
    h.screen.handleInput(data);
    assert.deepEqual(h.calls.slice(-2), ["save:keep me", "close"]);
  }
  const h = harness({ screen: "chat" });
  h.screen.handleInput("nd/-ctrl+d");
  h.screen.handleInput("\x1b[110;6u"); // Ctrl+Shift+N is not Ctrl+N.
  h.screen.handleInput("\x1b[100;5:3u"); // Key release must not delete.
  assert.equal(h.state.draft, "nd/-ctrl+d");
  assert.ok(!h.calls.some((call) => /^(delete:|new|close)/.test(call)));
  h.screen.handleInput("append");
  h.screen.handleInput("\x1b[45;5u");
  assert.equal(h.state.draft, "", "native undo groups consecutive typing");
  assert.ok(!h.calls.includes("close"));
});

test("delete delegates to controller confirmation, defaults Cancel, and accepts explicit choice", async () => {
  const h = harness({ screen: "chat", draft: "unsubmitted" });
  const deleted: string[] = [];
  h.actions.deleteThread = async (id) => {
    if (await h.screen.confirm({ title: "Delete side thread?", message: `Delete Thread ${id} and its saved messages?`, confirmLabel: "Delete" })) deleted.push(id);
  };
  h.screen.handleInput("\x04");
  assert.match(h.render(40), /Delete side thread\?/);
  assert.match(h.render(40), /\[ Cancel \]/);
  assert.ok(!h.screen.render(40).some((line) => line.includes(CURSOR_MARKER)));
  h.screen.handleInput("\r");
  await tick();
  assert.deepEqual(deleted, []);
  h.screen.handleInput("\x04");
  h.screen.handleInput("\t");
  assert.match(h.render(40), /\[ Delete \]/);
  h.screen.handleInput("\r");
  await tick();
  assert.deepEqual(deleted, ["one"]);
  assert.ok(h.calls.includes("save:unsubmitted"));
});

test("confirmation wraps the exact action and permits paging long action text", async () => {
  const h = harness({}, 24);
  const action = Array.from({ length: 50 }, (_, index) => `action_${index} 日本語`).join("\n");
  const pending = h.screen.confirm({ title: "Queue main action?", message: action, confirmLabel: "Queue" });
  for (const width of [20, 40, 80]) {
    const lines = h.screen.render(width);
    assert.equal(lines.length, 24);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
  }
  assert.match(h.render(40), /action_0/);
  for (let count = 0; count < 15; count++) h.screen.handleInput("\x1b[6~");
  assert.match(h.render(40), /action_49/);
  h.screen.handleInput("\x1b");
  assert.equal(await pending, false);
  assert.equal(h.state.screen, "list");
});

test("disposing, replacing, and closing a confirmation dismiss it safely", async () => {
  const h = harness({ screen: "chat", draft: "draft" });
  const first = h.screen.confirm({ title: "First", message: "First action" });
  const second = h.screen.confirm({ title: "Second", message: "Second action" });
  assert.equal(await first, false);
  h.screen.handleInput("\x1f");
  assert.equal(await second, false);
  assert.ok(h.calls.includes("close"));
  const last = h.screen.confirm({ title: "Last", message: "Last action" });
  h.screen.dispose();
  assert.equal(await last, false);
  assert.equal(await h.screen.confirm({ title: "Disposed", message: "Ignored" }), false);
  h.screen.handleInput("\x04");
  assert.ok(!h.calls.includes("delete:one"));
  assert.ok(h.screen.render(20).every((line) => stripTerminalSequences(line).trim() === ""));
});

test("Ctrl+C cancels the side reply and dismisses pending action approval", async () => {
  const h = harness({ screen: "chat", busy: true, draft: "local draft" });
  const pending = h.screen.confirm({ title: "Allow?", message: "Queue a main action", confirmLabel: "Allow" });
  h.screen.handleInput("\x03");
  assert.equal(await pending, false);
  assert.ok(h.calls.includes("cancel"));
  assert.ok(!h.calls.includes("close"));
  assert.equal(h.state.draft, "local draft");
});

test("bracketed paste controls cannot trigger thread actions or approve a dialog", async () => {
  const h = harness({ screen: "chat" });
  h.screen.handleInput("\x1b[200~");
  h.screen.handleInput("\x04");
  h.screen.handleInput("\x0e");
  h.screen.handleInput("\x1f");
  h.screen.handleInput("pasted question\x1b[201~");
  assert.ok(!h.calls.some((call) => /^(delete:|new|close)/.test(call)));
  const pending = h.screen.confirm({ title: "Allow?", message: "Main action", confirmLabel: "Allow" });
  h.screen.handleInput("\t");
  h.screen.handleInput("\x1b[200~");
  h.screen.handleInput("\r");
  h.screen.handleInput("\x1b[201~");
  assert.match(h.render(40), /Allow\?/);
  h.screen.handleInput("\x1b");
  assert.equal(await pending, false);
});

test("reply pages and native mouse wheel scroll independently of the editor", () => {
  const h = harness({ screen: "chat", draft: "draft", messages: [{ role: "assistant", text: Array.from({ length: 70 }, (_, index) => `line ${index}`).join("\n") }] }, 14);
  assert.match(h.render(40), /line 69/);
  h.screen.handleInput("\x1b[5~");
  assert.doesNotMatch(h.render(40), /line 69/);
  h.screen.handleInput("\x1b[6~");
  assert.match(h.render(40), /line 69/);
  const wheel = { type: "wheel", button: "none", x: 5, y: 4, screenX: 5, screenY: 4, width: 40, height: 14, shift: false, ctrl: false, alt: false, wheelDelta: -5 } as TuiMouseEvent;
  assert.equal(h.screen.handleMouse(wheel)?.handled, true);
  assert.doesNotMatch(h.render(40), /line 69/);
  assert.equal(h.state.draft, "draft");
  h.state.messages[0].text += "\nline 70\nline 71";
  assert.doesNotMatch(h.render(40), /line 71/, "streaming should retain the scrolled viewport");
});

test("a full native transcript reserves the main editor spacer and uses the same scroll viewport", () => {
  const reply = assistantMessage(Array.from({ length: 70 }, (_, index) => `line ${index}`).join("\n"));
  const clean = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
  for (const rows of [8, 14, 24]) {
    const h = harness({ screen: "chat", draft: "draft", nativeMessages: [reply] }, rows);
    const nativeEditor = (h.screen as unknown as { editors: Map<string, { editor: CustomEditor }> }).editors.get("one")!.editor;
    const editorLines = nativeEditor.render(80);
    // Main's dock contains the editor, the requested one-line footer, and its
    // native Spacer(1) above the editor; the remaining rows belong to ScrollView.
    const viewportHeight = rows - editorLines.length - 1 - 1;
    const nativeViewport = new ScrollView(new AssistantMessageComponent(reply), { follow: "end" });
    nativeViewport.updateLayout(nativeViewport.render(80).length, viewportHeight, () => {});
    const expectedBody = () => nativeViewport.render(80).slice(nativeViewport.scrollTop, nativeViewport.scrollTop + viewportHeight);
    let lines = h.screen.render(80);
    assert.deepEqual(clean(lines.slice(0, viewportHeight)), clean(expectedBody()));
    assert.equal(stripTerminalSequences(lines[viewportHeight]).trim(), "", "the last transcript row cannot consume the editor spacer");
    assert.deepEqual(clean(lines.slice(viewportHeight + 1, -1)), clean(editorLines));
    assert.match(stripTerminalSequences(lines[viewportHeight - 1]), /line 69/);
    assert.ok(lines.every((line) => visibleWidth(line) === 80));

    h.screen.handleInput("\x1b[5~");
    nativeViewport.scrollBy(-viewportHeight);
    lines = h.screen.render(80);
    assert.deepEqual(clean(lines.slice(0, viewportHeight)), clean(expectedBody()), "page size matches the native transcript viewport");
    assert.equal(stripTerminalSequences(lines[viewportHeight]).trim(), "");
    h.screen.handleInput("\x1b[6~");
    nativeViewport.scrollToEnd();
    assert.deepEqual(clean(h.screen.render(80).slice(0, viewportHeight)), clean(expectedBody()));

    let mouseRow: number | undefined;
    nativeEditor.handleMouse = (event) => { mouseRow = event.y; return { handled: true }; };
    const cursor = h.screen.render(80).findIndex((line) => line.includes(CURSOR_MARKER));
    const click = { type: "click", button: "left", x: 3, y: cursor, screenX: 3, screenY: cursor,
      width: 80, height: rows, shift: false, ctrl: false, alt: false } as TuiMouseEvent;
    assert.equal(h.screen.handleMouse(click)?.handled, true);
    assert.equal(mouseRow, 1, "screen coordinates account for the fixed spacer before the native editor");
    assert.equal(h.screen.handleMouse({ ...click, y: viewportHeight }), undefined, "the spacer is outside both transcript and editor");
  }
});

test("tiny chat terminals keep the native cursor and omit the spacer when no editor can render", () => {
  const reply = assistantMessage("last transcript line");
  const h = harness({ screen: "chat", draft: "draft", nativeMessages: [reply] }, 5);
  for (const rows of [3, 4, 5]) {
    h.terminal.rows = rows;
    const lines = h.screen.render(80);
    const internal = h.screen as unknown as { editorRow: number; bodyHeight: number };
    assert.equal(lines.length, rows);
    assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)), `keep the cursor at height ${rows}`);
    assert.equal(stripTerminalSequences(lines[internal.editorRow - 1]).trim(), "");
    assert.equal(internal.bodyHeight, 0);
    assert.ok(lines.every((line) => visibleWidth(line) === 80));
  }
  h.terminal.rows = 2;
  let lines = h.screen.render(80);
  assert.equal(lines.length, 2);
  assert.ok(!lines.some((line) => line.includes(CURSOR_MARKER)));
  assert.match(stripTerminalSequences(lines[0]), /last transcript line/);
  h.terminal.rows = 1;
  lines = h.screen.render(80);
  assert.equal(lines.length, 1);
  assert.equal(stripTerminalSequences(lines[0]).trim(), "^N new · ^D delete · Alt+T tools · ^/ main");
});

test("relative activity labels use compact human times", () => {
  assert.equal(relativeTime(now + 1000, now), "just now");
  assert.equal(relativeTime(now - 60_000, now), "1 min ago");
  assert.equal(relativeTime(now - 24 * 60_000, now), "24 mins ago");
  assert.equal(relativeTime(now - 3600_000, now), "1 hour ago");
  assert.equal(relativeTime(now - 86400_000, now), "1 day ago");
});
