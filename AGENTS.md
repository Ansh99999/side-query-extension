# Side Query Extension

Use TypeScript and Pi's native terminal components, current theme, model registry,
and agent loop. Add no runtime dependencies. Keep the entry limited to registrations
and lazy imports; no startup file reads, networking, timers, or background tasks.

Read docs/CONTRACT.md before changes. Workers edit only their assigned files.
Preserve the main conversation, main tools, editor draft, and unrelated settings.
Never run a main-conversation action without the side thread's explicit confirmation.
Do not read credentials; use the current model registry's request-time authentication.
Tests use temporary directories, dummy providers, and local HTTP servers.

The user has authorized creation and pushing of the new side-query-extension repo.
Do not add AI authors, coauthors, attribution footers, or session links to Git history.
