# Cindy — Phase 10 handover, 2026-11-10

For the agent picking up ROADMAP **Phase 10** (safety guard + composer ergonomics). Read `AGENTS.md` first, then
`HANDOVER.md`, then this file. This file supersedes `2026-11-10-latest-handover.md` **for Phase 10 work**; that one
still has the environment history and the earlier open items.

---

## 1. Where the repo is

| Thing | Value |
|---|---|
| Repo | `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy` (spaces and `=` — always quote) |
| Branch | `main`, clean, in sync with `origin/main` |
| HEAD at handover | `40c7d2cd4` + the docs commit that adds this file and the Phase 10 rows |
| Node / pnpm | **22.23.4** (`export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`), pnpm 10.33.2 |
| Hermes home | `~/.hermes-cindy` (via `hermes-cindy`); **`~/.hermes` is off-limits, always** |
| Dev app | sandbox `~/Library/Application Support/CindyGlobal-dev2-dev`, CDP `127.0.0.1:9222` |
| Daily model route | `deepseek-flash` on `deepseek` / `https://api.deepseek.com/v1`; fallback `mimo-v2.6-pro` (TokenHub) |

Gates, all green on this tree (Node 22): `pnpm typecheck` exit 0, `pnpm test:runner` 608 pass / 0 fail / 2 skipped,
`pnpm check:test-hygiene` PASS (361 files), `pnpm --filter @cindy/maker-hermes-manager test` 221/221.

---

## 2. What happened on 2026-11-10 (context for Phase 10)

Five commits changed behaviour; each has a `STATUS.md` entry with the evidence:

| Commit | What |
|---|---|
| `2ce69cc50e` | Dev launcher pins `HERMES_HOME=~/.hermes-cindy` for the Forge child (an agent shell exporting `~/.hermes` used to kill the whole Hermes integration inside the dev app). |
| `9b7563aaa6` | New daemon RPCs `config/getFallbackModel` / `config/setFallbackModel` (line-surgical `fallback_model:` writer). Needed because `config.yaml` must not be hand-edited. |
| `6b74aa552e` | Harness endpoint discovery resolves `keyEnv` with the Hermes home `.env` merged over `process.env` — that is what makes TokenHub models appear in the picker. |
| `aed7fa5c87` | Hermes model header shows the model id instead of "Model Details Unavailable". |
| `40c7d2cd4` | A new Hermes task starts on the home route, not on the composer's remembered model. |

**Semantics now in force — do not regress while working on 10.2/10.3:**

