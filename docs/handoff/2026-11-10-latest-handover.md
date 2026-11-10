# Cindy — Handover, 2026-11-10 (latest). Read this before doing anything.

Supersedes `2026-11-10-master-handover.md`, `2026-11-10-full-roadmap-completion-handover.md` and every older
file in `docs/handoff/`. Written by the agent that took over after the roadmap-completion handover; it covers
dogfooding, three commits, the Tencent TokenHub wiring, and every trap hit on the way.

Read order (mandatory): `AGENTS.md` → `HANDOVER.md` → this file → `ROADMAP.md` → `STATUS.md` (top entry).
`AGENTS.md` overrides everything, including this document. Where this document and `AGENTS.md` disagree, `AGENTS.md`
wins — and this file should be corrected.

---

## 1. State at handover

| Thing | Value |
|---|---|
| Repo | `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy` (spaces and `=` — **always quote**) |
| Branch | `main`, clean, **in sync with `origin/main`** |
| HEAD | `9b7563aaa6` — `feat(hermes): read and write the fallback_model route through the daemon` |
| Previous | `2ce69cc50e` — `fix(dev): pin Cindy's Hermes home for the desktop dev app` |
| Before that | `9284f1274f` (takeover housekeeping), `aa53b57e75`, `fc4e4f5596` (gate repairs), `a6f317e646` (roadmap completion) |
| Untracked (intentional) | `.kimi-code/`, `.serena/`, `.specify/`, `.workbuddy-ai/` — never stage |
| Node / pnpm | **22.23.4** at `/opt/homebrew/opt/node@22/bin`, pnpm 10.33.2 |
| Dev app | running, isolated sandbox `~/Library/Application Support/CindyGlobal-dev2-dev`, CDP on `127.0.0.1:9222` |
| Hermes home | `~/.hermes-cindy` (via `hermes-cindy`); `~/.hermes` stays untouched |

Gates on `9b7563aaa6`, Node 22:

```
pnpm typecheck            exit 0 (all 37 projects)
pnpm test:runner          610 tests — 608 pass, 0 fail, 2 skipped, exit 0
pnpm check:test-hygiene   PASS (361 files within baseline)
pnpm --filter @cindy/maker-hermes-manager test   221/221 (includes 5 new fallback-model tests)
```

Roadmap status is unchanged: Phases 0–9 stay as recorded in `ROADMAP.md`. Nothing in this session changed a
roadmap row; it fixed infrastructure and added one capability (fallback-model RPC).

---

## 2. What this session did

### 2.1 Dogfooded the dev app and found Hermes was dead inside it (`2ce69cc50e`)

The dev app launched by the previous agent was up, but every 60 s its log repeated:

```
hermes-mgr configuration invalid
  error : refusing to use the daily Hermes home (or any path inside it) as Cindy's HERMES_HOME (/Users/turko/.hermes)
```

**Root cause.** `resolveHermesHome()` (`apps/desktop/src/main/maker-host/hermes-manager-client.ts`) only reads
`process.env.HERMES_HOME`. The dev app inherits whatever the launching shell exports. Any agent harness (or a
developer shell) that exports `HERMES_HOME=~/.hermes` poisons the app *at exec time*, and the app has no way back:
the daemon never forks, `maker:hermes-config:*` fails, expert sessions cannot start, and the schedules engine
records `Failed to create session: hermes daemon not provisioned: AgentDeps.resolveHermesManagerSocketPath returned
no socket path`.

**What did NOT work** (do not repeat these):
- `env -u HERMES_HOME pnpm restart:desktop:remote …` — the value came back as `~/.hermes` in the app.
- `HERMES_HOME=~/.hermes-cindy pnpm restart:desktop:remote …` — same; also came back as `~/.hermes`.
Both die in the `osascript → do script → script(1) → pnpm → forge` launch path: the app is started from a fresh
Terminal tab, not from your process environment.

