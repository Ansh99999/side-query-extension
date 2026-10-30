import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  getAgentDir, SettingsManager, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MainActionBridge, ACTION_RECEIPT, ACTION_TOOL } from "./actions.ts";
import { SideQueryEngine, type MainActionRequest } from "./engine.ts";
import { SideThreadStore } from "./store.ts";
import { SideQueryScreen } from "./ui.ts";
import type { DisplayMessage, ScreenActions, SideScreen, SideScreenState, SideThread } from "./types.ts";

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => part && part.type === "text" ? part.text : part?.type === "image" ? "[Image]" : "").join("\n");
}

function displayMessages(messages: AgentMessage[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const text = textContent(message.content);
      if (text) result.push({ role: "assistant", text });
      if (message.errorMessage) result.push({ role: "notice", text: message.errorMessage });
    } else if (message.role === "user") result.push({ role: "user", text: textContent(message.content) });
    else if (message.role === "toolResult") {
      const text = textContent(message.content);
      result.push({ role: "tool", text: `${message.toolName}${message.isError ? " failed" : ""}: ${text.slice(0, 8_000)}` });
    } else if (message.role === "custom" && message.customType === ACTION_RECEIPT) {
      result.push({ role: "notice", text: textContent(message.content) });
    }
  }
  return result;
}

function mainTitle(ctx: ExtensionContext): string {
  const name = ctx.sessionManager.getSessionName();
  if (name) return name;
  const first = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
  if (first?.type === "message" && first.message.role === "user") {
    return textContent(first.message.content).replace(/\s+/g, " ").slice(0, 96) || "Main conversation";
  }
  return "Main conversation";
}

interface ToolObservation {
  id: string;
  name: string;
  started: number;
  output: string;
  state: "running" | "completed" | "failed";
}

