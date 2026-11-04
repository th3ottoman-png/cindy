# Handover: 2026-11-04, end of day (supersedes all earlier handovers)

This is the current handover. It supersedes `2026-11-04-handover.md` (written the same morning),
`2026-11-03-handover.md` and every earlier compact note in this folder. Those files are kept for
history; their **open work lists and stopping points are stale**. If this file and `ROADMAP.md`
disagree, `ROADMAP.md` wins for task status and this file must be corrected.

Continue from the exact stopping point. Do not start over. Do not ask what happened so far.

Read in this order before touching anything:

1. `AGENTS.md`: the hard rules. They override everything, including this file.
2. This file.
3. `ROADMAP.md`: current phase tables and the Debt section.
4. The top entries of `STATUS.md` (newest first): handoff, 5.3b, 4.5 re-verify, 2.4b-fix.
5. `HANDOVER.md`: what the project is, how to build and run it, pinned versions.
6. `docs/dev-rules/desktop-development.md`: the canonical dev app startup and CDP rules.
7. `docs/decisions/` when a row references an ADR. Do not re-litigate recorded decisions.

The matching copy-paste prompt for a fresh agent is `2026-11-04-eod-next-agent-prompt.md`.

## 1. What this project is (one paragraph)

Cindy is the owner's private, single-user fork of an Electron desktop agent app, used as a daily
driver with **Hermes** (Nous Research's agent CLI, pinned to 0.22.5) as the main agent. Hermes runs
as one `hermes chat --format stream-json` child per turn, managed by the `hermes-mgr` daemon
(`packages/maker-hermes-manager`). The Hermes adapter lives in
`packages/maker-core/src/agents/hermes/`. The Hermes home is `~/.hermes-cindy`. **Never read,
write, list or name the owner's daily Hermes home** (AGENTS.md §1). `HANDOVER.md` has the
architecture, commands and versions.

## 2. Exact stopping point

`main` at the commit that adds this file (a docs-only handoff commit), pushed to `origin main`.
The **last code commit is `c483e79e3d`** (`feat(timeline): show and cancel long-running turns
(5.3b)`). Phrase it this way rather than naming a HEAD SHA, because the handoff commit itself
sits on top and any later correction commit would make an absolute SHA stale. Run `git log -3` for
exact SHAs. `git ls-remote origin refs/heads/main` must match local HEAD. The work tree is clean
except the untracked folders in §8, which must stay untracked.

Commits since the morning handover, in order:

| Commit | What |
|---|---|
| `06b1815d95` | 2.4b-live re-run as-is, plus the banner re-evaluation Debt row |
| `221e3d74cd` | 2.4b-fix: `SessionRouteBlockedBanner` re-evaluates on mid-session outages, `live-proven` |
| `b142cb4f42` | 4.5 example re-verify and four stale guide claims corrected |
| `c483e79e3d` | 5.3b long-running turn timeline and cancellation, `live-proven` |

Phase 4 (plugin and extension surface) is functionally complete:

| Row | State | Commit |
|---|---|---|
| 4.1 unified registry | 🧪 `unit-tested` | `3d50a8cd52` |
| 4.2 local plugin directory, live toggle | ✅ `live-proven` | `2c20a0a24f` |
| 4.3 MCP server catalog | ✅ `live-proven` **narrowed** (Hermes 0.22.5 ignores `disabled` on `mcp_servers`; "add to expert" open) | `ac8da38d86` |
| 4.4 skills manager | ✅ `live-proven` | `74dd93d594` |
| 4.5 extension author guide | 🧪 drafted and re-verified 2026-11-04; **done-test is the owner's call** | `b142cb4f42` |

Phase 5 (research workflow):

| Row | State |
|---|---|
| 5.1a vault notes, 5.2a session export, 5.4a scheduled sessions | 🧪 `unit-tested` pure modules, nothing consumes them yet |
| 5.3a turn timeline model | 🧪 `unit-tested` |
| 5.3b view and cancellation | ✅ `live-proven` (2026-11-04) |
| 5.1b, 5.2b, 5.4b | 🔲 app-facing halves open |

The no-silent-fallback safety rule (2.4b) is `live-proven` twice. The one-click "Use X instead"
alternative remains `unit-tested` only: both local providers were offline in every live run, so
there were zero healthy alternatives to click.

## 3. State of the machine at handover

- Dev app running: Electron **pid 77776**, started with the canonical wrapper
  `pnpm restart:desktop:remote --region=global`, verdict `DESKTOP_DEV_VERDICT=ready`. It owns
  `127.0.0.1:9222` (CDP). The Vite renderer is on **port 5174** this session, not 5173. Do not
  delete `apps/desktop/logs/` or `.vite/` while it is up.
- Open CDP pages: `#/cc-agent/ef62593b-…` (the main one), voice-input overlay, sidebar window,
  remote-desktop viewer, resource-usage window. **The first `page` target is not the main chat
  view.** Select by URL substring `#/cc-agent/`.
- The main chat is Hermes session `ef62593b-1c5f-49f1-ae32-dd25180d3b58` on
  `google/gemma-4-26b-a4b-qat (lmstudio-local)`. It currently shows the 5.3b panel in the
  frozen `cancelled` state at `126887 ms`. That is expected residue from the live proof, not a
  bug. It clears when the next turn starts.
- LM Studio `http://127.0.0.1:1234/v1/models` returns 200 with **11 models**. Ollama
  `11434` returns 502 (local proxy), effectively offline. No `vite-error-overlay`.
- `~/.hermes-cindy/config.yaml`: no edit today, no `config.yaml` RPC, no hand edit. The state
  described in the morning handover still holds (no global `model.ollama_num_ctx`;
  `custom_providers` entries for `lmstudio-local` :1234 and `ollama-local` :11434, both
  `context_length: 65536`, Gemma deliberately capped there; `cindy_docs` has `disabled: false`).
  No Hermes config backup was needed because no live test wrote to it.
- Vault note `/Users/turko/Bishi-memory/memory/Project — Cindy.md`: 83 lines, one dated line per
  session, newest at the bottom. Workspace note
  `.workbuddy-ai/memory/2026-11-04.md`: 11 lines.
- No linked agent sessions or worker teams are running. Before editing anything: `git status`,
  `git log -3`, `git pull`.

## 4. Open work, in the order to take it

One task per session (AGENTS.md §4). Go top-down unless the owner names a task.

1. **4.5 done-test is the owner's.** Walk them through `docs/extending.md` and let them say
   "Pass" or "failed at step X". An agent cannot close it. The examples were re-verified today.
2. **2.4b one-click alternatives.** The wiring exists and is `unit-tested`. It needs a
   `live-proven` run with at least one healthy alternative route. Bring Ollama up or add a second
   healthy local route, then exercise the button in the dev app.
3. **3.2b `tools.yaml` schema is a real product decision.** Ask the owner one question if it
   blocks the task you pick. It blocks 5.1b and 4.3's "add to expert" shortcut. Also open in 3.2b:
   `skills/`, auto-selecting the expert's model in the draft, non-Hermes experts.
4. **5.1b local notes vault bridge**: agent-facing tool, `tools.yaml` opt-in, vault-path setting,
   live read and append in the app. `packages/maker-core/src/notes/vault-notes.ts` is ready.
5. **5.2b session export**: adapter from stored messages to `ExportSession`, IPC plus Export
   action, vault-path choice, live export of a real session.
   `packages/maker-core/src/export/session-markdown.ts` is ready.
6. **5.4b scheduled sessions**: run a due schedule through the upstream scheduler, persist
   last-run times, write the result with 5.1a `appendNote`, live scheduled run.
   `packages/maker-core/src/schedules/scheduled-sessions.ts` is ready.
7. **3.7** Hermes as an Orca lead: 3.7a and 3.9 are done; read the row before picking it. The
   remaining part is UI hiding team mode for Hermes on the new-task screen.
8. **Debt picks** (full list in ROADMAP §Debt): cancelled Hermes turn persisted as
   `turnCompleted: true` (`main/maker-ipc/sessionEventTerminal.ts:234`); Hermes ignoring
   `disabled` MCP servers (filter in the bridge preparer); expert draft card repeating header
   rows; owner-reported expert-switch bug; the `unit tier` environmental red set in a WorkBuddy
   shell; the `query/start` prewarm race.

## 5. Working rules and gotchas (accumulated; do not re-discover)

- **Node 22 first:** `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` must say
  v22.23.4. Node 26 on PATH breaks `better-sqlite3` (`NODE_MODULE_VERSION`).
- **The agent shell is not a valid gate environment.** WorkBuddy injects
  `NODE_OPTIONS=--require=…/node-language-shim.cjs`, which distorts FS-heavy tests and makes
  `/bin/ps` unusable. Run gates in a **real Terminal**: write a `.command` file and launch it with
  the computer-use `open_app` helper. That tool often reports a timeout, but the script does
  start, so check the log rather than relaunching. Canonical markers in the log:
  `PS_PROBE=    1 /sbin/launchd` and `NODE_OPTIONS=[]`. Never use `open -a Terminal`,
  `osascript`, `launchctl` or GUI clicks for this.
- **Gates before every commit:** `pnpm typecheck`, `pnpm test:runner`,
  `pnpm test:unit:related`, `pnpm check:test-hygiene`. **AGENTS.md §2 has no docs-only
  exception.** The morning handover claimed three gates suffice for docs-only commits; that claim
  is wrong and was corrected in `HANDOVER.md`. A full run takes about 26 minutes.
- **Sanctioned unit-tier split** (from the 2026-11-01 handover):
  `node scripts/test-workspaces.mjs --tier unit --related --exclude-workspace apps/desktop`, then
  `XDT_UNIT_TEST_SHARD=i/8 node scripts/test-workspaces.mjs --tier unit --related --workspace apps/desktop`
  for i=1..8. The desktop threads pool intermittently dies with **SIGSEGV** in V8 GC during
  worker-isolate teardown. Rerun only the crashed shard standalone in the same canonical
  environment. All 8 green counts as the gate. Never count a crashed run as green. Today's runs:
  shard 4 crashed once (4.5), shards 3 and 7 crashed once (5.3b); all standalone reruns green,
  zero assertion failures.
- **Commits:** `git commit -s`, imperative subject under 72 chars, push to `origin main`, never
  force-push. End every session with `ROADMAP.md` and `STATUS.md` edits, `HANDOVER.md` only for
  stable changes, and a dated vault line. Stage only your task files.
- **Dev app startup:** `pnpm restart:desktop:remote --region=global` from a real Terminal. Wait
  for `DESKTOP_DEV_VERDICT=ready`; do not bypass with `pnpm dev:desktop`. Main-process changes
  need a full restart. Renderer-only changes hot-reload, but see the next bullet.
- **Never edit a renderer file while a live-proof turn is running.** A `.tsx` edit triggers a
  Vite reload that kills the turn mid-flight. This cost one live proof on 2026-11-04; the fix was
  a canonical restart and a clean third run. Vite esbuild can also die on a reload right after a
  renderer edit ("The service is no longer running", blank root); the canonical wrapper restart
  fixes it.
- **Driving the UI over CDP:** dev binds `127.0.0.1:9222` (`XDT_CDP_PORT` overrides). Select the
  `#/cc-agent/` page target, not the first `page`. A tiny Node-22 script with the built-in
  `WebSocket` client doing `Runtime.evaluate` is enough for navigation, clicks, form fills and
  assertions. `/tmp/cindy-cdp.mjs` and `/tmp/cindy-53b-live.mjs` are working examples, but they
  are scratch files, not repo code.
- **Composer selectors:** the Tiptap editor is `DIV.tiptap.ProseMirror[contenteditable=true]`,
  not a `textarea`. Type with `e.focus(); document.execCommand('insertText', false, text)`. Send
  is `button[aria-label="Send message"]`. Dismiss a stale pre-restart error with
  `button[aria-label="Dismiss error"]`. A healthy control turn may reply `Hi!`, so never poll
  for fixed greeting words.
- **Renderer tests:** jsdom is opt-in per file via a first line
  `// @vitest-environment jsdom`. Never `vi.mock('react-i18next')` wholesale, because
  `makerChatStore.ts` imports the real i18n init. Hygiene ratchet is
  `PASS (361 files within baseline)`; new tests with no real waits, `resetModules` or source
  reads pass automatically.
- **New renderer surfaces:** run `node scripts/design-inventory.mjs --check` (baseline
  54 surfaces). A component mounted inside an existing view does not change the generated block.
  Typography: placeholders use `--text-placeholder`, not `--text-tertiary` (the ink-ladder test
  in shard 8 catches it).
- **Plugin examples:** `loadPlugins`' native `import()` fails inside a Vitest worker
  ("A dynamic import callback was not specified"), so verify plugin examples in **plain Node**.
  A `tsx` harness also cannot import `adapter-extensions.ts` (its agent modules load `.md`
  assets only Vite understands); that one check belongs in Vitest.
- **5.3b facts:** the raw `maker:event` payload has **no timestamp**. `makerChatStore` stamps
  `createdAt` on `tool_use` / `tool_result` message bubbles at reducer time and stamps
  `agentStatus.startedAt` from a separate `maker:status-changed` event. Tool durations are
  therefore receipt-time estimates. A merged `tool_result` keeps only the primary `toolUseId`;
  secondary tools are settled by adjacency (`packages/maker-shared/src/messageNormalize.ts`).
  `stopSession` flips `isRunning` optimistically and never calls `maker:abort-session`. A
  cancelled Hermes row is still persisted `turnCompleted: true`, so declare the state from
  `turnStoppedByUser`, never from persisted rows.
- **Hermes source:** the installed code sits inside the owner's daily Hermes home (off limits).
  Read the public tag instead:
  `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/refs/tags/v0.22.5`.
- **Probes:** throwaway `HERMES_HOME` in your scratchpad, small Node stub model on `127.0.0.1`
  (OpenAI-compatible). Kill only your probe's gateway (check its `HERMES_HOME` with
  `ps eww -p <pid>`).