**Fix shipped.** New `scripts/shared/desktop-dev-hermes-home.mjs` (`resolveDesktopDevHermesHome`) and
`scripts/desktop-dev-runner.mjs` now pass an explicit `HERMES_HOME` to the Forge child: `~/.hermes-cindy` by
default, an explicit override only when it points outside the daily home, never `~/.hermes` or anything under it
(case-folded on darwin/win32). 5 tests in `scripts/__tests__/desktop-dev-hermes-home.test.mjs`.

**Proof.** `pnpm restart:desktop:remote --region=global` → `DESKTOP_DEV_VERDICT=ready`; Electron main carries
`HERMES_HOME=/Users/turko/.hermes-cindy`; log shows `hermes-mgr forked` → `hermes-mgr ready`; zero
`configuration invalid` lines (was one per 60 s).

### 2.2 Live-checked the three new right-sidebar panels

In the running app over CDP 9222 (see §6 for the recipe):

- **Chat Inventory** (`In This Chat`): context/token utilization 0 %, capacity 200k, tools 0, files 0, no attached
  skills/connectors.
- **Operations Rail**: 1 schedule `daily-review`, buttons `Run Now` / `Dry-Run` / `Open`. Its recorded last run is
  the stale 17:44 pre-fix daemon error, not a new failure.
- **Git Sync**: `Git Workspace ↔ Vault Sync`, target note `memory/Project — Cindy.md` `EXACT MATCH`, branch `main`,
  working tree read live, 5 recent commits.

### 2.3 Proved the Hermes hot path with real (paid) turns

One session, two turns on `deepseek-flash` (owner-approved): "Reply with exactly: OK" → `OK`; then "What did I just
ask you to reply with?" → *"You asked me to reply with exactly "OK""*. Resume works, tokens persisted across both
turns, total cost **$0.0112**. `~/.hermes-cindy/hermes-mgr/sessions.json` gained a `hermesSessionId`.

### 2.4 Tencent TokenHub provider, `hy4` main, `mimo-v2.6-pro` fallback (`9b7563aaa6`)

Owner-supplied details: base URL (Singapore) `https://tokenhub-intl.tencentcloudmaas.com/v1`, Bearer auth for
OpenAI paths (`x-api-key` on the Anthropic `/messages` path), paths `/chat/completions`, `/responses`, `/messages`,
discovery `GET /v1/models`, key env `TOKENHUB_API_KEY`.

Configured:

- `~/.cindy-harness/providers.yaml` — new entry `tokenhub` (`kind: openai-compatible`, intl base URL,
  `keyEnv: TOKENHUB_API_KEY`, tools on).
- `~/.hermes-cindy/config.yaml` — main route written **through the daemon RPC**
  (`config/setDefaultRoute`), so comments/format survive:
  ```yaml
  model:
    default: hy4
    provider: tokenhub
    base_url: https://tokenhub-intl.tencentcloudmaas.com/v1
  ```
  Backup of the pre-change file: `~/.hermes-cindy/config.yaml.bak-2026-11-10-tokenhub`.
- Fallback had **no RPC**, and `AGENTS.md` §3 forbids hand-editing `config.yaml`, so a sanctioned path was added:
  - `readHermesFallbackModel` / `writeHermesFallbackModel` in `packages/maker-hermes-manager/src/hermes-config.ts`
    (line-surgical, comments and unrelated bytes preserved, temp+rename atomic).
  - Protocol methods `config/getFallbackModel`, `config/setFallbackModel`; manager handlers; IPC channels
    `maker:hermes-config:{get,set}-fallback-model`; preload `hermesConfig.getFallbackModel/setFallbackModel`
    (`clear: true` deletes the block).
  - Written live through that RPC:
    ```yaml
    fallback_model:
      provider: tokenhub
      model: mimo-v2.6-pro
      base_url: https://tokenhub-intl.tencentcloudmaas.com/v1
      key_env: TOKENHUB_API_KEY
    ```
