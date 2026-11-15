# Handover — 2026-11-15, Session 13 (Phase 13 complete)

**Read in this order:** `AGENTS.md` (the rules; they override everything) → this file → `ROADMAP.md`
(the only source of truth for status) → `STATUS.md` entries `(av)`, `(aw)`, `(ax)` (this session,
what was done and how it was proven) → `HANDOVER.md` (architecture, versions, traps) →
`docs/phase-14-blueprint.md` before touching any Phase 14 row.

This supersedes `docs/handover-2026-11-15.md` (Session 12). That file is still worth reading for the
13.4/13.5 detail and the older traps, but its "what to do next" section is out of date.

Owner: one person, the only reviewer and product manager. Work one row at a time, to its honest
label (`typechecked` / `unit-tested` / `live-proven`). Never mark a green cell that is not proven;
split the row instead.

---

## 1. Where the repo is right now

- Branch `main`, **HEAD = origin/main = `b4a6adc281`**, working tree clean, everything pushed
  (0 unpushed commits). Plus the docs commit that adds this file.
- **Phase 13 is complete. There are no open rows in it.** The only open work is Phase 14
  (`14.0`–`14.10`), and `14.0` is gated on an owner decision (see §3).
- Node **22.23.4** (`/opt/homebrew/opt/node@22/bin`), pnpm **10.33.2**. Hermes CLI **installed
  0.23.0**, code pin still **0.22.7** (deliberate; see HANDOVER §Versions). Daemon bundle **0.3.2**.
- The dev app is running from this tree (sandbox `CindyGlobal-dev2-dev`, CDP `9222`, Vite `5174`),
  restarted at 09:46 on 2026-11-15.

Session 13 commits, oldest first:

| Commit | What |
|---|---|
| `9066eb74d9` | 13.8 worker model allowlist (`live-proven`) |
| `b25b8a6d85` | 13.10a shell-limits probe, docs only (`live-proven`) |
| `db3356d9ab` | 13.10b shell limits (`live-proven`) |
| `b4a6adc281` | 13.10c output-cap decision (`Dropped`) |
| (this commit) | this handover |

## 2. What this session finished

### 13.8 worker model allowlist — `live-proven`
Managed `workers:` block in `~/.cindy-harness/routing.yaml` (`allow_model_choice`,
`allowed_routes`), parsed fail-closed in `packages/model-providers/src/routingFile.ts`, enforced in
`orcaHermesWorker.ts` **before any slot is reserved** and at the `createWorkerInTeam` boundary for
non-Hermes kinds. Settings → Personalization has the checklist (routes marked Local/API). Live: an
unlisted route was refused naming the allowed ones, a listed local route started a real worker.
48 tests. Evidence `docs/evidence/13.8-worker-model-allowlist-live-proof.md`, STATUS `(au)`.

### 13.10a shell-limits probe — `live-proven`, no feature code
Facts now pinned in HANDOVER §3 (and they matter for any future shell work):
- `terminal.timeout` exists, integer seconds, **default 180**, foreground hard cap **600**
  (`TERMINAL_MAX_FOREGROUND_TIMEOUT`).
- At the limit the model sees exactly `[Command timed out after Ns]` and exit **124**.
- A per-call `timeout=` **overrides** the config. Any setting is a default, not a ceiling.
- **There is no output-cap setting.** The cap is the generic per-result budget (15 % of the model's
  context window in chars, floor 8 000, ceiling 100 000; terminal registers 100 000) and an
  oversize result is **persisted** to `$HERMES_HOME/cache/spillover/<id>.txt` behind a 1 500-char
  preview with **no** truncation marker.
- A session-home `config.yaml` edit is picked up on the next command with **no gateway restart**
  (the terminal policy is rebuilt per turn, signature-cached).
Evidence `docs/evidence/13.10a-shell-limits-probe.md`, STATUS `(av)`.

### 13.10b shell limits — `live-proven`
`~/.cindy-harness/shell-limits.yaml` (`timeout_seconds`, default **300**, `0` = leave the Hermes
default alone, upper bound 600) is written into **each session home's** `config.yaml` as
`terminal.timeout`, through the same keep-formatting `transformConfig` chain as the vision route.
The base home is never written; `0` removes the key on the next prepare.
- New: `packages/maker-hermes-manager/src/shell-limits.ts` (narrow reader + `injectTerminalTimeout`),
  `apps/desktop/src/main/maker-ipc/shellLimits.ts` + IPC `maker:shell-limits:get`,
  `session-manifest/ShellLimitsChip.tsx` (`shell 300s` / `shell default`),
  `@cindy/maker-shared/shell-limit-notice` + one `AgentActionRow` badge (`stopped at 5 s`).
- Bundle **0.3.1 → 0.3.2**. 46 new tests. Evidence
  `docs/evidence/13.10b-shell-limits-live-proof.md`, STATUS `(aw)`.