/** Controller state exists only after /btw is first opened. */
export class SideQueryApp {
  private readonly engine = new SideQueryEngine();
  private readonly bridge: MainActionBridge;
  private ctx?: ExtensionContext;
  private parentId?: string;
  private store?: SideThreadStore;
  private thread?: SideThread;
  private screen?: SideScreen;
  private closeOverlay?: () => void;
  private opening = false;
  private visible = false;
  private closing = false;
  private closePromise: Promise<void> = Promise.resolve();
  private running?: Promise<void>;
  private navigation: Promise<void> = Promise.resolve();
  private revision = 0;
  private lastAssistant = "";
  private readonly observations: ToolObservation[] = [];
  private readonly subscriptions: Array<() => void> = [];
  private readonly pi: ExtensionAPI;
  private promptOptions?: ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>;
  private state: SideScreenState = {
    parentTitle: "Main conversation", threads: [], screen: "list", messages: [], draft: "", busy: false,
  };

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.bridge = new MainActionBridge(pi);
    const track = (name: string, handler: (event: any) => void): void => {
      this.subscriptions.push((pi.on as any)(name, handler));
    };
    track("tool_execution_start", (event) => {
      this.observations.push({ id: event.toolCallId, name: event.toolName, started: Date.now(), output: "", state: "running" });
      if (this.observations.length > 24) this.observations.shift();
    });
    track("tool_execution_update", (event) => {
      const item = this.observations.find((observation) => observation.id === event.toolCallId);
      if (item) item.output = textContent(event.partialResult?.content).slice(-3_000);
    });
    track("tool_execution_end", (event) => {
      const item = this.observations.find((observation) => observation.id === event.toolCallId);
      if (item) {
        item.output = textContent(event.result?.content).slice(-3_000);
        item.state = event.isError ? "failed" : "completed";
      }
    });
    track("message_update", (event) => {
      if (event.message.role === "assistant") this.lastAssistant = textContent(event.message.content).slice(-3_000);
    });
    track("session_start", () => this.invalidateSession());
    track("session_shutdown", async () => {
      this.invalidateSession();
      await this.closePromise;
      for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    });
  }

  isOpen(): boolean { return this.visible || this.opening; }

  async open(ctx: ExtensionContext, create: boolean, question = ""): Promise<void> {
    if (this.opening || this.closing) return;
    if (this.visible) {
      if (create) {
        await this.navigate(() => this.newThread());
        if (question) await this.submit(question);
      }
      return;
    }
    this.opening = true;
    const parentId = ctx.sessionManager.getSessionId();
    let openingRevision = this.revision;
    const stillCurrent = () => openingRevision === this.revision && ctx.sessionManager.getSessionId() === parentId;
    try {
      await this.closePromise;
      if (!stillCurrent()) return;
      if (parentId !== this.parentId) {
        this.bridge.cancelAll();
        openingRevision = ++this.revision;
        this.thread = undefined;
        this.lastAssistant = "";
        this.observations.length = 0;
        this.promptOptions = undefined;
        const store = await SideThreadStore.open(getAgentDir(), parentId, Boolean(ctx.sessionManager.getSessionFile()));
        if (!stillCurrent()) return;
        this.store = store;
        this.parentId = parentId;
      }
      const store = this.store!;
      const thread = create ? await store.create() : store.currentId ? await store.load(store.currentId) : undefined;
      if (!stillCurrent()) return;
      this.thread = thread;
      this.ctx = ctx;
      this.promptOptions = (ctx as Partial<ExtensionCommandContext>).getSystemPromptOptions?.() ?? this.promptOptions;
      if (ctx.cwd) this.state.toolRenderers = Object.fromEntries([
        createReadToolDefinition(ctx.cwd), createGrepToolDefinition(ctx.cwd),
        createFindToolDefinition(ctx.cwd), createLsToolDefinition(ctx.cwd),
      ].map((tool) => [tool.name, { renderCall: tool.renderCall, renderResult: tool.renderResult, renderShell: tool.renderShell }])) as unknown as NonNullable<SideScreenState["toolRenderers"]>;
      this.state.parentTitle = mainTitle(ctx);
      this.state.error = undefined;
      this.state.busy = false;
      this.state.activity = undefined;
      this.state.screen = this.thread ? "chat" : "list";
      this.syncState();
      this.visible = true;
      this.closing = false;
      const overlay = ctx.ui.custom<void>((tui, theme, keys, done) => {
        const screen = new SideQueryScreen(tui, () => ctx.ui.theme ?? theme, () => this.state, this.actions(), keys);
        if (!stillCurrent() || !this.visible) {
          screen.dispose();
          done();
          return screen;
        }
        this.closeOverlay = () => done();
        this.screen = screen;
        return screen;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
      // custom() resolves its component asynchronously before the first optional question.
      await Promise.resolve();
      this.opening = false;
      if (question && stillCurrent()) void this.submit(question);
      await overlay;
    } finally {
      this.opening = false;
      if (this.visible) this.close();
    }
  }

  private actions(): ScreenActions {
    return {
      submit: (text, behavior) => this.submit(text, behavior),
      newThread: () => this.navigate(() => this.newThread()),
      openThread: (id) => this.navigate(() => this.openThread(id)),
      deleteThread: (id) => this.navigate(() => this.deleteThread(id)),
      toggleTools: (id) => this.navigate(() => this.toggleTools(id)),
      saveDraft: (text) => { if (this.thread) { this.thread.draft = text; this.state.draft = text; } },
      showList: () => {
        this.state.screen = "list";
        this.refresh();
        void this.persistCurrent().catch((error) => this.error(error));
      },
      close: () => this.close(),
      cancel: () => { this.cancelReply(); },
    };
  }

  private syncState(): void {
    this.state.threads = this.store?.list() ?? [];
    this.state.currentId = this.thread?.id;
    this.state.messages = this.thread ? displayMessages(this.thread.messages) : [];
    this.state.nativeMessages = this.thread?.messages ?? [];
    if (this.ctx) {
      const settings = SettingsManager.inMemory(this.pi.getSettings?.() ?? {});
      this.state.ui = {
        outputPaddingX: settings.getOutputPad(),
        editorPaddingX: settings.getEditorPaddingX(),
        autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
        hideThinkingBlock: settings.getHideThinkingBlock(),
        showImages: settings.getShowImages(),
        imageWidthCells: settings.getImageWidthCells(),
        thinkingLevel: this.pi.getThinkingLevel?.() ?? "off",
        toolOutputExpanded: this.ctx.ui.getToolsExpanded?.() ?? false,
        cwd: this.ctx.cwd,
        codeBlockIndent: settings.getCodeBlockIndent(),
      };
    }
    this.state.draft = this.thread?.draft ?? "";
  }

  private refresh(): void { if (this.visible) this.screen?.refresh(); }

  private error(error: unknown): void {
    this.state.error = error instanceof Error ? error.message : String(error);
    this.refresh();
  }

  private navigate(operation: () => Promise<void>): Promise<void> {
    const result = this.navigation.then(async () => {
      if (!this.visible || this.closing) return;
      try { await operation(); }
      catch (error) { this.error(error); }
    });
    this.navigation = result.catch(() => {});
    return result;
  }

  private async stopReply(): Promise<void> {
    this.cancelReply();
    await this.running;
  }

  private cancelReply(): void {
    const queued = this.engine.abort();
    if (queued && this.thread) {
      const waiting = [...queued.steering, ...queued.followUp].filter(Boolean).join("\n\n");
      const text = waiting === this.thread.draft ? waiting : [waiting, this.thread.draft].filter(Boolean).join("\n\n");
      this.thread.draft = text;
      this.state.draft = text;
    }
  }

  private onSideEvent(event: AgentSessionEvent): void {
    if ((event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant") {
      this.state.streamingAssistantTimestamp = event.message.timestamp;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      this.state.streamingAssistantTimestamp = undefined;
    } else if (event.type === "tool_execution_start") {
      this.state.activeTools ??= [];
      this.state.activeTools.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, isPartial: true });
    } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const tool = this.state.activeTools?.find((item) => item.toolCallId === event.toolCallId);
      if (tool) {
        const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
        tool.result = { ...result, isError: event.type === "tool_execution_end" && event.isError };
        tool.isPartial = event.type !== "tool_execution_end";
      }
    }
    this.refresh();
  }

  private async persistCurrent(): Promise<void> {
    if (this.store && this.thread) await this.store.save(this.thread);
  }

  private async newThread(): Promise<void> {
    await this.stopReply();
    await this.persistCurrent();
    if (!this.visible || this.closing) return;
    this.thread = await this.store!.create();
    this.state.screen = "chat";
    this.state.error = undefined;
    this.syncState();
    this.refresh();
  }

  private async openThread(id: string): Promise<void> {
    await this.stopReply();
    await this.persistCurrent();
    const thread = await this.store!.load(id);
    if (!this.visible || this.closing) return;
    await this.store!.select(id);
    this.thread = thread;
    this.state.screen = "chat";
    this.state.error = undefined;
    this.syncState();
    this.refresh();
  }

  private async deleteThread(id: string): Promise<void> {
    const target = this.store!.list().find((thread) => thread.id === id);
    if (!target || !this.screen) return;
    if (this.thread?.id === id) await this.stopReply();
    const accepted = await this.screen.confirm({ title: "Delete side conversation?", confirmLabel: "Delete",
      message: target.title });
    if (!accepted || !this.visible || this.closing) return;
    await this.bridge.cancelThread(id);
    await this.store!.delete(id);
    if (this.thread?.id === id) this.thread = undefined;
    this.state.screen = "list";
    this.state.error = undefined;
    this.syncState();
    this.refresh();
  }

  private async toggleTools(id: string): Promise<void> {
    await this.stopReply();
    const thread = this.thread?.id === id ? this.thread : await this.store!.load(id);
    thread.toolsEnabled = !thread.toolsEnabled;
    if (!thread.toolsEnabled) await this.bridge.cancelThread(id);
    await this.store!.save(thread);
    this.syncState();
    this.refresh();
  }

  private mainStatus(): string {
    const ctx = this.ctx;
    if (!ctx || ctx.sessionManager.getSessionId() !== this.parentId) return "The original main session is unavailable.";
    const usage = ctx.getContextUsage();
    const records = this.observations.map((item) => `${item.name}: ${item.state}, observed ${Math.floor((Date.now() - item.started) / 1000)} seconds ago${item.output ? `\n${item.output}` : ""}`);
    return [
      `Main conversation: ${mainTitle(ctx)}. ${ctx.isIdle() ? "Idle" : "Working"}.`,
      ctx.hasPendingMessages() ? "Messages are waiting in the main queue." : "",
      usage?.percent !== undefined ? `Context usage: ${usage.percent?.toFixed(1)}%. This is context size, not task completion.` : "",
      records.length ? `Observed native tool activity:\n${records.join("\n")}` : "No live tool activity has been observed since side conversations opened.",
      this.lastAssistant ? `Latest streamed main text:\n${this.lastAssistant}` : "",
      this.bridge.status(),
      "Do not invent task completion percentages, agent counts, or outcomes. Use the parent transcript and observed data.",
    ].filter(Boolean).join("\n\n").slice(-14_000);
  }

  private async submit(text: string, behavior: "steer" | "followUp" = "steer"): Promise<void> {
    const question = text.trim();
    if (!question || !this.thread || !this.visible || this.closing) return;
    const command = /^\/btw(?:\s+([\s\S]*))?$/.exec(question);
    if (command) {
      if (this.thread) this.thread.draft = "";
      await this.navigate(() => this.newThread());
      if (command[1]?.trim()) await this.submit(command[1]);
      return;
    }
    if (this.state.busy) {
      try {
        await this.engine.queue(question, behavior);
        this.thread.draft = "";
        this.state.draft = "";
      } catch (error) {
        if (!this.thread.draft) this.thread.draft = question;
        this.state.draft = this.thread.draft;
        throw error;
      }
      this.refresh();
      return;
    }
    const ctx = this.ctx!, thread = this.thread, store = this.store!, revision = this.revision;
    if (ctx.sessionManager.getSessionId() !== this.parentId) return;
    thread.draft = "";
    thread.updatedAt = Date.now();
    this.state.busy = true;
    this.state.error = undefined;
    this.state.activity = "Thinking";
    this.state.activeTools = [];
    this.state.draft = "";
    this.refresh();
    const run = async (): Promise<void> => {
      try {
        await this.engine.run(thread, question, ctx, {
          onUpdate: (messages, activity) => {
            thread.messages = messages;
            store.mergeReceipts(thread);
            if (this.thread !== thread || revision !== this.revision) return;
            this.state.messages = displayMessages(messages);
            this.state.nativeMessages = messages;
            this.state.activity = activity;
            this.refresh();
          },
          onEvent: (event) => {
            if (this.thread !== thread || revision !== this.revision) return;
            this.onSideEvent(event);
          },
          settings: () => this.pi.getSettings?.() ?? {},
          promptOptions: () => this.promptOptions,
          onTools: (tools) => {
            if (this.thread === thread && revision === this.revision) this.state.toolRenderers = tools;
          },
          mainStatus: () => this.mainStatus(),
          mainTools: () => this.pi.getAllTools().filter((tool) => tool.name !== ACTION_TOOL),
          requestMainAction: (request, signal) => this.requestAction(request, thread, store, ctx, revision, signal),
        });
      } catch (error) {
        if (revision === this.revision) this.error(error);
      } finally {
        try { await store.save(thread); }
        catch (error) { if (revision === this.revision) this.error(error); }
        if (revision === this.revision && this.thread === thread) {
          this.state.busy = false;
          this.state.activity = undefined;
          this.state.streamingAssistantTimestamp = undefined;
          this.state.activeTools = [];
          this.syncState();
          this.refresh();
        }
      }
    };
    const running = run();
    this.running = running;
    try { await running; }
    finally { if (this.running === running) this.running = undefined; }
  }

  private async requestAction(request: MainActionRequest, thread: SideThread, store: SideThreadStore,
    ctx: ExtensionContext, revision: number, signal?: AbortSignal): Promise<string> {
    if (!thread.toolsEnabled || !this.visible || this.thread !== thread || !this.screen || revision !== this.revision) {
      return "Main action cancelled. Open this thread with tools enabled to request it.";
    }
    return this.bridge.request(request, { threadId: thread.id, threadTitle: thread.title, ctx, signal,
      confirm: (confirmation) => this.screen!.confirm(confirmation),
      receipt: async (text, approvalId) => {
        // The main may finish while a later side reply streams. Defer inserting a receipt
        // into that transcript until its call/result pairs have settled.
        if (this.thread?.id === thread.id && this.running) await this.running;
        const recorded = await store.recordReceipt(thread.id, {
          role: "custom", customType: ACTION_RECEIPT, content: text, display: true,
          details: { approvalId }, timestamp: Date.now(),
        });
        if (recorded && this.thread?.id === thread.id) {
          store.mergeReceipts(this.thread);
          this.thread.updatedAt = Math.max(this.thread.updatedAt, recorded.updatedAt);
          if (revision === this.revision) { this.syncState(); this.refresh(); }
        }
      },
    });
  }

  private close(): void {
    if (this.closing || !this.visible) return;
    this.closing = true;
    this.visible = false;
    this.cancelReply();
    this.screen?.dispose();
    this.screen = undefined;
    this.closeOverlay?.();
    this.closeOverlay = undefined;
    this.closePromise = (async () => {
      try {
        await this.running;
        await this.navigation;
        await this.persistCurrent();
        await this.store?.flush();
      } catch (error) {
        this.ctx?.ui.notify(`Could not save the side conversation: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally { this.closing = false; }
    })();
  }

  private invalidateSession(): void {
    this.revision++;
    this.bridge.cancelAll();
    this.close();
    this.parentId = undefined;
  }
}
