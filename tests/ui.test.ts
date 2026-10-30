import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Input, Markdown, matchesKey, parseKey, stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { relativeTime, SideQueryScreen } from "../src/ui.ts";
import type { ScreenActions, SideScreenState, ThreadSummary } from "../src/types.ts";

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
} as unknown as Theme;

function harness(overrides: Partial<SideScreenState> = {}, rows = 24) {
  const state: SideScreenState = {
    parentTitle: "Main project conversation", threads: [thread("one"), thread("two")],
    currentId: "one", screen: "list", messages: [], draft: "", busy: false,
    ...overrides,
  };
  const calls: string[] = [];
  const submitted: string[] = [];
  const drafts = new Map(state.threads.map((item) => [item.id, item.id === state.currentId ? state.draft : ""]));
  let renders = 0;
  const terminal = { rows, columns: 80 };
  const tui = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
  let screen: SideQueryScreen;
  const actions: ScreenActions = {
    submit: async (text) => { calls.push("submit"); submitted.push(text); },
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
  screen.focused = true;
  const render = (width = 80) => screen.render(width).map(stripTerminalSequences).join("\n");
  return { screen, state, calls, submitted, drafts, tui, terminal, actions, render, get renders() { return renders; } };
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
  const internal = h.screen as unknown as { editors: Map<string, { editor: Editor }>; messageCache: { markdown: Markdown }[] };
  assert.ok(internal.editors.get("one")?.editor instanceof Editor);
  assert.ok(internal.messageCache[0].markdown instanceof Markdown);
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
  assert.match(h.render(), /Tools off/);
  assert.match(h.render(), /Reading side context/);
  h.screen.handleInput("\x1bt");
  await tick();
  assert.match(h.render(), /Tools on/);
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

test("relative activity labels use compact human times", () => {
  assert.equal(relativeTime(now + 1000, now), "just now");
  assert.equal(relativeTime(now - 60_000, now), "1 min ago");
  assert.equal(relativeTime(now - 24 * 60_000, now), "24 mins ago");
  assert.equal(relativeTime(now - 3600_000, now), "1 hour ago");
  assert.equal(relativeTime(now - 86400_000, now), "1 day ago");
});
