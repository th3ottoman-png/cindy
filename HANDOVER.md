# HANDOVER.md — Cindy personal harness (stable reference)

This file describes **what the project is and how it works**. It changes rarely.

- What to work on → `ROADMAP.md`
- What was done, when, and how it was verified → `STATUS.md`
- Rules you must follow → `AGENTS.md` (read it first)
- Why things are the way they are → `docs/decisions/`

---

## 1. Purpose

A private, single-user fork of **Cindy** (`makecindy/cindy`, Apache-2.0): an Electron desktop
app that runs AI coding agents — Claude Code, Codex, Pi and **Hermes** — on the owner's machine.

The fork's intent:

- A **daily-driver harness** for coding and research: reliable, fast, no cloud dependency.
- Agents talk **directly** to the owner's own providers: local LLMs (Ollama / LM Studio /
  llama.cpp) and API endpoints. No Cindy accounts, telemetry, remote sync or auto-update.
- **Hermes** is the primary agent and the extensibility path: skills, plugins, MCP servers.
- The owner defines **experts** (specialised bots) as plain files and can extend the harness
  with plugins without reading the whole codebase.

This is not a product. There is no marketing surface, no onboarding funnel, no other user.

---

## 2. Locations

| Thing | Value |
|---|---|
| Repo | `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy` — path has spaces and `=`; **quote it**. macOS FS is case-insensitive, so older docs spelling it `=Projects_Main=` resolve to the same place |
| Remote | private GitHub, `origin main`. Upstream remote `upstream` (strategy: see `docs/decisions/0001`) |
| Dev app data | `~/Library/Application Support/CindyGlobal-dev2-private`; the isolated `…/CindyGlobal-dev2-dev` sandbox is what `restart:desktop:remote` uses |
| Current handover | `docs/handoff/2026-11-04-eod-handover.md` and `docs/handoff/2026-11-04-eod-next-agent-prompt.md`. All older handover files are historical |
| Owner vault note | `/Users/turko/Bishi-memory/memory/Project — Cindy.md` — append one dated line per session at the end |
| Hermes home | **`~/.hermes-cindy`** — isolated. **`~/.hermes` is off-limits, always.** |
| Hermes launcher | `~/.local/bin/hermes-cindy` (pins `HERMES_HOME`) |
| Hermes daemon state | `~/.hermes-cindy/hermes-mgr/sessions.json` |
| Harness user files (planned) | `~/.cindy-harness/{providers.yaml, routing.yaml, experts/, plugins/, plugins.json}` |
| Vendored agent binaries | `tools/` — untracked, required at runtime, **keep** |
| CDP debugging | dev app binds `127.0.0.1:9222` (fixed; `XDT_CDP_PORT` overrides, dev-only — `docs/dev-rules/desktop-development.md`) |

---

## 3. Versions

| Component | Pinned | Notes |
|---|---|---|
| Node | **22.23.4** at `/opt/homebrew/opt/node@22/bin` | System default is 26 and breaks native modules (`better-sqlite3` NODE_MODULE_VERSION mismatch). `.nvmrc` + `engine-strict` enforce this (ROADMAP 0.3). |
| pnpm | 10.33.2 | |
| Hermes CLI | **0.22.5** (2026.9.24, stable; local `bf0203a794a0`) | Resume logic depends on `session_id` appearing on the `result` event; the context ring depends on the `logs/agent.log` line `[<session>] agent.conversation_loop: API call #N: model=… provider=… in=<prompt>` (`hermes-context.ts`; missing → falls back to the over-reporting session sum). Re-verify both on every Hermes upgrade. The compression notice (ROADMAP 1.11a, ADR 0010) depends on the `agent.log` lines `context compression started: session=… tokens=~N` and `context compression done: session=… rough_tokens=~M`; re-verify on upgrade. Expert `toolsets:` locks (ROADMAP 3.10, ADR 0009) depend on `hermes chat -t`: fixed at session creation, a resume must repeat the exact launch string or omit it (a different one exits 2), MCP servers are not scoped by it, and only whole built-in toolsets are accepted. Re-probe on upgrade (method: STATUS 2026-11-03, stub model in a throwaway home). The daemon's `config/status` RPC (called when Settings loads the model catalog) runs `<hermes> --version` and logs a warning on mismatch with the pin in `packages/maker-hermes-manager/src/hermes-version.ts`; an unreadable version warns and returns `matches: null`. Bump the pin there and here together. |
| Upstream SHA at fork freeze | **`7c5bd270c956417127e12a74934d0ecdb97ba55d`** | `git merge-base main upstream/main`; see ADR 0001. |

