# STATUS.md — Cindy work log

Append-only. Newest entry at the **top**. One entry per agent session.
Every claim carries a verification label from `AGENTS.md` rule 0:
`typechecked` · `unit-tested` · `live-proven` · `unverified`.

Entries before 2026-10-28 were reconstructed from the old `HANDOVER.md` §6 and
re-labelled honestly. Where the original text claimed "done" but the evidence
was weaker, the weaker label is used and the roadmap row reflects it.

---

## 2026-10-30 — Phase 1: ROADMAP 1.8b, Hermes model label in the session header (`unit-tested`)

**Outcome:** new `apps/desktop/src/renderer/features/cc-agent/HermesSessionModelLabel.tsx` renders `session.model` as a muted read-only label next to the title when `agentKind === 'hermes'` (null otherwise); `SessionContentHeader.tsx` (upstream file, +3 lines, additive) mounts it, hidden while renaming. Test: `apps/desktop/src/renderer/__tests__/hermesSessionModelLabel.test.tsx` (`renderToStaticMarkup`, 2 tests). My first version read the source text in a test; `check:test-hygiene` rejected it, so it was replaced by this behavioural test.

**Not proven:** the label is not seen rendered, and I have not checked that `session.model` updates after `setModel` in a running app. That is 1.8c (live). Owner authorised paid calls on 2026-10-30.

**Gates (2026-10-30, Node 22.23.4):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all exit 0 on the final tree. An earlier run was red on `check:test-hygiene` (source-reading test), fixed as described above.

---

## 2026-10-30 — Phase 1: ROADMAP 1.8a, manager-level test that `query/setModel` reaches `-m` (`unit-tested`)

**Outcome:** row 1.8 was mostly built already (`query/setModel` handler in `hermes-manager.ts`, `-m` in `hermes-run.ts` `buildHermesArgs`, agent method, chat-input picker). What was missing was a test at the manager level. Added 3 tests plus helper `runTurnArgv` to `packages/maker-hermes-manager/src/__tests__/hermes-manager.test.ts` (fake Hermes only): full-access session has no `-m` by default, an override sets it, clearing with `''` drops it, `config.yaml` untouched; safe mode uses the home route `fake/default-model`, an override swaps `-m` and keeps `--provider fake-provider`, clearing falls back; `query/setModel` rejects an unknown session and a missing model. All 16 tests in the file pass under Node 22. Mutation check: disabling the registry update in the handler made the two main tests fail; source restored.

**Not done / still open:** 1.8b (model shown in session header; `SessionContentHeader.tsx` is an upstream file, needs owner OK) and 1.8c (live proof, paid turn, needs approval). Row 1.8 stays open. Nothing live was run.

**Surprise (not fixed):** in safe mode an override model is paired with the home route's provider when the session has no provider of its own, so a model from a different provider could mismatch. Flagged for the owner.

**Gates (2026-10-30, Node 22.23.4):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all exit 0. Two earlier runs were red for environmental reasons, not assertions: a vitest SIGSEGV in `apps/desktop unit` with the dev Electron app running, and vitest SIGABRT in every workspace after a background `brew` upgrade moved `simdjson` to 5.0.7 under Node 22 (fixed with `brew reinstall node@22`).

---

## 2026-10-30 — Phase 1: ROADMAP housekeeping, 1.5b closed (docs only)

**Outcome:** rows 1.5b and 1.5b-4b were still marked open although 1.5b-5c redid the 4b proof and is `live-proven` (`docs/evidence/1.5b-5c-live-proof.md`). Both are now ✅ `live-proven` via 5c; the 5c row's "Open: auth.json write-back" now points at the free probe. No code changed, no gates needed. Known gaps stay in Debt: packaged builds lack the shim bundle; real OAuth refresh untested.

**1.7 closed (docs only):** its 🧪 note said "live-prove via 0.8", and 0.8 did exactly that (model Save diffed the `default:` line); the catalog listing was already `live-proven` on 2026-10-23. Marked ✅ citing both entries. Caveat: the listing proof predates the 10-29 session-home work; nothing in that work touched the catalog code, but I did not re-run it.

**Next:** 1.6 is a design row (📐, needs a spec); 1.8 (per-session model override) is the first open row with a testable spec.

---

## 2026-10-29 — Phase 1: shared `memories` across session homes, concurrent-writer probe (`live-proven` for the writer; owner decided: keep shared)

**Outcome:** Hermes v0.22.5 `MemoryStore._mutate` takes an exclusive `flock` on `MEMORY.md.lock`, re-reads `MEMORY.md` inside the lock, then replaces the file atomically. Probe: two real Python processes using the real `MemoryStore.add`, each with its own throwaway `HERMES_HOME` whose `memories` is a symlink to one shared directory, 40 adds each at the same time. Result: 0 failures and all 80 entries present in `MEMORY.md` (A 40/40, B 40/40). So two sessions sharing `memories` do not lose each other's writes. Throwaway dir under `$HOME`, deleted afterwards; no real memories, no model call, `~/.hermes` not referenced.

**Not proven:** `replace`/`patch` races between sessions (a session can still edit an entry another session just changed; the drift guard returns an error then, not data loss), and the char limit being shared by all sessions. **Owner decision (2026-10-30): keep `memories` shared across session homes.** Veto flag closed; do not re-litigate.

---

## 2026-10-29 — Phase 1: `auth.json` write-back from a session home, free probe (`live-proven` for the writer only; real token refresh NOT tested)

**Outcome:** Hermes v0.22.5 saves `auth.json` through `hermes_cli/auth.py::_save_auth_store` -> `utils.atomic_json_write` (temp file + replace). I ran that real function from the Hermes venv on a throwaway directory: `home/auth.json` as a symlink to `shared.json`, then a write. Result: the symlink survived and `shared.json` received the new content. So a write from a per-session home reaches the shared `auth.json`; a refreshed token will not be stranded in one session home. The "global root" write-through (`_global_auth_file_path`) returns None when the home and the root are the same directory; I did not run it against a session home.

**Not proven:** a real provider token refresh (no OAuth provider is logged in: Nous was logged out in 0.9b, DeepSeek uses a static key in `.env`, `copilot` comes from the gh CLI), and the global-root write-through with a real `HERMES_HOME` set to a session home. The first is moot until the owner logs in to an OAuth provider again; re-check then. No credentials read, no real `auth.json` touched, no model call, `~/.hermes` not referenced.

---

## 2026-10-29 — Phase 1: orphan session homes reaper live check (`live-proven`)

**Outcome:** planted `session-homes/livecheck-old-aaaaaaaaaa` (mtime set to 2026-10-26) and `livecheck-new-bbbbbbbbbb` (fresh), restarted the dev app (`pnpm restart:desktop:local`; rebuilt `hermes-mgr.mjs` contains `reapOrphanHomes`), then waited for the window to finish loading (I only took a screenshot; no clicks or typing). The daemon was not running right after the restart, but by the next listing about 2 minutes later the old fake home was gone, so it started on its own during app start-up (exact trigger not identified). The fresh fake, the real `0c5e9200-...-2d51ca5605` (about 1.5 h idle) and `~/.hermes-cindy/auth.json` were untouched. I removed the fresh fake by hand afterwards. No model call, no config write.

**Not proven:** a real 24 h-old orphan; a home whose gateway pid is alive. I did not find the "removed orphan session homes" log line (logger location not checked), so the evidence is the directory listing before and after.

---

## 2026-10-29 — Phase 1: orphan session homes reaped at startup (`unit-tested`; live check in the entry above)

**Outcome:** the Debt row "orphan Hermes session homes accumulate" is fixed in code. `hermes-mgr` start (only with per-session homes) now runs `reapOrphanHomes` after `reapOrphanGateways`: it removes `session-homes/<id>-<10 hex>` directories that no registered session owns and that were idle for 24 h (`orphanHomeMinAgeMs`, default 24 h). Safety: real directories only, never follows symlinks (shared items are links, so the base home's `auth.json`/`installs` survive), skips a home whose gateway pid is alive but not verifiably its Hermes gateway, best effort (errors logged, start continues). Decision recorded in ADR 0004.

**Changed:** `packages/maker-hermes-manager/src/session-home.ts` (`reapOrphanHomes`, `orphanHomeMinAgeMs`), `index.ts` (exports), `hermes-manager.ts` (start). Tests: 5 in `session-home.test.ts` (removes idle orphan and keeps registered one with base-home files intact; keeps recent; ignores stray names/files and an outside-pointing symlink; keeps unverifiable live pid; no root dir), 1 in `hermes-manager-session-homes.test.ts` (start removes idle orphan, keeps recent).

**Not done:** live proof in the running app. The real orphan `0c5e9200-...` is only about 1.5 h old, so it is not eligible until 24 h idle; a live check needs a planted old directory or waiting until tomorrow plus an app restart.

**Gates (Node 22), corrected:** commit `8d17c31f55` was pushed after a RED chain by my mistake (the commit step was not chained to the gate result), and the line that stood here claiming exit 0 was wrong at that time. Record for this code: chain #1 and #2 exited 1, `apps/desktop` vitest killed with SIGSEGV (crash reports: V8 GC in `IsolateData::~IsolateData`, worker-thread teardown, no Cindy frames); related unit tier alone exit 0; chain #3 of `typecheck`, `test:runner`, `test:unit:related`, `check:test-hygiene` exit 0 (`EXIT=0`, 0 FAIL lines), so one clean chain exists for this change. The flake predates it: two `gates10.log` files from two sessions on the earlier `49cff34639` state, one `EXIT=0`, one `EXIT=1`. Logged in ROADMAP Debt.

---

## 2026-10-29 — Phase 1: 1.5b-5c close cleanup (`live-proven`)

**Outcome:** after QuakeNotch was turned off I clicked B's archive icon twice (B was an unsent draft, no visible effect) and, on the owner's "Archive A", took full-screen control to click A's row. Before I could, the sidebar already showed no sessions (`localDb.sessions.list` filter=active rows=0) and `session-homes/` had changed at 23:08:26: homes `fa64fbc6-...` (B) and `3bc1dab6-...` (A) and both gateways (pids 13291, 17042) were gone. The pre-restart orphan home `0c5e9200-...` was untouched (matches the Debt row). Main log has no `session home cleanup failed` warning.

**Trigger (owner, afterwards):** the owner deleted both sessions (A and B) in the UI themselves, so session delete is what removed each home and gateway; archiving the unsent draft B did nothing. Not tested: removal on a session with an in-flight turn.

**Still open:** `auth.json` refresh write-back from a session home; orphan-home accumulation (Debt).

---

## 2026-10-29 — Phase 1: 1.5b-5c concurrent sessions (`live-proven`); close cleanup NOT proven

**Outcome:** one owner-approved paid DeepSeek turn (3 API calls). Dev app, two Full-access Hermes sessions with live gateways at the same time:
- B (new session, prewarmed by typing in the composer, never sent): home `session-homes/fa64fbc6-...-d174bb84ce`, gateway pid 13291, `cindy_docs` registered 6 tools before any model call, **0 inbound messages** afterwards.
- A (the earlier proof session, resumed): home `session-homes/3bc1dab6-...-f00551e2ef`, gateway pid 17042 (started by the turn), `read_sheet` completed, answer "plums = 5" from A's own `proof-5c.csv` (B's file said 9, so no cross-talk).
Distinct `HERMES_HOME` per gateway read from each process's env (`ps eww`). Config backup: `config.yaml.bak-20261029-1.5b-5e`.

