// Keep stock Pi-Bolt's source loader in control of lazy SDK imports. The native
// .mjs fast path resolves this empty import from Pi's existing module bridge.
import {} from "typebox";

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function sideQuery(pi) {
  let app;
  let loading;
  let latestContext;
  let removeLegacyInput;

  const open = async (ctx, create, question = "") => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Side conversations need the interactive terminal.", "warning");
      return;
    }
    try {
      if (!app) {
        loading ??= import("./dist/app.js").then(({ SideQueryApp }) => new SideQueryApp(pi));
        app = await loading;
      }
      await app.open(ctx, create, question);
    } catch (error) {
      loading = undefined;
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.registerCommand("btw", {
    description: "Ask a side question",
    handler: (question, ctx) => open(ctx, true, question.trim()),
  });
  pi.registerShortcut("ctrl+/", {
    description: "Open side conversations",
    handler: (ctx) => open(ctx, false),
  });

  // Legacy terminals encode Ctrl+/ and Ctrl+_ as the same byte. Match that
  // byte only, leaving the distinct Ctrl+- undo key in modern terminals alone.
  pi.on("session_start", (_event, ctx) => {
    latestContext = ctx;
    removeLegacyInput?.();
    removeLegacyInput = undefined;
    if (ctx.mode !== "tui") return;
    removeLegacyInput = ctx.ui.onTerminalInput((data) => {
      if (data !== "\x1f") return;
      if (app?.isOpen()) return;
      void open(latestContext, false);
      return { consume: true };
    });
  });
  pi.on("model_select", (_event, ctx) => { latestContext = ctx; });
  pi.on("thinking_level_select", (_event, ctx) => { latestContext = ctx; });
  pi.on("session_shutdown", () => {
    removeLegacyInput?.();
    removeLegacyInput = undefined;
  });
}