- Live: 5 s → home got `terminal.timeout: 5`, Hermes logged
  `Tool terminal returned error (5.39s): {"output": "[Command timed out after 5s]", "exit_code": 124}`,
  row badge `stopped at 5 s`, chip `shell 5s`; 0 → block removed and `tool terminal completed
  (30.30s)`; file deleted → `terminal.timeout: 300`, chip `shell 300s`.

**Behaviour change to be aware of:** there is no `shell-limits.yaml` now, so the shipped default
**300 s** applies to every session home from its next prepare. Hermes's own default was 180 s.
The owner has not been asked whether 300 is the number he wants.

### 13.10c output cap — `Dropped` (decision, no code)
Decision (a): **no Cindy-side output cap.** Hermes already spills an oversize result before the
model sees it; Cindy's own compaction only runs when a task is **archived**
(`compactSessionToolResultsBestEffort` ← `orcaTeamStore`); and blueprint §12 forbids rewriting tool
results in the stream. `max_output_chars` stays in the file but reports itself as ignored **with the
reason**. Reopen trigger recorded: a result Hermes does **not** spill, because `read_file` is pinned
out of spillover (`PINNED_THRESHOLDS`), so a giant file read still reaches the model in full and
costs money on an API model. STATUS `(ax)`.

## 3. What remains — and the one blocker

**Everything left is Phase 14, "Cindy Doctor"** (`docs/phase-14-blueprint.md`, rows `14.0`–`14.10`;
`14.11` is Parked). Order matters: `14.0` is the contract the rest depends on.

**BLOCKER: row 14.0 needs the owner's decision.** ADR `0015-cindy-doctor.md` must record a
sanctioned exception to `AGENTS.md` §3: the doctor restoring `~/.hermes-cindy/config.yaml`
**byte-exactly** from a snapshot, with the app closed, via the move-aside path. Options put to the
owner:

1. Approve the exception as scoped in blueprint §13 (recommended: without it the doctor can only
   report config damage, never repair a hand-broken file).
2. No exception: fixes go through daemon RPCs only, narrower but no §3 conflict.
3. Park Phase 14.

The other Phase 14 defaults are already written in blueprint §13; do not re-ask them.

After 14.0, the rows are `14.1` pure doctor core → `14.2` `pnpm doctor` CLI + environment/runtimes
packs → `14.3` config pack → `14.4` endpoints/processes/data → `14.5` LKG snapshots → `14.6` fix
runner → `14.7` upgrade canary → `14.8` Settings section → `14.9` incident bundle → `14.10`
proposed rule (docs only).

## 4. Known issues and debt (do not silently fix)

From `ROADMAP.md` §Debt, the ones that still bite:

- **Continuing a Hermes conversation after an app restart loses the agent's context.** `agent.ts`
  `startSession` mints a new `randomUUID()`, so the home changes and `--resume` cannot resolve.
  Recorded by 13.2a. This is the most damaging open defect.
- **`maker:routing:request-task-text` cannot authenticate** against a provider whose key lives only
  in `~/.hermes-cindy/.env` (`providersHandlers.ts` forwards only `process.env`). Same defect hits
  auto-title and the Magic rename. The newer hosts (`recap`, `retitle`, `tool-label`) pass
  `env: harnessDiscoveryEnv` and do not have it.
- **The managed `cindy-council` block names a tokenhub model that no longer exists**
  (`deepseek-v4-flash-202605`). It fails closed with `model-missing`; nobody edited it.
- **Default (`--safe-mode`) sessions run no hooks**, so the web-search cap and Auto-review cannot
  apply there. The chips say so.
- **Hook-blocked tool calls never appear in Cindy's transcript** (guard blocks too).
- **`apps/desktop` unit shards can die with SIGSEGV** (V8 GC in worker-isolate teardown). Rerun; a
  retried PASS is green. Never switch the vitest pool.
- Hermes installed **0.23.0** vs code pin **0.22.7**. The pin moves only after every pinned
  behaviour is re-probed (HANDOVER §3 lists them). The Runtimes tab shows the mismatch by design.