- **Cindy DB (read only):** `~/Library/Application Support/CindyGlobal-dev2-dev/cindy-local-v1.db`
  (`sqlite3 -readonly`), tables `messages` and `sessions`. There is also a `-private` data dir.
- **Hermes per-session logs:** `~/.hermes-cindy/session-homes/<id>/logs/agent.log`.
- **zsh gotcha:** an unquoted `$R` holding `--resume <id>` stays one argument. Use bash for loops.
- **One question rule:** ask the owner only when a real product decision is needed (for example
  the 3.2b `tools.yaml` schema), and ask one question. Everything else, answer by reading the
  repo.

## 6. Key files (newest first)

- 5.3b long-running turn view:
  `apps/desktop/src/renderer/features/cc-agent/turn-timeline-adapter.ts` (pure adapter),
  `apps/desktop/src/renderer/features/cc-agent/LongRunningTurnTimeline.tsx` (view + container),
  mount at `apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx` near L5871,
  tests `apps/desktop/src/renderer/__tests__/{turnTimelineAdapter.test.ts,longRunningTurnTimeline.test.tsx}`.
  Consumes `packages/maker-core/src/tasks/turn-timeline.ts` via the
  `@cindy/maker-core/turn-timeline` subpath.
- 2.4b banner: `apps/desktop/src/renderer/features/cc-agent/SessionRouteBlockedBanner.tsx`
  (container wiring), `sessionRouteBlockedBannerReevaluation.test.tsx`.
