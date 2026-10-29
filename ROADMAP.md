# ROADMAP.md — Cindy personal harness

**Single source of truth for task status.** If `STATUS.md` or `HANDOVER.md` disagree with this
file, this file wins and the other must be corrected.

## Goal

A desktop harness the owner uses every day for coding and research, running local LLMs and API
providers side by side, with **experts** (specialised bots) that the owner defines in plain files,
and a plugin surface the owner can extend without reading the whole codebase.

It must be: **reliable** (never loses a conversation, never silently changes model, survives
restarts and updates), **powerful** (full tool access, multi-model routing, long-running
research), and **owner-maintainable** (small, documented extension points; no cloud).

## Status legend

| Symbol | Meaning |
|---|---|
| ✅ `live-proven` | Exercised in the running app / real CLI, result recorded in `STATUS.md` |
| 🧪 `unit-tested` | Tests pass; not yet exercised live |
| 📐 `typechecked` | Compiles only — **not done** |
| 🔲 | Open |
| ⛔ | Parked — do not build until the owner asks |
| ❌ | Dropped |

Ordering within a phase is priority order. Agents take the top open row unless told otherwise.

---

## Phase 0 — Foundations (do these before any feature work)

Nothing below is glamorous. All of it is what separates a toy from a daily driver.

| # | Task | Done when | Status |
|---|---|---|---|
| 0.1 | **Upstream strategy ADR.** `docs/decisions/0001-upstream-strategy.md` — decision: *freeze* `upstream/main`, cherry-pick security fixes only (allow-list in the ADR); de-cloud via flags/implementation swaps, never file deletion. Record the frozen upstream SHA (`git merge-base main upstream/main`) in the ADR and in `HANDOVER.md` §Versions. | ADR committed; SHA recorded | ✅ |
| 0.2 | **Packaged build.** Run `pnpm release:package`. Confirm: app launches, Hermes daemon bundle path resolves, Hermes turn works, settings surfaces render, icon/name correct. Record the output path. | ✅ required | ✅ `live-proven` |
| 0.3 | **Enforce Node 22.** Add `.nvmrc` (`22.23.4`), `"engines"` + `engine-strict=true`, and an early exit in `scripts/desktop-dev-runner.mjs` that prints the PATH export. | Running under Node 26 fails fast with the fix on screen | ✅ `live-proven` |
| 0.4 | **Green gate.** Fix, skip-with-reason, or quarantine the two known failing suites and the two `maker-core` type errors. | Default gate set exits 0 | 🧪 `unit-tested` |
| 0.5 | **Atomic `sessions.json`.** Temp-write + rename in the registry; add a corruption test (truncated file → empty registry + warning, not crash). | 🧪 | 🧪 `unit-tested` |
| 0.6 | **Pin Hermes version.** Record installed `hermes --version` in `HANDOVER.md` §Versions. Daemon logs a warning on `status` if installed version ≠ pinned. | ✅ | ✅ `live-proven` |
| 0.7 | **Fixture parity test.** Capture one real `hermes chat` NDJSON transcript (redacted) into fixtures; assert `fake-hermes.mjs` emits the same event shapes and key placement (`session_id` on `result`). | 🧪 | 🧪 `unit-tested` |
| 0.8 | **Live-prove the config writers.** Back up `~/.hermes-cindy/config.yaml`, click "set default model", add and remove one MCP server from the UI, diff the file, confirm `hermes-cindy` still starts and loads the MCP server. | ✅ | ✅ `live-proven` (STATUS 2026-10-29: model save, add + remove stdio MCP server via UI, config diffed, `hermes-cindy mcp test` connected; residual empty `mcp_servers:` key logged in Debt) |
| 0.9 | **Secrets hygiene.** Rotate the ElevenLabs key; `git log -p` grep for any key material; decide and record what to do with the unused Nous login. | Done in `STATUS.md` | ✅ done: **0.9a** history/tree scan clean; **0.9b** Nous logged out 2026-10-29 (`auth.json` has no providers), ElevenLabs key rotated by the owner (owner-reported, not machine-verifiable) |
| 0.10 | **Docs consolidation.** Move `~/Desktop/Cindy-Master-Plan.md` into `docs/`; split old handover into `HANDOVER.md` (stable) + `STATUS.md` (log) + this file; mirror constraints into `AGENTS.md`. | Files exist, old sections removed | 🧪 `unit-tested` |
| 0.11 | **Local backup/restore.** One command (and a Settings button) that tars the Cindy SQLite DB, `~/.hermes-cindy` (minus caches), and the experts directory to a dated archive; and restores from one. | ✅ round-trip | ✅ `live-proven`: **0.11a** CLI create/restore; **0.11b** Settings "Back up now" in the UI; **0.11c** Settings "Restore…" driven through the native picker + confirm dialog, config restored byte-identical, replaced files renamed `*.pre-restore-*`, app relaunched (STATUS 2026-10-29) |
| 0.12 | **Upstream security scan.** `scripts/upstream-security-scan.sh`: fetches `upstream/main`, lists commits since the frozen SHA whose message or diff touches `package.json` deps, `electron`, preload/IPC/sandbox files, or matches `security|CVE|vuln|fix.*crash|data loss`. Prints candidates for cherry-pick per ADR 0001 allow-list — never applies them. Add a `pnpm upstream:scan` script and a quarterly reminder line in `STATUS.md`. | Script runs clean against current upstream; first scan result logged in `STATUS.md` | ✅ `live-proven` |

