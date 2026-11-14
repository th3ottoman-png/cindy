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
| Current handover | `docs/handover-2026-11-13.md` (session-close handover: repo state, exact gate/dev-app commands, hard rules, traps, paste-ready next-agent prompt in §7). All older files in `docs/handoff/` are historical. |
| Owner vault note | `/Users/turko/Bishi-memory/memory/Project — Cindy.md` — append one dated line per session at the end |
| Hermes home | **`~/.hermes-cindy`** — isolated. **`~/.hermes` is off-limits, always.** |
| Hermes launcher | `~/.local/bin/hermes-cindy` (pins `HERMES_HOME`) |
| Hermes daemon state | `~/.hermes-cindy/hermes-mgr/sessions.json` |
| Harness user files | `~/.cindy-harness/{providers.yaml, routing.yaml, experts/, squads/, plugins/, plugins.json, packs/, vault.json, chat-autosave.json, chat-summary.json, expert-sessions.json, session-teammates.json, schedules-config.json, schedules-state.json, pinned-vault-notes.json, vault-embeddings.db, session-adrs.json, turn-audit-sessions.json}`. `session-teammates.json` (12.3a/b) records, per lead session, the joined @agent: teammates (roster id → Orca worker/session/team ids + definition file + optional `mayPropose`) and any pending teammate proposals; the 8.2 strip lists and removes them (removing the last one ends the team), toggles "May bring in others", and confirms/dismisses proposals. `squads/<slug>/squad.yaml` (12.4b) holds saved teams (name, description, lead + member roster ids, `worker_permission_mode` ceiling, `max_turns`); the Squads tab launches one as a Hermes lead plus Orca teammates through the 12.3 registry (ADR 0012). `turn-audit-sessions.json` (11.10) holds the sessions whose turns ask for a `cindy-audit` footer (toggled by the `Audit` header chip; the Hermes agent re-reads it each turn). `session-adrs.json` (11.8) records, per session, its workspace dir and the ADRs injected into its first turn; `record_adr` takes its repo path from here, never from the agent. `experts/decision-recorder/` is installed from `docs/experts-examples/decision-recorder/` and is the only starter expert that lists `record_adr` |
| Notes vault | `/Users/turko/Bishi-memory` (from `vault.json`). Chat auto-save (5.5, **on**) writes `Cindy/Chats/<date>-<slug>-<8-char id>.md`; Auto-summary (5.6) writes `Cindy/Memory/<date>-<slug>-<8-char id>-summary.md` on idle or close |
| Vendored agent binaries | `tools/` — untracked, required at runtime, **keep** |
| CDP debugging | dev app binds `127.0.0.1:9222` (fixed; `XDT_CDP_PORT` overrides, dev-only — `docs/dev-rules/desktop-development.md`) |

---

## 3. Versions

