import { AssistantMessageComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, CustomEditor, CustomMessageComponent, getMarkdownTheme, getSelectListTheme, parseSkillBlock, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent, } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, compositeTuiLine, Container, getKeybindings, Input, Loader, Markdown, Spacer, matchesKey, isKeyRelease, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, } from "@earendil-works/pi-tui";
class EditorWorkingStatus extends Loader {
    kind = "working";
    renderInBorder(width) {
        const line = super.render(width + 2)[1] ?? "";
        return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
    }
    renderSpinnerInBorder(width) {
        return truncateToWidth(this.getRenderedIndicator(), width, "");
    }
    dispose() {
        this.stop();
    }
}
function plain(text, multiline = false) {
    const cleaned = stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
    return multiline ? cleaned : cleaned.replace(/[\n\t]/g, " ");
}
function fit(text, width) {
    const clipped = truncateToWidth(text, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function safeStrings(value) {
    if (typeof value === "string")
        return plain(value, true);
    if (Array.isArray(value))
        return value.map(safeStrings);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeStrings(item)]));
    return value;
}
function safeAssistant(message) {
    return {
        ...message,
        content: message.content.map((content) => content.type === "text"
            ? { ...content, text: plain(content.text, true) }
            : content.type === "thinking" ? { ...content, thinking: plain(content.thinking, true) } : content),
        ...(message.errorMessage ? { errorMessage: plain(message.errorMessage, true) } : {}),
    };
}
export function relativeTime(updatedAt, now = Date.now()) {
    const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
    if (seconds < 60)
        return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes} ${minutes === 1 ? "min" : "mins"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30)
        return `${days} ${days === 1 ? "day" : "days"} ago`;
    const months = Math.floor(days / 30);
    if (months < 12)
        return `${months} ${months === 1 ? "month" : "months"} ago`;
    const years = Math.floor(days / 365);
    return `${years} ${years === 1 ? "year" : "years"} ago`;
}
export class SideQueryScreen {
    tui;
    themeSource;
    keybindings;
    state;
    actions;
    focus = false;
    search;
    editors = new Map();
    markdownTheme;
    messageCache = [];
    toolCache = new Map();
    bodyRows = [];
    bodyStart = 0;
    workingStatus;
    workingMessage;
    toolAvailabilityVisible = false;
    toolExpansionOverride;
    hideThinkingOverride;
    listFocus = "search";
    selectedId;
    activeEditorId;
    lastScreen;
    listStart = 0;
    listPageSize = 1;
    bodyHeight = 1;
    scrollFromBottom = 0;
    previousBodyLength = 0;
    previousBodyWidth = 0;
    pending;
    confirmationPageSize = 1;
    disposed = false;
    pasteInProgress = false;
    localError;
    searchRow = 0;
    listRow = 0;
    listItemHeight = 1;
    editorRow = 0;
    editorNativeRows = [];
    constructor(tui, theme, state, actions, keybindings = getKeybindings()) {
        this.tui = tui;
        this.themeSource = typeof theme === "function" ? theme : () => theme;
        this.keybindings = keybindings;
        this.state = state;
        this.actions = actions;
        this.search = new Input({
            prompt: "> ",
            placeholder: "Search titles",
            placeholderStyle: (text) => this.color("muted", text),
        });
        this.markdownTheme = getMarkdownTheme();
        this.refresh();
    }
    get focused() {
        return this.focus;
    }
    set focused(value) {
        this.focus = value;
        this.updateFocus();
    }
    color(token, text) {
        return this.theme.fg(token, text);
    }
    get theme() {
        return this.themeSource();
    }
    get outputPad() {
        return this.state().ui?.outputPaddingX ?? 1;
    }
    get toolsExpanded() {
        return this.toolExpansionOverride ?? this.state().ui?.toolOutputExpanded ?? false;
    }
    get hideThinking() {
        return this.hideThinkingOverride ?? this.state().ui?.hideThinkingBlock ?? false;
    }
    nativeMarkdownTheme() {
        const markdownTheme = this.state().ui?.markdownTheme ?? this.markdownTheme;
        const indent = this.state().ui?.codeBlockIndent;
        if (indent !== undefined)
            markdownTheme.codeBlockIndent = indent;
        return markdownTheme;
    }
    filteredThreads() {
        const query = this.search.getValue().toLocaleLowerCase().trim();
        return this.state().threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query));
    }
    normalizeSelection() {
        const threads = this.filteredThreads();
        if (!threads.some((thread) => thread.id === this.selectedId)) {
            this.selectedId = threads.find((thread) => thread.id === this.state().currentId)?.id ?? threads[0]?.id;
            this.listStart = 0;
        }
    }
    draftEditor(id, draft) {
        let entry = this.editors.get(id);
        if (!entry) {
            const editor = new CustomEditor(this.tui, {
                borderColor: (text) => this.color("borderMuted", text),
                selectList: getSelectListTheme(),
            }, this.keybindings, {
                paddingX: this.state().ui?.editorPaddingX,
                autocompleteMaxVisible: this.state().ui?.autocompleteMaxVisible,
                embedWorkingStatus: true,
            });
            entry = { editor, draft };
            this.editors.set(id, entry);
            editor.setText(draft);
            editor.onChange = () => {
                const current = this.editors.get(id);
                current.draft = editor.getExpandedText();
                if (!this.disposed && this.state().currentId === id)
                    this.actions.saveDraft(current.draft);
            };
            editor.onSubmit = (text) => {
                if (!text.trim() || this.disposed)
                    return;
                editor.addToHistory(text);
                this.scrollFromBottom = 0;
                this.run(() => this.actions.submit(text));
            };
            editor.onAction("app.message.followUp", () => this.submitFollowUp(editor));
            editor.onAction("app.tools.expand", () => {
                this.toolExpansionOverride = !this.toolsExpanded;
                for (const tool of this.toolCache.values())
                    tool.component.setExpanded(this.toolsExpanded);
                this.refresh();
            });
            editor.onAction("app.thinking.toggle", () => {
                this.hideThinkingOverride = !this.hideThinking;
                for (const message of this.messageCache) {
                    if (message.component instanceof AssistantMessageComponent)
                        message.component.setHideThinkingBlock(this.hideThinking);
                }
                this.refresh();
            });
        }
        else if (entry.draft !== draft) {
            entry.draft = draft;
            entry.editor.setText(draft);
        }
        const settings = this.state().ui;
        if (settings?.editorPaddingX !== undefined)
            entry.editor.setPaddingX(settings.editorPaddingX);
        if (settings?.autocompleteMaxVisible !== undefined)
            entry.editor.setAutocompleteMaxVisible(settings.autocompleteMaxVisible);
        entry.editor.borderColor = (text) => this.theme.getThinkingBorderColor(settings?.thinkingLevel ?? "off")(text);
        entry.editor.disableSubmit = false;
        return entry;
    }
    submitFollowUp(editor) {
        const text = editor.getExpandedText().trim();
        if (!text || this.disposed)
            return;
        if (!this.state().busy) {
            editor.onSubmit?.(text);
            editor.setText("");
            return;
        }
        editor.addToHistory(text);
        editor.setText("");
        this.scrollFromBottom = 0;
        this.run(() => this.actions.submit(text, "followUp"));
    }
    syncState() {
        if (this.disposed)
            return;
        const current = this.state();
        if (current.screen !== this.lastScreen) {
            if (current.screen === "list")
                this.listFocus = "search";
            this.toolAvailabilityVisible = false;
            this.lastScreen = current.screen;
        }
        if (current.screen === "chat" && current.currentId) {
            if (this.activeEditorId !== current.currentId) {
                this.scrollFromBottom = 0;
                this.previousBodyLength = 0;
                this.previousBodyWidth = 0;
                this.messageCache.length = 0;
                this.toolCache.clear();
                this.toolAvailabilityVisible = false;
            }
            this.activeEditorId = current.currentId;
            this.draftEditor(current.currentId, current.draft);
        }
        for (const id of this.editors.keys()) {
            if (!current.threads.some((thread) => thread.id === id) && id !== current.currentId)
                this.editors.delete(id);
        }
        this.normalizeSelection();
        this.syncWorkingStatus();
        this.updateFocus();
    }
    syncWorkingStatus() {
        const state = this.state();
        if (state.screen === "chat" && state.busy && state.currentId) {
            const message = plain(state.activity ?? "Working");
            if (!this.workingStatus) {
                const color = (text) => this.theme.getThinkingBorderColor(this.state().ui?.thinkingLevel ?? "off")(text);
                this.workingStatus = new EditorWorkingStatus(this.tui, color, color, message);
            }
            else if (this.workingMessage !== message)
                this.workingStatus.setMessage(message);
            this.workingMessage = message;
        }
        else {
            this.workingStatus?.dispose();
            this.workingStatus = undefined;
            this.workingMessage = undefined;
        }
        for (const [id, entry] of this.editors)
            entry.editor.setWorkingStatusIndicator(id === state.currentId ? this.workingStatus : undefined);
    }
    refresh() {
        this.syncState();
        if (!this.disposed)
            this.tui.requestRender();
    }
    updateFocus() {
        const current = this.state();
        this.search.focused = this.focus && !this.pending && current.screen === "list" && this.listFocus === "search";
        for (const [id, entry] of this.editors) {
            entry.editor.focused = this.focus && !this.pending && current.screen === "chat" && id === current.currentId;
        }
    }
    invalidate() {
        this.search.invalidate();
        for (const entry of this.editors.values())
            entry.editor.invalidate();
        for (const message of this.messageCache)
            message.component.invalidate();
        for (const tool of this.toolCache.values())
            tool.component.invalidate();
        this.workingStatus?.invalidate();
    }
    saveDraft() {
        const current = this.state();
        if (current.currentId) {
            const entry = this.editors.get(current.currentId);
            if (entry)
                this.actions.saveDraft(entry.editor.getExpandedText());
        }
    }
    run(action) {
        this.localError = undefined;
        try {
            void action().then(() => this.refresh(), (error) => {
                if (this.disposed)
                    return;
                this.localError = error instanceof Error ? error.message : String(error);
                this.refresh();
            });
        }
        catch (error) {
            this.localError = error instanceof Error ? error.message : String(error);
            this.refresh();
        }
    }
    close() {
        this.saveDraft();
        this.resolveConfirmation(false);
        this.actions.close();
    }
    handleInput(data) {
        if (this.disposed || isKeyRelease(data))
            return;
        this.syncState();
        if (this.pasteInProgress || data.includes("\x1b[200~")) {
            this.toolAvailabilityVisible = false;
            this.pasteInProgress = !data.includes("\x1b[201~");
            if (!this.pending) {
                if (this.state().screen === "chat" && this.state().currentId) {
                    this.editors.get(this.state().currentId)?.editor.handleInput(data);
                }
                else {
                    this.listFocus = "search";
                    this.search.handleInput(data);
                    this.normalizeSelection();
                }
            }
            this.updateFocus();
            this.tui.requestRender();
            return;
        }
        if (data === "\x1f" || matchesKey(data, "ctrl+/")) {
            this.close();
            return;
        }
        if (matchesKey(data, "ctrl+c")) {
            this.resolveConfirmation(false);
            this.actions.cancel();
            this.refresh();
            return;
        }
        if (this.pending) {
            this.handleConfirmation(data);
            return;
        }
        if (data === "\x1b\t" || matchesKey(data, "alt+tab")) {
            this.toolAvailabilityVisible = !this.toolAvailabilityVisible;
            this.tui.requestRender();
            return;
        }
        if (!matchesKey(data, "alt+t"))
            this.toolAvailabilityVisible = false;
        if (matchesKey(data, "escape")) {
            this.saveDraft();
            if (this.state().screen === "chat")
                this.actions.showList();
            else
                this.close();
            this.refresh();
            return;
        }
        if (matchesKey(data, "ctrl+n")) {
            this.saveDraft();
            this.run(() => this.actions.newThread());
            return;
        }
        const targetId = this.state().screen === "chat" ? this.state().currentId : this.selectedId;
        if (matchesKey(data, "ctrl+d")) {
            if (targetId) {
                this.saveDraft();
                this.run(() => this.actions.deleteThread(targetId));
            }
            return;
        }
        if (matchesKey(data, "alt+t")) {
            if (targetId)
                this.run(() => this.actions.toggleTools(targetId));
            return;
        }
        if (this.state().screen === "list")
            this.handleList(data);
        else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
            this.scrollReply(matchesKey(data, "pageUp") ? -this.bodyHeight : this.bodyHeight);
        }
        else if (matchesKey(data, "alt+enter") && this.state().currentId) {
            this.submitFollowUp(this.editors.get(this.state().currentId).editor);
        }
        else if (this.state().currentId) {
            this.editors.get(this.state().currentId)?.editor.handleInput(data);
        }
        this.updateFocus();
        this.tui.requestRender();
    }
    handleList(data) {
        const threads = this.filteredThreads();
        if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
            this.listFocus = this.listFocus === "search" ? "threads" : "search";
            return;
        }
        if (matchesKey(data, "enter") || data === "\n") {
            if (this.selectedId) {
                this.saveDraft();
                this.run(() => this.actions.openThread(this.selectedId));
            }
            return;
        }
        const down = matchesKey(data, "down");
        const up = matchesKey(data, "up");
        const pageDown = matchesKey(data, "pageDown");
        const pageUp = matchesKey(data, "pageUp");
        if (down || up || pageDown || pageUp || (this.listFocus === "threads" && (matchesKey(data, "home") || matchesKey(data, "end")))) {
            if (this.listFocus === "search" && down) {
                this.listFocus = "threads";
                return;
            }
            this.listFocus = "threads";
            const index = Math.max(0, threads.findIndex((thread) => thread.id === this.selectedId));
            let next = index + (down ? 1 : up ? -1 : pageDown ? this.listPageSize : -this.listPageSize);
            if (matchesKey(data, "home"))
                next = 0;
            if (matchesKey(data, "end"))
                next = threads.length - 1;
            this.selectedId = threads[Math.max(0, Math.min(threads.length - 1, next))]?.id;
            return;
        }
        this.listFocus = "search";
        const before = this.search.getValue();
        this.search.handleInput(data);
        if (before !== this.search.getValue()) {
            this.listStart = 0;
            this.selectedId = undefined;
            this.normalizeSelection();
        }
    }
    scrollReply(delta) {
        this.scrollFromBottom = Math.max(0, Math.min(Math.max(0, this.previousBodyLength - this.bodyHeight), this.scrollFromBottom - delta));
        this.tui.requestRender();
    }
    confirm(request) {
        if (this.disposed)
            return Promise.resolve(false);
        this.resolveConfirmation(false);
        return new Promise((resolve) => {
            this.pending = { request, accepted: false, scroll: 0, resolve };
            this.updateFocus();
            this.tui.requestRender();
        });
    }
    resolveConfirmation(accepted) {
        const pending = this.pending;
        if (!pending)
            return;
        this.pending = undefined;
        pending.resolve(accepted);
        this.updateFocus();
        this.tui.requestRender();
    }
    handleConfirmation(data) {
        const pending = this.pending;
        if (matchesKey(data, "escape"))
            this.resolveConfirmation(false);
        else if (matchesKey(data, "enter") || data === "\n")
            this.resolveConfirmation(pending.accepted);
        else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))
            pending.accepted = !pending.accepted;
        else if (matchesKey(data, "left"))
            pending.accepted = false;
        else if (matchesKey(data, "right"))
            pending.accepted = true;
        else if (matchesKey(data, "pageDown") || matchesKey(data, "down"))
            pending.scroll += this.confirmationPageSize;
        else if (matchesKey(data, "pageUp") || matchesKey(data, "up"))
            pending.scroll = Math.max(0, pending.scroll - this.confirmationPageSize);
        this.tui.requestRender();
    }
    dispose() {
        if (this.disposed)
            return;
        this.saveDraft();
        this.resolveConfirmation(false);
        this.disposed = true;
        this.workingStatus?.dispose();
        this.workingStatus = undefined;
        this.focus = false;
        this.updateFocus();
        this.editors.clear();
        this.messageCache.length = 0;
        this.toolCache.clear();
        this.bodyRows = [];
    }
    render(width) {
        const columns = Math.max(1, Math.floor(width));
        const rows = Math.max(1, Math.floor(this.tui.terminal.rows));
        if (this.disposed)
            return Array.from({ length: rows }, () => " ".repeat(columns));
        this.syncState();
        const lines = this.state().screen === "list" ? this.renderList(columns, rows) : this.renderChat(columns, rows);
        while (lines.length < rows)
            lines.push("");
        const output = lines.slice(0, rows).map((line) => fit(line, columns));
        if (this.pending)
            this.renderConfirmation(output, columns, rows);
        return output;
    }
    help(width) {
        return wrapTextWithAnsi(this.color("muted", "^N new · ^D delete · Alt+T tools · ^/ main"), width);
    }
    toolAvailability(width) {
        if (!this.toolAvailabilityVisible)
            return [];
        const id = this.state().screen === "chat" ? this.state().currentId : this.selectedId;
        const enabled = this.state().threads.find((thread) => thread.id === id)?.toolsEnabled ?? false;
        return [this.color(enabled ? "accent" : "dim", truncateToWidth(`Tool ${enabled ? "on" : "off"}`, width, ""))];
    }
    parentHeader(width) {
        return this.theme.bold(this.color("accent", truncateToWidth(plain(this.state().parentTitle) || "Main conversation", width)));
    }
    renderList(width, rows) {
        const header = [this.parentHeader(width)];
        const innerWidth = Math.max(1, width - 4);
        const border = this.color("borderMuted", "+" + "-".repeat(Math.max(0, width - 2)) + "+");
        header.push(border);
        this.searchRow = header.length;
        header.push(this.color("borderMuted", "| ") + fit(this.search.render(innerWidth)[0] ?? "", innerWidth) + this.color("borderMuted", " |"));
        header.push(border);
        const error = this.state().error ?? this.localError;
        const footer = [...(error ? [this.color("error", truncateToWidth(plain(error), width))] : []), ...this.toolAvailability(width), ...this.help(width)];
        const available = Math.max(0, rows - header.length - footer.length);
        this.listRow = header.length;
        this.listItemHeight = width < 40 ? 2 : 1;
        this.listPageSize = Math.max(1, Math.floor(available / this.listItemHeight));
        const threads = this.filteredThreads();
        const index = Math.max(0, threads.findIndex((thread) => thread.id === this.selectedId));
        if (index < this.listStart)
            this.listStart = index;
        if (index >= this.listStart + this.listPageSize)
            this.listStart = index - this.listPageSize + 1;
        this.listStart = Math.max(0, Math.min(this.listStart, Math.max(0, threads.length - this.listPageSize)));
        const content = [];
        if (!threads.length)
            content.push(this.color("muted", this.search.getValue() ? "No titles match your search." : "No side threads yet."));
        const now = Date.now();
        for (const thread of threads.slice(this.listStart, this.listStart + this.listPageSize)) {
            const selected = thread.id === this.selectedId;
            const prefix = selected ? "> " : "  ";
            const time = relativeTime(thread.updatedAt, now);
            const titleWidth = this.listItemHeight === 1 ? Math.max(1, width - visibleWidth(time) - 4) : Math.max(1, width - 2);
            let title = prefix + truncateToWidth(plain(thread.title) || "New side thread", titleWidth);
            if (selected)
                title = this.color("accent", title);
            if (this.listItemHeight === 1)
                content.push(fit(title, width - visibleWidth(time) - 2) + "  " + this.color("dim", time));
            else
                content.push(title, this.color("dim", `  ${time}`));
        }
        while (content.length < available)
            content.push("");
        return [...header, ...content.slice(0, available), ...footer];
    }
    renderMessages(width) {
        const state = this.state();
        const messages = state.nativeMessages;
        const result = [];
        this.bodyRows = [];
        let viewIndex = 0;
        let componentCount = 0;
        const append = (component) => {
            const lines = component.render(width);
            this.bodyRows.push({ component, y: result.length, height: lines.length });
            result.push(...lines);
            componentCount++;
        };
        const markdownTheme = this.nativeMarkdownTheme();
        const baseSettings = JSON.stringify([this.outputPad, markdownTheme.codeBlockIndent]);
        const user = (text, key) => {
            if (!text)
                return;
            if (componentCount)
                result.push("");
            const settings = `${baseSettings}:${this.toolsExpanded}`;
            append(this.messageView(viewIndex++, "user", key, text, settings, () => {
                const skill = parseSkillBlock(text);
                if (!skill)
                    return new UserMessageComponent(text, markdownTheme, this.outputPad);
                const container = new Container();
                const invocation = new SkillInvocationMessageComponent(skill, markdownTheme, this.outputPad);
                invocation.setExpanded(this.toolsExpanded);
                container.addChild(invocation);
                if (skill.userMessage) {
                    const textMessage = new UserMessageComponent(skill.userMessage, markdownTheme, this.outputPad);
                    container.addChild(new Spacer(1));
                    container.addChild(textMessage);
                }
                return container;
            }));
        };
        const assistant = (message, key, streaming) => {
            const source = JSON.stringify([
                message.content.map((content) => content.type === "text" ? ["text", content.text]
                    : content.type === "thinking" ? ["thinking", content.thinking] : ["toolCall"]),
                message.stopReason, message.errorMessage, streaming,
            ]);
            const settings = JSON.stringify([baseSettings, this.hideThinking, state.ui?.hiddenThinkingLabel ?? "Thinking..."]);
            append(this.messageView(viewIndex++, "assistant", key, source, settings, () => {
                const component = new AssistantMessageComponent(undefined, this.hideThinking, markdownTheme, state.ui?.hiddenThinkingLabel ?? "Thinking...", this.outputPad);
                component.updateContent(safeAssistant(message), streaming);
                return component;
            }, (component) => {
                component.updateContent(safeAssistant(message), streaming);
            }));
        };
        if (messages === undefined) {
            for (const [index, message] of state.messages.entries()) {
                const text = plain(message.text, true);
                if (message.role === "user")
                    user(text, String(index));
                else if (message.role === "assistant")
                    assistant({
                        role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
                        provider: "side-query-display", model: "side-query-display", timestamp: index,
                        stopReason: state.busy && index === state.messages.length - 1 ? "pending" : "stop",
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                    }, String(index), state.busy && index === state.messages.length - 1);
                else {
                    result.push("");
                    append(this.messageView(viewIndex++, message.role, String(index), text, baseSettings, () => new Markdown(text, this.outputPad, 0, markdownTheme, { color: (value) => this.color("dim", value) })));
                }
            }
            this.toolCache.clear();
        }
        else {
            const toolResults = new Map(messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
            const activeTools = new Map(state.activeTools?.map((tool) => [tool.toolCallId, tool]) ?? []);
            const renderedTools = new Set();
            for (const [index, message] of messages.entries()) {
                const key = `${message.role}:${"timestamp" in message ? message.timestamp : index}:${index}`;
                if (message.role === "user") {
                    const text = typeof message.content === "string" ? message.content
                        : message.content.filter((content) => content.type === "text").map((content) => content.text).join("");
                    user(plain(text, true), key);
                }
                else if (message.role === "assistant") {
                    const streaming = state.streamingAssistantTimestamp === message.timestamp;
                    assistant(message, key, streaming);
                    for (const call of message.content) {
                        if (call.type !== "toolCall")
                            continue;
                        const active = activeTools.get(call.id);
                        const final = toolResults.get(call.id);
                        let toolResult = final ? {
                            content: final.content, details: final.details, isError: final.isError,
                            durationMs: final.durationMs,
                        } : active?.result;
                        if (!toolResult && (message.stopReason === "aborted" || message.stopReason === "error")) {
                            toolResult = { content: [{ type: "text", text: message.stopReason === "aborted"
                                            ? message.errorMessage ?? "Operation aborted" : message.errorMessage ?? "Error" }], isError: true };
                        }
                        append(this.toolView(call, active, toolResult, !final && (active?.isPartial ?? streaming), streaming).component);
                        renderedTools.add(call.id);
                    }
                }
                else if (message.role === "custom" && message.display) {
                    result.push("");
                    append(this.messageView(viewIndex++, message.role, key, JSON.stringify(message), `${baseSettings}:${this.toolsExpanded}`, () => {
                        const component = new CustomMessageComponent({ ...message, content: typeof message.content === "string"
                                ? plain(message.content, true) : message.content.map((content) => content.type === "text" ? { ...content, text: plain(content.text, true) } : content) }, undefined, markdownTheme, this.outputPad);
                        component.setExpanded(this.toolsExpanded);
                        return component;
                    }));
                }
                else if (message.role === "compactionSummary" || message.role === "branchSummary") {
                    result.push("");
                    append(this.messageView(viewIndex++, message.role, key, JSON.stringify(message), `${baseSettings}:${this.toolsExpanded}`, () => {
                        const component = message.role === "compactionSummary"
                            ? new CompactionSummaryMessageComponent(message, markdownTheme, this.outputPad)
                            : new BranchSummaryMessageComponent(message, markdownTheme, this.outputPad);
                        component.setExpanded(this.toolsExpanded);
                        return component;
                    }));
                }
            }
            for (const id of this.toolCache.keys())
                if (!renderedTools.has(id))
                    this.toolCache.delete(id);
        }
        this.messageCache.length = viewIndex;
        return result;
    }
    messageView(index, role, key, source, settings, create, update) {
        let cached = this.messageCache[index];
        if (!cached || cached.role !== role || cached.key !== key || cached.settings !== settings) {
            cached = { role, key, source, settings, component: create() };
            this.messageCache[index] = cached;
        }
        else if (cached.source !== source) {
            if (update)
                update(cached.component);
            else
                cached.component = create();
            cached.source = source;
        }
        return cached.component;
    }
    toolView(call, active, result, partial, streaming) {
        const ui = this.state().ui;
        const args = JSON.stringify(active?.args ?? call.arguments) ?? "";
        const settings = JSON.stringify([this.toolsExpanded, ui?.showImages ?? true, ui?.imageWidthCells ?? 60, this.outputPad, ui?.cwd]);
        const definition = this.state().toolRenderers?.[call.name];
        let cached = this.toolCache.get(call.id);
        if (!cached || cached.name !== call.name || cached.definition !== definition) {
            cached = {
                name: call.name, args, settings, definition, started: false, argsComplete: false,
                component: new ToolExecutionComponent(call.name, call.id, safeStrings(active?.args ?? call.arguments), {
                    showImages: ui?.showImages, imageWidthCells: ui?.imageWidthCells, outputPad: this.outputPad,
                }, definition, this.tui, ui?.cwd ?? "."),
            };
            cached.component.setExpanded(this.toolsExpanded);
            this.toolCache.set(call.id, cached);
        }
        else {
            if (cached.args !== args) {
                cached.component.updateArgs(safeStrings(active?.args ?? call.arguments));
                cached.args = args;
            }
            if (cached.settings !== settings) {
                cached.component.setExpanded(this.toolsExpanded);
                cached.component.setShowImages(ui?.showImages ?? true);
                cached.component.setImageWidthCells(ui?.imageWidthCells ?? 60);
                cached.component.setOutputPad(this.outputPad);
                cached.settings = settings;
            }
        }
        if (active && !cached.started) {
            cached.component.markExecutionStarted();
            cached.started = true;
        }
        if (!streaming && !cached.argsComplete && active) {
            cached.component.setArgsComplete();
            cached.argsComplete = true;
        }
        const resultKey = result ? JSON.stringify([result, partial]) : undefined;
        if (result && cached.result !== resultKey) {
            cached.component.updateResult({
                ...result,
                content: result.content.map((content) => content.type === "text" ? { ...content, text: plain(content.text ?? "", true) } : content),
                details: safeStrings(result.details),
            }, partial);
            cached.result = resultKey;
        }
        return cached;
    }
    renderChat(width, rows) {
        const current = this.state();
        const footer = this.help(width);
        const error = current.error ?? this.localError;
        const statusLines = [...(error ? [this.color("error", truncateToWidth(plain(error), width))] : []), ...this.toolAvailability(width)];
        const editor = current.currentId ? this.draftEditor(current.currentId, current.draft).editor : undefined;
        const nativeEditor = editor?.render(width) ?? [];
        const editorBudget = Math.max(0, rows - footer.length - statusLines.length - 1);
        const editorLines = this.cropEditor(nativeEditor, editorBudget);
        this.bodyHeight = Math.max(0, rows - editorLines.length - footer.length - statusLines.length);
        const body = this.renderMessages(width);
        if (this.scrollFromBottom > 0 && this.previousBodyWidth === width && body.length > this.previousBodyLength) {
            this.scrollFromBottom += body.length - this.previousBodyLength;
        }
        this.previousBodyLength = body.length;
        this.previousBodyWidth = width;
        this.scrollFromBottom = Math.min(this.scrollFromBottom, Math.max(0, body.length - this.bodyHeight));
        const start = Math.max(0, body.length - this.bodyHeight - this.scrollFromBottom);
        this.bodyStart = start;
        const visible = body.slice(start, start + this.bodyHeight);
        while (visible.length < this.bodyHeight)
            visible.push("");
        this.editorRow = visible.length + statusLines.length;
        return [...visible, ...statusLines, ...editorLines, ...footer];
    }
    cropEditor(native, budget) {
        this.editorNativeRows = [];
        if (!budget || !native.length)
            return [];
        if (native.length <= budget) {
            this.editorNativeRows = native.map((_, index) => index);
            return native;
        }
        const cursor = Math.max(1, native.findIndex((line) => line.includes(CURSOR_MARKER)));
        if (budget < 3) {
            this.editorNativeRows = [cursor];
            if (budget === 2)
                this.editorNativeRows.push(native.length - 1);
        }
        else {
            const contentBudget = budget - 2;
            const start = Math.max(1, Math.min(cursor - contentBudget + 1, native.length - 1 - contentBudget));
            this.editorNativeRows = [0, ...Array.from({ length: contentBudget }, (_, index) => start + index), native.length - 1];
        }
        return this.editorNativeRows.map((index) => native[index]);
    }
    renderConfirmation(output, width, rows) {
        const pending = this.pending;
        const boxWidth = Math.max(4, Math.min(72, width - (width >= 20 ? 4 : 0)));
        const innerWidth = Math.max(1, boxWidth - 4);
        const message = wrapTextWithAnsi(plain(pending.request.message, true), innerWidth);
        const label = plain(pending.request.confirmLabel ?? "Confirm");
        const cancel = pending.accepted ? "  Cancel  " : "[ Cancel ]";
        const confirm = pending.accepted ? `[ ${label} ]` : `  ${label}  `;
        const buttons = wrapTextWithAnsi(this.color(pending.accepted ? "muted" : "accent", cancel) + "  " + this.color(pending.accepted ? "accent" : "muted", confirm), innerWidth);
        const maxHeight = Math.max(1, rows - (rows >= 10 ? 4 : 0));
        this.confirmationPageSize = Math.max(1, maxHeight - buttons.length - 5);
        pending.scroll = Math.max(0, Math.min(pending.scroll, Math.max(0, message.length - this.confirmationPageSize)));
        const body = message.slice(pending.scroll, pending.scroll + this.confirmationPageSize);
        const border = this.color("border", "+" + "-".repeat(boxWidth - 2) + "+");
        const inset = (line) => this.color("border", "| ") + fit(line, innerWidth) + this.color("border", " |");
        const help = message.length > this.confirmationPageSize ? "Tab choose · PgUp/PgDn" : "Tab choose · Enter · Esc";
        const box = [border, inset(this.theme.bold(truncateToWidth(plain(pending.request.title), innerWidth))), ...body.map(inset), inset(""), ...buttons.map(inset), inset(this.color("muted", truncateToWidth(help, innerWidth, ""))), border].slice(0, rows);
        const top = Math.max(0, Math.floor((rows - box.length) / 2));
        const left = Math.max(0, Math.floor((width - boxWidth) / 2));
        for (let row = 0; row < output.length; row++)
            output[row] = output[row].replaceAll(CURSOR_MARKER, "");
        for (let index = 0; index < box.length; index++) {
            const base = output[top + index] ?? "";
            output[top + index] = fit(compositeTuiLine(base, box[index], left, Math.min(boxWidth, width - left), width), width);
        }
    }
    handleMouse(event) {
        if (this.disposed || this.pending)
            return { handled: true };
        if (event.type === "wheel") {
            const delta = event.wheelDelta ?? 0;
            if (this.state().screen === "chat")
                this.scrollReply(delta);
            else {
                this.listFocus = "threads";
                const threads = this.filteredThreads();
                const index = Math.max(0, threads.findIndex((thread) => thread.id === this.selectedId));
                this.selectedId = threads[Math.max(0, Math.min(threads.length - 1, index + delta))]?.id;
            }
            this.updateFocus();
            this.tui.requestRender();
            return { handled: true, render: true };
        }
        if (this.state().screen === "list") {
            if (event.y === this.searchRow) {
                this.listFocus = "search";
                this.search.handleMouse({ ...event, x: event.x - 2, y: 0, width: Math.max(1, event.width - 4), height: 1 });
            }
            else if ((event.type === "press" || event.type === "click") && event.button === "left") {
                const index = this.listStart + Math.floor((event.y - this.listRow) / this.listItemHeight);
                const thread = this.filteredThreads()[index];
                if (event.y < this.listRow || index >= this.listStart + this.listPageSize || !thread)
                    return undefined;
                this.selectedId = thread.id;
                this.listFocus = "threads";
                if (event.type === "click" && (event.clickCount ?? 1) >= 2)
                    this.run(() => this.actions.openThread(thread.id));
            }
            else
                return undefined;
            this.updateFocus();
            return { handled: true, focus: true, render: true };
        }
        if (event.y >= 0 && event.y < this.bodyHeight) {
            const bodyY = event.y + this.bodyStart;
            const row = this.bodyRows.find((item) => bodyY >= item.y && bodyY < item.y + item.height);
            const handled = row?.component.handleMouse?.({ ...event, y: bodyY - row.y, height: row.height });
            if (handled?.handled) {
                this.tui.requestRender();
                return { ...handled, render: true };
            }
            return undefined;
        }
        const localRow = event.y - this.editorRow;
        const nativeRow = this.editorNativeRows[localRow];
        if (nativeRow === undefined || !this.state().currentId)
            return undefined;
        return this.editors.get(this.state().currentId)?.editor.handleMouse({ ...event, y: nativeRow });
    }
}