- 4.5 guide: `docs/extending.md`, `docs/examples/extending/`.
- Skills manager (4.4): `packages/maker-core/src/skills/skill-manager.ts`;
  `apps/desktop/src/main/maker-ipc/{skills.ts,skillsDesktop.ts}`;
  `apps/desktop/src/renderer/components/settings/SkillsSection.tsx`; IPC `maker:skills:*`.
- MCP catalog (4.3): `packages/maker-core/src/mcp/mcp-catalog.ts`;
  `apps/desktop/src/main/maker-ipc/{mcpCatalog.ts,mcpCatalogDesktop.ts}`;
  `apps/desktop/src/renderer/components/settings/McpCatalogSection.tsx`; IPC `maker:mcp-catalog:*`.
- Plugins (4.2): `packages/maker-core/src/plugins/{plugin-loader,plugin-state}.ts`;
  `apps/desktop/src/main/maker-ipc/extensionPlugins.ts`;
  `apps/desktop/src/renderer/components/settings/PluginsSection.tsx`; IPC `maker:ext-plugins:*`.
- Registry (4.1): `packages/maker-core/src/extensions/registry.ts`,
  `packages/maker-core/src/agents/adapter-extensions.ts` (header records the TS 5.9 overload
  gotcha; do not "simplify" it back).
