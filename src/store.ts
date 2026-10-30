import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SideThread, ThreadSummary } from "./types.ts";

interface ThreadIndex {
  version: 1;
  currentId?: string;
  threads: ThreadSummary[];
}

const ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const RECEIPT_TYPE = "side-query-main-action";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function receiptKey(message: AgentMessage): string | undefined {
  if (message.role !== "custom" || message.customType !== RECEIPT_TYPE) return undefined;
  if (object(message.details) && typeof message.details.approvalId === "string" && message.details.approvalId) {
    return `approval:${message.details.approvalId}`;
  }
  return `legacy:${createHash("sha256").update(JSON.stringify([message.timestamp, message.content])).digest("hex")}`;
}

function summary(value: unknown): value is ThreadSummary {
  if (!object(value)) return false;
  return typeof value.id === "string" && ID.test(value.id)
    && typeof value.title === "string" && typeof value.titleGenerated === "boolean"
    && typeof value.toolsEnabled === "boolean"
    && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);
}

function toSummary(thread: ThreadSummary): ThreadSummary {
  return {
    id: thread.id, title: thread.title, titleGenerated: thread.titleGenerated,
    createdAt: thread.createdAt, updatedAt: thread.updatedAt, toolsEnabled: thread.toolsEnabled,
  };
}

function parseIndex(value: unknown): ThreadIndex {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.threads)
    || !value.threads.every(summary)) throw new Error("The side conversation list is invalid. Its file was preserved.");
  const threads = value.threads as ThreadSummary[];
  if (new Set(threads.map((thread) => thread.id)).size !== threads.length
    || (value.currentId !== undefined && !threads.some((thread) => thread.id === value.currentId))) {
    throw new Error("The side conversation list is inconsistent. Its file was preserved.");
  }
  return { version: 1, currentId: value.currentId as string | undefined, threads: threads.map(toSummary) };
}

function parseThread(value: unknown, id: string): SideThread {
  if (!object(value) || value.version !== 1 || !summary(value) || value.id !== id
    || typeof value.draft !== "string" || !Array.isArray(value.messages)
    || !value.messages.every((message) => object(message) && typeof message.role === "string")) {
    throw new Error("This side conversation is invalid. Its file was preserved.");
  }
  return { ...toSummary(value as unknown as ThreadSummary), draft: value.draft, messages: value.messages as SideThread["messages"] };
}

function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}