## 5. Setup, commands and dependencies

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"     # node -v must say v22.23.4
cd "/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy"    # spaces AND '=' in the path: quote everything
```

Gates (AGENTS.md §2):
- **Tier 0 (docs only):** `pnpm test:runner`.
- **Tier 1 (mid-task):** `pnpm typecheck`, `pnpm test:runner`, `pnpm check:test-hygiene`, plus the
  touched files' tests run directly.
- **Tier 2 (before the closing commit):** `pnpm typecheck`, `pnpm test:runner`,
  `pnpm test:unit:related`, `pnpm check:test-hygiene`. One `test:unit:related` run covers every
  workspace (61 legs, ~10–15 min). `apps/desktop` is the slow part.
- Never run `tsc` directly in `apps/desktop`. After any UI change:
  `node scripts/design-inventory.mjs --check` (regenerate with `pnpm design:inventory`).

**Gates and the dev restart cannot run in the agent shell.** It blocks `/bin/ps` (EPERM for every
descendant) and injects `NODE_OPTIONS`. Write a `.command` file and open it in a real Terminal with
the computer-use helper; the script should `unset XDT_ISOLATED` and `unset NODE_OPTIONS`, log
`PS_PROBE=/bin/ps -p 1 -o comm=` and an `ALL_DONE` sentinel, and you poll the log file. Working
examples: `/tmp/proofs/13.10b/restart.command` and `/tmp/proofs/13.10b/tier2.command`.

Dev app:
- Restart: `pnpm restart:desktop:remote --region=global`, wait for `DESKTOP_DEV_VERDICT=ready`.
- **Daemon bundle:** after changing `packages/maker-hermes-manager`, rebuild and sync by hand:
  `pnpm --dir packages/maker-hermes-manager bundle` then copy `dist/hermes-mgr.mjs` to
  `apps/desktop/resources/hermes-manager/hermes-mgr.mjs`. Both paths are **gitignored**, so a bundle
  change never shows in `git status` and never gets committed. Bump `HERMES_MGR_BUNDLE_VERSION` in
  `src/protocol.ts` (and its test) when the daemon's behaviour changes, and grep the built bundle for
  a string from your change before trusting a live run.
- Daemon socket: `~/Library/Application Support/CindyGlobal-dev2-dev/hermes-mgr/hermes-mgr.sock`.
- Proof helpers: `/tmp/proofs/13.10b/cdp.mjs` (evaluates JS in the chat renderer over CDP `9222`)
  and `turn.sh` (sends a prompt, polls until idle). `/tmp` is wiped on reboot; copy them somewhere if
  you want them to survive.
- A session's real Hermes log:
  `~/.hermes-cindy/session-homes/cindy-<cindySessionId>-<hash>/logs/agent.log`. Cindy's transcript is
  the SQLite DB at `~/Library/Application Support/CindyGlobal-dev2-dev/cindy-local-v1.db`.
- Free local chat: LM Studio `qwen3-8b` at `http://127.0.0.1:1234/v1` (route `lmstudio-local`).

## 6. Decisions already made (do not re-litigate)

`docs/decisions/`: `0001` fork freeze, `0004` one HERMES_HOME per session, `0011` @-mention
teammates, `0012` squads launch Orca teams, `0013` vision bridge is native Hermes `auxiliary.vision`
(not a Cindy pre-describe path), `0014` storage housekeeping (+ addendum on the orphan-home window).

Session 13 added no ADR. Its decisions live in the ROADMAP rows: 13.10b was **narrowed to the
timeout** because blueprint §12 says so when Hermes has no output cap, and 13.10c was **dropped** for
the reasons in §2. Phase 14's `14.0` will be ADR `0015`.

Also decided, and easy to break by accident:
- `window.electronAPI` is frozen. Live proofs use real IPC, not in-memory stubs.
- Session homes are generated. Only `prepareSessionHome` writes `config.yaml` there, through the
  keep-formatting chain (`injectAutoReviewHook` → `injectVisionRoute` → `injectTerminalTimeout`).
  Never hand-edit a session home.
- `~/.hermes-cindy/config.yaml` and `routing.yaml` are never hand-edited. Back up to
  `<name>.bak-<date>-<row>`, change through daemon RPCs, `cmp` after restoring.

## 7. Traps that cost time this session

- **The agent shell cannot run gates or the restart** (see §5). This is the biggest time sink;
  set up the `.command` route first, before writing any code.
- **Ambient `XDT_ISOLATED=1` breaks 4 `restart-desktop-remote.test.mjs` tests.** Unset it in the
  gate script or the run is red for a reason that has nothing to do with your change.
- **`grep` on `agent.log` needs `-a`** (the file contains NUL bytes and is treated as binary), and
  `\|` alternation silently matched nothing in this shell. Use `grep -a -e A -e B`.
- **A tool-row badge only renders when its work group is expanded.** `Collapse` unmounts children,
  so a DOM query for `[data-testid="agent-action-shell-limit"]` returns 0 until you click the
  `Worked for …` header. Check the group's `innerText` too.
- **The model will pass its own `timeout=`** unless you tell it not to. Any live proof of a timeout
  setting must say "Do NOT pass a timeout argument".
- **A local model sometimes answers without calling the tool.** 13.10b's control turn did exactly
  that; re-send with "You must call the terminal tool in this reply".
- **ECC `stop:format-typecheck` hook reformats every JS/TS file touched by the Edit/Write tools.**
  Edit existing files with a Python exact-anchor script (assert each anchor occurs once), and use
  Write only for new files.