- Daemon config RPCs: `packages/maker-hermes-manager/src/{protocol.ts,hermes-config.ts}`
  (`config/setLocalContextWindows`, bundle 0.3.0; read before adding an RPC).

## 7. Evidence files for today

These are scratch files under `/tmp`, not repo code. They are the raw proof behind the STATUS
entries and will not survive a reboot.

| File | What |
|---|---|
| `/tmp/cindy-gates-45.log`, `/tmp/cindy-shard4-45.log` | 4.5 four-gate run and the shard-4 standalone rerun |
| `/tmp/cindy-gates-53b-aborted.log` | first 5.3b gate run, deliberately aborted after the review fixes |
| `/tmp/cindy-gates-53b.log`, `/tmp/cindy-shard3-7-53b.log` | final 5.3b four-gate run and the standalone shard 3/7 reruns |
| `/tmp/cindy-53b-live-run1.log` | first 5.3b live proof (before the review fixes) |
| `/tmp/cindy-53b-live.log` | final 5.3b live proof, including the 35 ms `cancelling` observation |
| `/tmp/cindy-restart.log` | dev app restart verdicts |

## 8. Untracked, deliberately not committed

`.kimi-code/`, `.serena/`, `.specify/`, `.workbuddy-ai/` (other tools' local config) and
`apps/desktop/src/renderer/__tests__/tmp-probe/` (leftover probe test from 1.11a). Leave them
alone unless the owner says otherwise. **Never stage them.**
