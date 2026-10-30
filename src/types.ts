import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component, Focusable } from "@earendil-works/pi-tui";

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
  draft: string;
  busy: boolean;
  activity?: string;
  error?: string;
}

export interface ScreenActions {
  submit(text: string): Promise<void>;
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