---

## 4. Architecture

```
Cindy renderer (React)
   │  IPC (preload → main)
Cindy main process
   │  maker-core ──► agent adapters (claude-code | codex | pi | hermes)
   │                       │
   │                       └─ hermes: NDJSON RPC over a unix socket
   │                                 ▼
   │                          hermes-mgr daemon (utilityProcess)
   │                                 ▼
   │                          one `hermes chat` child per turn
   ▼                                 ▼
SQLite (Cindy DB)             ~/.hermes-cindy  (isolated Hermes home)
```

### Packages

| Path | Role |
|---|---|
| `apps/desktop` | Electron app: main, preload, renderer, DB, packaging |
| `packages/maker-core` | Session lifecycle + agent adapters (`src/agents/hermes/`) |
| `packages/maker-hermes-manager` | `hermes-mgr` daemon: protocol, session registry, spawn layer, config RPCs |
| `packages/maker-shared` | Shared types, brand identity, pricing/usage helpers |
| `packages/model-providers` | Provider catalog + routing |
| `docs/dev-rules/` | Upstream engineering rulebook — `AGENTS.md` overrides it where they conflict |

### Hermes integration — key files

| File | Responsibility |
|---|---|
| `packages/maker-hermes-manager/src/hermes-manager.ts` | RPC handlers, session registry, per-turn retry on stale resume id |
| `packages/maker-hermes-manager/src/hermes-run.ts` | Builds argv, spawns one `hermes chat` per turn |
| `packages/maker-hermes-manager/src/hermes-config.ts` | Line-based read/write of `config.yaml` (model route, `mcp_servers:`, local `custom_providers` context windows) preserving comments. `config/setLocalContextWindows` (bundle 0.3.0) removes the global `model.ollama_num_ctx` and upserts per-endpoint `custom_providers` entries matched by normalized base_url (ROADMAP 1.12b) |
| `packages/maker-hermes-manager/src/hermes-models.ts` | Reads home `.env` key, queries `GET <base_url>/models` |
| `packages/maker-hermes-manager/src/protocol.ts` | RPC method/shape definitions — read before adding an RPC |
| `packages/maker-hermes-manager/src/__tests__/fixtures/fake-hermes.mjs` | Test double; **only** Hermes binary tests may spawn |
| `packages/maker-core/src/agents/hermes/` | Adapter (`agent.ts`), event translator, transport, protocol mirror |
| `packages/maker-core/src/agents/adapter-extensions.ts` | Registers the four built-in adapters in the 4.1a extension registry; production sites build them via `createAdapterAgent` (typed) — untyped `createRegisteredAdapterAgent` is reserved for the 4.2 plugin loader (ROADMAP 4.1b; do not re-merge the two, see the module header) |
| `apps/desktop/src/main/maker-host/hermes-manager-client.ts` | Desktop side of the daemon; `getHermesHomeStatus`, MCP helpers |
| `apps/desktop/src/main/maker-ipc/channels.ts`, `register.ts` | IPC channel names and handlers |
| `apps/desktop/src/renderer/components/settings/HermesSection.tsx` | Settings card: home, route, plugins, skills, MCP servers |
| `apps/desktop/src/main/maker-ipc/{skills.ts,skillsDesktop.ts}` | 4.4 skills manager host: list/scan/install/enable/disable/uninstall over `~/.hermes-cindy/skills` (+ `skills-disabled/`); scan-first install, Cindy-side shallow git clone is the only outbound call |
| `apps/desktop/src/main/maker-ipc/{mcpCatalog.ts,mcpCatalogDesktop.ts}` | 4.3 MCP server catalog host (Hermes config servers + lizi in-process); Hermes toggle is config-write-only (0.22.5 ignores `disabled` at startup — Debt) |
| `apps/desktop/src/renderer/hooks/useHermesModelCatalog.ts` | Model picker data |
| `apps/desktop/src/main/maker-ipc/title.ts` | `TITLE_AGENT_KINDS` includes `hermes` |