- Keys live **only** in `~/.hermes-cindy/.env` (0600): `DEEPSEEK_API_KEY`, `OPENAI_BASE_URL`,
  `TOKENHUB_API_KEY`, `TENCENT_TOKENHUB_API_KEY`. Nothing in the repo, nothing in Cindy's own config, nothing in a
  commit.

Verified live:

- `GET /v1/models` → **101** models (includes `hy4`, `hy4-preview`, `hy3`, `mimo-v2.6-pro`, `kimi-k3`,
  `kimi-k3.1-pro`, `glm-5.3`, `deepseek-v4.1-flash`, `minimax-m3`).
- `POST /chat/completions` `hy4` → 200 in 1.9 s (returns `reasoning_content`); `mimo-v2.6-pro` → 200 in 1.7 s.
- `config/listModels` **through Cindy's daemon** after the route change returned the same 101-model catalog — the
  provider entry and the key resolve end to end.
- `hermes-cindy chat -q … --oneshot -m hy4 --provider tokenhub` in `~/.hermes-cindy` answered with **no** fallback
  notice.

**Hermes 0.22.7 gotcha — read this before touching models.** `hy4` is a models.dev model, so Hermes resolves it to
its **built-in** `tencent-tokenhub` provider (models.dev `env: [TENCENT_TOKENHUB_API_KEY]`) and ignores the custom
provider id in the route. Without `TENCENT_TOKENHUB_API_KEY` the turn still "succeeds", but on the fallback:

```
⚠️ Model fallback: hy4 via tencent-tokenhub unavailable (authentication failed); using mimo-v2.6-pro via tokenhub
```

Probed in throwaway homes: adding `key_env:` under the `model:` block does **not** change provider resolution.
Both env names are now present, so `hy4` is primary. If you ever see that warning, the env var is missing — not the
network and not the key.

### 2.5 Tencent TokenHub visibility in the UI (`6b74aa552e`)

The owner could not find Tencent anywhere in Settings. Two reasons, one a real bug:
Settings → **Providers** only lists `claude-code` / `codex` / `pi` accounts and *rejects* a Hermes runtime
(`invalid runtime 'hermes'`), so a Hermes endpoint can never appear there — it lives in Settings → **General →
Hermes Harness** ("Provider Registry" card) and in the model picker. And `maker:providers:discover` resolved
`keyEnv` against the desktop main's `process.env`, which never loads `~/.hermes-cindy/.env`, so the endpoint probed
HTTP 401, showed no models and filled no picker rows. `registerProvidersHandlers` now takes a `discoveryEnv` hook and
`register.ts` merges the Hermes home `.env` over `process.env`, re-read per probe. After a restart: registry =
`[lmstudio-local, ollama-local, tokenhub]`, `tokenhub` online with **101 models**, picker shows ~100 `(tokenhub)` rows.
The daily route was restored to `deepseek-flash` / `deepseek` / `api.deepseek.com` at the owner's request.

### 2.6 Housekeeping inherited from the previous agent

Residue in `~/.hermes/cache/scratch/` was already removed, branch `cindy/7.4-local-duplicate` was already deleted,
and the 14 gate-repair files were already committed (`fc4e4f5596`) before this session started. `~/.hermes` was
never read or written by this session; the only time it appears is the guard's own error message.

---

## 3. Environment rules that will bite you

1. **Node 22 only.** `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` must say v22. System default 26
   breaks `better-sqlite3`.
2. **`HERMES_HOME` is a trap.** Your shell (an agent harness) exports `HERMES_HOME=~/.hermes`. Anything you spawn
   inherits it. The dev launcher is now immune (2.1), but **CLI probes are not** — always
   `HERMES_HOME="$HOME/.hermes-cindy" hermes-cindy …`, and never point anything at `~/.hermes`.
3. **Never read/write/list/reference `~/.hermes`** — not even to grab a key. `hermes-cindy` is the only entry point.
   If a credential is needed, ask the owner to place it in `~/.hermes-cindy/.env`.