**Not proven:** session close. The only UI route I found is the row's archive icon; a background `AXPress` just re-selected the row, then full-screen control was blocked by `QuakeNotch` (as in 5c). Both B's home and gateway are still there, so removal is untested either way. Code path: `QUERY_CLOSE` in `hermes-manager.ts`; unit-tested only. `auth.json` write-back also untested.

**Surprises:** (1) a resumed session got a **new** session home after the app restart (old home `0c5e9200-...` stayed, no gateway): the home is keyed by the Hermes session id, which changed. Old homes are not removed by `reapOrphanGateways` (it stops gateways only), so they accumulate: logged for ROADMAP Debt. (2) Prewarm happens when you type in the composer, not when the composer opens.

**Left running / on disk:** gateways 13291 and 17042 and three session homes; the owner can archive B's row by hand and I will check removal.

---

## 2026-10-29 — Phase 1: 1.5b-5c-ui-b: permission-mode tooltips checked in the running app (`live-proven`)

**Outcome:** fresh dev-app restart (`pnpm restart:desktop:local`), opened the composer permission dropdown in a Hermes chat and hovered each item. Default permissions tooltip: "Hermes safe mode: tool actions follow the Hermes home policy. Cindy document tools are off (safe mode disables MCP)." Full access tooltip: "Runs Hermes with --yolo and no further confirmation. Highest risk. Cindy document tools (cindy_docs) are available when the chat starts in this mode." Both match 5c-ui-a. Mode left unchanged (Full access), no model call made. Row 5c-ui is now closed.

**How:** hover needs full-screen control (the background `app_*` tools cannot hover); granted by the owner for this step and released afterwards. Docs-only change since `49cff34639`, gates not rerun.

**Still open:** concurrent full-access sessions and session-close cleanup (paid turn, owner approval first); `memories` sharing veto flag.

---

## 2026-10-29 — Phase 1: 1.5b-5c-ui-a: permission-mode descriptions say which mode carries Cindy tools (`unit-tested`, rendering NOT checked)

**Outcome:** the Hermes permission-mode descriptions now state the 5d decision. Default: "Cindy document tools are off (safe mode disables MCP)." Full access: `cindy_docs` is available "when the chat starts in this mode". Wording is deliberate: switching mode mid-chat does not re-register the bridge, so tools depend on the mode the chat starts in.

**Changed:** `packages/maker-core/src/agents/hermes/agent.ts` (two description strings); `packages/maker-core/src/agents/hermes/__tests__/agent.test.ts` (one test pins both strings; 36 Hermes tests pass). Descriptions render as tooltips in `apps/desktop/src/renderer/components/new-chat/PermissionSelector.tsx`; not opened in the app.

**Row split:** 5c-ui-a done (`unit-tested`). **5c-ui-b open:** eyeball the tooltip in the running app (restart needed, the change is in `maker-core`); only then is it `live-proven`. Still untested live: two concurrent full-access sessions, session-close cleanup, `auth.json` write-back from a session home. `memories` shared across session homes: owner has not answered the veto flag.

**Gates (Node 22), corrected:** commit `49cff34639` was made while the gates were red and its original line here claimed all four exit 0; that was not verified. Actual record: two full chains (gates9, gates10) exited 1 with a vitest SIGSEGV in `apps/desktop unit` (worker crash, not an assertion), after `typecheck` and `test:runner` had passed in them; a rerun of `test:unit:related` + `check:test-hygiene` alone then exited 0 with no crash. No single clean chain exists for this change. The crash is intermittent, logged in ROADMAP Debt.

---

## 2026-10-29 — Phase 1: 1.5b-5c live proof (`live-proven`): `cindy_docs` read_sheet round-trips inside the desktop app

**Outcome:** one owner-approved paid DeepSeek turn in a Full-access Hermes session in the running dev app: `mcp__cindy_docs__read_sheet` completed and the answer (`figs` = 17) matched the file. This closes the 4b failure. Evidence, log excerpts and caveats: `docs/evidence/1.5b-5c-live-proof.md`.

**How:** fresh app start (daemon forked with `--per-session-homes`), new Full-access session, per-session home prewarmed, shim registered 6 tools in that session's own gateway before any model call. Config backed up first (`config.yaml.bak-20261029-1.5b-5c`).

**Honest limits:** model also ran an unrecorded `terminal` call first, so the proof rests on the `read_sheet completed` + bridge `mcp session initialized` lines, not on the answer. One session only: concurrent sessions, close-time cleanup and `auth.json` write-back are not live-tested. UI note on why tools are absent outside Full access is still not built. Packaged builds still lack the shim bundle (Debt). Gates not rerun: docs only since `1b12c0110a` (gates exit 0).

**Surprises:** the desktop UI renders slowly and background clicks on popups did nothing; `QuakeNotch` (overlay app) blocked full-screen clicks, so the owner switched the permission mode by hand.

---

## 2026-10-29 — Phase 1: 1.5b-5c wiring: full-access guard + per-session homes in the desktop (`unit-tested`, live proof NOT done)

**Outcome:** the code half of 1.5b-5c. The live half (redo 4b, one paid DeepSeek turn) is **not done** and needs owner approval, so the row stays open.

**Changed:** `maker-core` `base-agent.ts` + `hermes/agent.ts` (the bridge hook now receives the requested `permissionMode`); `hermesBridgeHost.ts` (preparer returns null, before touching any state, unless `permissionMode === 'bypassPermissions'`; exported `HERMES_BRIDGE_PERMISSION_MODE`); `hermes-manager-client.ts` (desktop forks `hermes-mgr` with `--per-session-homes`). Tests: guard test (undefined/default/acceptEdits/plan -> null, nothing registered), agent passes the mode, client args.

**Design note:** no shim/config change was needed. Session homes copy the base `config.yaml`, which already holds the static shim entries with `${CINDY_BRIDGE_SESSION}`; that variable now expands from the session's own gateway, which the client starts with the session env (5a/5b). The "static in the shared config" decision from 1.5b-1 therefore stands, but is only sound with per-session homes on.

**Verified:** targeted tests pass; gates (Node 22, exit 0) on the second run. The first run failed once in `scheduler-host/preRunHook.test.ts` ("预检耗尽超时预算", 1 ms budget, asserts no spawn); it passed 3/3 alone and the full rerun was green, so it is a load-sensitive flake outside this change. Logged in ROADMAP Debt.

**Known limits:** (1) a `hermes-mgr` daemon started before this change is reused without the flag until the app restarts, so shared-home behaviour (the 4b failure) persists until then; restart the app before the live proof. (2) The UI does not yet say why Cindy tools are absent outside full access (1.5b-5d asks for it). (3) Packaged builds still lack the shim bundle (Debt).

---

## 2026-10-29 — Phase 1: 1.5b-5b per-session homes + gateway lifecycle (`unit-tested`)

**Outcome:** `hermes-manager` can run each Cindy session in its own `HERMES_HOME` with its own gateway. Opt-in and default off: `sessionHomes` option, `hermes-mgr --per-session-homes`. With it off, behaviour is unchanged. Not wired from the desktop yet (that is 1.5b-5c).

**Changed (`packages/maker-hermes-manager/src`):** `session-home.ts` (new: build home, symlink shared items, generate regular `config.yaml`, share `installs/`), `hermes-manager.ts` (turns run in the session home; gateway prewarmed at `query/start`; `query/close` removes home and gateway; startup reaps orphan gateways; daemon stop stops session gateways), `bin/hermes-mgr.ts` (flag), `index.ts` (re-export), `__tests__/fixtures/fake-hermes.mjs` (`FAKE_RECORD_ENV` recorder), tests `session-home.test.ts` and `hermes-manager-session-homes.test.ts`.

