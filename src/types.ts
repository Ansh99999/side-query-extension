import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Component, Focusable, MarkdownTheme } from "@earendil-works/pi-tui";
import type { FileEntry, ToolRenderers } from "@earendil-works/pi-coding-agent";

export interface ThreadSummary {
  id: string;
  title: string;
  titleGenerated: boolean;
  createdAt: number;
  updatedAt: number;
  toolsEnabled: boolean;
}

export interface SideThread extends ThreadSummary {
  draft: string;
  messages: AgentMessage[];
  /** Native session history retains compaction and context edits across restarts. */
  sessionEntries?: FileEntry[];
}

export interface DisplayMessage {
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
}

export interface SideScreenState {
  parentTitle: string;
  threads: ThreadSummary[];
  currentId?: string;
  screen: "chat" | "list";
  messages: DisplayMessage[];
  /** Pi's complete messages, including thinking blocks and tool-call arguments. */
  nativeMessages?: AgentMessage[];
  streamingAssistantTimestamp?: number;
  activeTools?: SideToolExecution[];
  toolRenderers?: Record<string, ToolRenderers>;
  ui?: {
    outputPaddingX?: number;
    editorPaddingX?: number;
    autocompleteMaxVisible?: number;
    hideThinkingBlock?: boolean;
    hiddenThinkingLabel?: string;
    toolOutputExpanded?: boolean;
    showImages?: boolean;
    imageWidthCells?: number;
    thinkingLevel?: ThinkingLevel;
    cwd?: string;
    markdownTheme?: MarkdownTheme;
    codeBlockIndent?: string;
  };
  draft: string;
  busy: boolean;
  activity?: string;
  error?: string;
}

export interface SideToolExecution {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: unknown;
    isError: boolean;
    durationMs?: number;
  };
  isPartial?: boolean;
}

export interface ScreenActions {
  submit(text: string, streamingBehavior?: "steer" | "followUp"): Promise<void>;
  newThread(): Promise<void>;
  openThread(id: string): Promise<void>;
  deleteThread(id: string): Promise<void>;
  toggleTools(id: string): Promise<void>;
  saveDraft(text: string): void;
  showList(): void;
  close(): void;
  cancel(): void;
}

export interface ConfirmationRequest {
  title: string;
  message: string;
  confirmLabel?: string;
}

export interface SideScreen extends Component, Focusable {
  refresh(): void;
  confirm(request: ConfirmationRequest): Promise<boolean>;
  dispose(): void;
}
