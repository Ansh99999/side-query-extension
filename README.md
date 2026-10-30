# Side Query Extension

Lightweight `/btw` side conversations for **Pi-Bolt 1.0.7 / Pi 1.4.0 or later**. Uses Pi's native message components, editor, theme, and `AgentSession` prompt handler. No runtime dependencies, startup requests, polling, or background agents.

## Install

```sh
pi-bolt install git:github.com/Ansh99999/side-query-extension
```

Restart Pi-Bolt after installation. The built JavaScript is included; Node.js, npm, and a build step are not required to run the extension in Pi-Bolt. Installation does not require `pi-bolt compile` on Termux; device validation is still pending.

To try a checkout without installing:

```sh
git clone https://github.com/Ansh99999/side-query-extension.git
pi-bolt -e ./side-query-extension/index.mjs
```

## Use

Type `/btw Why is this taking so long?`, or `/btw` to open an empty side conversation. Each invocation creates a new thread, including `/btw` typed inside a side conversation. Ctrl+/ resumes the current thread, or opens the searchable list when none is selected.

Press **Esc once** in a thread to see the list, then **Esc again** to return to the main conversation.

```text
Main conversation title
+----------------------------------------------------------+
| > Search titles                                          |
+----------------------------------------------------------+
> Startup investigation                         24 mins ago
  Build options                                  1 hour ago
```

Titles are generated once after the first successful answer; activity times use the current theme's gray text. The chat uses the same native user, assistant, thinking, code, tool, and editor components as Pi-Bolt's main conversation. It has no chat title or corner tool badge. The footer contains only `^N new · ^D delete · Alt+T tools · ^/ main`. Press Alt+Tab to reveal `Tool on` or `Tool off` when needed; the status disappears when typing or navigating.

| Key | Action inside the side screen |
| --- | --- |
| ^N | New thread |
| ^D | Delete the selected thread after confirmation |
| Alt+T | Enable or disable tools for this thread |
| ^/ | Return to main; press again there to resume |
| ^C | Cancel the current side reply or pending confirmation |
| Alt+Tab | Show tool availability |
| PgUp / PgDn | Scroll the reply |

Search by typing a title fragment. Enter opens the selection; arrows choose a thread and Tab switches between search and list. Shift+Enter inserts a newline in the editor. During a reply, Enter steers the native session and Alt+Enter queues a follow-up; cancellation returns waiting prompts to the draft. Legacy terminals may encode Ctrl+/ and Ctrl+_ identically; modern Ctrl+- keeps Pi's undo behavior.

## Tools and main actions

Tools start **off** in each new thread. The model receives a bounded excerpt of the main conversation and observed activity. It cannot execute tools in that mode. Status answers use available evidence; context usage is not a task completion percentage.

With tools enabled, the side conversation can use Pi's native `read`, `grep`, `find`, and `ls`, inspect main tool metadata, and request a main action. A change, shell command, or subagent launch shows a confirmation containing the exact main tool and arguments. Cancel is selected by default.

Choosing **Allow once** queues one immutable approved call in the original main conversation. Pi's normal permissions and tool hooks still apply. The main and side transcripts receive a completion or failure receipt identifying the requesting thread. A queued request is reported as queued until it runs. Subagents can be requested when your main session supplies a callable subagent tool.

The side thread itself runs no parallel task. There is at most one active side reply. Returning to main or switching threads cancels an unfinished reply and keeps its partial text. A previously approved main action can continue in the main queue; disabling side tools or deleting its thread cancels approvals still waiting to execute. Changing the main session invalidates its approvals. Main tools disabled by policy are respected; a restrictive tool allowlist must also permit the `btw_execute_approved` bridge for approved actions to run.

## Storage and limits

Threads belong to a main session and resume with it. The extension stores a small index and separate transcripts under `~/.pi/agent/side-query/<hash-of-main-session-id>/`, or the configured Pi agent directory. It loads the index on opening and reads each transcript on selection. Writes are atomic and user-only. Draft text, titles, and the tools toggle persist; the main editor draft and side messages stay in their respective conversations. Ephemeral sessions keep side data in memory.

Only explicit questions make model requests. The first successful answer may make one small additional request for its title. Replies use Pi-Bolt's native model settings, retry policy, history projection, and automatic compaction. The previous custom eight-turn limit and history trimming are removed. Native session entries preserve compaction summaries and context edits across restarts. The quoted parent excerpt and helper metadata remain bounded. Terminal output is sanitized, and pasted control bytes cannot approve a dialog or trigger shortcuts.

## Startup and Termux

The entry only registers the command, shortcut, and lifecycle handlers. Conversation code loads on first use. Stock Pi-Bolt still initializes its source loader for filesystem extensions, including JavaScript, so a small entry alone cannot remove that fixed cost.

The patched host is experimental. A reported device comparison found no meaningful startup gain and about 16 MB more peak RSS. Local matched tests show that startup savings disappear when another extension already needs jiti; the device memory difference remains unexplained. See the [interactive startup and memory report](docs/performance.md#interactive-startup-and-memory).

The repository includes a small Pi-Bolt native `.mjs` loader patch and reproducible offline benchmarks. See [the patched host download and installation notes](docs/patched-host.md) and [measurements and Termux instructions](docs/performance.md). The patch addresses the loader cost without requiring `pi-bolt compile` on Android; it needs a Pi-Bolt build that includes the patch. The tested host is distributed separately as an experimental prerelease; it is not an upstream release. Native-loaded code edits require a restart; `/reload` reruns the factory but may retain cached module code.

## Development

```sh
npm install
npm run check
npm test
npm run build
python3 scripts/terminal-smoke.py --binary pi-bolt
node scripts/benchmark.mjs --help
```

Development uses Node.js 22.19+ and TypeScript. Pi supplies all runtime modules. Commit `dist/` with source changes so installation stays build-free. Tests use temporary directories, native sessions with dummy model runtimes, and local dummy providers; the terminal smoke test exercises navigation, persistence, cancelled replies, and an approved main file change against the real binary.

MIT licensed.