**Verified:** 24 new tests, package 87/87, all with `fake-hermes` (no real Hermes, no model call). Gates (Node 22, exit 0): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`. Not `live-proven`: no real gateway was started by this code; that is 1.5b-5c.

**For the owner to veto:** `memories` is shared across session homes (symlink), which preserves today's behaviour. Say so if sessions should get isolated memory.

**Still open:** `auth.json` refresh write-back from a session home (needs credentials/model call); non-interactive approval behaviour without `--safe-mode`/`--yolo`. Next: 1.5b-5c (needs one paid DeepSeek turn, approval first).

---

## 2026-10-29 — Phase 1: 1.5b-5d decided, "full access only" (docs only)

**Outcome:** owner chose "Full access only" for the `--safe-mode` blocker. Cindy tools in Hermes are available only in full-access (`bypassPermissions` → `--yolo`) sessions; all other
modes keep `--safe-mode` (MCP off) and get no Cindy tools. Recorded in ROADMAP row 1.5b-5d (✅ decided, no code yet) and as an addendum to `docs/decisions/0004-hermes-gateway-per-session.md`.

**What it changes:** (1) 1.5b-5c gains a guard: `prepareHermesBridgeSession` returns null unless the session is `bypassPermissions` (the current hook in `maker-host` does not check this, so today it would
register bridge state for sessions whose run ignores MCP); the UI should state why tools are absent. (2) The GATED servers stay off and exposure stays `cindy_docs` only, since `--yolo` bypasses
Hermes' approvals (consistent with ADR 0003). (3) The live proof (4b, redone in 5c) must use a full-access session, which also fits the 4b failure: it ran "Default permissions", i.e. `--safe-mode`.

**Order of the rest, each on the owner's word:** 1.5b-5b (per-session home + gateway lifecycle in `hermes-manager`, hot path) → 1.5b-5c (rewire preparer/shim, add the guard, redo 4b live, one paid turn with approval).
Gates not rerun: docs only.

---

## 2026-10-29 — Phase 1: 1.5b-5a free probes (`live-proven`, probes) + new blocker `--safe-mode`

**Outcome:** 1.5b-5a done to `live-proven` at probe level (real Hermes v0.22.5, stub MCP server, throwaway homes, scrubbed env, no credentials, no model call; real
`~/.hermes-cindy/config.yaml` unchanged, probe gateways stopped, scratch deleted). Full results: `docs/evidence/1.5b-5a-probes.md`; ADR 0004 amended with them.

**Answers:** (1) a real `hermes chat` client starts the gateway with the client's env, so gateway-per-session works with how `hermes-run.ts` already spawns. (2) Symlinks to
`.env`/`auth.json`/`SOUL.md`/`skills`/`plugins`/`memories` survive; Cindy's rename-based writer would replace a link, so the per-session `config.yaml` must be a generated regular file.
(3) Share `.env`, `auth.json`, `SOUL.md`, `skills`, `plugins`, `installs`; per session `config.yaml`, `state.db`, sessions, logs. (4) Copying a warmed home fails (absolute venv paths);
sharing `installs/` by symlink works: home 1.0 GB → 5 MB, start 9–18 s → ~2–7 s.

**Mistake caught:** my first template-clone timing (0.76 s) was a fast failure, not a start. I noticed only 2 of 3 gateways were up and the `--json` output was empty, reran with the
exit code, and corrected the conclusion.

**New blocker (affects the whole 1.5b, not just identity):** Hermes documents `--safe-mode` as disabling "user config, AGENTS.md/memory injection, plugins, and MCP servers".
`permissionModeToFlags` passes `--safe-mode` for every Cindy permission mode except full access (`--yolo`). So a default/ask Hermes run has MCP off regardless of identity. That also
explains why the 4b model saw only `terminal` and `todo`. Recorded as row **1.5b-5d** (owner decision on the mapping); 1.5b-5c is not useful before it.

**Still untested (needs credentials or a model call):** `auth.json` refresh write-back from a session home; approval behaviour without `--safe-mode`/`--yolo` in non-interactive mode;
memory sharing policy. No paid calls this session. Gates not rerun: docs only.

---

## 2026-10-29 — Phase 1: identity channel decided, design recorded (docs only)

**Outcome:** owner answered the one open product question: Hermes sessions **do overlap** ("Sometimes overlap"). So single-active-session identity is out and
gateway-per-session is the route. Recorded as `docs/decisions/0004-hermes-gateway-per-session.md` (status **Proposed**) and three new ROADMAP rows,
1.5b-5a (free probes), 1.5b-5b (per-session home + gateway lifecycle in `hermes-manager`), 1.5b-5c (rewire preparer/shim, then redo 4b live). No code written.

**Why not the alternatives (details in the earlier 2026-10-29 entries):** shared-gateway env cannot carry per-session identity; per-session shim entries need
up to 60 s to reconcile and would expose every session's tools to every session's agent; tool-argument identity is forbidden by the bridge's trust rule.

**What stays valid from 1.5b-1/-2/-3:** bridge identity registration, the 0600 runtime file, the shim's proxying, ADR 0003 exposure policy, mid-run config
reconcile. What gets replaced: the "static `${CINDY_BRIDGE_SESSION}` in shared config.yaml + per-session query/start env" channel.

**Next (needs the owner's word, one sub-row at a time):** 1.5b-5a, the free probes that answer ADR 0004's four open questions (real `hermes chat` client env,
what Hermes writes into a home, what must be shared, cold-start hiding). Gates not rerun: docs only.

---

## 2026-10-29 — Phase 1: 1.5b-4b option (b) probe, per-session shim entry (free, negative result)

**Outcome:** no way found to force Hermes to reload MCP config; option (b) as designed is weaker than it looked. Nothing built; 1.5b-4b stays open. Throwaway home,
stub MCP server, no model call, no `~/.hermes*` touched, probe gateways stopped, scratch deleted. Table: `docs/evidence/1.5b-4b-attempt-not-proven.md`.

**Measured:** Hermes reconciles `mcp_servers` on a fixed ~60 s tick (log at :56 each minute). Writing config, `hermes status`, `hermes gateway ensure`, and `touch`
did not shorten the wait. SIGUSR1 and SIGHUP terminate the gateway instead of reloading. So a new entry is usable 0-60 s after it is written (avg ~30 s).

**Reasoned, not tested (flagged):** a shared gateway exposes every registered MCP server to every session's agent. With one entry per session, session A's model
would also see session B's tools and could call them under B's identity: that breaks the isolation the bridge's per-session tokens exist to give. It would only
hold if `hermes chat -t/--toolsets` can scope MCP servers per run, which I could not test without a model call. Per-session entries also add the 0-60 s no-tools
window at the start of a session.

**State of the options:** (a) gateway per session preserves isolation by construction but is an architecture change (STATUS 2026-10-29 above); (b) has the
tool-visibility hole and the latency; (c) single-active-session identity is simple but only safe if Hermes sessions never overlap; (d) tool-arg identity is forbidden.

**Decision needed from the owner (a product fact, not something the repo answers):** do you ever run more than one Hermes session at the same time, or leave one
open while starting another? If never, (c) with a hard guard (refuse tool calls unless exactly one Cindy Hermes session is active, fail closed) is a small change
that restores the feature; if sometimes, (a) is the only isolation-safe route.

---

## 2026-10-29 — Phase 1: 1.5b-4b option (a) probe, gateway per session (free, mechanism `live-proven`)

**Outcome:** option (a) works as a mechanism, and it is expensive. Nothing built; 1.5b-4b stays open. Stub MCP server only, throwaway homes, no
model call, nothing under `~/.hermes*` touched, all four probe gateways stopped and scratch deleted. Table and detail:
`docs/evidence/1.5b-4b-attempt-not-proven.md`.

**Proven:** a per-session `HERMES_HOME` gives a per-session gateway whose MCP children receive that session's env: 4 homes, 4 gateways, 4 correct values.
A symlinked shared `config.yaml` works. `startHermesRun` already takes `hermesHome` per spawn; only `hermes-manager.ts:198` (and the route/config reads)
pass the daemon-wide home today, so the code change is small.

**Costs measured:** cold home 14.02 s and 8.69 s (9–14 s observed), warm 0.4 s, about 250 MB RSS per gateway.

**Not proven, and the real risk:** (1) a real `hermes chat` client starting the gateway with its own env (the probe used `gateway ensure`; 4a's leftover
gateway suggests yes, but that was by accident). (2) What a thin per-session home must share: credentials (`.env`, `auth.json`, Nous token refresh writes
back), models/route, plugins, skills, memories. Symlinks break if Hermes or `hermes-config.ts` writes with temp-file-plus-rename, which replaces the link
with a file. (3) Resume: Hermes session ids live under the home, so a Cindy session must always reuse its own home. (4) Lifecycle: stopping gateways at
session close and app quit, and reaping orphans, is new work. (5) The first turn of a new session pays the cold-start cost unless homes are pre-cloned
from a template.

**Where this leaves the options:** (a) is viable but is a real architecture change in how Cindy drives Hermes (state fragmentation, per-session process,
lifecycle), not a small wiring fix. (b) one shim entry per session is unprobed except for its reconcile latency (~60 s measured); a way to force reload
is the open question and would be a free probe. Both preserve today's bridge trust model. Recommendation: do one more free probe for (b)'s forced reload
(`hermes mcp`/gateway commands, no model call) before choosing, because (b) avoids per-session state and processes entirely if the latency can be removed.

---

## 2026-10-29 — Phase 1: 1.5b-4b free control experiment (design finding, `live-proven` for the mechanism)

**Outcome:** the identity-channel risk from the 4b attempt is now confirmed, not just suspected. 1.5b-4b stays open; **the current per-session-env
design (1.5b-1/-2/-3) cannot deliver a session id to the shim when one Hermes gateway serves several Cindy sessions.** No model call, no
`~/.hermes*` touched (throwaway `HERMES_HOME` in the scratchpad, gateway stopped, scratch deleted). Detail: `docs/evidence/1.5b-4b-attempt-not-proven.md`.

**Evidence:** (1) gateway started with `CINDY_PROBE=gateway-val`: an MCP child present at start got `gateway-val`. (2) an entry appended to `config.yaml`
from another process with a different env was reconciled by the gateway ~60 s later and also got `gateway-val`. (3) code: `hermes-run.ts` spawns
`hermes chat` as a client with the per-session env; Hermes routes it through the shared gateway. (4) the live 4b run: client env = app session id, shim got
the gateway's stale value.

**What this invalidates:** the 1.5b-1 decision "static `${CINDY_BRIDGE_SESSION}` in config.yaml + per-session `query/start` env" and the 1.5b-1/-3
unit tests only prove the app side. What still stands: bridge identity registration, the 0600 file, the shim's proxying, exposure policy,
mid-run config reconcile (~60 s latency, no trigger needed).

**Options, none built (owner decision):**
- (a) One Hermes gateway per Cindy session via a per-session profile/home (`--profile`, gateways are keyed by home). The shim env then really is per session.
  Cost: per-session home must share credentials and config; heavier startup; touches how `hermes-mgr` launches.
- (b) One shim entry per session (`cindy_docs__<id>`, session id baked into static `args`, token still in the 0600 file), written on session start
  and removed on dispose. Cost: Hermes needs ~60 s to reconcile a new entry, so the first turn would have no tools unless a reload can be forced.
- (c) Single-active-session identity read from the runtime file. Rejected here: breaks isolation with concurrent sessions.
- (d) Identity as a tool argument. Forbidden by the bridge's trust rule.

**Suggested next free step (my recommendation: look at (a) first):** read how `hermes-mgr` starts the gateway and whether a per-session profile is
viable, and test `--profile` isolation with the same stub-probe method. Not started.

---

## 2026-10-29 — Phase 1: 1.5b-4b attempt in the desktop app (FAILED, not proven)

**Outcome:** 1.5b-4b stays open, no label earned. Owner approved one more paid DeepSeek turn; it was spent and the tool did not connect.
Evidence and log excerpts: `docs/evidence/1.5b-4b-attempt-not-proven.md`.

**What was proven (live, in the app):** the injected hook runs in `maker-host`: the app's own `hermes-bridge-host` started the bridge with
`cindy_docs`, wrote the 0600 runtime file with the session entry, and wrote the static shim entry to `config.yaml`. Hermes reconciled that
entry live (`added=['cindy_docs']`), so **mid-run config pickup works** (closes the 1.5b-3 open item). No credentials were entered; the
sandbox ToS dialog was accepted only after the owner said yes.

**What failed:** the shim exited 3 times with `no bridge credentials for this session`; Hermes answered "no cindy_docs tool available".
Cause: the shim got a session id with no runtime-file entry. The Hermes gateway in use (pid started by my 4a harness) had
`CINDY_BRIDGE_SESSION=live-1b4` in its own env, and Hermes expands `${CINDY_BRIDGE_SESSION}` from the gateway env, not from the per-session
`query/start` env. So 4b was contaminated by 4a's leftover gateway.

**Real design risk this exposes (not yet proven by a clean run):** one gateway serves many Cindy sessions and connects each MCP server once, so a
per-session env var in `config.yaml` cannot carry per-session identity, even without the stale gateway. The 1.5b-1 probe used `hermes mcp test`
(expands from its own process env), which could not reveal this. A fix needs an owner decision on the identity channel (options below).
Second, smaller miss: my prompt's CSV was in the bot workspace, but the Hermes session ran in `dialogues/<date>/<session-id>/`; `read_sheet` is
bound to the session dir.

**Options for the owner (nothing built):** (a) one Hermes gateway per Cindy session so its env is the session's, checked first because it may
already be how hermes-mgr behaves on a clean start; (b) a single-active-session rule: shim reads "current session" from the runtime file, which
weakens isolation and is unsafe with concurrent sessions; (c) pass identity through a tool argument or a per-session MCP URL if Hermes supports
it, which today's bridge rules forbid ("never trust tool-arg identity"). A free first step before any paid turn: start the app clean with no
stale gateway, start a Hermes session, and `ps eww` the gateway to see what env it actually has.

**State handling:** backed up `config.yaml` to `config.yaml.bak-20261029-1.5b-4b` before the run; restored from it afterwards (identical).
Deleted the runtime file, the proof CSV in the dev sandbox workspace, stopped my leftover gateway and the dev app. `~/.hermes` untouched.
Gates not rerun: docs only, no code changed since the 1.5b-3 `EXIT=0` run.

---

## 2026-10-29 — Phase 1: 1.5b-4a live proof (harness-hosted bridge)

**Outcome:** 1.5b-4a `live-proven`. 1.5b-4b (same inside the running desktop app) is open; original 1.5b stays open. Owner accepted the
1.5b-3 choices ("lets go with your choices") and approved one paid DeepSeek turn; recorded in `docs/decisions/0003-hermes-cindy-tool-exposure.md`.

**Done:** (1) free probe, throwaway `HERMES_HOME`, no model call: real Hermes v0.22.5 spawned `node <shim> --server cindy_docs`, connected
in 679 ms to the real bridge and listed `read_sheet`. (2) One paid `hermes-cindy -z` turn on `deepseek-flash`: asked to call `read_sheet`
on a CSV I wrote (`pears,42`); it answered `42` and named the tool. Transcript: `docs/evidence/1.5b-4-live-proof-transcript.md`.

**State handling:** backed up `~/.hermes-cindy/config.yaml` to `config.yaml.bak-20261029` (no `sessions.json` existed to back up). The shim entry
was written and removed through the 1.5a writers; `config.yaml` is identical to the backup afterwards and `~/.cindy-harness/hermes-bridge.json`
is gone. `~/.hermes` untouched. No credentials read or written. The harness (a temporary vitest file) was deleted, not committed.

**Resolved from the 1.5b-3 open list:** `node` resolves on Hermes' PATH (shell had Node 22 first; a GUI-launched app may differ, check in 4b).
Hermes picked up the entry written moments before spawn (start-of-process read); mid-session re-read is still unknown and not needed.

**Honest limits:** bridge hosted by a script, not the app, so `maker-host` injection and the UI path are unproven (4b). No bridge-side
`tools/call` log and no Hermes session record exist; the claim rests on the unguessable `42`. The turn is two model requests (call + answer),
one chat turn. Gates not rerun: docs only (no code changed since the 1.5b-3 `EXIT=0` run).

**Next:** 1.5b-4b needs a second paid turn — ask the owner first. Still open from earlier: packaging of the shim bundle, a source for the gated opt-in.

---

## 2026-10-29 — Phase 1: 1.5b-3 main-process wiring

**Outcome:** 1.5b-3 `unit-tested`. Not `live-proven`: no real Hermes has loaded the shim (1.5b-4). Original 1.5b stays open.

**Changed (`apps/desktop/src/main`):**
- `mcp-integrations/hermesBridgeHost.ts` (new): `createHermesBridgePreparer` = the `prepareHermesBridgeSession` hook. Per turn it
  leases the shared local bridge, freezes the per-project policy into the ctx `vendorOptions` (disabled plugin ids via the plugin
  registry, allowed plugin ids, `RUNTIME_MCP_NAMES_KEY` = exposed servers), then calls `registerHermesBridgeSession`. Also
  `syncHermesShimRegistrations` (static `config.yaml` entries) and the exposure allow-list.
- `mcp-integrations/piEnvironment.ts`: new `acquireCindyToolBridge` (lease on the same Pi bridge generation; Pi behaviour unchanged)
  and `'hermes'` accepted in the provider session-context pass-through.
- `maker-host/index.ts`: injects the hook into `HermesAgent`. `maker-host/hermes-manager-client.ts`: `listHermesMcpServers`,
  `resolveHermesBridgeShimPath`. `bootstrap-electron.ts`: runtime file cleared on quit; the hook also clears it once per process
  before the first entry (stale file from a crashed run).

**Decisions (mine, reversible, please veto):**
- Exposure is fail-closed. Default: `cindy_docs` only. `cindy_browser`, `cindy_computer`, `cindy_ssh` are GATED and stay off
  because Hermes' approval hook is not wired (protocol "reserved M3"). Nothing supplies an opt-in yet (`optedInGatedServers`).
- `config.yaml` entries are written via the 1.5a helpers with a static command `node <shim> --server <name>` and
  `env: { CINDY_BRIDGE_SESSION: "${CINDY_BRIDGE_SESSION}" }`. Only entries pointing at our bundle are ever changed or removed;
  a user-owned entry with the same name is left alone.
- Shim bundle: dev `packages/cindy-tools/dist/hermes-bridge-shim.mjs`; packaged `resources/hermes-bridge-shim/`. Nothing ships it
  there yet, so a packaged app runs Hermes without Cindy tools (logged in ROADMAP Debt). Missing bundle = fail open, no tools.

**Verified (`unit-tested`):** `mcp-integrations/__tests__/hermesBridgeHost.test.ts` 8 pass: exposure policy, static shim config,
idempotent sync and user-entry protection, and the preparer against a real bridge with stub providers (identity + 0600 file,
only the SAFE entry written, a gated server's route refused, dispose removes the session, null without a bundle).
`hermesBridgeSession.test.ts` still 5/5.

**Gates (Node 22, exit 0):** `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene` ran as one
chain on the final tree, `EXIT=0`.

**Surprise:** a formatter hook rewrote `index.ts`, `bootstrap-electron.ts` and `piEnvironment.ts` wholesale after my edits (+1400
lines in `index.ts`). I restored those from git and re-applied only my hunks via script (diff +101/-1), then reran the gates.

**Open:** (1) `command: node` must resolve on Hermes' PATH, 1.5b-4. (2) Whether Hermes re-reads `config.yaml` for an already
running daemon or only at session start, 1.5b-4. (3) Known edge from 1.5b-1: re-registering a session id before the old handle's late
`dispose` removes the file entry; the shim then fails closed. (4) Packaging of the bundle. (5) A source for the gated opt-in.

---

## 2026-10-29 — Phase 1: 1.5b-2 stdio shim

**Outcome:** 1.5b-2 `unit-tested`. Not registered with Hermes or launched by the app (1.5b-3); original 1.5b stays open.

**Changed (all in `packages/cindy-tools`):**
- `src/hermes-bridge-shim/shim.ts`: `createBridgeShim` reads port+token for `CINDY_BRIDGE_SESSION` from the runtime file,
  connects a streamable-HTTP client to `http://127.0.0.1:<port>/mcp/<server>?session=<id>` with the bearer token, and
  proxies `tools/list` + `tools/call` (600 s call timeout, same as the desktop bridge) through a low-level stdio `Server`.
  Error results (`isError`) pass through unchanged.
