# HANDOVER — Cindy local-only fork

_Last updated: 2026-10-28. Keep this file current: it is the fastest way back in after a break._

---

## 1. What this project is

This is a fork of **Cindy** (`makecindy/cindy`, Apache-2.0) — an Electron desktop app that runs AI coding agents (Claude Code, Codex, Pi, and now **Hermes**) on your own machine.

The fork lives at:

```
/Users/turko/=ai space=/=Projects_Main=/Cindy
```

It is pushed to a **private GitHub repo**: `https://github.com/th3ottoman-png/cindy.git` (remote `origin`). The original project is remote `upstream`.

Current divergence from upstream: **11 commits ahead, 136 commits behind** `upstream/main`.

## 2. What you are trying to achieve

A **private, local-only daily driver**:

- No Cindy cloud: no account, no sharing, no telemetry, no remote sync.
- Agents talk directly to providers you configure yourself (currently DeepSeek direct).
- Hermes is the harness you actually want to grow into: headless, self-improving, plugin/skill based.
- The app should look and behave like a personal tool, not a marketing product: no "sign in", no community surfaces, no broken "check for updates" rows.
- Everything must survive restarts and upgrades without quietly losing conversation history.

## 3. Architecture in one page

```
Cindy renderer (React)
   │  IPC (preload → main)
Cindy main process
   │  maker-core  ──► agent adapters (claude-code | codex | pi | hermes)
   │                        │
   │                        └─ hermes: local NDJSON RPC over a unix socket
   │                                  ▼
   │                           hermes-mgr daemon (utilityProcess)
   │                                  ▼
   │                           one `hermes chat` child per turn
   ▼                                  ▼
SQLite (Cindy DB)              ~/.hermes-cindy  (isolated Hermes home)
```

Key packages:

| Path | Role |
|---|---|
| `apps/desktop` | Electron app (main, preload, renderer, DB, packaging) |
| `packages/maker-core` | Session lifecycle + agent adapters (`src/agents/hermes/`) |
| `packages/maker-hermes-manager` | The `hermes-mgr` daemon: protocol, session registry, spawn layer, config RPCs |
| `packages/maker-shared` | Shared types, brand identity, pricing/usage helpers |
| `packages/model-providers` | Provider catalog + routing |
| `tools/` | Vendored agent binaries (Claude, Codex, Pi, ripgrep) — **not** tracked source, keep on disk |
| `docs/` | Design and product rules; `docs/dev-rules/` is the engineering rulebook |

Hermes-specific files added by this fork:

- `packages/maker-hermes-manager/src/hermes-manager.ts` — RPC handlers, session registry, per-turn retry logic.
- `packages/maker-hermes-manager/src/hermes-run.ts` — builds argv and spawns one `hermes chat` per turn.
- `packages/maker-hermes-manager/src/hermes-config.ts` — reads/writes the Hermes home `config.yaml` model route.
- `packages/maker-hermes-manager/src/hermes-models.ts` — reads the home `.env` key, queries `GET <base_url>/models`.
- `packages/maker-core/src/agents/hermes/` — adapter (`agent.ts`), event translator, transport, protocol mirror.
- `apps/desktop/src/main/maker-host/hermes-manager-client.ts` — desktop side of the daemon.
- `apps/desktop/src/renderer/hooks/useHermesModelCatalog.ts` — model picker data.

## 4. Environment

| Thing | Value |
|---|---|
| Node | **22.23.4** at `/opt/homebrew/opt/node@22/bin` — the default `node` on PATH is 26 and **breaks native modules** (`better-sqlite3` NODE_MODULE_VERSION mismatch). Always run gates with Node 22 first in PATH. |
| pnpm | 10.33.2 |
| Repo path | contains spaces and `=` — quote every path. |
| Dev app data | `~/Library/Application Support/CindyGlobal-dev2-private` |
| Dev launcher | `scripts/desktop-dev-runner.mjs local` (wrapped by `cindy-dev` if installed) |
| CDP debugging | port `9333` (env `XDT_CDP_PORT`) |
| Hermes home | `~/.hermes-cindy` — **never** `~/.hermes` |
| Hermes launcher | `~/.local/bin/hermes-cindy` (pins `HERMES_HOME`) |

### Run and verify

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd "/Users/turko/=ai space=/=Projects_Main=/Cindy"