| Component | Pinned | Notes |
|---|---|---|
| Node | **22.23.4** at `/opt/homebrew/opt/node@22/bin` | System default is 26 and breaks native modules (`better-sqlite3` NODE_MODULE_VERSION mismatch). `.nvmrc` + `engine-strict` enforce this (ROADMAP 0.3). |
| pnpm | 10.33.2 | |
| Hermes CLI | **0.22.7** (2026.9.24, stable; local `b200f5bc60e3`; pin bumped from 0.22.5 on 2026-11-07, the installed version had already moved) | Resume logic depends on `session_id` appearing on the `result` event; the context ring depends on the `logs/agent.log` line `[<session>] agent.conversation_loop: API call #N: model=… provider=… in=<prompt>` (`hermes-context.ts`; missing → falls back to the over-reporting session sum). Re-verify both on every Hermes upgrade. The Auto-review hook (ROADMAP 1.13e) finds Hermes's Python from the `hermes` entry script (an `sh` wrapper that execs its python in 0.22.7) and falls back to PATH `node` if that layout changes (logged as `using node`); re-verify on upgrade. Hermes 0.22.7 stops waiting for a `pre_tool_call` callback after ~30 s, whatever the hook's `timeout` says, and refuses later calls while one still runs (ROADMAP 1.13f). So the daemon answers every hook within 24 s, and a review still open then (an unanswered card) is blocked with "retry this exact call", and a later owner Allow becomes a one-time grant (`ReviewHold` in `auto-review-gate.ts`). Re-measure the cap on upgrade (STATUS 2026-11-07 1.13f method). The compression notice (ROADMAP 1.11a, ADR 0010) depends on the `agent.log` lines `context compression started: session=… tokens=~N` and `context compression done: session=… rough_tokens=~M`; re-verify on upgrade. Expert `toolsets:` locks (ROADMAP 3.10, ADR 0009) depend on `hermes chat -t`: fixed at session creation, a resume must repeat the exact launch string or omit it (a different one exits 2), MCP servers are not scoped by it, and only whole built-in toolsets are accepted. Re-probe on upgrade (method: STATUS 2026-11-03, stub model in a throwaway home). The daemon's `config/status` RPC (called when Settings loads the model catalog) runs `<hermes> --version` and logs a warning on mismatch with the pin in `packages/maker-hermes-manager/src/hermes-version.ts`; an unreadable version warns and returns `matches: null`. Bump the pin there and here together. Most behaviours above were last probed on 0.22.5 and have not been re-probed on 0.22.7; the Auto-review hook (ROADMAP 1.13: `pre_tool_call`, the gateway's env) was probed and proven live on 0.22.7. **Installed on this machine is 0.23.0** (checked 2026-11-12 with `hermes-cindy --version`); the pin deliberately stays 0.22.7 until the behaviours above are re-probed on 0.23.0. On 0.23.0 `--safe-mode --provider <custom_providers name>` fails at once (`result` exit 1, text `Worker execution is unknown.`, 0 tokens; the managed worker logs `Unknown provider '<name>'`), because `--safe-mode` implies `--ignore-user-config` and the name only exists there. Cindy therefore never spells a custom endpoint that way under safe-mode: the daemon reads the home's `custom_providers:` block and rewrites the launch to the built-in form `--provider custom --base-url <entry base_url>` (`rewriteProviderForSafeMode` in `hermes-config.ts`, applied in `buildHermesArgs`, used by both `default`/ask and chat-only). Names it cannot map are left untouched so Hermes reports them. A hand-typed `--provider <name> --safe-mode` still fails; `--yolo` still reads the config. The stream-json event shapes did not move: the 0.7 parity fixture was re-captured on 0.23.0 and matches. The Auto-review hook itself (`pre_tool_call`, the daemon bundle + 0600 credentials file) was re-proven on 0.23.0 on 2026-11-12: real Hermes blocked a model-issued `rm -rf` and kept the reviewer wired across an app restart (STATUS (n)/(o)); re-probe again on the next upgrade. |
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
| `apps/desktop/src/main/maker-ipc/{skills.ts,skillsDesktop.ts}` | 4.4 skills manager host: list/scan/install/enable/disable/uninstall over `~/.hermes-cindy/skills` (+ `skills-disabled/`); 11.1 `resolvePinned` resolves composer pins to full `SKILL.md` bodies. Cindy-side shallow git clone is the only outbound call |
| `packages/maker-core/src/skills/progressive-skill-engine.ts`, `packages/maker-core/src/session/pinned-skill-invocation.ts` | 11.1 engine: bounded discovery catalog, `activateSkill` (32 KB cap, `realpath` containment), path-only `scripts/`+`references/` index, and pure `@skill:<slug>` / `/name` pin preamble. Subpaths `@cindy/maker-core/progressive-skills` and `@cindy/maker-core/pinned-skill-invocation` |
| `apps/desktop/src/main/mcp-integrations/cindySkillsMcpServer.ts` | 11.1 first-party `cindy_skills` MCP server (`activate_skill` / `list_skills`). Mounted on the Hermes-only bridge (`HERMES_BRIDGE_SKILLS_SERVERS`), never on Claude Code / Codex / Pi |
| `packages/maker-core/src/review/council-review.ts` | 11.4 council engine: selection validation, neutral brief, reviewer-output parsing, `dropUnknownFiles`, dedupe and consensus ranking. Closed `kind` vocabulary is what makes two models agree. Subpath `@cindy/maker-core/council-review` |
| `apps/desktop/src/main/git-review/{councilReview.ts,councilIpc.ts}` | 11.4 council host + IPC (`git-review:council-options` / `git-review:council-run`). Diff read through `readReviewData` inside `withSessionReviewExecution`; last-used reviewers kept as a managed block in `~/.cindy-harness/routing.yaml` |
| `packages/maker-core/src/providers/routed-auxiliary.ts` | `requestRouteTargetText` (11.4): one exact providers.yaml entry + model, bypassing routing.yaml, with the same key handling and redirect refusal as `requestRoutedTaskText`. `acceptReasoningContent` covers reasoning-only local models |
| `packages/maker-core/src/providers/vision-route.ts` + `packages/maker-hermes-manager/src/vision-route.ts` | 13.1/13.1b vision bridge (ADR 0013 Design A): `resolveVisionRoute` resolves the `vision` task class (fail-closed; the provider must declare `capabilities.vision: true`), and the keep-formatting `injectVisionRoute` writes `auxiliary.vision` into the session home at preparation so Hermes `vision_analyze` sees attached images for a text-only chat model (key travels env-only via `key_env`). Bypass: skipped when the chat model's own provider declares vision (`providerDeclaresVision`, fail-safe for unknown providers). Not routed + image + text-only chat -> the daemon emits `hermes-mgr/vision-notice`, surfaced as a durable one-liner; the send is never blocked. The 8.2 manifest shows `model-route:vision` when routed |
| `packages/maker-core/src/experts/imported-agents.ts` | 12.1 pure parser / fail-closed tool map / draft conversion for read-only foreign agent definitions. Subpath `@cindy/maker-core/imported-agents`. Roster id space: `expert:<slug>` + `imported:<source>:<relPath>`; `model:` is never auto-mapped |
| `apps/desktop/src/main/maker-ipc/importedAgents.ts` | 12.1 discovery over `~/.claude/agents`, `~/.qwen/agents` and the project equivalents (depth 1, realpath containment, 1,000-file cap) + IPC `maker:imported-agents:list/read/copy-to-expert`. Copy goes through the EXPERTS_SAVE create path; foreign directories are never written. The 3.2 binding store (`expertSessions.ts`) binds imported ids and persists the project dir with the binding |
| `packages/maker-core/src/experts/expert-form.ts` | 12.2 form ⇄ expert.md contract (`markdownToExpertForm` / `expertFormToMarkdown`, unknown keys + body preserved) and `expertSlugFromName`. Subpath `@cindy/maker-core/expert-form`. `expert-loader.ts` also owns `max_concurrent` (default 1), `STARTER_EXPERT_SLUGS` and the pure `checkExpertConcurrency`; `expert-draft.ts` `writeExpertFromForm` is the owner-authored create path (EXPERTS_SAVE `create-from-form`) |
| `apps/desktop/src/renderer/features/agents/` | 12.2 Agents page (route `#/agents`, always-on sidebar row): one roster over experts + imported agents, search/filter chips, detail drawer (Reveal / Edit→Settings / Copy), New-agent form incl. program + `max_concurrent` and "Generate with model" → expert-creator brief. The cap is enforced in `expertSessions.ts` at session start and Orca worker start against `getMakerIfReady().listActiveSessions()`; Squads (12.4b) and Runtimes (12.5) tabs built |
| `packages/maker-core/src/session/teammate-mention.ts` + `apps/desktop/src/main/maker-ipc/{sessionTeammates.ts,teammateMentionService.ts,teammateProposalService.ts}` + `apps/desktop/src/renderer/components/teammates/` | 12.3a/b @-mention teammates (ADR 0011): `@agent:<roster-id>` joins one Hermes Orca worker per roster entry at the shared send boundary (`sendToAgentAccepted` wrapper — coordinator drain + legacy maker:send). Registry `~/.cindy-harness/session-teammates.json`; IPC `maker:teammates:list/remove/set-may-propose/proposal-decide` + push `maker:teammates:changed`; 8.2 strip shows the `teammate` kind with Remove (last removal ends the team) + the "May bring in others" toggle + pending-proposal Confirm/Dismiss. Permission ceiling = lead mode (only Full-access leads can host; worker modes are binary). Join carries the 3.6 excerpt; reuse sends plain text; reply rides the unchanged 3.7 auto-bridge. The teammate dispatch waits for worker acceptance (first-join race fix); `teammateBindingId` normalizes `expert:<slug>` for the binding store. 12.3b: `TeammatePickerSlot` opens at the colon (program/source badges, disabled non-Hermes rows); opt-in "may bring in others" is propose-only — the worker's `propose_teammate` bridge tool records a proposal, the owner confirms, and the confirmed entry joins the SAME lead as a second worker (depth 1). Hermes workers only |
| `packages/maker-core/src/squads/squad.ts` + `apps/desktop/src/main/maker-ipc/squads.ts` + `apps/desktop/src/renderer/features/agents/SquadsTab.tsx` | 12.4b squads (ADR 0012): pure `@cindy/maker-core/squads` parser + fail-closed `buildSquadLaunchPlan` (unknown roster id / sub-Full-access ceiling refuses). Host discovers `~/.cindy-harness/squads/<slug>/squad.yaml` (atomic write), IPC `maker:squads:list/read/save/resolve-launch` + push `maker:squads:changed`; `resolve-launch` reuses the 12.3 roster check. The Squads tab Launch makes the lead the pending pick and prefills a new Hermes lead draft (`prefillSquadLaunchDraft`) with the member `@agent:` tokens + task; the owner sends and the unchanged 12.3 boundary joins the members. `TurnAttachmentSlot` leaves `agent` tokens unattached and `NewMakerDraftRoute` preserves `['skill','agent']` so the tokens reach the send boundary |
| `packages/maker-core/src/runtimes/runtime-status.ts` + `apps/desktop/src/main/maker-ipc/runtimes.ts` + `apps/desktop/src/renderer/features/agents/RuntimesTab.tsx` | 12.5 Runtimes tab (read-only): pure `@cindy/maker-core/runtime-status` model + `parseRuntimeVersion` (real --version shapes) + `buildRuntimeStatus` (ok/missing/error, matchesPin). `maker:runtimes:list` resolves each binary as its adapter does — Hermes via `resolveOnPath('hermes')` + `readInstalledHermesVersion`/`HERMES_CLI_PINNED_VERSION`, cc/codex/pi via the fs-verified `getCachedBinaryStatus` — then a 5 s --version probe, no network. Cards show path/version/pin match (Hermes)/health/agents-using-it/Recheck; nothing installed or updated |
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
- **The gate retries one kind of crash.** A vitest worker thread can die by `SIGSEGV` while V8
  tears its isolate down (macOS, threads pool, ~1 in 8–12 `apps/desktop unit` legs under load).
  `classifyFailure` reports it as `WORKER_CRASHED` (not an assertion failure), and
  `runTestLegWithWorkerCrashRetry` reruns that leg **once**, printing
  `RETRY … rerunning this leg once`; the summary keeps the truth as
  `PASS … [retried after a worker SIGSEGV]`. A second crash fails. Getting a real stack needs
  `sudo DevToolsSecurity -enable` first — `lldb` hangs while developer mode is off, and Node's
  `--report-on-signal` swallows the fault instead of reporting it.