async function atomicJson(path: string, directory: string, data: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(data)}\n`, "utf8"); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Separate metadata and transcripts; only the selected transcript is read. */
export class SideThreadStore {
  private index: ThreadIndex = { version: 1, threads: [] };
  private readonly memory = new Map<string, SideThread>();
  // Keep only action receipts, rather than duplicate transcript snapshots. These
  // survive a streamed or navigation snapshot captured before an action finished.
  private readonly receipts = new Map<string, Map<string, AgentMessage>>();
  private queue: Promise<void> = Promise.resolve();
  readonly directory: string;
  private readonly persistent: boolean;

  private constructor(agentDir: string, parentId: string, persistent: boolean) {
    this.persistent = persistent;
    const key = createHash("sha256").update(parentId).digest("hex");
    this.directory = join(agentDir, "side-query", key);
  }

  static async open(agentDir: string, parentId: string, persistent = true): Promise<SideThreadStore> {
    const store = new SideThreadStore(agentDir, parentId, persistent);
    if (persistent) {
      try { store.index = parseIndex(JSON.parse(await readFile(join(store.directory, "threads.json"), "utf8"))); }
      catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return store;
  }

  get currentId(): string | undefined { return this.index.currentId; }

  list(): ThreadSummary[] {
    return this.index.threads.map(toSummary).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async writeIndex(next: ThreadIndex): Promise<void> {
    if (this.persistent) await atomicJson(join(this.directory, "threads.json"), this.directory, next);
    this.index = next;
  }

  private rememberReceipts(thread: SideThread): void {
    for (const message of thread.messages) {
      const key = receiptKey(message);
      if (!key) continue;
      let known = this.receipts.get(thread.id);
      if (!known) this.receipts.set(thread.id, known = new Map());
      if (!known.has(key)) known.set(key, structuredClone(message));
    }
  }

  /** Preserve committed action outcomes when the caller has an older snapshot. */
  mergeReceipts(thread: SideThread): void {
    const known = this.receipts.get(thread.id);
    if (!known) return;
    const present = new Set(thread.messages.map(receiptKey).filter((key) => key !== undefined));
    for (const [key, message] of known) {
      if (present.has(key)) continue;
      thread.messages.push(structuredClone(message));
      present.add(key);
    }
  }

  /** Read only from inside the queue; public load() must not be called there. */
  private async readThread(id: string): Promise<SideThread> {
    const thread = this.persistent
      ? parseThread(JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")), id)
      : structuredClone(this.memory.get(id)!);
    this.rememberReceipts(thread);
    this.mergeReceipts(thread);
    return thread;
  }

  private async writeThread(thread: SideThread): Promise<void> {
    thread.updatedAt = Math.max(thread.updatedAt, this.index.threads.find((item) => item.id === thread.id)?.updatedAt ?? thread.updatedAt);
    if (this.persistent) await atomicJson(join(this.directory, `${thread.id}.json`), this.directory, { version: 1, ...thread });
    else this.memory.set(thread.id, structuredClone(thread));
    await this.writeIndex({ ...this.index, threads: this.index.threads.map((item) => item.id === thread.id ? toSummary(thread) : item) });
  }

  async create(): Promise<SideThread> {
    return this.enqueue(async () => {
      const now = Date.now();
      const thread: SideThread = {
        id: randomUUID(), title: "New side conversation", titleGenerated: false,
        createdAt: now, updatedAt: now, toolsEnabled: false, draft: "", messages: [],
      };
      if (this.persistent) await atomicJson(join(this.directory, `${thread.id}.json`), this.directory, { version: 1, ...thread });
      else this.memory.set(thread.id, structuredClone(thread));
      await this.writeIndex({ version: 1, currentId: thread.id, threads: [...this.index.threads, toSummary(thread)] });
      return thread;
    });
  }

  async load(id: string): Promise<SideThread> {
    return this.enqueue(async () => {
      if (!ID.test(id) || !this.index.threads.some((thread) => thread.id === id)) throw new Error("Side conversation not found.");
      return this.readThread(id);
    });
  }

  async select(id: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.index.threads.some((thread) => thread.id === id)) throw new Error("Side conversation not found.");
      await this.writeIndex({ ...this.index, currentId: id });
    });
  }

  async save(thread: SideThread): Promise<void> {
    const copy = structuredClone(thread);
    copy.messages = copy.messages.filter((message) => message.role !== "system");
    if (!summary(copy)) throw new Error("Invalid side conversation.");
    await this.enqueue(async () => {
      if (!this.index.threads.some((item) => item.id === copy.id)) return;
      this.rememberReceipts(copy);
      this.mergeReceipts(copy);
      await this.writeThread(copy);
    });
  }

  /** Append an action outcome atomically without overwriting a concurrent draft or tool choice. */
  async recordReceipt(id: string, receipt: AgentMessage): Promise<SideThread | undefined> {
    const message = structuredClone(receipt);
    const key = receiptKey(message);
    if (!key) throw new Error("Invalid side action receipt.");
    return this.enqueue(async () => {
      if (!ID.test(id) || !this.index.threads.some((thread) => thread.id === id)) return undefined;
      const thread = await this.readThread(id);
      if (!thread.messages.some((existing) => receiptKey(existing) === key)) thread.messages.push(message);
      if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
        thread.updatedAt = Math.max(thread.updatedAt, message.timestamp);
      }
      this.rememberReceipts(thread);
      this.mergeReceipts(thread);
      await this.writeThread(thread);
      return thread;
    });
  }

  async delete(id: string): Promise<void> {
    await this.enqueue(async () => {
      if (!ID.test(id) || !this.index.threads.some((thread) => thread.id === id)) throw new Error("Side conversation not found.");
      const threads = this.index.threads.filter((thread) => thread.id !== id);
      const currentId = this.index.currentId === id ? undefined : this.index.currentId;
      // Remove the index reference first, so an interrupted delete cannot leave a missing transcript referenced.
      await this.writeIndex({ version: 1, currentId, threads });
      this.memory.delete(id);
      this.receipts.delete(id);
      if (this.persistent) await rm(join(this.directory, `${id}.json`), { force: true });
    });
  }

  async flush(): Promise<void> { await this.queue; }
}