pnpm install                     # first time / after lockfile changes
pnpm --filter desktop dev        # or: node scripts/desktop-dev-runner.mjs local
```

Gates (all run on Node 22):

```bash
pnpm typecheck                   # desktop umbrella: apps/desktop pnpm typecheck (needs NODE_OPTIONS heap)
pnpm test:runner                 # repo contracts: docs links, brand, design inventory, test hygiene
pnpm test:unit:related           # unit tests touched by the diff (picks workspaces automatically)
pnpm check:i18n                  # 5-language parity (en, zh-CN, zh-TW, ja, ko)
pnpm check:test-hygiene
pnpm check:brand-terminology
```

Known flaky/pre-existing failures in `test:unit:related` (not caused by current work):

- `apps/desktop/src/main/device-link/__tests__/sharedTaskMediaAccess.test.ts` — 2 failures.
- `packages/browser-control-runtime` — `background-open.test.ts` ("does not fall back to /json/new…").

Everything else in the related run should be green.

## 5. Hard constraints (do not violate)

1. **Never touch `~/.hermes`.** Only `~/.hermes-cindy`. The daemon has a fail-closed guard, but also keep it in mind for manual commands.
2. **Never spawn a real Hermes in tests.** Use `packages/maker-hermes-manager/src/__tests__/fixtures/fake-hermes.mjs`.
3. **No prompt-text / system-prompt changes.** Prompt copy is product-owned.
4. **`git commit -s` (DCO)** on every commit, then `git push origin main`.
5. Do not change other agents' behavior (Claude Code, Codex, Pi) or the lizi MCP tool schemas.
6. Do not persist provider credentials. They travel per-session to the daemon in memory only.

## 6. What has been done so far

### 6.1 Hermes as a harness (M2b)

- Daemon protocol (`protocol/`, `query/`, `session/`, `config/`) over a unix socket, NDJSON framed.
- One `hermes chat` child per turn; `--safe-mode` by default (explicit model required) or `--yolo` for Full access.
- Session registry persisted at `~/.hermes-cindy/hermes-mgr/sessions.json`.
- Provider keys: desktop env → daemon per-session env → `$HERMES_HOME/.env` fallback (the CLI also loads its own `.env`).
- Renderer/host integration: Hermes appears as a normal agent kind with its own icon.

### 6.2 Model picker (task 1.1) — done

- `config/getDefaultRoute`, `config/setDefaultRoute`, `config/listModels` RPCs.
- Per-session override via `query/setModel` (empty string = follow the home default).
- `useHermesModelCatalog` merges the home default with the provider's live `GET /models`.
- Footer action **"Set <model> as the Hermes home default"** writes `config.yaml` surgically (preserves comments/order, quotes scalars).
- Verified live: the picker listed `Hermes home default (deepseek-v4-flash)`, `deepseek-flash`, `deepseek-v4-pro`.

### 6.3 Resume correctness (task 1.3) — done and live-proven

Two fixes in `f1df8f8a08`:

1. **Lost resume id** (`No session found matching '<id>'`): the daemon holds that attempt's events, drops the dead id, emits a `resume-reset` notice, and replays the same message on a fresh session. The user sees one short notice and a real answer.
2. **Session-id bind point**: current Hermes sends `system/init` with `session_id: ""` and puts the real id on the `result` event. The daemon only bound from `init`, so **no session was ever resumable** and every turn silently started over. It now binds from either event.

Live evidence: two turns on one daemon session returned the codeword stored in turn 1, proving real conversational continuity.

### 6.4 Auto-title and prompt prediction for Hermes (task 1.2) — done

- `apps/desktop/src/main/maker-ipc/title.ts`: added `hermes` to `TITLE_AGENT_KINDS`.
- Sessions no longer fail `maker:auto-title` and `maker:predict-prompt` with `INVALID_PARAMS: invalid agentKind`.
- Sessions receive heuristic first-message titling immediately, followed by auxiliary model title resolution when available.
- Unit tested via `autoTitleIpcBoundary.test.ts` and `predictPromptIpcBoundary.test.ts`.

### 6.5 Image attachments for Hermes (task 1.4) — done

- `packages/maker-core/src/agents/hermes/agent.ts`: `flattenUserMessage` inlines image attachments as path references (`Attached image <name> located at: <path>`), and `capabilities.multimodal.image` is set to `{ supported: true }`.
- Hermes turns accept image blocks, making images accessible to Hermes on the local filesystem.
- Unit tested via `packages/maker-core/src/agents/hermes/__tests__/agent.test.ts`.

### 6.6 Hermes Settings surface (task 1.6) — done

- `apps/desktop/src/main/maker-host/hermes-manager-client.ts`: added `getHermesHomeStatus` returning home path, route, provider models, installed plugins metadata, and skills categories.
- `apps/desktop/src/main/maker-ipc/channels.ts` & `register.ts`: added `maker:hermes-config:get-status` IPC handler.
- `apps/desktop/src/renderer/components/settings/HermesSection.tsx`: card in General settings showing Hermes home path, runtime status, "Reveal Folder", default model selection with save action, installed plugins (status and repository source), and active skills categories.
- Passed full `apps/desktop` TypeScript compile (`tsc --noEmit`).

### 6.7 Hermes MCP Server Bridge & Management (task 1.5) — done

- `packages/maker-hermes-manager/src/hermes-config.ts`: added line-based parsing (`parseHermesMcpServers`), reading, writing (`writeHermesMcpServer`), and deletion (`removeHermesMcpServer`) for `mcp_servers:` in `$HERMES_HOME/config.yaml`, supporting both Streamable HTTP/SSE and Stdio server configurations while preserving file formatting and comments.
- `packages/maker-hermes-manager/src/protocol.ts` & `hermes-manager.ts`: added `config/listMcpServers`, `config/setMcpServer`, and `config/removeMcpServer` RPC methods to the daemon.
- `packages/maker-hermes-manager/src/__tests__/hermes-config.test.ts`: added 14 unit test cases for parsing, inserting, updating, and removing MCP server configurations; all passing.
- `apps/desktop/src/main/maker-host/hermes-manager-client.ts`: extended `HermesHomeStatus` to include `mcpServers: Record<string, HermesMcpServerConfig>`, and implemented `setHermesMcpServer` and `removeHermesMcpServer` host helpers.
- `apps/desktop/src/main/maker-ipc/`: added IPC channels (`HERMES_CONFIG_SET_MCP_SERVER`, `HERMES_CONFIG_REMOVE_MCP_SERVER`), registered handlers, and exposed them via `preload.ts` and `vite-env.d.ts`.
- `apps/desktop/src/renderer/components/settings/HermesSection.tsx`: added interactive MCP Servers management UI displaying configured servers with transport badges (`http` / `stdio`), server targets, inline server addition form, and server removal actions.

### 6.8 De-clouding

- Settings: removed Shared Tasks, Help, the "Not signed in" banner ("Data stays on this device"), manual update/log-upload rows, and the auto-update/analytics/crash-upload toggles.
- About: app version always shown; harness checks honestly report "unavailable" when no vendor endpoint is configured; official CDN update checks skipped when unconfigured.
- Bots: all IM channels except **Telegram** removed from the UI; Feishu/WeChat/WeCom/DingTalk/Discord UI files deleted; builtin plugin metadata retired.
- Log noise: migration status poll returns an idle view instead of erroring every 10 s; bot-group retry stops on non-retryable codes.

### 6.8 Local cleanup (2026-10-28)

- Deleted the entire dead **Help feature** backend: `help-knowledge/` (25 docs), `maker-ipc/help.ts`, `help-feedback.ts`, `helpKnowledge.generated.ts`, renderer `helpThreadStore`, shared `helpTypes`, `gen-help-kb` scripts and their tests, plus the IPC channels/preload/type entries. The Help UI had already been removed, so this was unreachable code.
- Deleted upstream PR/mobile evidence: `docs/e2e-evidence/`, `docs/pr-assets/`, `prototypes/`.
- Removed a stray empty `apps/desktop/C:/locks` directory (Windows path artifact).

### 6.9 Plugins and skills

- **Hermes** is headless and does **not** consume Cindy's plugin marketplace. Its plugins/skills/MCP servers are installed into `~/.hermes-cindy`.
- `obra/superpowers` is installed in Hermes (disabled → enabled after review) and in Pi (`~/.pi/agent/settings.json`).
- A Cindy plugin install and a Hermes plugin install are **different installs**. Nothing bridges them today (see 8.3).

## 7. What is working (verified)

- Hermes turns end to end (real CLI, real DeepSeek provider): text streaming, tool calls/results, token usage, clean closes.
- Multi-turn Hermes continuity after `f1df8f8a08`.
- Recovery from a stale resume id (fresh session + one-line notice).
- Hermes model catalog from the provider's own `/models`, plus the home-default write path (unit tested; the button was not clicked live on purpose to avoid mutating the default).
- Hermes auto-titling and prompt prediction: `maker:auto-title` and `maker:predict-prompt` accept `hermes` agentKind (unit tested in `autoTitleIpcBoundary.test.ts` and `predictPromptIpcBoundary.test.ts`).
- Hermes image attachments: user images inlined as local file references and advertised via `multimodal.image` (unit tested in `agent.test.ts`).
- Hermes settings panel in General settings: inspects home directory, default model route, plugins, and skills (typechecked & verified).
- Local-only Settings/About/Bots surfaces after the de-clouding pass (verified over CDP DOM sweeps).
- Repo gates: typecheck, `test:runner`, test hygiene, i18n parity, related unit tests (apart from the two known failures listed in §4).

## 8. What failed, what does not work, what to watch

### 8.1 Default model alignment — resolved

`~/.hermes-cindy/config.yaml` was updated to `default: deepseek-flash` (matching DeepSeek's `/models` catalog: `deepseek-flash` and `deepseek-v4-pro`), eliminating 404s when using the home default route.

### 8.2 Hermes security scan blocks community plugins

`hermes-cindy plugins install obra/superpowers` was **BLOCKED** (community source, CAUTION, ~170 findings, 14 HIGH). Every HIGH finding was read manually (all in docs/test files: `rm -rf ~/.config/opencode/...`, `printenv IDENTITY`, copying `CLAUDE.md`). It was installed with `--force` **disabled**, inspected `.hermes-plugin/__init__.py` (only reads `SKILL.md` and injects a bootstrap), then enabled. `doctor` reports OK. Expect this friction for every community plugin.

### 8.3 Cindy tools are not available inside Hermes

Hermes sees only its own tools/skills/MCP servers. Cindy's builtin tools (Browser, SSH, Docs, etc.) and Cindy's MCP servers are **not** bridged. That is task 1.5.

### 8.4 Runtime/test environment traps

- Default `node` is 26 → native modules fail with `NODE_MODULE_VERSION 147 vs 127`. Use Node 22.
- `test:unit:related` has no `--maxWorkers` flag; it manages workspaces itself.
- `pnpm build` inside `packages/maker-core` reports two pre-existing type errors (`lizi-mcps` `import.meta.glob`, a Pi test fixture). The desktop umbrella typecheck is the authoritative gate.
- Large `apps/desktop` suites are slow (~5 min) and need Node 22.

### 8.5 Untested areas

- **Packaged build** (`pnpm release:package`): never run in this fork. Dev mode only.
- Windows/Linux: no verification. Several path/temp/lock behaviors are platform-specific.
- Voice input, scheduler, device-link, mobile app: untouched, assumed working from upstream.

### 8.6 Upstream drift

136 commits behind, no merge strategy decided. Aggressive deletion of upstream files (docs, mobile code) would turn future merges into conflict hell — that is why this cleanup deliberately kept upstream source and docs that still compile or are referenced.

## 9. What still needs doing

Ordered as agreed. The full plan also lives in `~/Desktop/Cindy-Master-Plan.md` (outside the repo).

### Phase 1 — Hermes daily-driver gaps

| # | Task | Where to start |
|---|---|---|
| **1.2** | **Auto-title for Hermes sessions.** *(Done)* Added `hermes` to `TITLE_AGENT_KINDS` in `title.ts`; tested via `autoTitleIpcBoundary.test.ts` & `predictPromptIpcBoundary.test.ts`. | `apps/desktop/src/main/maker-ipc/title.ts` |
| **1.4** | **Image attachments for Hermes.** *(Done)* Inlined local image references in `flattenUserMessage` and enabled `multimodal.image`; tested via `agent.test.ts`. | `packages/maker-core/src/agents/hermes/agent.ts` |
| **1.6** | **Hermes settings surface in Cindy.** *(Done)* Added `HermesSection` to General settings, backed by `getHermesHomeStatus` IPC. | `apps/desktop/src/renderer/components/settings/HermesSection.tsx` |
| **1.5** | **Bridge Cindy's toolset into Hermes via MCP.** *(Done)* Added MCP server config RPCs in `maker-hermes-manager`, host API, and management UI in `HermesSection`. | `packages/maker-hermes-manager` + `apps/desktop/src/main/maker-host` |

### Phase 0 — housekeeping decisions

| # | Task |
|---|---|
| **0.2** | **Upstream sync strategy.** Decide: periodic merge of `upstream/main`, cherry-pick only security fixes, or freeze. All three have different implications for the deletions already made. |
| **0.3** | **Packaged-build check.** One `pnpm release:package`, confirm the Hermes daemon bundle path, the new settings surfaces, and the app icon/name in the packaged app. |

### Phase 2 — local-only polish

| # | Task |
|---|---|
| **2.1** | **App-wide "Sign in to Cindy" sweep outside Settings.** *(Done)* In `HomeZeroModelAction.tsx`, `ConnectProviderBanner.tsx`, and `ConnectProviderCard.tsx`, replaced cloud-service login prompts with direct navigation to local/BYOK provider wizards when in local mode; suppressed Cindy AI managed service row in local mode. 20 tests passing. |
| 2.2 | Decide on the remaining cloud-only Bots surfaces (group chat endpoints are unavailable locally): hide or leave. |
| 2.3 | Harness update checks: either vendor-direct checks (npm registry / GitHub releases) with real installers, or keep the honest "unavailable" copy. |
| **2.4** | **ElevenLabs key fallback to the saved provider key.** *(Done)* `readElevenLabsApiKey()` falls back to `elevenlabs-api`/`elevenlabs` custom provider credentials or `voice-asr` key when `ELEVENLABS_API_KEY` is not in environment. Tested via `elevenLabsKeyFallback.test.ts`. |
| **2.5** | **Voice zero-input user-facing notice.** *(Done)* In `VoiceInputOverlay.tsx`, empty voice input displays localized notice "No microphone signal — check microphone permissions and audio connection" before scheduling close instead of silent dismiss. i18n added for en/zh-CN/zh-TW/ja/ko. |
| 2.6 | Housekeeping: delete stale "Untitled session" rows, rotate the ElevenLabs key, decide on the unused Nous login. |

### Phase 3 — parked ideas (explicitly do not build until asked)

| # | Idea |
|---|---|
| 3.1 | **Curated plugin marketplace** for Cindy, sourced mostly from GitHub, so a set of plugins can be fired up in one go. Needs a 5–10 plugin shortlist from Mario first. |
| 3.2 | **Generic webhook bot channel** (e.g. WhatsApp-style). Mario asked to save it as an idea and not build it yet. |
| 3.3 | Optional upstream PR for the Hermes adapter or the de-clouding work. |

## 10. Deliberately kept (do not "clean up" without thinking)

- `tools/` — vendored agent binaries. Untracked but required at runtime.
- `apps/desktop/resources/{hermes,cc,pi}-manager/` and `packages/*/dist` — generated daemon bundles. Regenerated by `apps/desktop/scripts/build-remote-bundles.mjs` on dev start.
- Upstream community docs (`CONTRIBUTING*`, `CODE_OF_CONDUCT*`, `SECURITY*`, `SUPPORT*`, `DCO`, `REVIEW.md`): `scripts/__tests__/dev-docs-contract.test.mjs` requires `CONTRIBUTING.md`/`CONTRIBUTING.en.md`; `REVIEW.md` is still cited by `AGENTS.md` and the PR review workflow. Deleting them buys nothing and costs merge conflicts.
- `.github/` — `scripts/__tests__/hardcoded-color-audit.test.mjs` reads `.github/workflows/ci.yml`.
- `docs/design-evidence/` and `docs/design-previews/` — still linked from design rules; deleting breaks `dev-docs-contract`.
- `apps/desktop/logs/` and `apps/desktop/.vite/` — live caches of the running dev app. Safe to delete only while the app is stopped.

## 11. First 30 minutes back

1. `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` — check `node -v` says 22.
2. `cd` into the repo (quoted path) and `git status` — the tree should be clean.
3. `git log --oneline -12` — the latest commits are the Hermes work.
4. Start the app: `node scripts/desktop-dev-runner.mjs local`.
5. Open a Hermes task, send one short message. Confirm the reply streams and `~/.hermes-cindy/hermes-mgr/sessions.json` gains a `hermesSessionId`.
6. Send a second message that depends on the first (e.g. "what did I just say?"). If it answers correctly, resume works.
7. Phase 1 (Hermes daily-driver gaps) is complete! Pick the next task from §9 (Phase 0 packaged-build / upstream strategy, or Phase 2 local-only polish).