- `src/hermes-bridge-shim/bin.ts`: `--server <name> [--runtime-file <path>]`, default `~/.cindy-harness/hermes-bridge.json`.
  Exits 1 with a stderr message (stdout stays the MCP channel) if the session env is unset or still the literal `${...}`.
- `build-shim.mjs` + `bundle:shim` script: esbuild → `dist/hermes-bridge-shim.mjs` (gitignored, ~800 KB, plain `node`).
  Bug found and fixed while verifying: the "run directly" guard compared `file://` strings and silently built nothing in
  this repo path (spaces); now uses `pathToFileURL`.

**Verified (`unit-tested`):** `hermesBridgeShim.test.ts` 6 pass against a stub HTTP MCP server enforcing Bearer token +
`?session=`: list/call proxy with token and session on every request, `isError` passthrough, fail-closed on missing file,
unknown session, truncated file, wrong version, stale token (401), dead port; plus the **esbuild bundle over real stdio**
(list/call round-trip) and bundle exit-1 on missing or un-interpolated session env.

**Gates (Node 22, exit 0):** typecheck ✅, test:runner ✅, test:unit:related ✅ (cindy-tools unit PASS), check:test-hygiene PASS (361 files).

**Open:** the shim has not talked to the real desktop bridge or a real Hermes (1.5b-3 wiring, 1.5b-4 live proof). The
bundle must be rebuilt/shipped by the app; where it lives at runtime is a 1.5b-3 decision.