4. **Never hand-edit `~/.hermes-cindy/config.yaml`.** Use the daemon RPCs. If one is missing, add it (2.4 is the
   pattern: writer in `hermes-config.ts`, protocol method, manager handler, IPC channel, preload, tests).
5. **Never persist provider keys** in the repo or in Cindy's config/DB. `providers.yaml` names env vars only.
6. Stage files by explicit path; `git commit -s`; push to `origin main`; never force-push.

---

## 4. Open items, in priority order

1. **New Cindy sessions ignore the home route.** `config/getDefaultRoute` returns `hy4`, but a session created in
   the UI still launched on `deepseek-flash` (observed at 21:59, after the route change). The composer's
   last-selected model wins over `config.yaml`. Decide one: seed a new session's model from `getDefaultRoute`, or
   make the picker's default follow the route. Until then the Cindy UI is **not** on TokenHub even though the CLI
   is. Evidence: `sessions.json` row for session `f4b29286-478a-4202-a4ff-a6b6729ac9d2` (`model: deepseek-flash`).
2. ~~**`Model Details Unavailable`** in the session header.~~ **Fixed 2026-11-10 (`aed7fa5c87`, `live-proven`).** The
   picker lists a Hermes route's model as the `hermes-default` sentinel and skips a row carrying that id, so a session
   on the home route matched no descriptor. `hermesModelDisplayFallback` now shows the raw id (the header reads
   `Hermes · deepseek-flash`).
3. **Schedules have not run successfully since the fix.** `~/.cindy-harness/schedules-state.json` still holds the
   17:44 error. Exercise `Run Now` on `daily-review` once and confirm a session is created; that closes the loop on
   the daemon-provisioning error. Note the schedule writes into the owner's real vault.
4. **Auxiliary routes point at a dead endpoint.** `~/.cindy-harness/routing.yaml` maps `title`, `predict` and
   `summary` to `local-small` (LM Studio at `127.0.0.1:1234`) and `chat.default` to `ollama-offline`; neither
   server was running. Auto-title/prediction/summary will fail closed (by design) while that is true. Either start
   LM Studio/Ollama or re-route those task classes (they cost money if routed to TokenHub — a paid call per turn).
