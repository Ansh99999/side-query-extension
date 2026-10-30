import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
const ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const RECEIPT_TYPE = "side-query-main-action";
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function receiptKey(message) {
    if (message.role !== "custom" || message.customType !== RECEIPT_TYPE)
        return undefined;
    if (object(message.details) && typeof message.details.approvalId === "string" && message.details.approvalId) {
        return `approval:${message.details.approvalId}`;
    }
    return `legacy:${createHash("sha256").update(JSON.stringify([message.timestamp, message.content])).digest("hex")}`;
}
function summary(value) {
    if (!object(value))
        return false;
    return typeof value.id === "string" && ID.test(value.id)
        && typeof value.title === "string" && typeof value.titleGenerated === "boolean"
        && typeof value.toolsEnabled === "boolean"
        && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);
}
function toSummary(thread) {
    return {
        id: thread.id, title: thread.title, titleGenerated: thread.titleGenerated,
        createdAt: thread.createdAt, updatedAt: thread.updatedAt, toolsEnabled: thread.toolsEnabled,
    };
}
function parseIndex(value) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.threads)
        || !value.threads.every(summary))
        throw new Error("The side conversation list is invalid. Its file was preserved.");
    const threads = value.threads;
    if (new Set(threads.map((thread) => thread.id)).size !== threads.length
        || (value.currentId !== undefined && !threads.some((thread) => thread.id === value.currentId))) {
        throw new Error("The side conversation list is inconsistent. Its file was preserved.");
    }
    return { version: 1, currentId: value.currentId, threads: threads.map(toSummary) };
}
function parseThread(value, id) {
    if (!object(value) || value.version !== 1 || !summary(value) || value.id !== id
        || typeof value.draft !== "string" || !Array.isArray(value.messages)
        || !value.messages.every((message) => object(message) && typeof message.role === "string")) {
        throw new Error("This side conversation is invalid. Its file was preserved.");
    }
    return { ...toSummary(value), draft: value.draft, messages: value.messages };
}
function missing(error) {
    return object(error) && error.code === "ENOENT";
}
async function atomicJson(path, directory, data) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(`${JSON.stringify(data)}\n`, "utf8");
        }
        finally {
            await file.close();
        }
        await rename(temporary, path);
    }
    finally {
        await rm(temporary, { force: true }).catch(() => { });
    }
}
export class SideThreadStore {
    index = { version: 1, threads: [] };
    memory = new Map();
    receipts = new Map();
    queue = Promise.resolve();
    directory;
    persistent;
    constructor(agentDir, parentId, persistent) {
        this.persistent = persistent;
        const key = createHash("sha256").update(parentId).digest("hex");
        this.directory = join(agentDir, "side-query", key);
    }
    static async open(agentDir, parentId, persistent = true) {
        const store = new SideThreadStore(agentDir, parentId, persistent);
        if (persistent) {
            try {
                store.index = parseIndex(JSON.parse(await readFile(join(store.directory, "threads.json"), "utf8")));
            }
            catch (error) {
                if (!missing(error))
                    throw error;
            }
        }
        return store;
    }
    get currentId() { return this.index.currentId; }
    list() {
        return this.index.threads.map(toSummary).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    }
    enqueue(operation) {
        const result = this.queue.then(operation);
        this.queue = result.then(() => { }, () => { });
        return result;
    }
    async writeIndex(next) {
        if (this.persistent)
            await atomicJson(join(this.directory, "threads.json"), this.directory, next);
        this.index = next;
    }
    rememberReceipts(thread) {
        for (const message of thread.messages) {
            const key = receiptKey(message);
            if (!key)
                continue;
            let known = this.receipts.get(thread.id);
            if (!known)
                this.receipts.set(thread.id, known = new Map());
            if (!known.has(key))
                known.set(key, structuredClone(message));
        }
    }
    mergeReceipts(thread) {
        const known = this.receipts.get(thread.id);
        if (!known)
            return;
        const present = new Set(thread.messages.map(receiptKey).filter((key) => key !== undefined));
        for (const [key, message] of known) {
            if (present.has(key))
                continue;
            thread.messages.push(structuredClone(message));
            present.add(key);
        }
    }
    async readThread(id) {
        const thread = this.persistent
            ? parseThread(JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")), id)
            : structuredClone(this.memory.get(id));
        this.rememberReceipts(thread);
        this.mergeReceipts(thread);
        return thread;
    }
    async writeThread(thread) {
        thread.updatedAt = Math.max(thread.updatedAt, this.index.threads.find((item) => item.id === thread.id)?.updatedAt ?? thread.updatedAt);
        if (this.persistent)
            await atomicJson(join(this.directory, `${thread.id}.json`), this.directory, { version: 1, ...thread });
        else
            this.memory.set(thread.id, structuredClone(thread));
        await this.writeIndex({ ...this.index, threads: this.index.threads.map((item) => item.id === thread.id ? toSummary(thread) : item) });
    }
    async create() {
        return this.enqueue(async () => {
            const now = Date.now();
            const thread = {
                id: randomUUID(), title: "New side conversation", titleGenerated: false,
                createdAt: now, updatedAt: now, toolsEnabled: false, draft: "", messages: [],
            };
            if (this.persistent)
                await atomicJson(join(this.directory, `${thread.id}.json`), this.directory, { version: 1, ...thread });
            else
                this.memory.set(thread.id, structuredClone(thread));
            await this.writeIndex({ version: 1, currentId: thread.id, threads: [...this.index.threads, toSummary(thread)] });
            return thread;
        });
    }
    async load(id) {
        return this.enqueue(async () => {
            if (!ID.test(id) || !this.index.threads.some((thread) => thread.id === id))
                throw new Error("Side conversation not found.");
            return this.readThread(id);
        });
    }
    async select(id) {
        await this.enqueue(async () => {
            if (!this.index.threads.some((thread) => thread.id === id))
                throw new Error("Side conversation not found.");
            await this.writeIndex({ ...this.index, currentId: id });
        });
    }
    async save(thread) {
        const copy = structuredClone(thread);
        copy.messages = copy.messages.filter((message) => message.role !== "system");
        if (!summary(copy))
            throw new Error("Invalid side conversation.");
        await this.enqueue(async () => {
            if (!this.index.threads.some((item) => item.id === copy.id))
                return;
            this.rememberReceipts(copy);
            this.mergeReceipts(copy);
            await this.writeThread(copy);
        });
    }
    async recordReceipt(id, receipt) {
        const message = structuredClone(receipt);
        const key = receiptKey(message);
        if (!key)
            throw new Error("Invalid side action receipt.");
        return this.enqueue(async () => {
            if (!ID.test(id) || !this.index.threads.some((thread) => thread.id === id))
                return undefined;
            const thread = await this.readThread(id);
            if (!thread.messages.some((existing) => receiptKey(existing) === key))
                thread.messages.push(message);
            if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
                thread.updatedAt = Math.max(thread.updatedAt, message.timestamp);
            }
            this.rememberReceipts(thread);
            this.mergeReceipts(thread);
            await this.writeThread(thread);
            return thread;
        });
    }
    async delete(id) {
        await this.enqueue(async () => {
            if (!ID.test(id) || !this.index.threads.some((thread) => thread.id === id))
                throw new Error("Side conversation not found.");
            const threads = this.index.threads.filter((thread) => thread.id !== id);
            const currentId = this.index.currentId === id ? undefined : this.index.currentId;
            await this.writeIndex({ version: 1, currentId, threads });
            this.memory.delete(id);
            this.receipts.delete(id);
            if (this.persistent)
                await rm(join(this.directory, `${id}.json`), { force: true });
        });
    }
    async flush() { await this.queue; }
}