- **GateGuard blocks the first Write/Edit of each file** until you state call sites and the owner's
  verbatim instruction.
- **macOS paths are case-insensitive.** Give a pure helper a distinct base name
  (`shellLimitsChipText.ts` next to `ShellLimitsChip.tsx`).
- **`test:unit:related` reads the staged diff.** Stage your paths before the Tier 2 run or it
  selects nothing.
- One near-miss worth repeating: a `Write` with a mistyped path created a stray
  `/Users/turko/=ai space=/=Projects_Pony=` directory. Check the path in every Write call.

## 8. Copy-paste prompt for the next agent

```
You are continuing work on Cindy, a private single-user fork of a desktop agent harness.
Repo: "/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy" (spaces and '=' in the path: quote everything).
Node 22 only: export PATH="/opt/homebrew/opt/node@22/bin:$PATH" and check node -v first (expect v22.23.4).

Read first, in this order: AGENTS.md (rules; they override upstream docs),
docs/handover-2026-11-15-session-13.md, ROADMAP.md (the only source of truth for status),
STATUS.md entries (au), (av), (aw) and (ax), HANDOVER.md, then docs/phase-14-blueprint.md.
Do not re-litigate anything in docs/decisions/.

State: Phase 13 is complete, HEAD = origin/main = b4a6adc281, working tree clean, daemon bundle 0.3.2,
Hermes installed 0.23.0 (code pin 0.22.7 by design). The only open rows are Phase 14 (14.0-14.10).

START BY ASKING THE OWNER ONE QUESTION, then stop and wait: row 14.0 (ADR 0015) needs his decision on
a sanctioned exception to AGENTS.md section 3, so the doctor may restore ~/.hermes-cindy/config.yaml
byte-exactly from a snapshot with the app closed. Options: (1) approve the exception as scoped in
blueprint section 13, (2) no exception, config fixes go through daemon RPCs only, (3) park Phase 14.
Do not write doctor code before that answer. If he already answered in your session, take row 14.0 and
work it to its honest label (typechecked / unit-tested / live-proven).

Work style: read before you write; failing test first; smallest diff; live-prove in the running dev
app when the row touches disk, a real binary, UI or runtime behaviour. Never mark a green cell that is
not proven: split the row instead.

Gates and the dev restart CANNOT run in the agent shell: it blocks /bin/ps and injects NODE_OPTIONS.
Write a .command file and open it in a real Terminal with the computer-use helper, unset XDT_ISOLATED
and NODE_OPTIONS inside it, log an ALL_DONE sentinel, and poll the log. Copy /tmp/proofs/13.10b/
restart.command and tier2.command if they still exist. Tier 2 = pnpm typecheck && pnpm test:runner &&
pnpm test:unit:related && pnpm check:test-hygiene, staged paths first because test:unit:related reads
the staged diff. Never run tsc directly in apps/desktop. After UI changes:
node scripts/design-inventory.mjs --check.

Daemon changes: rebuild with pnpm --dir packages/maker-hermes-manager bundle, copy dist/hermes-mgr.mjs
to apps/desktop/resources/hermes-manager/hermes-mgr.mjs (both gitignored, so git status will not show
them), bump HERMES_MGR_BUNDLE_VERSION in src/protocol.ts and its test, and grep the built bundle for a
string from your change before trusting a live run.

Traps that cost the last session hours: edit EXISTING JS/TS files with a Python exact-anchor script,
never the Edit tool (an ECC stop hook reformats every Edit-touched file); GateGuard wants call sites
plus the owner's verbatim instruction before the first edit of each file; grep agent.log with -a and
-e (it is binary and the shell's \| alternation silently matches nothing); a tool-row badge only
renders when its work group is expanded; tell the model "do NOT pass a timeout argument" in any
timeout proof; macOS paths are case-insensitive.

Hard rules: never read, list or reference ~/.hermes (only ~/.hermes-cindy); never hand-edit
~/.hermes-cindy/config.yaml or routing.yaml (daemon RPCs, back up to <name>.bak-<date>-<row>, cmp
after); back up user state before live writes; paid turns (API models, Nous web calls) need the
owner's explicit OK, asked as one question with costs; no new outbound calls, telemetry or credentials
on disk; window.electronAPI is frozen. git commit -s, push origin main, never force-push, stage only
what you touched. End with ROADMAP row + STATUS entry + HANDOVER (stable facts only) + a copy of the
evidence doc in /Users/turko/Bishi-memory/raw/cindy/ and one dated line in
/Users/turko/Bishi-memory/memory/Project — Cindy.md.

Your first message: confirm node -v, git status and the last commit (expect b4a6adc281 or the docs
commit after it), then ask the 14.0 question.
```

---

*Status of this document: handover only. Task status lives in `ROADMAP.md`, never here.*