### Session UI surfaces (renderer)

| File | Responsibility |
|---|---|
| `packages/maker-core/src/tasks/turn-timeline.ts` | Pure 5.3a turn timeline model. Subpath `@cindy/maker-core/turn-timeline`; `buildTurnTimeline`, `DEFAULT_LONG_RUNNING_AFTER_MS` (120,000 ms). Zero imports, no clock, no subscription, no cancellation |
| `apps/desktop/src/renderer/features/cc-agent/turn-timeline-adapter.ts` | 5.3b pure adapter. Maps `makerChatStore` tool bubbles to the 5.3a event shape, closes merged results by adjacency, declares turn state from `turnStoppedByUser`, folds a retained per-turn frame |
| `apps/desktop/src/renderer/features/cc-agent/LongRunningTurnTimeline.tsx` | 5.3b view plus container. Polls `makerChatStore.getSnapshot` once a second, renders above the composer only for turns past the threshold, wires Cancel to the composer's Stop handler |
| `apps/desktop/src/renderer/features/cc-agent/SessionRouteBlockedBanner.tsx` | 2.4b no-silent-fallback notice. Re-evaluates on store error/turn transitions, provider config changes and window focus. Never auto-switches |

The raw `maker:event` payload carries **no timestamp**. The store stamps `createdAt` on tool
message bubbles at reducer time and `agentStatus.startedAt` from a separate status event, so
displayed tool durations are receipt-time estimates, not SDK timings. A cancelled Hermes row is
still persisted `turnCompleted: true`, so turn state must be declared from `turnStoppedByUser`,
never derived from persisted rows.

### How a Hermes turn works

1. Renderer sends the user message over IPC; `maker-core` Hermes adapter forwards to the daemon.
2. Daemon looks up `sessions.json` for a `hermesSessionId`; builds argv (`--resume` if present).
   A resume must repeat the session's launch `-m`/`--provider`/permission flags exactly (Hermes 0.22.5 rejects any
   difference); the daemon stores them as `launch` in the registry. A model change is sent as a silent `/model <x>`
   run before the turn, never as a changed `-m` (ROADMAP 1.8d).
3. Spawns `hermes chat` with `HERMES_HOME=~/.hermes-cindy`; provider key passed in memory only.
4. NDJSON events stream back; the translator maps them to Cindy events (text, tool call/result, usage).
5. Real `session_id` is captured from `system/init` **and** `result`; registry updated.
6. If Hermes rejects the resume id, the daemon holds events, emits a one-line notice, and retries
   the turn in a fresh session.

### Safety model

- Safe mode by default with an explicit default model; `--yolo` is opt-in per session.
- Daemon has a fail-closed guard against any path resolving to `~/.hermes`.
- Provider keys are never written by Cindy; Hermes's own `.env` in `~/.hermes-cindy` is the
  only place a key exists on disk, and that is Hermes's file, not ours.

---

## 5. Running and checking

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"     # node -v → v22.x
cd "/Users/turko/=ai space=/=Projects_Main=/Cindy"