---

## Phase 1 — Hermes as a first-class agent

| # | Task | Done when | Status |
|---|---|---|---|
| 1.1 | Hermes RPC daemon, session registry, per-turn spawn | — | ✅ |
| 1.2 | Auto-title and prompt prediction accept `hermes` | — | 🧪 |
| 1.3 | Stale resume-id recovery, real session id from `result` | — | ✅ |
| 1.4 | Image attachments inlined as local file refs | — | 🧪 |
| 1.5a | MCP server **config** management (list/set/remove RPCs + UI) | — | 🧪 (live-prove via 0.8) |
| **1.5b** | **Cindy native tool bridge → Hermes.** Expose Cindy's builtin tools (browser, SSH, docs, computer-use) as a local **stdio MCP server** spawned by the main process; auto-register it in `~/.hermes-cindy/config.yaml` via 1.5a; one tool call round-trips in a live Hermes turn. | ✅ with transcript | 🔲 (split 2026-10-29 into 1.5b-1…4 below; this row stays open until 1.5b-4b is `live-proven`) |
| 1.5b-1 | **Session identity for Hermes tool calls.** Hermes spawns no Cindy session id today, and bridge tools must not trust tool-arg identity. Decide and implement how a Hermes turn maps to a Cindy session ctx (per-session token + `registerSessionCtx`, as Pi does in `piEnvironment.ts`). Owner decided token handoff: **0600 runtime file**, no secret in `config.yaml`. | 🧪 | 🧪 `unit-tested` (STATUS 2026-10-29): `AgentDeps.prepareHermesBridgeSession` hook in the Hermes agent, `hermesBridgeSession.ts` + `hermesBridgeRuntimeFile.ts`, real-bridge tests. **Not wired into `maker-host` yet — that is 1.5b-3.** |
| 1.5b-2 | **stdio shim.** Bundled ESM script (esbuild, like `maker-hermes-manager/build.mjs`) that speaks MCP over stdio and proxies `tools/list` + `tools/call` to the loopback streamable-HTTP bridge, reading port/token from the runtime file (`~/.cindy-harness/hermes-bridge.json`, shape in `hermesBridgeRuntimeFile.ts`) keyed by the `CINDY_BRIDGE_SESSION` env; fails closed if the file, the session entry, or the bridge instance is missing or stale. Hermes does **not** forward parent env to MCP children, so `config.yaml` must carry `env: { CINDY_BRIDGE_SESSION: "${CINDY_BRIDGE_SESSION}" }` (interpolation verified). | 🧪 against a stub HTTP MCP server | 🧪 `unit-tested` (STATUS 2026-10-29): `packages/cindy-tools/src/hermes-bridge-shim/`, `pnpm --filter cindy-tools bundle:shim`; one shim per bridge server (`--server <name>`). **Not registered in `config.yaml` or spawned by the app yet — 1.5b-3.** |
| 1.5b-3 | **Main-process wiring.** Inject `prepareHermesBridgeSession` in `maker-host/index.ts` (next to `resolveHermesManagerSocketPath`), freezing the per-project tool policy into `vendorOptions` as Pi does; clear the 0600 runtime file at bridge shutdown; register the shim via the 1.5a RPCs with a static command only; allow-list which Cindy servers are exposed (docs, ssh, browser, computer-use) and gate the risky ones. | 🧪 + config diff | 🧪 `unit-tested` (STATUS 2026-10-29): `hermesBridgeHost.ts` wired in `maker-host/index.ts`, runtime file cleared at startup and on quit. Default exposure is `cindy_docs` only; browser/computer/ssh are gated off (no opt-in source yet). **Not live-proven**: no real Hermes has loaded the shim; packaged builds do not ship the bundle yet (Debt). |
| 1.5b-4a | **Live proof, harness-hosted bridge.** One Cindy tool call round-trips inside a real `hermes-cindy` chat turn (real shim, production preparer + bridge, real `cindy_docs`), transcript saved. | ✅ with transcript | ✅ `live-proven` (STATUS 2026-10-29, `docs/evidence/1.5b-4-live-proof-transcript.md`): `read_sheet` answered `pears = 42` from a file only the tool could read; `node` on Hermes' PATH resolved; owner approved the one paid DeepSeek turn. Bridge was hosted by a throwaway script, not the desktop app. |
| 1.5b-4b | **Same proof inside the running desktop app.** Start the dev app, open a Hermes chat, ask for a `cindy_docs` tool call, confirm it round-trips through `maker-host`'s injected hook. Needs a second paid turn — owner approval required first. | ✅ with transcript | 🔲 Attempted 2026-10-29, **failed, not proven** (one paid turn used): tools never connected because Hermes expands `${CINDY_BRIDGE_SESSION}` from its long-lived gateway's env, not the per-session env (`docs/evidence/1.5b-4b-attempt-not-proven.md`). Blocked: free control experiment confirmed the per-session-env identity design cannot work with a shared gateway (STATUS 2026-10-29); needs an owner decision on the identity channel (options a/b in STATUS); no further paid turn until then. |
| 1.6 | Hermes settings surface (home, route, plugins, skills) | — | 📐 → needs ✅ |
| 1.7 | Model catalog from provider `/models`; default-model write | — | 🧪 (live-prove via 0.8) |
| 1.8 | **Per-session model override.** Pick a model for *this* session without touching `config.yaml`; shown in session header; passed via argv/env to `hermes chat`. | ✅ | 🔲 |
| 1.9 | **Session cost/usage panel** per conversation (tokens in/out, provider, model) reusing `maker-shared` pricing helpers. Local models show tokens only. | ✅ | 🔲 |
| 1.10 | **Cancel / interrupt a turn** cleanly: kill the `hermes chat` child, mark the turn aborted in the registry, keep the conversation resumable. | ✅ | 🔲 |

