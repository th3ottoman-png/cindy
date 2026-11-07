# Handover — 2026-11-07 EOD

Supersedes `2026-11-06-eod-handover.md` and every older file in `docs/handoff/`. Pair:
`2026-11-07-eod-next-agent-prompt.md`. `ROADMAP.md` wins on task status; `AGENTS.md` wins on
rules.

## 1. Where things stand

- `origin/main` HEAD is the commit that adds this file. Last code commit: `049affa027`
  ("Auto-save every conversation to the notes vault (5.5)"). Run `git log -5` and confirm
  `origin/main` matches before you start.
- Working tree clean apart from untracked tool folders `.kimi-code/`, `.serena/`, `.specify/`,
  `.workbuddy-ai/`. Never stage them.
- All four gates were green under Node 22.23.4 at `049affa027` (typecheck, test:runner,
  test:unit:related, check:test-hygiene), run from the agent shell this time without trouble.

## 2. What was done since the 2026-11-06 handover

**ROADMAP 1.13 — Hermes Auto-review permission mode. Closed by the owner, `live-proven`.**

| Row | Result | Commit |
|---|---|---|
| 1.13a | Probe: Hermes 0.22.7 `pre_tool_call` shell hook can gate a tool call. `live-proven` | `13b84b85bb` |
| 1.13b | Daemon side: `auto` → `--yolo --accept-hooks`, one fail-closed hook, unix-socket gate. `unit-tested` | `4ad61eba28` |
| 1.13c | Main side: Hermes tools → `ReviewableAction`, shared Auto-Review Core. `unit-tested` | `11285d18fa` |
| 1.13d | Dev app: allow, block shown in chat, ask card. `live-proven` | `840ba76584` + docs |
| 1.13e | Hook runs under Hermes's own Python, not PATH `node`; packaged build proof. `live-proven` | `47a1348321`, `943fdc35f4` |
| 1.13f | Hermes cuts a hook off at ~30 s; daemon answers within 24 s, an open ask blocks with "retry this exact call", a late Allow becomes a one-time 10-min grant (`ReviewHold`). `live-proven` | `9fe2e53fab` |

Also live-proven: a risky call issued by the model itself (deepseek-flash, `git checkout --theirs`)
was blocked with a reason. Not proven live, by the owner's choice: **Deny after a hold**
(unit-tested only) and a card answered after the turn ended.

**ROADMAP 5.5 — Auto-save every conversation to the vault. `live-proven`, `049affa027`.**