pnpm install                                          # first time / lockfile change
pnpm restart:desktop:remote --region=global           # canonical dev app start, from a real Terminal
pnpm release:package                                  # packaged build (ROADMAP 0.2)
```

The dev app must be started with the root wrapper above, from a real Terminal session, and you
must wait for `DESKTOP_DEV_VERDICT=ready`. Never bypass it with `pnpm dev:desktop`. Main-process
changes need a full restart; renderer-only changes hot-reload. See
`docs/dev-rules/desktop-development.md` for the full rules and the fixed CDP port 9222.

Local operations (Node 22):

```bash
pnpm backup:create [--out <dir>]     # dated .tar.gz of Cindy DB + ~/.hermes-cindy (no caches, no .env/auth.json) + experts → ~/.cindy-harness/backups
pnpm backup:restore <archive>        # quit Cindy first; replaced files are renamed *.pre-restore-<stamp>, never deleted
pnpm upstream:scan                   # fetch upstream/main, list cherry-pick candidates since the frozen SHA; applies nothing
```

Settings → Hermes Harness also has "Back up now" / "Restore…" (same code,
`apps/desktop/src/main/backup/localBackup.ts`). `upstream:scan` is due quarterly (reminder in `STATUS.md`).

Gates (all must pass before commit — see `AGENTS.md` §2):

```bash
pnpm typecheck                 # recursive workspace typecheck; authoritative
pnpm test:runner               # repo contracts: docs links, brand, design inventory, hygiene
pnpm test:unit:related         # unit tests for the diff; manages workspaces itself (no --maxWorkers)
pnpm check:test-hygiene
pnpm check:i18n                # advisory — UI is English-only by decision
pnpm check:brand-terminology   # advisory
```

Notes:

- **All four gates apply to every commit, including docs-only ones.** `AGENTS.md` §2 has no
  docs-only exception. A full run takes about 26 minutes. Older handover notes claiming three
  gates suffice for docs-only commits are wrong.
- **Run gates in a canonical environment.** The WorkBuddy agent shell injects
  `NODE_OPTIONS=--require=…/node-language-shim.cjs`, which distorts FS-heavy tests and breaks
  `/bin/ps`. Write a `.command` file and launch it with the computer-use `open_app` helper so it
  runs in a real Terminal. Confirm `PS_PROBE=    1 /sbin/launchd` and `NODE_OPTIONS=[]` in the
  log. The launcher may report a timeout even though the script has started; check the log.
- **Sanctioned unit-tier split:** `node scripts/test-workspaces.mjs --tier unit --related
  --exclude-workspace apps/desktop`, then `XDT_UNIT_TEST_SHARD=i/8 node
  scripts/test-workspaces.mjs --tier unit --related --workspace apps/desktop` for i=1..8. The
  desktop threads pool intermittently dies with **SIGSEGV** in V8 GC during worker-isolate
  teardown. Rerun only the crashed shard standalone in the same environment. All 8 green counts
  as the gate; never count a crashed run as green.
- Large `apps/desktop` suites take ~5 min per shard. The hygiene ratchet reports
  `PASS (361 files within baseline)`; `design-inventory --check` reports 54 surfaces.
- `pnpm build` inside `packages/maker-core` is **not** the gate; the root recursive typecheck is.
- Daemon bundles under `apps/desktop/resources/{hermes,cc,pi}-manager/` and `packages/*/dist`
  are regenerated by `apps/desktop/scripts/build-remote-bundles.mjs` on dev start.

---

## 6. Hard constraints

Authoritative list is `AGENTS.md` §1–§3. Summary:

1. `~/.hermes-cindy` only. Never `~/.hermes`.
2. Tests never spawn a real agent binary.
3. No changes to Claude Code / Codex / Pi behaviour, their prompt text, or lizi MCP schemas
   unless a `ROADMAP.md` row says so.
4. No upstream file deletion until ADR 0001 exists.
5. No credentials on disk; no telemetry; no outbound calls the owner did not ask for.
6. `git commit -s`, push `origin main`, never force-push.
7. Nothing is "done" without the verification label the task demands.

---

## 7. Deliberately kept — do not "clean up"

| Path | Why |
|---|---|
| `tools/` | Vendored binaries; untracked; required at runtime |
| `apps/desktop/resources/*-manager/`, `packages/*/dist` | Generated bundles; regenerated on dev start |
| `CONTRIBUTING*`, `CODE_OF_CONDUCT*`, `SECURITY*`, `SUPPORT*`, `DCO`, `REVIEW.md` | `dev-docs-contract` test and PR workflow reference them; deleting costs merge conflicts, buys nothing |
| `.github/` | `hardcoded-color-audit.test.mjs` reads `ci.yml` |
| `docs/design-evidence/`, `docs/design-previews/` | Linked from design rules; `dev-docs-contract` breaks without them |
| `apps/desktop/logs/`, `apps/desktop/.vite/` | Live caches of the running dev app; delete only when stopped |
| Any upstream code you think is dead | Dead code is cheaper than a merge conflict (see ADR 0001) |

---

## 8. Known traps

- **Node 26 on PATH** → `NODE_MODULE_VERSION 147 vs 127`. Fix: PATH export above.
- **Hermes security scan** blocks community plugins (e.g. `obra/superpowers`: ~170 findings,
  14 HIGH, all in docs/test files). Read each HIGH, install without `--force` where possible,
  inspect `.hermes-plugin/__init__.py`, enable, run `doctor`. Record what you read in `STATUS.md`.
- **Line-based YAML editing** of `config.yaml` preserves comments but is sensitive to unusual
  formatting. Always back up before a live write (`AGENTS.md` §4).
- **`sessions.json`** is rewritten every turn via temp-write + rename. A corrupt or truncated
  file starts an empty registry and logs a warning; Cindy-held Hermes ids remain usable for resume.
- **Untested surfaces**: Windows/Linux, voice, scheduler, device-link, mobile. The packaged
  build is live-proven under 0.2; mobile Hermes compatibility is unit-tested under 0.4.
- **CDP target selection**: the dev app opens several `page` targets. The main chat view is the
  one whose URL contains `#/cc-agent/`. The first `page` is usually the voice-input overlay.
  Drive the renderer with a Node-22 script using the built-in `WebSocket` client and
  `Runtime.evaluate`.