---

## Phase 2 — Multi-model: local + API, deliberately

| # | Task | Done when | Status |
|---|---|---|---|
| 2.1 | **Provider registry file.** `~/.cindy-harness/providers.yaml` listing each endpoint (Ollama / LM Studio / llama.cpp / OpenAI-compatible APIs) with base URL, key env-var name (never the key), capabilities (tools, vision, context length). Read by `model-providers`. | 🧪 + UI lists them | 🔲 |
| 2.2 | **Local model discovery.** Poll configured local endpoints' `/models` (and Ollama `/api/tags`); show online/offline and loaded models in the picker. | ✅ | 🔲 |
| 2.3 | **Explicit routing rules.** `routing.yaml`: task-class → model (e.g. `title: local-small`, `predict: local-small`, `chat.default: <owner choice>`). Auxiliary jobs (titling, prediction, summaries) **must** be routable to a local model so the daily driver costs nothing idle. | ✅ titles generated by local model | 🔲 |
| 2.4 | **No silent fallback.** If a routed model is offline, the session shows an error with a one-click "use X instead" — never auto-switch to a paid provider. | ✅ | 🔲 |
| 2.5 | **Context-window guard.** Warn when a conversation approaches the active model's context limit; offer "summarise and continue" using the routed summariser model. | ✅ | 🔲 |

---

## Phase 3 — Experts (specialised bots)

An **expert** is a directory the owner can create, copy, edit, and version:

```
~/.cindy-harness/experts/<slug>/
  expert.md         # YAML frontmatter + system prompt body
  skills/           # optional SKILL.md files, Hermes-compatible
  tools.yaml        # optional allow/deny list of tools + MCP servers
  knowledge/        # optional local files the expert may read (paths, not uploads)
```

Frontmatter: `name`, `description`, `agent` (hermes | claude-code | codex | pi), `model`
(route name from 2.3), `temperature`, `tools`, `skills`, `memory: true|false`, `tags`.