- A Hermes draft hydrates to the `hermes-default` sentinel with `providerId: null`
  (`newMakerDraft.sanitizeVendorPrefs`). An explicit pick applies to the task being drafted; it does **not** become the
  default for later tasks. Changing the default is a deliberate action (the picker's "Set … as the Hermes home
  default", or `config/setDefaultRoute`).
- A model id Hermes recognises from models.dev (e.g. `hy4`) resolves to Hermes's **built-in** provider and wants that
  provider's env var (`TENCENT_TOKENHUB_API_KEY`), ignoring the custom provider id in the route. Missing key = the turn
  silently rides `fallback_model`. Watch for `⚠️ Model fallback:` in the output.
- Provider keys live only in `~/.hermes-cindy/.env` (0600). Never in the repo, never in Cindy's config or DB.

---

## 3. Phase 10 rows (added to `ROADMAP.md`)

| # | Task | Status |
|---|---|---|
| 10.1 | Runtime prompt-injection & dangerous-command guard | 🔲 |
| 10.2 | Response style + thinking display | 🔲 |
| 10.3 | Chat-only mode (no tools, no MCP) | 🔲 |

Order matters: 10.1 first (it changes risk), then 10.2 + 10.3 as one small "composer ergonomics" pass. One task per
session per `AGENTS.md` §4.

### 10.1 — design brief

**Why it exists.** In Full access Cindy passes `--yolo` to Hermes, which deliberately bypasses Hermes's own
dangerous-command approvals (`ROADMAP 1.5b-5d`). `--safe-mode` and the permission modes are out of the picture there,
so today **nothing** inspects a tool call before it runs. Cindy has no injection detection at all (grep proves it: the
only "injection" code is Feishu group-context assembly).

**Where it hooks in** (all existing seams, in this order):

- `packages/maker-hermes-manager/src/hermes-run.ts` — builds argv and streams events; the turn's tool events pass
  through here. `tool-call-repair.ts` (ROADMAP 9.4) already sanitises arguments at this seam — its integration points
  are the model for where the scorer belongs.
- `packages/maker-hermes-manager/src/auto-review-gate.ts` — the existing `pre_tool_call` hook and its `ReviewHold`
  (1.13e/1.13f). A **hold** verdict should reuse this, not invent a second approval surface. Remember the measured
  cap: Hermes waits ~30 s for a hook callback and the daemon therefore answers within 24 s.
- Tool **output** re-entering context: the same event stream, after the tool result arrives. Score it before the
  renderer admits it to the transcript.

**Shape.** A pure scorer in a package subpath (house style), e.g.
`packages/maker-core/src/security/injection-guard.ts` → `@cindy/maker-core/injection-guard`: `scoreToolCall({tool,
input})` and `scoreToolResult({tool, output})` returning `{score, signals[], severity}`. Heuristic only, deterministic,
no network, no third-party model — a local model call would violate local-first and add latency to the hot path.
Signals worth starting with: shell metacharacter chains into interpreters, `curl|wget … | sh`, base64/hex blobs piped
into `sh`, writes to `~/.ssh`, `~/.hermes-cindy`, `~/.cindy-harness`, credential-shaped reads, `git push --force`,
`rm -rf` with a variable or `$HOME`, prompt text that impersonates system/tool messages ("ignore previous
instructions", "you are now", tool-call JSON embedded in a file's contents), and instructions arriving from a *tool
result* addressed at the model rather than at the user.

**Policy.** `block` / `hold` / `log`, threshold-configurable (default `0.8` on Goose's `0.01`…`1.0` scale). Persist in
the same place other preferences live (`~/.cindy-harness/…`, atomic write), surface in Settings, and always put the
reason in the transcript — a silent refusal is worse than no guard.

**Do not** add a network call, a hosted classifier, or a new approval dialog. False positives are the failure mode that
kills a guard: the acceptance criteria name ordinary destructive-but-intended commands that must pass.

### 10.2 — design brief

Preferences already have a home: `apps/desktop/src/renderer/lib/userPreferences.types.ts` plus the settings sections
under `components/settings/` (`CompactionSection.tsx` is the closest template — it renders a native setting and submits
it through IPC). Rendering lives in the cc-agent chat components (`features/cc-agent/`); tool bubbles are already
collapsed/expanded per tool there, so **response style** is a default, not a new mechanism. Thinking display must not
change what is stored — the raw transcript is the audit trail (see `renderer/features/cc-agent/turn-timeline-adapter.ts`
for how the store models tool bubbles, and `makerChatStore` for what is persisted).

### 10.3 — design brief

The launch path: `permissionModeToFlags` in `hermes-run.ts` (Full access → `--yolo`, everything else → `--safe-mode`),
expert `toolsets:` locks (ROADMAP 3.10, ADR 0009 — `hermes chat -t` is fixed at session creation, a resume must repeat
the exact string), and the session manifest (ROADMAP 8.2, `manifest.json`). Chat-only should be a **third** dimension,
not another permission mode: it must survive resume, be visible in the header, and never silently widen an expert's
lock. `--safe-mode` also disables MCP but refuses to run without an explicit model — supply `-m`/`--provider` from the
session's route (the daemon already freezes the launch route in the registry).

---

## 4. How to work in this repo without hurting yourself

1. `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` → v22.
2. Never `pnpm dev:desktop` / `dev:desktop:remote`. Start the app with
   `pnpm restart:desktop:remote --region=global` and wait for `DESKTOP_DEV_VERDICT=ready`.
3. Rebuild the daemon bundle after touching `packages/maker-hermes-manager`: `pnpm --filter @cindy/maker-hermes-manager
   bundle` (the `build` script is only `tsc --noEmit`). Main-process and preload changes need a full restart; renderer
   changes hot-reload.
4. Never hand-edit `~/.hermes-cindy/config.yaml` — add/use a daemon RPC. Back up before mutating owner state.
5. Hermes CLI probes: `HERMES_HOME="$HOME/.hermes-cindy" hermes-cindy chat -q "…" --oneshot -m <model> --provider
   <provider> --format text`. Your own shell exports `HERMES_HOME=~/.hermes`; never let that reach a probe or an app.
6. Paying for a turn: the owner approves specific spend. Local models (LM Studio/Ollama) are currently **not running**,
   so `chat.default` and the `title`/`predict`/`summary` routes will fail closed until they are started or re-routed.
7. Dogfooding over CDP: `curl -s http://127.0.0.1:9222/json/list` to find the `#/cc-agent` page, then drive it with
   `Runtime.evaluate`. `Input.dispatchMouseEvent` (real pointer) is required for buttons inside drag regions — a JS
   `.click()` silently does nothing. The renderer exposes `window.electronAPI.maker.*` (IPC) for state you cannot reach
   through the DOM.

---

## 5. What was reviewed from Goose and deliberately not taken

Reviewed against `aaif-goose/goose` on 2026-11-10 (screens: Agent, Prompts, Keyboard, App, Chat). Cindy already has:
slash commands, max turns, context compaction + reserve tokens, rebindable shortcuts with reset, always-on-top,
prevent sleep, spellcheck, cost tracking, themes, permission modes with Auto-review, MCP catalog, plugin registry.

Not taken, and why:

| Goose surface | Why not |
|---|---|
| ACP external backend | Cindy runs one local daemon per turn; a remote backend contradicts the isolation rules. |
| Auto-update, "anonymous usage data", update telemetry | Dropped by the project definition (no telemetry, no auto-update). |
| Jinja prompt-file editor (`system.md`, `compaction.md`, `permission_judge.md`, …) | `AGENTS.md` §3 forbids changing system-prompt text; experts are already user-editable Markdown files, which is the right extension point. |
| "Automatic thinking effort" via a third-party API (TypeSafe/Jev) | Sends request text to an external service — violates local-first. |
| `.goosehints` project file + Configure button | `AGENTS.md`/rules files already serve this; a second hints channel would fragment guidance. |
| Recipe retry / stop-hook block limit | The Auto-review gate covers the intent; a second knob would be maintenance for no benefit (`AGENTS.md` §2). |
| Tool-pair compaction with a cutoff | Zero presence in Cindy today, but it needs a flush point Hermes does not obviously expose. Not a row: probe Hermes first, and only then propose it. |

---

## 6. Definition of done for a Phase 10 row

Follow `AGENTS.md` §0: the label must match the claim. 10.1 and 10.3 are `live-proven` or they are not done (they
change what executes). 10.2 may be `unit-tested` + one live screenshot-level check. Every session ends with the
`ROADMAP.md` row updated, a `STATUS.md` entry, `HANDOVER.md` only if something stable changed, and a DCO commit pushed
to `origin main`.