- **Composer selectors**: Tiptap `DIV.tiptap.ProseMirror[contenteditable=true]`, not a
  `textarea`. Type with `e.focus(); document.execCommand('insertText', false, text)`. Send is
  `button[aria-label="Send message"]`. Clear a stale pre-restart error with
  `button[aria-label="Dismiss error"]`.
- **Live proofs and hot reload**: never edit a renderer file while a live-proof turn is running.
  The Vite reload kills the turn. A reload immediately after a renderer edit can also kill Vite
  esbuild ("The service is no longer running", blank root); restart with the canonical wrapper.
- **Renderer tests**: jsdom is opt-in per file via a first line
  `// @vitest-environment jsdom`. Never `vi.mock('react-i18next')` wholesale, because
  `makerChatStore.ts` imports the real i18n init.
- **Plugin examples**: `loadPlugins`' native `import()` fails inside a Vitest worker ("A dynamic
  import callback was not specified"). Verify plugin examples in plain Node, not Vitest.
- **New renderer surfaces**: run `node scripts/design-inventory.mjs --check`. A component mounted
  inside an existing view does not change the generated surface block. Placeholders use
  `--text-placeholder`, not `--text-tertiary` (the ink-ladder test in shard 8 catches it).

---

## 9. First 20 minutes for a new agent

For a paused handoff, the newest `STATUS.md` entry is the exact resume checklist and takes
precedence over this generic startup sequence where they differ. The current handover
(`docs/handoff/2026-11-04-eod-handover.md`) and its matching next-agent prompt carry the exact
stopping point and the up-to-date open-work order; read them before this generic sequence.

1. Read `AGENTS.md` end to end. Then this file. Then the current phase of `ROADMAP.md` and the
   last two entries of `STATUS.md`.
2. `export PATH=...node@22...`; `node -v` must say 22.
3. `cd` into the quoted repo path; inspect `git status` and `git log --oneline -10`. Paused
   work may be intentionally uncommitted; never reset or clean it before reading `STATUS.md`.
4. Start the dev app with `pnpm restart:desktop:remote --region=global` from a real Terminal and
   wait for `DESKTOP_DEV_VERDICT=ready`. Open a Hermes task, send one message, confirm it streams
   and `~/.hermes-cindy/hermes-mgr/sessions.json` gains a `hermesSessionId`.
5. Send "what did I just say?" — if answered correctly, resume works. You now know the hot path
   is healthy before you change anything.
6. Take the **top open row** in the current `ROADMAP.md` phase. One task. Finish it to its label
   or hand it back honestly in `STATUS.md`.

---