| # | Task | Done when | Status |
|---|---|---|---|
| 3.1 | **Expert loader.** Parse the directory, validate frontmatter, hot-reload on change, expose via IPC. Invalid expert → listed with the error, never crashes. | 🧪 | 🔲 |
| 3.2 | **Start a session as an expert.** Picker in new-task UI; session header shows expert name + model; prompt/tools/skills applied through the adapter (Hermes first). | ✅ | 🔲 |
| 3.3 | **Expert editor UI.** Create/duplicate/edit experts in Settings; writes the files above. Hand-editing still works and wins. | ✅ | 🔲 |
| 3.4 | **Expert memory (opt-in).** Per-expert append-only notes file the expert can read at start and write at end of a session (via one tool). Plain Markdown, owner-editable, shown in the editor. | ✅ | 🔲 |
| 3.5 | **Starter experts** committed under `docs/experts-examples/`: *Code Reviewer*, *Research Analyst* (web + notes), *Repo Explainer*, *Prompt Engineer*. Each tested once live. | ✅ | 🔲 |
| 3.6 | **Handoff between experts.** From any session: "ask <expert> about this" opens a new session with a summary of the current one as context. No autonomous multi-agent orchestration — the owner stays in the loop. | ✅ | 🔲 |

---

## Phase 4 — Plugin & extension surface

| # | Task | Done when | Status |
|---|---|---|---|
| 4.1 | **Unified registry.** One `registerExtension({kind, id, …})` entry point for adapters, tools, experts, model routes, UI panels. Existing adapters migrated with zero behaviour change. | 🧪 | 🔲 |
| 4.2 | **Local plugin directory.** `~/.cindy-harness/plugins/<name>/manifest.yaml` + entry module, loaded at startup, toggled in Settings. Failure isolates to the plugin. | ✅ | 🔲 |
| 4.3 | **MCP server catalog.** Settings page listing all configured MCP servers across agents (Hermes config, lizi MCP), start/stop/health, with "add to expert" shortcut. | ✅ | 🔲 |
| 4.4 | **Skills manager.** Browse/install/enable Hermes skills from local folders or git URLs into `~/.hermes-cindy`, with the security-scan report shown before enabling. | ✅ | 🔲 |
| 4.5 | **Extension author guide.** `docs/extending.md`: how to add an adapter, tool, expert, route, or panel in under one page each, with a worked example. | Owner can follow it unaided | 🔲 |

---

## Phase 5 — Research workflow

| # | Task | Done when | Status |
|---|---|---|---|
| 5.1 | **Local notes vault bridge.** Point the harness at a folder (Obsidian/Markdown). Tool: read/search/append notes. Experts opt in via `tools.yaml`. | ✅ | 🔲 |
| 5.2 | **Session export.** Export any conversation to Markdown (with tool calls collapsed) into the vault or a chosen path. | ✅ | 🔲 |
| 5.3 | **Long-running task view.** For turns > 2 minutes: live tool-call timeline, elapsed time, cancel. | ✅ | 🔲 |
| 5.4 | **Scheduled sessions (local).** Reuse upstream scheduler to run an expert on a cron with a fixed prompt, output to vault. No cloud. | ✅ | 🔲 |

---

## Debt (fix when touched, never let grow)

| Item | Owner note |
|---|---|
| Hermes security-scan friction for community plugins | Accepted; 4.4 surfaces the report instead of hiding it |
| Removing the last MCP server leaves an empty `mcp_servers:` key and no trailing newline in `config.yaml` | Found in 0.8; Hermes reads it fine. Fix in the config writer when next touched |
| Packaged build does not ship `hermes-bridge-shim.mjs` | 1.5b-3 resolves `resources/hermes-bridge-shim/` but nothing copies it there; Hermes runs without Cindy tools in a packaged app until it does. Fix before relying on it outside dev |
| ~~i18n parity check vs English-only UI~~ | Resolved in 0.10: kept advisory, see `docs/decisions/0002-advisory-i18n-checks.md` |

---

## Parked ⛔ — do not build until the owner asks

Kept so nobody re-proposes them as new ideas.

- Worktree manager dock, artifacts side-drawer, embedded terminal panel
- Time-travel / session forking UI
- Slash-command palette
- Automatic model cascade / cost-optimising router (conflicts with 2.4 "no silent fallback")
- Autonomous multi-agent orchestration (conflicts with 3.6 owner-in-the-loop)
- Windows / Linux support
- Voice input changes, device-link, mobile app
- Any upstream PR work (3.x in the old plan)

## Dropped ❌

- Cloud accounts, telemetry, remote sync, auto-update — by definition of the project.
- Marketing/landing/help-centre content.
