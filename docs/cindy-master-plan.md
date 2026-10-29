> **Historical.** Moved here from `~/Desktop/Cindy-Master-Plan.md` on 2026-10-29 (ROADMAP 0.10).
> Superseded by `ROADMAP.md` (task status), `HANDOVER.md` (stable reference), `STATUS.md` (log) and
> `AGENTS.md` (rules). Task numbers below are the *old* plan's numbering and do not match `ROADMAP.md`.
> Kept unedited below the rule for provenance; do not update it.

---

# Cindy Fork — Master Task List
_Last grounded: 2026-10-28 · repo `=Projects_Main=/Cindy` @ 7c5bd27 · 199 uncommitted files · ≥136 commits behind upstream_

## Phase 0 — Protect the work (do first)

| # | Task | Why | Size | Needs |
|---|------|-----|------|-------|
| 0.1 | Commit the working tree (~199 files) as DCO-signed (`git commit -s`) commits on a feature branch, grouped: M2b harness / settings de-clouding / voice+launcher fixes / docs | One `git clean` or reset loses everything; also the basis for any safe rebase | 30–45 min | Your go-ahead (git is state-changing) |
| 0.2 | Re-fetch upstream and decide sync strategy (fork is ≥136 commits behind; patch surface = settings lists, i18n keys, IM channel strip, providers page, UserInfoSection, About, voice-input) | Upstream drift grows every evening of work; decide rebase cadence vs fork-only | Decision now, first sync 1 evening | Your decision |
| 0.3 | Packaged-build check: one `pnpm release:package` pass, verify Hermes daemon path + new settings surfaces in the packaged app | Everything so far was tested in dev mode only | ~1 h | — |

## Phase 1 — Hermes daily-driver gaps (highest value)

| # | Task | Current state | Size |
|---|------|----------------|------|
| 1.1 | **In-app Hermes model picker** — per-session model override + "set as default" (writes home config) | Daemon `query/setModel` already works; missing: model list (Hermes naming vs provider naming) + renderer entries + tests | 1–2 evenings |
| 1.2 | **Auto-title for Hermes** — currently rejected (`invalid agentKind`), sessions stay "Untitled" or first-message title | Route titles through the auxiliary model chain for hermes sessions | ~½ evening |
| 1.3 | ✅ **Invalid-resume fallback** — done `f1df8f8a08`. Daemon holds a resuming attempt's events, drops the dead id, emits `resume-reset`, and replays the same input on a fresh session. Fixed on the way: current Hermes puts the session id only on `result` (init is empty), so the daemon also binds from `result` — without it nothing was ever resumable and every turn started over. Live-proven: two turns, second answered from resumed history. | Done | — |
| 1.4 | **Image attachments for Hermes** — text files inline today; images rejected | Options: write to temp dir + reference path (Hermes reads files), or model-native inline if supported | ~1 evening |
| 1.5 | **Bridge Cindy's toolset into Hermes (MCP)** — give Hermes Cindy's builtin/MCP tools (Browser, SSH, Docs, etc.), closing "plugins for Hermes vs Cindy" gap | Hermes supports `hermes mcp add`; needs design: static generated config vs per-session injection | 1–2 evenings |
| 1.6 | **Hermes settings surface in Cindy** — view/edit home default model/provider, maybe plugin/skill list status | Optional convenience; natural with 1.1 | ~1 evening |

## Phase 2 — Local-only polish (remaining cloud smells)

| # | Task | Detail | Size |
|---|------|--------|------|
| 2.1 | App-wide "Sign in to Cindy" sweep | Settings tabs are clean; check onboarding, home, dialogs, provider-share, bots, deep links | 1–2 h |
| 2.2 | Bots / group-chat surfaces | Log loops fixed, but cloud-only UI remains (chat endpoint unavailable); decide hide vs leave | 2–3 h |
| 2.3 | Harness update checks — real fix or accept "unavailable" | Vendor-direct checks (npm registry / GitHub releases) + installer integration; otherwise keep honest feature-off copy | 1–2 evenings |
| 2.4 | ElevenLabs key fallback | `readElevenLabsApiKey()` falls back to Settings→Providers key, removing the ~/.zshrc dependency | ~1 h |
| 2.5 | Voice zero-input notice | "No microphone signal — check macOS microphone permission" instead of silent cancel | ~1 h |
| 2.6 | Housekeeping | Delete failed "Untitled session" rows; rotate ElevenLabs key; Nous login unused (remove or keep as fallback) | 15 min |

## Phase 3 — Optional projects (your call, parked)

| # | Task | Prerequisite | Size |
|---|------|--------------|------|
| 3.1 | Curated plugin marketplace repo (`.agents/plugins/marketplace.json` + vendored ghosts) | Your list of 5–10 desired plugins, mapped to ghost / MCP / skill | scaffold ~1 h; ports variable |
| 3.2 | Generic webhook bot channel (inbound HTTP → agent lanes, outbound POST) | Parked idea, saved in memory | 1–2 evenings |
| 3.3 | Upstream PR of the reusable parts (Launcher guard, neutral fixes) | Only if you want them public | 1 evening |

## Verification / acceptance per phase
- Every code task: `pnpm check:test-hygiene`, `pnpm test:unit:related` (use `--maxWorkers=4` if the vitest segfault flake reappears), `apps/desktop` typecheck, `pnpm design:inventory` if settings UI changed, `check:i18n` if strings changed.
- Live check via CDP (port 9333, DOM text sweep beats screenshots).

## Deliberately excluded (standing constraints)
- No prompt-text / system-prompt edits.
- No changes to other agents' behavior; no lizi MCP schema changes.
- `~/.hermes` (daily home) untouched — only `~/.hermes-cindy`.
- No state-changing git commands without your explicit go.
