import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SideQueryApp } from "../src/app.ts";
import { SideThreadStore } from "../src/store.ts";
import type { SideThread } from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let parentId = "original", overlays = 0;
  const handlers = new Map<string, Array<() => void>>();
  const pi = {
    on: (name: string, handler: () => void) => {
      const list = handlers.get(name) ?? [];
      list.push(handler); handlers.set(name, list);
      return () => { handlers.set(name, list.filter((item) => item !== handler)); };
    },
    getActiveTools: () => [], setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getSessionId: () => parentId, getSessionFile: () => "session.jsonl", getSessionName: () => parentId, getBranch: () => [] },
    ui: { custom: () => { overlays++; return Promise.resolve(); }, notify: () => {} },
  } as unknown as ExtensionContext;
  return { app: new SideQueryApp(pi), ctx, overlays: () => overlays,
    switchSession: () => { parentId = "replacement"; for (const handler of handlers.get("session_start") ?? []) handler(); },
    shutdown: () => { for (const handler of [...handlers.get("session_shutdown") ?? []]) handler(); },
  };
}

function store(create: () => Promise<SideThread>) {
  return { create, list: () => [], save: async () => {}, flush: async () => {}, mergeReceipts: () => {} } as unknown as SideThreadStore;
}

const thread: SideThread = { id: "00000000-0000-4000-8000-000000000001", title: "Side", titleGenerated: false,
  createdAt: 1, updatedAt: 1, toolsEnabled: false, draft: "", messages: [] };

test("switching sessions during index loading cannot mount an old-parent screen", async () => {
  const original = SideThreadStore.open;
  const loading = deferred<SideThreadStore>();
  SideThreadStore.open = async () => loading.promise;
  try {
    const f = fixture();
    const opened = f.app.open(f.ctx, true);
    await Promise.resolve();
    f.switchSession();
    loading.resolve(store(async () => structuredClone(thread)));
    await opened;
    assert.equal(f.overlays(), 0);
    assert.equal(f.app.isOpen(), false);
    SideThreadStore.open = async () => store(async () => structuredClone(thread));
    await f.app.open(f.ctx, true);
    assert.equal(f.overlays(), 1, "Replacement parent must still be able to open a thread");
  } finally { SideThreadStore.open = original; }
});

test("session shutdown during thread creation cannot reopen its terminal overlay", async () => {
  const original = SideThreadStore.open;
  const creating = deferred<SideThread>();
  const entered = deferred<void>();
  SideThreadStore.open = async () => store(async () => { entered.resolve(); return creating.promise; });
  try {
    const f = fixture();
    const opened = f.app.open(f.ctx, true);
    await entered.promise;
    f.shutdown();
    creating.resolve(structuredClone(thread));
    await opened;
    assert.equal(f.overlays(), 0);
    assert.equal(f.app.isOpen(), false);
  } finally { SideThreadStore.open = original; }
});

test("a cancelled old-parent reply cannot leave the replacement screen busy", async () => {
  const original = SideThreadStore.open;
  SideThreadStore.open = async () => store(async () => structuredClone(thread));
  try {
    const f = fixture();
    const mounted = deferred<void>(), overlay = deferred<void>(), reply = deferred<void>();
    f.ctx.ui.custom = (() => { mounted.resolve(); return overlay.promise; }) as typeof f.ctx.ui.custom;
    const controller = f.app as unknown as {
      engine: { run(): Promise<void> };
      submit(text: string): Promise<void>;
      state: { busy: boolean; activity?: string };
      closePromise: Promise<void>;
    };
    controller.engine.run = async () => reply.promise;
    const opened = f.app.open(f.ctx, true);
    await mounted.promise;
    const running = controller.submit("Old parent question");
    assert.equal(controller.state.busy, true);
    f.switchSession();
    overlay.resolve();
    reply.resolve();
    await Promise.all([running, opened]);
    await controller.closePromise;
    let replacementMounted = false;
    f.ctx.ui.custom = (() => {
      replacementMounted = true;
      assert.equal(controller.state.busy, false, "Replacement editor must accept questions");
      assert.equal(controller.state.activity, undefined);
      return Promise.resolve();
    }) as typeof f.ctx.ui.custom;
    await f.app.open(f.ctx, true);
    assert.equal(replacementMounted, true);
  } finally { SideThreadStore.open = original; }
});
