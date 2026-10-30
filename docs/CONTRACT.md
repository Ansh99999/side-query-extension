# Implementation contract

The extension has no runtime dependencies. Pi supplies its terminal components,
agent loop, model registry, and built-in read tools. The shipped index.mjs only
registers /btw, Ctrl+/, and a legacy terminal fallback. Everything else loads on
first use. No extension startup I/O, network requests, polling, or background jobs.

/btw always creates a new side thread, with an optional first question. Ctrl+/
resumes the current side thread, or shows the thread list if none exists. Esc in
chat shows the searchable list; Esc in the list returns to the main conversation.
Ctrl+N creates a thread. Ctrl+D requests deletion with confirmation. Alt+T toggles
tools for the selected thread. All three controls are local to this screen.

Use Pi's current theme and native Input/Editor/Markdown components. Cover the
terminal with one full-height custom overlay. The list shows the main conversation
title, an ASCII boxed search input, AI-generated thread titles, and gray relative
activity times. Keep help subtle and contextual. Handle narrow terminals and resize.
The main editor draft and streaming conversation must survive opening/closing.

Tools start off per thread. With tools off, side replies can read the bounded
main conversation snapshot but execute no tools. With tools on, only Pi-native
read-only tools and a main-action request tool are provided. Changes, arbitrary
shell commands, registered main tools, and subagent launches go through an explicit
confirmation, then Pi's main conversation queue and normal tool permission checks.
Record which side thread requested the action. A queued request must not claim it
has already completed. No model requests occur merely by opening/resuming threads.
Only one side reply may run at a time; returning to main cancels an unfinished reply.

Persist summaries and transcripts separately under the agent directory, keyed by
main session ID. Read summaries on opening and each transcript only when selected.
Save drafts on navigation/close, and transcripts on explicit turns. Use atomic writes
and user-only permissions. Never persist credentials or duplicate the parent history.
Ephemeral main sessions keep side data in memory. Session changes cannot redirect an
approved action into another parent. Closing/cancelling must dismiss pending approval.

src/types.ts defines the controller/UI boundary. Root owns types.ts, entry, store,
engine, controller, integration tests, and overall integration. The UI worker owns
src/ui.ts and tests/ui.test.ts. The performance worker owns patches/ and its assigned
benchmark/patch scripts and documentation. Workers must not alter another worker's
files or the read-only upstream/source SDKs.

Benchmark the actual Pi-Bolt binary with temporary settings and dummy models offline,
alternating baseline and extension runs, including cache-warm measurements and a
cold-loader scenario. Provide reproducible Termux commands and distinguish Linux
measurements from Android measurements. Stock Pi-Bolt initializes jiti for filesystem
extensions even when the entry is JavaScript; do not claim shipping JS removes that
cost. Investigate and validate a small native ESM loader fix separately.