- **A failed Hermes turn explains itself now.** When a launch dies before its first model call,
  Hermes 0.23.0 emits a `result` with `exit_code: 1` and no `error`; the cause is in
  `<session home>/logs/managed-worker.log`, not in the CLI's stderr. The daemon fills `error`
  from that log's tail (`run-failure.ts`, only a log written since the run started) so the chat
  banner shows the cause, and WARNs one JSON line `Hermes run failed {…}` with the argv
  (`--api-key` masked), exit code and stderr tail; the desktop client forwards the daemon's
  `[hermes-mgr][warn|error]` stderr lines into `apps/desktop/logs/main-*.log` (dev) or
  `<userData>/logs/` (packaged). Grep `Hermes run failed` there before grepping the Hermes home.
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
  Editing a file that belongs to an existing surface (e.g. `components/settings/*`) still changes
  that surface's hash: `test:runner` then fails on `CLI --check`; regenerate with
  `node scripts/design-inventory.mjs` and commit the ledger.
- **Formatter hook rewrites whole files.** A PostToolUse formatter in the agent tooling ran
  Prettier over `preload.ts` and `vite-env.d.ts` after small Edits (+600 lines of churn). Check
  `git diff --stat` before every commit; rebuild a ballooned file from `git show HEAD:<file>` plus
  only the new lines, by script.
- **Dev launcher strips env.** `scripts/restart-desktop-remote.mjs` forwards a fixed env list, so
  `HTTPS_PROXY`-style tricks (reviewer-down tests) only work on the packaged app
  (`/Applications/Cindy.app/Contents/MacOS/Cindy --remote-debugging-port=9223`).
- **BSD `env -i` and the repo path:** the `=` in the path is read as an assignment. Use
  `env -i … /bin/sh -c 'exec "$1" …' sh "<path>"`.

---

## 9. First 20 minutes for a new agent

For a paused handoff, the newest `STATUS.md` entry is the exact resume checklist and takes
precedence over this generic startup sequence where they differ. The current handover
(`docs/handoff/2026-11-12-phase11-session-handover.md`, §5 has the paste-ready prompt) carries the
exact stopping point and the up-to-date open-work order; read them before this generic sequence.

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