---

## 2026-10-29 — Phase 1: 1.5b-1 session identity for Hermes tool calls

**Outcome:** 1.5b-1 `unit-tested`. Production wiring is **not** done (1.5b-3); the original 1.5b stays open.

**Probe (live, no model call, temp `HERMES_HOME` under the scratchpad, not `~/.hermes*`):** `hermes mcp test` with a stub
stdio server that dumps its env. Parent env is **not** forwarded to MCP children (`CINDY_PROBE` absent, 8 env keys).
`env: { CINDY_PROBE: "${CINDY_PROBE}" }` in `config.yaml` **is** interpolated from the parent env. So config.yaml carries a
static `${CINDY_BRIDGE_SESSION}` reference and the non-secret session id rides the existing per-session `query/start` env.
The token stays in the 0600 runtime file (owner's earlier decision).

**Changed:**
- `packages/maker-core/src/agents/base-agent.ts`: optional `AgentDeps.prepareHermesBridgeSession`.
- `packages/maker-core/src/agents/hermes/agent.ts`: calls it with the **Cindy** session id (`opts.sessionId`, not the
  daemon's random id), merges its env into `query/start`, disposes on `close()` and on start failure. Prep failure logs and
  continues without Cindy tools (fail open on convenience).
- `apps/desktop/src/main/mcp-integrations/hermesBridgeRuntimeFile.ts` (new): atomic 0600 file `{version, port,
  instanceId, sessions{id→token}}`, per-file write queue, stale `instanceId` drops old tokens, truncated file reads as absent.
- `apps/desktop/src/main/mcp-integrations/hermesBridgeSession.ts` (new): `registerHermesBridgeSession` registers ctx
  (`agentKind: 'hermes'`, `mcpCallerKind: 'root'`, attested) + HMAC per-session token, same model as `piEnvironment.ts`.

**Verified (`unit-tested`):** Hermes agent tests 25 pass (3 new: env + dispose, fail-open, dispose on failed start);
`hermesBridgeSession.test.ts` 5 pass against a **real** `startCodexHttpBridge`: tool call resolves `sess-A`, concurrent
sessions isolated, session A's id with session B's token → 401, dispose → 401 and entry removed, stale instance dropped.

**Open / known:**
1. Nothing injects the hook in `maker-host` yet, so no Hermes session registers today (1.5b-3).
2. Per-project tool policy (`CODEX_*_BUILTIN_PLUGIN_IDS_KEY`) is not frozen into `vendorOptions` yet (1.5b-3); the
   option exists on `registerHermesBridgeSession`.
3. Edge: if a session id is re-registered (resume) before the old handle's late `dispose`, the file entry is removed
   while the bridge keeps the new registration. Effect is fail-closed (shim cannot auth), not a leak.

**Gates (Node 22, exit 0):** typecheck ✅ (first run caught `opts.sessionId` being optional in `agent.ts`; hook now
skipped without a session id), test:runner ✅, test:unit:related ✅, check:test-hygiene PASS (361 files).

---

## 2026-10-29 — Phase 1: 1.5b split (no code changed)

**Outcome:** 1.5b stays 🔲. Split into 1.5b-1…4 in `ROADMAP.md`. Nothing built; label `unverified` for all.

**Why not done in one session:** reading `codexHttpBridge.ts` / `codexEnvironment.ts` / `piEnvironment.ts` showed
1. The loopback streamable-HTTP bridge already serves Cindy's in-process MCP servers (Codex/Pi use it), so the
   shim can be a thin stdio↔HTTP proxy.
2. Bridge tools resolve identity from a registered session ctx (per-session token + `?session=`, or Codex
   `threadId`), never from tool args. A Hermes turn has no such identity today — that is the real design work (1.5b-1).
3. `live-proven` needs a real model call (DeepSeek). Not made; needs owner approval (1.5b-4).

**Owner decision (this session):** shim gets port+token from a **0600 runtime file** written by the main process
at bridge start; `config.yaml` holds only a static command. Rejected: per-turn env, token in `config.yaml`.

**Next:** 1.5b-1 (session identity), then -2 shim, -3 wiring, -4 live proof. Gates not rerun (docs only).

---

## 2026-10-29 — Roadmap 0.8–0.12: built, split, and UI-proven

**Outcomes:** 0.8 `live-proven` · 0.9a ✅ done / 0.9b ✅ done (owner actions) · 0.10 `unit-tested` ·
0.11a `live-proven` / 0.11b "Back up now" `live-proven`, 0.11c "Restore…" `live-proven` ·
0.12 `live-proven`.

**Gates (Node 22, all exit 0):** typecheck ✅; test:runner 608 pass / 0 fail / 2 skipped
(+2 from the new scan test); test:unit:related ✅; check:test-hygiene PASS (361 files). Rerun in full
after the WAL fix below; same numbers.

**0.8 — `live-proven`.** Isolated dev app (`~/Library/Application Support/CindyGlobal-dev2-private`),
driven over CDP (Settings → General → Hermes Harness). Owner approved clicking Agree on the Terms of
Service prompt, but when I reconnected the dev profile was already past login/ToS, so I clicked nothing on it.
Backup first: `config.yaml.bak-2026-10-29-0.8`. Observed:
1. Default model `deepseek-flash` → `deepseek-v4-pro`, Save: `config.yaml` diff is exactly `default:` line 2.
2. Add Server (stdio, a local no-network stub MCP server `mini-mcp.mjs`, not a real third-party one): diff adds
   `mcp_servers: mini_mcp: command/args`. `hermes-cindy mcp list` showed it enabled; `mcp test` connected (449 ms),
   1 tool discovered. Hermes = v0.22.5.
3. Remove via UI + model back to `deepseek-flash`: `mcp list` → none. Net diff vs original: an empty
   `mcp_servers:` key and no trailing newline remain (Debt row; Hermes reads it fine).
Not done: a full chat turn using the MCP tool (would spend a DeepSeek call). Surprise: my first launch created an
empty `~/Library/Application Support/CindyGlobal` profile; left in place.

**0.9a — findings (history + tree scan, all refs).** 15 hits, all upstream test fixtures
(fake `ghp_0123…`, `AKIAIOSFODNN7…`, `sk-abcde…`); none in the 27 fork commits.
- `apps/desktop/.env`: untracked, gitignored; Google client id/secret + voice-provider settings, no ElevenLabs key.
- `~/.hermes-cindy/.env`: only `DEEPSEEK_API_KEY`, `OPENAI_BASE_URL`.
- ElevenLabs key location unknown (app reads `XDT_ELEVENLABS_API_KEY` / `ELEVENLABS_API_KEY` from env; earlier notes say `~/.zshrc`).
- `~/.hermes-cindy/auth.json` holds a live Nous login (`providers.nous`, `active_provider` null → unused). Not deleted.
**0.9b done (owner actions).** Owner ran `hermes-cindy logout --provider nous` ("Logged out of Nous Portal");
verified after: `auth.json` `providers` empty, `active_provider` null, `auth list` shows only `copilot` (gh CLI) and
`deepseek` (env). Owner reports the ElevenLabs key is rotated; I cannot verify that from here.

**0.10 — `unit-tested`.** Master Plan → `docs/cindy-master-plan.md` with historical banner (body SHA-256 verified,
then `~/Desktop/Cindy-Master-Plan.md` removed). `docs/decisions/0002-advisory-i18n-checks.md` keeps i18n/brand checks
advisory and resolves the Debt row.

**0.11a — `live-proven`.** `apps/desktop/src/main/backup/localBackup.ts` (+4 tests), `scripts/cindy-backup.mjs`,
`pnpm backup:create` / `backup:restore`. Round trip: real `~/.hermes-cindy` backed up, restored into temp dirs;
a SQLite row and `config.yaml` matched; `.env`/`auth.json` absent by design. Archive excludes `.env`, `auth.json`,
`auth.lock`, caches, SQLite `-wal/-shm`; `.db` files snapshotted via `sqlite3 .backup`. Restore renames replaced
files to `*.pre-restore-<stamp>`, never deletes.
**0.11b — "Back up now" `live-proven`; "Restore…" `typechecked` only.** Settings buttons (`channels.ts`
BACKUP_CREATE/RESTORE, `register.ts`, `preload.ts`, `vite-env.d.ts`, `HermesSection.tsx`). Clicking "Back up now" in the
running app wrote `~/.cindy-harness/backups/cindy-backup-20261029T163929Z.tar.gz` (887 entries); no `.env`, `auth.json`,
`-wal` or `-shm`; extracted `state.db` passes `integrity_check`. Left two archives from my UI runs in that folder.
**Bug found by the UI proof and fixed:** `sqlite3 .backup` keeps WAL mode, so the snapshot copy shipped its own
`state.db-wal`/`-shm` (empty), contradicting the 0.11a claim above. `snapshotSqlite` now sets `journal_mode=delete`
on the copy and drops empty leftover sidecars; the test fixture's `state.db` is now WAL mode and asserts no
`-wal`/`-shm` (red before the fix, 4/4 after).
**0.11c — `live-proven`.** Isolated dev app, but note the Hermes home is always the real `~/.hermes-cindy`.
Safety first: full copy outside it (`scratchpad/hermes-cindy-safety-2026-10-29.tgz`, 182 MB) and
`config.yaml.bak-2026-10-29-0.11c`. Steps: "Back up now" (UI) → appended a marker line to the live `config.yaml` →
clicked "Restore…" → native picker (driven with System Events keystrokes: Go to Folder + full path; background clicks
did not select rows) → confirm dialog "Restore and restart" (AXPress). Result: marker gone from live config, which is
byte-identical to the archive's; `config.yaml.pre-restore-20261029T170045Z` still holds the marker; 39 replaced
entries renamed `*.pre-restore-20261029T170045Z`, none deleted; `state.db` `integrity_check` ok; `hermes-cindy` starts
(v0.22.5) and `auth list` unchanged; the app relaunched itself (CDP back up).
**Clean-up left to the owner:** those 39 `*.pre-restore-*` entries in `~/.hermes-cindy` (not deleted by me, per
AGENTS.md), plus 4 archives in `~/.cindy-harness/backups` from my UI runs.

**0.12 — `live-proven`.** `scripts/upstream-security-scan.sh`, `pnpm upstream:scan`, test
`scripts/__tests__/upstream-security-scan.test.mjs` (2 tests, in `test:runner`). First scan (2026-10-29):
`upstream/main` at `727afb1ad6`, 999 commits since frozen SHA `7c5bd270c956417127e12a74934d0ecdb97ba55d`,
47 cherry-pick candidates (1 message, 2 deps, 46 path). Applied nothing.
**Quarterly reminder:** run `pnpm upstream:scan` next about **2027-01-29**, then every quarter.

Hermes backups: `config.yaml.bak-2026-10-29`, `hermes-mgr/sessions.json.bak-2026-10-29`.

**Open:** nothing in Phase 0. Phase 1 not started (owner has not asked).

---

## 2026-10-29 — Roadmap 0.7: fixture parity with a real transcript

**Outcome: `unit-tested`.** Captured one real `hermes-cindy chat --format stream-json
--query-file - --safe-mode -m deepseek-flash --provider deepseek` turn (prompt: run
`echo parity-check` in the terminal tool): 7 events (init, tool_use, tool_result, 3× text,
result). Real CLI = Hermes 0.22.5; this made one DeepSeek call through Hermes's own `.env`.
Backups taken first: `config.yaml.bak-2026-10-29`, `hermes-mgr/sessions.json.bak-2026-10-29`.

**Changed**
- `packages/maker-hermes-manager/src/__tests__/fixtures/real-hermes-transcript.ndjson`
  (new): the transcript with session id, tool-call id and timestamps redacted/synthetic.
- `.../__tests__/fixture-parity.test.ts` (new, 5 tests): runs `fake-hermes.mjs` and asserts
  every event kind in the real transcript exists in the fixture with identical keys and value
  types; `session_id` empty on `init` (`FAKE_INIT_EMPTY`) and set on `result`; same `tokens`
  keys; transcript contains no key-like strings.
- `.../fixtures/fake-hermes.mjs`: `emit()` now adds the `timestamp` key the real CLI adds.
  The parity test failed (`fixture lacks system/init`) without this and passes with it.

**Findings:** the real CLI also emits events in tool-then-text order, the fixture's happy
path emits text first; parity is asserted on shapes, not event order. A first capture attempt
without `-m/--provider` produced the real "safe-mode needs explicit model" error shape
(init with empty id, result exit_code 1).

**Verification:** package suite 63/63, `tsc --noEmit` clean. Gates: typecheck 0 (100s),
test:runner 0 (606/608, 2 skipped), test:unit:related 0 (531s), check:test-hygiene 0.
Not live-proven beyond the capture itself (the row requires 🧪).

**Open:** 0.8 next.

---

## 2026-10-29 — Roadmap 0.6: Hermes version-mismatch warning

**Outcome: `live-proven`.** Resumed Kimi's paused 0.6 draft. Baseline before any change
(Node 22.23.4): typecheck, test:runner (606/608, 2 skipped) and check:test-hygiene green;
`test:unit:related` red on exactly the 2 documented version-probe tests.

**Root cause:** `hermes-version.ts` used `/\b(\d+\.\d+\.\d+…)/`; there is no word boundary
between `v` and `0` in `v0.22.5`, so the real CLI output (`Hermes Agent v0.22.5 …`) never
matched. The handover's fixture-truncation hypothesis was **disproven**: the suite passes 5/5
with the original fixture. Fix: `/\bv?(\d+…)/` in `packages/maker-hermes-manager/src/hermes-version.ts`.
Tests were not weakened.

**Changed:** the Kimi draft (`config/status` RPC, protocol bundle `0.2.0`, fixture `--version`,
tests, `hermes-manager-client.ts` ping) plus the regex fix and a doc comment on
`getHermesModelCatalog`. `HANDOVER.md` §3 now describes the behaviour; the paused §10 is removed.

**Verification**
- Package suite 58/58 (7 files); `tsc --noEmit` clean.
- Live, built bundle `dist/hermes-mgr.mjs` with a temp `--hermes-home`, real RPC client:
  real `hermes-cindy` → `{"installedVersion":"0.22.5","matches":true}`, no warning;
  temp launcher printing v0.22.6 → `matches:false` + daemon log `Hermes CLI version mismatch`;
  missing launcher → `matches:null` + `Unable to verify Hermes CLI version`.
- Gates after the fix: `pnpm typecheck` 0 (107s); `test:runner` 0 (608: 606 pass, 2 skipped);
  `test:unit:related` 0 (532s); `check:test-hygiene` 0. `git diff --check` clean; no new
  outbound calls, credentials, `~/.hermes` references or upstream deletions.
- Backups taken before the 0.7 capture: `~/.hermes-cindy/config.yaml.bak-2026-10-29`,
  `~/.hermes-cindy/hermes-mgr/sessions.json.bak-2026-10-29`.

**Open:** 0.7 next.

---

## 2026-10-29 — Paused handoff: roadmap 0.6 still red

**Outcome: `unverified`; work stopped at the owner's request. No commit or push.** The version
pin was already recorded; the daemon warning implementation is present but unfinished and left
uncommitted intentionally. `HANDOVER.md` §10 is now the exact resume checklist.

**Changed before pausing**
- Added the draft `config/status` version probe and mismatch/failure warnings in
  `packages/maker-hermes-manager/src/{hermes-version.ts,hermes-manager.ts,protocol.ts,index.ts}`.
- Invoked status from `apps/desktop/src/main/maker-host/hermes-manager-client.ts`.
- Added fixture support and matching/mismatch/failure tests under
  `packages/maker-hermes-manager/src/__tests__/`.
- Updated `HANDOVER.md` with the paused state, current evidence, modified files and resume steps.

**Verification**
- Initial RED: **4 failed / 21 passed** (missing RPC and old bundle version).
- Current focused run: **2 failed / 23 passed**. Both valid-version cases return
  `installedVersion: null`; the failure-path and protocol tests pass.
- Direct fake `--version` output and real `hermes-cindy --version` (`0.22.5`) checks passed.
- Package build, full package/Desktop suites, live daemon proof, code review and all four
  required gates were **not run** for this diff. Do not reuse earlier green results as proof.

**Open:** diagnose the valid-version probe failures without weakening tests, complete focused and
live verification, run all gates, then update roadmap 0.6 honestly. Working tree must not be
reset or cleaned. Full details and commands are in `HANDOVER.md` §10.

---

## 2026-10-29 — Roadmap 0.5: atomic sessions registry

**Outcome: `unit-tested`.** The registry already used temp-write + rename; this task added
the missing corruption warning and regression proof without changing the persistence format.

**Changed**
- `packages/maker-hermes-manager/src/session-registry.ts`: warn on registry read/parse
  failures other than a missing file; truncated JSON still starts an empty registry.
- `packages/maker-hermes-manager/src/__tests__/session-registry.test.ts`: isolated real-file
  regression test for truncated JSON, empty recovery and one warning.
- `HANDOVER.md`: replaced the stale non-atomic-write warning with the current behavior.

**Verification**
- RED: the new test failed before the fix because no warning was emitted; GREEN afterward.
- Focused registry test **1/1**; full Hermes manager suite **55/55**; package `tsc --noEmit` passed.
- `pnpm typecheck`: exit **0**, 161.611s; scope **37 of 38** workspace projects.
- `pnpm test:runner`: exit **0**, 84.097s; **608 tests: 606 passed, 2 skipped, 0 failed**.
- `pnpm test:unit:related`: exit **0**, 578.965s; **30 runnable workspaces passed**, 7 skipped.
- `pnpm check:test-hygiene`: exit **0**; **361 files within baseline**.
- Code review reported no findings; `git diff --check` passed. No live daemon restart or live
  corruption exercise was performed; this entry makes no `live-proven` claim.

**Open:** roadmap 0.6 next (Hermes version mismatch warning).

---

## 2026-10-29 — Roadmap 0.1/0.4: Hermes compatibility and green gates

**Outcome: `unit-tested`.** Roadmap 0.4 is complete: all four default gates exit 0
under Node 22.23.4 with `NODE_OPTIONS` unset and the brokered filesystem hook disabled.
This was not a live mobile UI exercise. ADR 0001 is included in this tranche, completing
0.1 with frozen upstream SHA `7c5bd270c956417127e12a74934d0ecdb97ba55d`.

**Changed**
- Mobile Hermes compatibility in `apps/mobile/app/sessions/new.tsx`,
  `apps/mobile/src/session/*`, `apps/mobile/src/components/MobileAgentMark.tsx`,
  `MobileVendorIcon.tsx`, and `apps/mobile/src/device-link/*`: preserve existing Hermes
  sessions through runtime/cache projections, labels, menus, filters, auth hints, agent
  switching and marks. Mobile new-session choices remain Claude Code/Codex/Pi; Orca worker
  types stay narrow. Added/updated focused tests under `apps/mobile/src/__tests__/`,
  including `mobileAgentMark.test.ts`.
- Desktop favorites and selection in `apps/desktop/src/renderer/state/modelConfigCopy.ts`,
  `modelFavorites.ts`, and `components/new-chat/unifiedModelSelection.ts`: preserve stored
  Hermes favorites and placeholders without silently changing favorite identity.
- Shared/device-link identity in `packages/maker-shared/src/sessionList.ts` and
  `packages/device-link/src/modelFavorites.ts`.
- Repaired the known gate failures in the touched Desktop, browser-control-runtime and
  maker-core suites; kept the existing adapter behavior and added the required reset reason
  to `apps/desktop/src/renderer/__tests__/modelFavorites.test.ts`.
- Completed the inherited Phase 0 tranche: Node 22 enforcement (`.nvmrc`, `package.json`,
  `scripts/desktop-dev-runner.mjs`, `apps/desktop/src/main/cindy-make/doctor.ts`), packaged
  dependency declaration (`apps/desktop/forge.config.ts`), governance docs and ADR 0001.

**Verification**
- `pnpm typecheck`: exit **0**, 167.586s; recursive scope 37 of 38 workspace projects.
- `pnpm test:runner`: exit **0**, 85.971s; **608 tests: 606 passed, 2 skipped, 0 failed**.
- `pnpm test:unit:related`: exit **0**, 596.357s; prerequisite runner **606 passed / 2 skipped**;
  all **30 runnable workspaces passed**, 7 declared no-test workspaces skipped.
- `pnpm check:test-hygiene`: exit **0**; **361 files within baseline**.
- Focused suites: mobile seven files **173/173**; Desktop favorites **45/45**;
  unified model selection **71/71**; shared session list **43/43**.
- `git diff --check`: clean. Two independent code-review passes reported no actionable
  findings. No new outbound application calls, credentials, upstream deletions or Hermes
  mobile creation option were introduced.

**Open:** roadmap 0.5 next; no new live-proven claim for the mobile changes.

---

## 2026-10-28 — Paused handoff: 0.3 live-proven, 0.4 still red

**Session outcome**

Work stopped during roadmap **0.4** so the owner can resume later. This is not a
Phase 0 completion claim. No Phase 1 work was started. The working tree is
intentionally left uncommitted because the required gates are not all green;
there were no commits or pushes from this session. HEAD and `origin/main` are
both `05a8af84a1` (`docs(handover): add Phase 4 proposed feature roadmap`).

**Verified state by roadmap row**

- **0.1 — content complete, row remains open.** ADR 0001 and the Versions table
  record frozen upstream SHA `7c5bd270c956417127e12a74934d0ecdb97ba55d`.
  Its explicit done condition includes an ADR commit, which has not happened.
- **0.2 — `live-proven`.** The previous entry below records the packaged output,
  Hermes turn and Settings proof. Packaging required `@mixmark-io/domino` in
  `apps/desktop/forge.config.ts`; its regression test is in
  `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.
- **0.3 — `live-proven`.** `.nvmrc` is `22.23.4`; root `engines.node` is
  `>=22.12 <23`; `doctor.ts` rejects later majors; the dev runner exits before
  spawning Forge on a non-22 runtime and prints the required PATH export.
  Live negative check: `/opt/homebrew/bin/node scripts/desktop-dev-runner.mjs local`
  under Node **26.12.1** exited **1** with `Node.js 22 is required` and
  `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. The runner regression
  test also covers this early exit.
- **0.4 — in progress, not done.** Existing Hermes sessions/favorites are being
  made compatible with mobile read/display paths without adding a Hermes mobile
  new-session choice. The three choices remain Claude Code/Codex/Pi.
- **0.5–0.12 — untouched.** Resume in roadmap order after 0.4 is fully green.
  For 0.6 only the installed-version recording is done (`0.22.5`); the daemon
  mismatch warning is not implemented.

**0.4 changes currently in the working tree**

- `apps/mobile/src/session/sessionAgentSwitch.ts`,
  `apps/mobile/src/session/newSession.ts`, and
  `apps/mobile/src/device-link/mobileMakerTransport.ts`: use the shared
  `AgentKind` union and preserve Hermes session kind, label and vendor.
- `packages/device-link/src/modelFavorites.ts`: accept Hermes favorites without
  remapping them to another agent.
- `MessageRenderer.tsx`, `useConversationSearchFilterMenu.ts` and the two
  corresponding test files: display Hermes as Hermes.
- Regression reproduction before implementation: Hermes session mapping became
  `claude-code`, and Hermes favorite parsing threw `Invalid model favorite`.
  Both focused behaviors now pass.
- Deliberate boundary: do **not** add Hermes to mobile new-session options and
  do **not** widen Orca worker agent types merely to silence TypeScript.

**Current red compiler state**

Latest command: `pnpm --filter mobile typecheck` under Node **22.23.4** —
**failed with 24 errors**. Grouped locations:

- `app/sessions/[sessionId].tsx`: 2890, 2894, 8699, 8789, 8799, 8855.
- `app/sessions/new.tsx`: 693, 1164, 4182, 4369, 4390, 4648, 4723, 5463.
- `src/__tests__/sessionAgentSwitch.test.ts`: 53.
- `src/session/MobileAgentSwitcher.tsx`: 109.
- `src/session/newSession.ts`: 1158.
- `src/session/sessionAgentSwitch.ts`: 52.
- `src/session/UnifiedModelPickerView.ios.tsx`: 204, 378, 442.
- `src/session/UnifiedModelPickerView.tsx`: 387, 500, 691.

Intended narrow fixes, not yet applied:

1. Widen the DB/runtime/queued-message agent unions in
   `apps/mobile/src/session/types.ts` (lines 77, 121 and 243 at time of pause)
   to include Hermes. Do not change unrelated protocol fields.
2. Add an explicit Hermes branch to `src/components/MobileAgentMark.tsx`; the
   desktop wing geometry is in
   `apps/desktop/src/renderer/components/icons/HermesMark.tsx`. Never fall
   through to the Claude glyph for Hermes.
3. Widen `agentAuthGateVerdict` / `agentAuthGateHint` in
   `src/session/agentAuthGate.ts` to `AgentKind`, retaining actual provider
   routing through `connectedProvidersForAgent`, and label Hermes explicitly.
4. In `app/sessions/new.tsx` around line 678, make collaboration ineligible for
   Hermes and narrow the draft agent to the existing Orca union before calling
   `readOrcaCollabEntryStatus`. Do not widen `OrcaWorkerAgentKind`.
5. Fix the Hermes-as-Claude fallback in `src/session/sessionMenu.ts` around
   line 224 with the shared label helper or an explicit branch.

**Verification run during this handoff**

- `pnpm test:runner`: **PASS** — 608 tests, 606 passed, 2 skipped, 0 failed;
  Windows-only atomic rename check skipped on macOS.
- Mobile focused tests (`sessionAgentSwitch`, `conversationSearchFilterMenu`,
  `newSession`): **PASS** — 3 files, 185 tests.
- Device-link `modelFavorites`: **PASS** — 1 file, 5 tests.
- `pnpm --filter mobile typecheck`: **FAIL** — 24 errors listed above.
- Root `pnpm typecheck`, `pnpm test:unit:related`, and
  `pnpm check:test-hygiene` were **not rerun** after the latest mobile edits.
  Do not represent this handoff as a green gate set.
- `git diff --check`: **PASS** at the start of the handoff.

**Files to preserve**

All current modifications and untracked files are part of the paused state;
do not reset or clean them. The groups are:

- Governance/docs: `AGENTS.md`, `HANDOVER.md`, `ROADMAP.md`, `STATUS.md`,
  `docs/decisions/0001-upstream-strategy.md`,
  `docs/design-rules/design-inventory.md`, and
  `scripts/__tests__/dev-docs-contract.test.mjs`.
- Packaged build: `apps/desktop/forge.config.ts` and
  `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.
- Node 22: `.nvmrc`, `package.json`,
  `apps/desktop/src/main/cindy-make/doctor.ts` and its test,
  `scripts/desktop-dev-runner.mjs`, and
  `scripts/__tests__/restart-desktop-remote.test.mjs`.
- Paused 0.4 work: the mobile/device-link files listed above.

**Exact resume sequence**

1. Read `AGENTS.md`, this entry, `ROADMAP.md` 0.4 and `HANDOVER.md`; run
   `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` and inspect `git status`.
2. Apply only the remaining 0.4 compatibility fixes; add focused red/green
   regression coverage for the auth hint, menu label and Hermes mark.
3. Rerun `pnpm --filter mobile typecheck` and the focused tests above. Resolve
   residual errors locally; do not cast Hermes to Claude or widen Orca.
4. Run all required gates in order: `pnpm typecheck`, `pnpm test:runner`,
   `pnpm test:unit:related`, `pnpm check:test-hygiene`.
5. Only after all four pass, update roadmap statuses, commit with `git commit -s`
   and push `origin main`. Then continue 0.5–0.12 in order; do not start Phase 1
   without the owner's explicit approval.

---

## 2026-10-28 — Phase 0.1/0.2: frozen versions and packaged Hermes proof

**Did**
- Recorded frozen upstream merge-base `7c5bd270c956417127e12a74934d0ecdb97ba55d`
  in `docs/decisions/0001-upstream-strategy.md` and `HANDOVER.md` §Versions.
- Recorded installed Hermes CLI **0.22.5** (2026.9.24, stable; local
  `bf0203a794a0`) in `HANDOVER.md` §Versions. This completes only the recording
  portion of 0.6; its daemon version-mismatch warning remains open.
- Packaged the app with `pnpm release:package`. Added `@mixmark-io/domino` to
  `NATIVE_RUNTIME_DEPS` in `apps/desktop/forge.config.ts` after the first package
  exposed the missing Node HTML parser required by bundled turndown. Added a
  regression assertion in `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.

**Verification: `live-proven`**
- Packaged output: `/tmp/cindy-packaged-proof.IIrqMS/app/Cindy.app`.
- Launched that app with isolated user data, confirmed the Cindy name/icon, and
  selected Hermes. A real prompt returned exactly `PACKAGED_HERMES_OK` in session
  `3a19ab0c-8567-4407-8af3-49b108187262`, proving the packaged daemon/bundle path
  and a complete Hermes turn.
- Opened packaged Settings and confirmed the Hermes card renders the active home,
  DeepSeek default route, MCP server section, enabled `superpowers` plugin, and
  12 active skill categories.

**Open for next agent:** roadmap 0.3 (Node 22 enforcement). Gates for this entry
are recorded below after their final run.

---

## 2026-10-28 — Documentation restructure (handover → AGENTS / ROADMAP / HANDOVER / STATUS / ADR)

**Did**
- Split the old monolithic `HANDOVER.md` into: `AGENTS.md` (rules), `ROADMAP.md`
  (single source of truth for task status), `HANDOVER.md` (stable reference),
  `STATUS.md` (this log), `docs/decisions/0001-upstream-strategy.md`.
- Re-opened task **1.5** as 1.5a (MCP config management — done) and
  **1.5b** (real Cindy tool bridge — not started). The original "done" mark
  described a config editor, not a bridge; Hermes still cannot call Cindy's
  Browser/SSH/Docs tools.
- Moved the old "Phase 4" feature wishlist to **Parked** in the roadmap.
- Recorded the upstream decision: **freeze + cherry-pick security fixes** (ADR 0001).

**Verification:** documentation only — n/a.

**Open for next agent:** Phase 0 in `ROADMAP.md`, starting with 0.1 (packaged build)
and 0.5 (record Hermes version). Fill the blanks in the `HANDOVER.md` Versions table.

---

## 2026-10-28 — Local cleanup (old §6.8b)

**Did**
- Deleted the dead Help feature backend: `help-knowledge/` (25 docs),
  `maker-ipc/help.ts`, `help-feedback.ts`, `helpKnowledge.generated.ts`,
  renderer `helpThreadStore`, shared `helpTypes`, `gen-help-kb` scripts and tests,
  plus IPC channels/preload/type entries. The Help UI was already gone, so this
  was unreachable code.
- Deleted upstream PR/mobile evidence: `docs/e2e-evidence/`, `docs/pr-assets/`,
  `prototypes/`.
- Removed a stray empty `apps/desktop/C:/locks` directory (Windows path artifact).

**Verification:** `typechecked` (desktop `tsc --noEmit`), `test:runner` green
apart from the two known pre-existing failures.

**Note:** these deletions were made before the upstream decision. Under ADR 0001
(freeze) they are now acceptable. Further upstream deletions still require the
rule in `AGENTS.md` §3.

---

## 2026-10-27 — De-clouding pass (old §6.8a) and Phase 2 items

**Did**
- Settings: removed Shared Tasks, Help, the "Not signed in" banner (now
  "Data stays on this device"), manual update/log-upload rows, auto-update /
  analytics / crash-upload toggles.
- About: version always shown; harness update checks report "unavailable" when no
  vendor endpoint is configured; official CDN checks skipped when unconfigured.
- Bots: all IM channels except **Telegram** removed from the UI; Feishu / WeChat /
  WeCom / DingTalk / Discord UI files deleted; builtin plugin metadata retired.
- Log noise: migration status poll returns an idle view instead of erroring every
  10 s; bot-group retry stops on non-retryable codes.
- **2.1** App-wide "Sign in to Cindy" sweep: `HomeZeroModelAction.tsx`,
  `ConnectProviderBanner.tsx`, `ConnectProviderCard.tsx` now route to local/BYOK
  provider wizards in local mode; managed-service row suppressed. 20 tests passing.
- **2.4** ElevenLabs key fallback: `readElevenLabsApiKey()` falls back to the
  `elevenlabs-api` / `elevenlabs` custom provider credential or `voice-asr` key
  when `ELEVENLABS_API_KEY` is absent. `elevenLabsKeyFallback.test.ts`.
- **2.5** Voice zero-input notice in `VoiceInputOverlay.tsx` instead of silent
  dismiss. Strings added for en/zh-CN/zh-TW/ja/ko.
- **2.7** English-only runtime lock: `LanguageSection` offers English only;
  `bootstrap-electron` and `i18n` default `DEFAULT_LOCALE` to `en`. Renamed
  `siliconflow-global` base name to `SiliconFlow`; `nameEn` used on provider import
  and preset OAuth creation; English `CINDY_DEFAULT_IDENTITY` with legacy
  recognition fallback; bot import invites default to English; bot draft
  expiration error translated.

**Verification**
- De-clouding surfaces: `live-proven` (CDP DOM sweeps of Settings / About / Bots).
- 2.1, 2.4, 2.5, 2.7: `unit-tested` (`botStore.modelSettings.test.ts`,
  `botTemplatePreset.test.ts`, `addProviderWizardPresetEntry.test.tsx`,
  `nativePackage.test.ts`, `elevenLabsKeyFallback.test.ts`).
- Note: 2.5 added four non-English locales for a notice that 2.7 made unreachable.
  Harmless, but see roadmap 0.4 (i18n gate decision).

---

## 2026-10-26 — Hermes MCP server config management (old §6.7, was "task 1.5")

**Did**
- `packages/maker-hermes-manager/src/hermes-config.ts`: line-based
  `parseHermesMcpServers`, `writeHermesMcpServer`, `removeHermesMcpServer` for
  `mcp_servers:` in `$HERMES_HOME/config.yaml`. Supports Streamable HTTP/SSE and
  stdio entries; preserves formatting and comments.
- `protocol.ts` / `hermes-manager.ts`: `config/listMcpServers`,
  `config/setMcpServer`, `config/removeMcpServer` RPCs.
- `hermes-manager-client.ts`: `HermesHomeStatus.mcpServers`, `setHermesMcpServer`,
  `removeHermesMcpServer` host helpers.
- `maker-ipc/`: `HERMES_CONFIG_SET_MCP_SERVER`, `HERMES_CONFIG_REMOVE_MCP_SERVER`
  channels, handlers, preload and `vite-env.d.ts` entries.
- `HermesSection.tsx`: MCP Servers list with transport badges (`http` / `stdio`),
  inline add form, remove action.

**Verification:** `unit-tested` — 14 cases in `hermes-config.test.ts` against
synthetic YAML. **Not** tested against a Hermes-generated `config.yaml`, and never
confirmed that Hermes loads a server Cindy wrote. See roadmap **0.7**.

**Correction (2026-10-28):** this is task **1.5a**. It does not bridge Cindy's
tools into Hermes. **1.5b** remains open.

---

## 2026-10-25 — Hermes settings surface (old §6.6, task 1.6)

**Did**
- `hermes-manager-client.ts`: `getHermesHomeStatus` returning home path, default
  route, provider models, installed plugin metadata, skills categories.
- `maker-ipc/channels.ts` + `register.ts`: `maker:hermes-config:get-status`.
- `HermesSection.tsx` card in General settings: home path, runtime status,
  "Reveal Folder", default model select + save, installed plugins (status and
  repository source), active skills categories.

**Verification:** `typechecked` only (`tsc --noEmit`). The old handover's
"verified" claim is downgraded: no unit test and no recorded live check of the
rendered data. Roadmap row 1.6 reflects this.

---

## 2026-10-25 — Image attachments for Hermes (old §6.5, task 1.4)

**Did**
- `packages/maker-core/src/agents/hermes/agent.ts`: `flattenUserMessage` inlines
  image attachments as `Attached image <name> located at: <path>`;
  `capabilities.multimodal.image = { supported: true }`.

**Verification:** `unit-tested` (`agents/hermes/__tests__/agent.test.ts`).
Not live-proven with a vision-capable model.

---

## 2026-10-24 — Auto-title and prompt prediction for Hermes (old §6.4, task 1.2)

**Did**
- `apps/desktop/src/main/maker-ipc/title.ts`: `hermes` added to
  `TITLE_AGENT_KINDS`. Sessions no longer fail `maker:auto-title` /
  `maker:predict-prompt` with `INVALID_PARAMS: invalid agentKind`.

**Verification:** `unit-tested` (`autoTitleIpcBoundary.test.ts`,
`predictPromptIpcBoundary.test.ts`).

---

## 2026-10-24 — Resume correctness (old §6.3, task 1.3) — commit `f1df8f8a08`

**Did**
1. **Stale resume id** (`No session found matching '<id>'`): daemon holds that
   attempt's events, drops the dead id, emits a `resume-reset` notice, replays the
   same message on a fresh session.
2. **Session-id bind point**: current Hermes sends `system/init` with
   `session_id: ""` and puts the real id on the `result` event. The daemon only
   bound from `init`, so no session was ever resumable. Now binds from either.

**Verification:** `live-proven` — two turns on one daemon session returned the
codeword stored in turn 1.

**Risk recorded:** depends on undocumented Hermes CLI event shape. Hermes version
at time of fix was **not recorded**. See roadmap **0.5**.

---

## 2026-10-23 — Model picker and default route (old §6.2, task 1.1)

**Did**
- `config/getDefaultRoute`, `config/setDefaultRoute`, `config/listModels` RPCs.
- Per-session override via `query/setModel` (empty string = follow home default).
- `useHermesModelCatalog` merges the home default with the provider's live
  `GET /models`.
- Footer action "Set <model> as the Hermes home default" writes `config.yaml`
  surgically (preserves comments/order, quotes scalars).

**Verification**
- Picker listing: `live-proven` (showed `Hermes home default (deepseek-v4-flash)`,
  `deepseek-flash`, `deepseek-v4-pro`).
- Default-route **write**: `unit-tested` only — the button was deliberately never
  clicked live. See roadmap **0.6**.

---

## 2026-10-22 — Hermes RPC core and session registry (old §6.1)

**Did**
- `maker-hermes-manager` daemon: NDJSON RPC over Unix socket; spawns one
  `hermes chat` process per turn; `sessions.json` registry under
  `~/.hermes-cindy/hermes-mgr/`.
- Safe mode with explicit default model; `--yolo` mode.
- Provider keys passed per-session in memory only; never persisted.
- Fail-closed guard against `~/.hermes`.
- `fake-hermes.mjs` test fixture.

**Verification:** `live-proven` — end-to-end turns with the real CLI and real
DeepSeek provider: text streaming, tool calls/results, token usage, clean closes.

---

## Standing known issues (carry forward until fixed)

| Issue | Owner task |
|---|---|
| Daemon does not warn when Hermes differs from the pinned version | 0.6 |
| `sessions.json` written non-atomically | 0.5 |
| ElevenLabs key may need rotation; unused Nous login | 0.9 |
| 136 commits behind upstream | ADR 0001 — resolved: freeze |
