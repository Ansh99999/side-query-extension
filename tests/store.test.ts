import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { SideThreadStore } from "../src/store.ts";

test("native compaction history survives a restart without changing entry identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-native-history-"));
  try {
    const store = await SideThreadStore.open(root, "parent");
    const thread = await store.create();
    const entries: FileEntry[] = [
      { type: "session", version: 3, id: thread.id, timestamp: new Date(1).toISOString(), cwd: "/test" },
      { type: "message", id: "message1", parentId: null, timestamp: new Date(2).toISOString(),
        message: { role: "user", content: "Keep this context", timestamp: 2 } },
      { type: "compaction", id: "compact1", parentId: "message1", timestamp: new Date(3).toISOString(),
        summary: "Earlier context", firstKeptEntryId: "message1", tokensBefore: 12000 },
    ];
    thread.sessionEntries = entries;
    await store.save(thread);
    const reopened = await SideThreadStore.open(root, "parent");
    assert.deepEqual((await reopened.load(thread.id)).sessionEntries, entries);
    await reopened.recordReceipt(thread.id, receipt("native-outcome"));
    assert.deepEqual((await reopened.load(thread.id)).sessionEntries, entries);
    assert.equal((await reopened.load(thread.id)).messages[0].role, "custom");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("threads persist separately per parent with retained drafts, title, and tool choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-store-"));
  try {
    const store = await SideThreadStore.open(root, "parent-one");
    assert.deepEqual(store.list(), []);
    assert.deepEqual(await readdir(root), []);
    const one = await store.create();
    const two = await store.create();
    assert.notEqual(one.id, two.id);
    assert.equal(one.toolsEnabled, false);
    one.title = "Caching a slow provider";
    one.titleGenerated = true;
    one.toolsEnabled = true;
    one.draft = "unfinished\nquestion";
    one.messages = [{ role: "user", content: "a side question", timestamp: Date.now() }];
    await store.save(one);
    await store.select(one.id);
    const reopened = await SideThreadStore.open(root, "parent-one");
    assert.equal(reopened.currentId, one.id);
    assert.deepEqual(await reopened.load(one.id), one);
    assert.equal((await SideThreadStore.open(root, "parent-two")).list().length, 0);
    const names = await readdir(store.directory);
    assert.deepEqual(names.sort(), [`${one.id}.json`, `${two.id}.json`, "threads.json"].sort());
    if (process.platform !== "win32") {
      assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
      for (const name of names) assert.equal((await stat(join(store.directory, name))).mode & 0o777, 0o600);
    }
    const index = JSON.parse(await readFile(join(store.directory, "threads.json"), "utf8"));
    assert.equal(index.threads[0].messages, undefined);
    assert.equal(index.threads[0].draft, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("index can open and another thread can load without reading an unselected corrupt transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-store-"));
  try {
    const store = await SideThreadStore.open(root, "parent");
    const one = await store.create(), two = await store.create();
    await writeFile(join(store.directory, `${one.id}.json`), "invalid transcript");
    const reopened = await SideThreadStore.open(root, "parent");
    assert.equal(reopened.list().length, 2);
    assert.deepEqual(await reopened.load(two.id), two);
    await assert.rejects(reopened.load(one.id));
    await assert.rejects(reopened.load("../../outside"), /not found/);
    assert.equal(await readFile(join(store.directory, `${one.id}.json`), "utf8"), "invalid transcript");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a malformed index is preserved instead of silently overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-store-"));
  try {
    const store = await SideThreadStore.open(root, "parent");
    await store.create();
    const path = join(store.directory, "threads.json");
    const bad = '{"version":1,"threads":[{"id":"../../outside"}]}';
    await writeFile(path, bad);
    await assert.rejects(SideThreadStore.open(root, "parent"), /invalid/);
    assert.equal(await readFile(path, "utf8"), bad);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ephemeral sessions never touch the filesystem and remove only the selected thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-store-"));
  try {
    const store = await SideThreadStore.open(root, "ephemeral", false);
    const one = await store.create(), two = await store.create();
    one.draft = "keep this draft";
    await store.save(one);
    await store.select(two.id);
    await store.delete(two.id);
    assert.equal(store.currentId, undefined);
    assert.deepEqual(await store.load(one.id), one);
    await assert.rejects(store.load(two.id), /not found/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("queued writes are atomic, exclude replayed system loadouts, and survive later operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-store-"));
  try {
    const store = await SideThreadStore.open(root, "parent");
    const thread = await store.create();
    thread.messages.push({ role: "system", content: "parent instructions must not persist", timestamp: Date.now() });
    thread.draft = "first";
    const first = store.save(thread);
    thread.draft = "second";
    const second = store.save(thread);
    await Promise.all([first, second]);
    const result = await store.load(thread.id);
    assert.equal(result.draft, "second");
    assert.deepEqual(result.messages, []);
    assert.equal((await readdir(store.directory)).some((name) => name.endsWith(".tmp")), false);
    await store.delete(thread.id);
    await store.save(thread); // A late streamed write cannot resurrect a deleted thread.
    assert.deepEqual(store.list(), []);
    await assert.rejects(store.load(thread.id), /not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function receipt(approvalId: string, content = `Completed ${approvalId}`, timestamp = Date.now()): AgentMessage {
  return { role: "custom", customType: "side-query-main-action", content, display: true, timestamp, details: { approvalId } };
}

test("a stale loaded snapshot and tool toggle cannot erase a committed receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-receipt-"));
  try {
    const store = await SideThreadStore.open(root, "parent");
    const thread = await store.create();
    thread.draft = "draft before action";
    thread.messages.push({ role: "user", content: "existing turn", timestamp: Date.now() });
    await store.save(thread);
    const stale = await store.load(thread.id);
    const outcome = receipt("one", "Completed one", thread.updatedAt + 60_000);
    const recorded = await store.recordReceipt(thread.id, outcome);
    assert.equal(recorded?.draft, "draft before action");
    assert.deepEqual(recorded?.messages.at(-1), outcome);
    stale.toolsEnabled = true;
    stale.draft = "newer draft";
    await store.save(stale);
    const loaded = await store.load(thread.id);
    assert.equal(loaded.toolsEnabled, true);
    assert.equal(loaded.draft, "newer draft");
    assert.deepEqual(loaded.messages, [...thread.messages, outcome]);
    assert.equal(loaded.updatedAt, outcome.timestamp, "A stale save must not roll back the activity time");
    store.mergeReceipts(stale);
    assert.deepEqual(stale.messages, loaded.messages);
    store.mergeReceipts(stale);
    assert.deepEqual(stale.messages, loaded.messages, "repeated merge does not duplicate receipts");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("save copies captured before queued receipt commits merge it when their operation runs", async () => {
  const store = await SideThreadStore.open("/unused/ephemeral", "parent", false);
  const thread = await store.create();
  const old = await store.load(thread.id);
  const action = receipt("queued");
  const committing = store.recordReceipt(thread.id, action);
  old.draft = "saved during action completion";
  const saving = store.save(old); // clone lacks the receipt because its write is still queued.
  assert.deepEqual(old.messages, []);
  await Promise.all([committing, saving]);
  const loaded = await store.load(thread.id);
  assert.equal(loaded.draft, old.draft);
  assert.deepEqual(loaded.messages, [action]);
});

test("concurrent outcomes serialize append updates and approval IDs prevent duplicates", async () => {
  const store = await SideThreadStore.open("/unused/ephemeral", "parent", false);
  const thread = await store.create();
  const one = receipt("one"), two = receipt("two");
  await Promise.all([store.recordReceipt(thread.id, one), store.recordReceipt(thread.id, two)]);
  await store.recordReceipt(thread.id, receipt("one", "retry must not replace original", Date.now() + 100));
  assert.deepEqual((await store.load(thread.id)).messages, [one, two]);
  const returned = await store.recordReceipt(thread.id, receipt("three"));
  returned!.messages.length = 0;
  assert.equal((await store.load(thread.id)).messages.length, 3, "return value does not alias ephemeral storage");
});

test("reopened load remembers disk receipts; merge preserves only outcomes, not ordinary fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-receipt-"));
  try {
    const first = await SideThreadStore.open(root, "parent");
    const thread = await first.create();
    const stale = structuredClone(thread);
    await first.recordReceipt(thread.id, receipt("persisted"));
    const reopened = await SideThreadStore.open(root, "parent");
    await reopened.load(thread.id);
    stale.draft = "stale intentional draft";
    stale.toolsEnabled = true;
    stale.title = "intentional title";
    stale.messages.push({ role: "user", content: "intentional replacement", timestamp: Date.now() });
    await reopened.save(stale);
    const loaded = await reopened.load(thread.id);
    assert.equal(loaded.draft, stale.draft);
    assert.equal(loaded.toolsEnabled, stale.toolsEnabled);
    assert.equal(loaded.title, stale.title);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0].role, "user");
    assert.equal(loaded.messages[1].role, "custom");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy receipt identity uses timestamp/content and merges snapshots submitted with receipts", async () => {
  const store = await SideThreadStore.open("/unused/ephemeral", "parent", false);
  const thread = await store.create();
  const legacy: AgentMessage = { role: "custom", customType: "side-query-main-action", content: "Legacy outcome", display: true, timestamp: 123 };
  thread.messages.push(legacy);
  await store.save(thread);
  await store.recordReceipt(thread.id, structuredClone(legacy));
  await store.recordReceipt(thread.id, { ...legacy, timestamp: 124 });
  assert.equal((await store.load(thread.id)).messages.length, 2);
  thread.messages = [];
  store.mergeReceipts(thread);
  assert.equal(thread.messages.length, 2);
});

test("deleted threads reject receipt updates without recreation and discard receipt cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-query-receipt-"));
  try {
    const store = await SideThreadStore.open(root, "parent");
    const thread = await store.create();
    await store.recordReceipt(thread.id, receipt("before-delete"));
    const stale = structuredClone(thread);
    const deleting = store.delete(thread.id);
    const lateReceipt = store.recordReceipt(thread.id, receipt("after-delete"));
    const lateSave = store.save(stale);
    await deleting;
    assert.equal(await lateReceipt, undefined);
    await lateSave;
    store.mergeReceipts(stale);
    assert.deepEqual(stale.messages, [], "deletion also releases remembered outcomes");
    assert.deepEqual(store.list(), []);
    assert.equal((await readdir(store.directory)).includes(`${thread.id}.json`), false);
    assert.equal(await store.recordReceipt("../outside", receipt("invalid-target")), undefined);
    await assert.rejects(store.recordReceipt(thread.id, { role: "user", content: "not an action receipt", timestamp: 1 }), /Invalid side action receipt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
