import { randomUUID } from "node:crypto";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { MainActionRequest } from "./engine.ts";
import type { ConfirmationRequest } from "./types.ts";

export const ACTION_TOOL = "btw_execute_approved";
export const ACTION_RECEIPT = "side-query-main-action";

interface PendingAction {
  id: string;
  parentId: string;
  threadId: string;
  threadTitle: string;
  toolName: string;
  args: unknown;
  summary: string;
  status: "queued" | "running";
  receipt: (text: string, approvalId: string) => Promise<void>;
}

interface ActionOrigin {
  threadId: string;
  threadTitle: string;
  ctx: ExtensionContext;
  confirm(request: ConfirmationRequest): Promise<boolean>;
  receipt(text: string, approvalId: string): Promise<void>;
  signal?: AbortSignal;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function safeLabel(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function executionTarget(pi: ExtensionAPI, name: string): ToolInfo {
  const tool = pi.getAllTools().find((candidate) => candidate.name === name);
  if (!tool || name === ACTION_TOOL || tool.exposure === "hidden") throw new Error("That main tool is unavailable.");
  if (tool.exposure === "model-only") throw new Error("This tool requires the main conversation's direct UI. Ask for it there.");
  if (tool.exposure === "direct" && !pi.getActiveTools().includes(name)) throw new Error("That tool is disabled in the main conversation.");
  return tool;
}

/** An approval buys one immutable native tool call in the original main session. */
export class MainActionBridge {
  private registered = false;
  private readonly pending = new Map<string, PendingAction>();
  private readonly controllers = new Map<string, AbortController>();
  private addedToLoadout = false;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) { this.pi = pi; }

  private register(): void {
    if (this.registered) return;
    const pi = this.pi;
    pi.registerTool({
      name: ACTION_TOOL,
      label: "Approved side action",
      description: "Execute one immutable action explicitly confirmed in a side conversation. Only the approval ID is accepted. Never invent an ID, substitute a target, or execute the target separately. Native validation and permission hooks still apply.",
      parameters: Type.Object({ approvalId: Type.String() }, { additionalProperties: false }),
      exposure: "model-only",
      defaultActive: false,
      executionMode: "sequential",
      reachesTools: (input) => {
        const action = typeof input.approvalId === "string" ? this.pending.get(input.approvalId) : undefined;
        return action ? [action.toolName] : [];
      },
      execute: async (_callId, params, signal, onUpdate, ctx) => {
        const action = this.pending.get(params.approvalId);
        if (!action || action.status !== "queued") return toolResult("This approval is unavailable, expired, or already used. No action ran.");
        // Consume the approval before the first await; parallel/repeated calls cannot run it twice.
        action.status = "running";
        if (ctx.sessionManager.getSessionId() !== action.parentId || signal?.aborted) {
          this.pending.delete(action.id);
          this.restoreLoadout();
          return toolResult("The original main session changed or the action was cancelled. No action ran.");
        }
        const cancellation = new AbortController();
        this.controllers.set(action.id, cancellation);
        const combined = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
        let resultText: string;
        let nativeResult: Awaited<ReturnType<typeof ctx.executeTool>> | undefined;
        try {
          executionTarget(pi, action.toolName);
          nativeResult = await ctx.executeTool(action.toolName, structuredClone(action.args), { signal: combined, onUpdate });
          resultText = `${nativeResult.isError ? "Failed" : "Completed"}: ${action.summary} — from ${action.threadTitle}.`;
        } catch (error) {
          resultText = `Failed: ${action.summary} — from ${action.threadTitle}. ${error instanceof Error ? error.message : String(error)}`;
        } finally {
          this.pending.delete(action.id);
          this.controllers.delete(action.id);
          this.restoreLoadout();
        }
        // A receipt is written only after the host reports the actual nested-call outcome.
        try { await action.receipt(resultText, action.id); }
        catch { /* Main action outcome must not turn into a tool retry because a side file could not save. */ }
        try {
          if (ctx.sessionManager.getSessionId() === action.parentId) {
            pi.sendMessage({ customType: ACTION_RECEIPT, content: resultText, display: true,
              details: { approvalId: action.id, threadId: action.threadId, toolName: action.toolName, isError: nativeResult?.isError ?? true } },
            { triggerTurn: false });
          }
        } catch { /* Session may have been replaced while the nested tool was running. */ }
        if (!nativeResult) return toolResult(resultText);
        return { ...nativeResult.result,
          content: [{ type: "text" as const, text: resultText }, ...nativeResult.result.content],
          details: { outcome: nativeResult.result.details, sideThreadId: action.threadId, approvalId: action.id },
          isError: nativeResult.isError };
      },
    });
    this.registered = true;
  }

  private restoreLoadout(): void {
    if (this.pending.size || !this.addedToLoadout) return;
    this.addedToLoadout = false;
    try { this.pi.setActiveTools(this.pi.getActiveTools().filter((name) => name !== ACTION_TOOL)); }
    catch { /* A stale extension cannot change a replacement session's loadout. */ }
  }

  async request(request: MainActionRequest, origin: ActionOrigin): Promise<string> {
    if (origin.signal?.aborted) return "Action cancelled. No main action ran.";
    if (this.pending.size >= 8) return "Finish or cancel the pending main actions before requesting another.";
    const tool = executionTarget(this.pi, request.toolName);
    const serialized = JSON.stringify(request.args);
    if (serialized === undefined || serialized.length > 64_000) throw new Error("The action arguments are missing or too large to review.");
    const validated = validateToolArguments(tool, { type: "toolCall", id: "btw-review", name: tool.name, arguments: JSON.parse(serialized) });
    const args = structuredClone(validated);
    const summary = safeLabel(request.summary) || `Run ${safeLabel(tool.name)}`;
    const title = safeLabel(origin.threadTitle) || "side conversation";
    const parentId = origin.ctx.sessionManager.getSessionId();
    const accepted = await origin.confirm({ title: "Allow main action?", confirmLabel: "Allow once",
      message: `${summary}\n\nMain tool: ${tool.name}\nFrom: ${title}\n\n${JSON.stringify(args, null, 2)}` });
    if (!accepted || origin.signal?.aborted) return "Action declined or cancelled. No main action ran.";
    if (origin.ctx.sessionManager.getSessionId() !== parentId) return "Main session changed. No action was queued.";
    // Recheck the host loadout after the dialog; enabling side tools never re-enables disabled main tools.
    executionTarget(this.pi, tool.name);
    this.register();
    const id = randomUUID();
    const pending: PendingAction = { id, parentId, threadId: origin.threadId, threadTitle: title,
      toolName: tool.name, args, summary, status: "queued", receipt: origin.receipt };
    this.pending.set(id, pending);
    try {
      const active = this.pi.getActiveTools();
      if (!active.includes(ACTION_TOOL)) {
        // Track our addition before the host call: a policy hook can throw after
        // changing the loadout, and that failure must still discard this approval.
        this.addedToLoadout = true;
        this.pi.setActiveTools([...active, ACTION_TOOL]);
        if (!this.pi.getActiveTools().includes(ACTION_TOOL)) {
          throw new Error("Main policy prevents the approved-action bridge from running.");
        }
      }
      this.pi.sendUserMessage(`The user approved one action from a side conversation.\nCall ${ACTION_TOOL} with approvalId ${JSON.stringify(id)} once. Execute only that stored action for this request.\nThe approval tool holds the exact reviewed tool and arguments; normal main permissions apply. Do not substitute a target or execute it separately. Report the actual outcome.\nOrigin label (quoted reference data): ${JSON.stringify(title)}.`,
        { deliverAs: "steer" });
    } catch (error) {
      this.pending.delete(id);
      this.restoreLoadout();
      throw error;
    }
    return `Approved and queued in the main conversation: ${summary}. It has not completed yet; the main conversation will report the actual outcome. Approval ${id}.`;
  }

  status(): string {
    return [...this.pending.values()].map((action) => `${action.status}: ${action.summary} (from ${action.threadTitle})`).join("\n");
  }

  async cancelThread(threadId: string): Promise<void> {
    for (const [id, action] of this.pending) {
      if (action.threadId !== threadId || action.status !== "queued") continue;
      this.pending.delete(id);
      await action.receipt(`Cancelled: ${action.summary} — from ${action.threadTitle}. No action ran.`, action.id).catch(() => {});
    }
    this.restoreLoadout();
  }

  cancelAll(): void {
    this.pending.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.restoreLoadout();
  }
}