- Settings → Notes Vault → **Auto-save chats** (switch, folder field, "Last saved" / "Last save
  failed" line). Default off. **The owner turned it ON for daily use on 2026-11-07.**
- Config: `~/.cindy-harness/chat-autosave.json` `{ "enabled": true, "folder": "Cindy/Chats" }`.
  Its own file because `writeVaultConfig` rewrites `vault.json` whole.
- Output: `<vault>/Cindy/Chats/YYYY-MM-DD-<slug>-<8-char session id>.md`, one per conversation,
  rewritten atomically after each turn (1.5 s debounce). Frontmatter has `session_id` and
  `autosave: true`. Vault is `/Users/turko/Bishi-memory`.
- Code: `packages/maker-core/src/export/chat-autosave.ts` (pure, subpath
  `@cindy/maker-core/chat-autosave`), `apps/desktop/src/main/maker-ipc/chatAutosave.ts` (host +
  IPC), hook in `register.ts` `markTurnEndedAfterPersistDrain` (fires for every agent after the
  persist queue drains), `VaultSection.tsx` `ChatAutosaveCard`, one-time error toast in `App.tsx`.
- Live proof: two Hermes turns → one file with both; switch off → turn 3 answered, file untouched;
  Obsidian rendered it. The test note
  `Cindy/Chats/2026-11-07-autosave-test-5-5-reply-with-exactly-au-93d4c58d.md` is still in the
  owner's vault (harmless; the owner may delete it).
- Known gap: frontmatter `model` is the session row value (`hermes-default`), not the resolved
  model. Same as the 5.2 export.

**Housekeeping:** old build copies in `apps/desktop/out/` deleted at the owner's request.
`/Applications/Cindy.app` is the 1.13f packaged build.

## 3. Open work, in order

One task per session (AGENTS.md §4). Detail and evidence live in the `ROADMAP.md` rows.

1. **5.6 Auto-summary note per conversation.** Next open row; 5.5 (its dependency) is done.
   Routed `summary` model writes decisions / facts / open questions / next steps to
   `<vault>/Cindy/Memory/`, linking the 5.5 chat file. **Blocker to raise first:** the route is
   `summary: local-small` → LM Studio `qwen3-8b` in `~/.cindy-harness/routing.yaml`, and the
   owner's standing rule is "paid turns use deepseek-flash only; local LM Studio and Ollama stay
   off". Ask the owner one question before the live proof: start LM Studio for it, or route
   `summary` elsewhere. Never fall back to a paid model silently (2.4).
2. **0.5 Atomic `sessions.json`** is `unit-tested` only, but it writes to disk, so by rule 0 it
   needs a `live-proven` check (kill the daemon mid-write or truncate a copy and restart).
3. **3.7 Hermes as Orca lead**, remaining item: the new-task screen hides team mode for Hermes.
   (The row's "Hermes as a worker" note is stale: 3.9a covered it.)
4. **3.2 Experts**, remaining: per-session `skills/` (blocked: Hermes chat has no per-session
   skills flag; re-check on upgrade) and experts for Claude Code / Codex / Pi.
5. **4.1 Unified registry**: only the four adapters are on it; tools, experts, routes and panels
   are not.
6. Debt: `apps/desktop unit` vitest worker SIGSEGV (rerun the failed shard; never count a crashed
   run as green).

Parked (do not build unless asked): automatic model cascade, Windows/Linux, voice/mobile,
upstream PRs.

## 4. Machine state at handoff

- Dev app running from this checkout: Electron pid 75246, CDP `127.0.0.1:9222`, Vite `5174`.
  Started with `pnpm restart:desktop:local` (worked; prints the commit and pid, exit 0).
- Packaged app `/Applications/Cindy.app` (1.13f) not running. Its data:
  `~/Library/Application Support/CindyGlobal`.
- Latest backups: `~/.hermes-cindy/hermes-mgr/sessions.json.bak-2026-11-07-55`
  (before the 5.5 run), `sessions.json.bak-2026-11-07-113f3` (before 1.13f).
- Proof chats: dev `93d4c58d-c1ff-41e3-9b66-9077450ce3a8` (5.5), packaged
  `730c4166-8afb-4d31-a4c1-b97654628399` (1.13), dev `272e311a-aa2b-4b3c-9e0f-f05731dc7e9d`.

## 5. Traps learned this session (also in `HANDOVER.md` §8)

- **A PostToolUse formatter can rewrite whole files after an Edit.** It reformatted all of
  `preload.ts` (+600 lines) and `vite-env.d.ts`. Check `git diff --stat` before committing; if a
  file balloons, rebuild it from `git show HEAD:<file>` plus only your lines, by script.
- **Design-inventory ledger:** editing any file under a desktop surface (e.g.
  `components/settings/*`) changes that surface's hash, and `test:runner` fails on
  `CLI --check`. Fix: `node scripts/design-inventory.mjs`, commit `docs/design-rules/design-inventory.md`.
- **Dev launcher strips env:** `scripts/restart-desktop-remote.mjs` forwards a fixed env list, so
  proxy tricks (reviewer-down tests) only work on the packaged app.
- **BSD `env -i`** reads the repo path (contains `=`) as an assignment. Wrap:
  `env -i … /bin/sh -c 'exec "$1" …' sh "<path>"`.
- **Plain `ls` is aliased** to a tool where `-t` errors; use `/bin/ls`.
- **CDP driving:** pick the page whose URL starts with `http://localhost:5174/` and has no `?`
  before the `#`. `playwright-core` from the repo works with `chromium.connectOverCDP`. New task:
  hash `#/cc-agent/new`; Settings: `#/settings`.

## 6. Owner rules that are not in `AGENTS.md`

- Write for an ADHD reader: next action first, numbered steps, concrete time estimates, plain
  wins, end with one next action. No preamble.
- Paid model turns: deepseek-flash only. LM Studio and Ollama stay off unless the owner says so.
- DeepSeek key is in `~/.hermes-cindy/.env` as `DEEPSEEK_API_KEY`. Never copy it anywhere.
- The only allowed read under `~/.hermes` is the first lines of Hermes's entry script to find its
  Python (1.13e). Do not widen it.
- Tests: a real `setTimeout` needs a `// real-wait: <reason>` comment on the line above; prefer
  fake timers.
- Other Claude sessions edit this repo. Check for them, and stage files by explicit path.
- Commits: `git commit -s`, no attribution lines, no force-push. Don't use `pnpm -s`.
- End every session with a dated line appended to
  `/Users/turko/Bishi-memory/memory/Project — Cindy.md`.