5. **`hermes` warns `install out of sync (ffmpeg: not installed or outdated)`** on every invocation. Harmless for
   text turns, but it will break any voice/media path. `hermes pm install` is the fix; not run (outward-facing
   install, needs the owner's nod).
6. **Rotate the TokenHub key.** It was pasted into chat to unblock model discovery, so treat it as exposed.
7. **Stale doc pointers** (fixed in the same commit as this file): `HANDOVER.md` §2 still named the
   roadmap-completion handover as current, and `ROADMAP.md`'s header still said "2026-11-08 EOD".
8. **`pnpm release:package` (ROADMAP 0.2) has not been re-run** since the launcher and RPC changes. It was
   `live-proven` for an older commit; a packaging pass would re-prove it (`docs/dev-rules/` has the rules).

---

## 5. Useful commands

```bash
cd "/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

pnpm typecheck && pnpm test:runner && pnpm check:test-hygiene   # gates (AGENTS.md §2)
pnpm restart:desktop:remote --region=global                     # THE dev app start; wait for DESKTOP_DEV_VERDICT=ready
pnpm --filter @cindy/maker-hermes-manager bundle                # rebuild the daemon bundle (dist/hermes-mgr.mjs)
pnpm --filter @cindy/maker-hermes-manager test                  # daemon + config writer tests

# Hermes probes (always with Cindy's home)
HERMES_HOME="$HOME/.hermes-cindy" hermes-cindy chat -q "Reply with exactly: OK" --oneshot -m hy4 \
  --provider tokenhub --format text
```

Never use `pnpm dev:desktop` / `pnpm dev:desktop:remote` — the wrapper exists for env setup and the ready verdict.

---

## 6. Driving the running app over CDP (dogfooding recipe)

The dev app exposes Chrome DevTools Protocol on `127.0.0.1:9222`; the renderer is at
`http://localhost:5174/#/cc-agent/...`. `ws` is available in the repo's `node_modules`.

1. List targets: `curl -s http://127.0.0.1:9222/json/list` — pick the `page` whose URL has `#/cc-agent`.
2. Connect the websocket, send `Runtime.evaluate` with `awaitPromise: true, returnByValue: true`.
3. Reading state is reliable: `document.body.innerText`, `[role="tab"]`, `[aria-label]` all work.
4. **Clicking is not uniform:**
   - The right-sidebar `Add tab` button needs a **real pointer** (`Input.dispatchMouseEvent` mouseMoved →
     mousePressed → mouseReleased at its `getBoundingClientRect()` centre) plus
     `Emulation.setFocusEmulationEnabled {enabled: true}`. A JS `.click()` does nothing.
   - Panel rows inside the opened menu respond to a plain JS `.click()` on the ancestor `[role="menuitem"]`.
   - Typing into the composer: click its `[contenteditable="true"]`, then `Input.insertText`, then click the
     `Send message` button by coordinates. The composer sits around y≈400 on the new-session screen and y≈755 in a
     populated session — do not hardcode one.
5. Direct unix-socket RPC to the daemon (`…/CindyGlobal-dev2-dev/hermes-mgr/hermes-mgr.sock`) needs a
   `protocol/hello` first and timed out when attempted by hand; **use the renderer instead** —
   `window.electronAPI.maker.hermesConfig.*`, `window.electronAPI.maker.routing.*` are available in the page and go
   through the same IPC the UI uses.

---

## 7. Files touched by this session

```
scripts/shared/desktop-dev-hermes-home.mjs                     (new)  HERMES_HOME resolver for the dev launcher
scripts/__tests__/desktop-dev-hermes-home.test.mjs              (new)  5 tests
scripts/desktop-dev-runner.mjs                                  pin HERMES_HOME on the Forge child
packages/maker-hermes-manager/src/hermes-config.ts              read/write fallback_model (line-surgical)
packages/maker-hermes-manager/src/hermes-manager.ts             config/getFallbackModel, config/setFallbackModel
packages/maker-hermes-manager/src/protocol.ts                  two new methods
packages/maker-hermes-manager/src/__tests__/hermes-config.test.ts  5 new tests
apps/desktop/src/main/maker-ipc/channels.ts                     two new channels
apps/desktop/src/main/maker-ipc/register.ts                     IPC handlers
apps/desktop/src/preload/preload.ts                             hermesConfig.get/setFallbackModel
STATUS.md                                                       two dated session entries (this is the audit trail)
```

Outside the repo (state, not code): `~/.cindy-harness/providers.yaml`,
`~/.hermes-cindy/config.yaml` (+ `.bak-2026-11-10-tokenhub`), `~/.hermes-cindy/.env`.

---

## 8. First 30 minutes for the next agent

1. `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` → v22.
2. `git -C "<repo>" status -sb` and `git log --oneline -5` — confirm `main` clean at `9b7563aaa6` or later.
3. Read `STATUS.md` top two entries; they are the honest record of this session.
4. Check whether the dev app is running (`lsof -nP -iTCP:9222 -sTCP:LISTEN`). If the app is up, confirm the log has
   no `hermes-mgr configuration invalid` in the last 5 minutes. If it is not up, start it with the wrapper and wait
   for `DESKTOP_DEV_VERDICT=ready`.
5. Probe Hermes cheaply before promising anything: `HERMES_HOME="$HOME/.hermes-cindy" hermes-cindy chat -q "Reply
   with exactly: PING" --oneshot -m hy4 --provider tokenhub --format text`. A `Model fallback:` line means
   `TENCENT_TOKENHUB_API_KEY` is missing.
6. Then take **one** open item from §4 — item 1 is the one the owner will notice first.
