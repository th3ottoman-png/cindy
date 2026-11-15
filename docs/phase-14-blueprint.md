# Phase 14 blueprint — Cindy Doctor (diagnose, snapshot, repair)

Owner request, 2026-11-15: "something will go wrong in the future, either updates or whatever the
reason, so build a built-in doctor to fix the system." This file is the full plan for ROADMAP
Phase 14. An agent picking a 14.x row reads **§0, §2, §10 and that row's section in §11** before
writing code. Rows go in the order given in §12.

---

## §0 What the doctor is (and is not)

**One sentence:** a standalone tool that tells the owner, in plain words, what is broken in
Cindy + Hermes + the Claude Code / Codex / Pi runtimes, why, and the one safe action to fix it —
and that keeps last-known-good copies of the config so a bad change can be undone.

Principles (they come from AGENTS.md §6 and override convenience):

1. **CLI first, UI second.** `pnpm doctor` must work when the desktop app does not start. The
   Settings section (14.8) is a viewer over the same checks, never a second implementation.
2. **Read-only by default.** `pnpm doctor` with no flags changes nothing — no files, no
   processes, no network beyond local endpoint probes that already exist (2.2a).
3. **Every fix is explicit, previewed, backed up, verified, and reversible** (§5). No fix runs at
   app start. No fix runs because a check failed. The owner clicks or passes `fix <id>`.
4. **Plugin boundary.** Checks and fixes register through one registry (§2). Adding a check is
   one new entry in its pack's list. No central switch statement.
5. **Fail closed on safety.** A check that crashes or times out reports `fail` ("check crashed:
   …"), never `ok`. A fix whose re-check fails rolls back and says so.
6. **No hidden state.** The report names every file, path, version, and command it looked at.
7. **Never `~/.hermes`.** The doctor reads `~/.hermes-cindy`, `~/.cindy-harness`, the Cindy user
   data dir and the repo. It reuses `assertNotDailyHermes` (`apps/desktop/src/main/backup/localBackup.ts`).
8. **Credentials never leave memory.** `.env`, `auth.json`, key values: the doctor may report a
   key *name* is set or missing, never its value; snapshots and bundles exclude them (§4, §9).

Not in scope: auto-update of any runtime, telemetry, remote help, "self-healing" loops, editing
system prompts, changing Claude Code / Codex / Pi adapter behaviour, pruning storage (13.2c owns it).

---

## §1 What already exists — reuse, do not rebuild

| Need | Already in the repo | How the doctor uses it |
|---|---|---|
| Runtime path + version + pin | `packages/maker-core/src/runtimes/runtime-status.ts` (`parseRuntimeVersion`, `buildRuntimeStatus`), `apps/desktop/src/main/maker-ipc/runtimes.ts` (12.5) | Runtime checks call the pure model; the CLI resolves binaries the same way (PATH + `--version`, 5 s timeout) |
| Hermes pin | `packages/maker-hermes-manager/src/hermes-version.ts` (`HERMES_CLI_PINNED_VERSION`, `readInstalledHermesVersion`) | `runtime.hermes.pin` check. Today: installed 0.23.0, pin 0.22.7 → `warn` |
| Behaviours to re-verify on upgrade | `HANDOVER.md` §3 Versions, Hermes row (session_id on `result`, `agent.log` lines, `pre_tool_call` ~30 s cap, `--safe-mode` provider rewrite, web tool names) | The canary (§6) turns that prose list into checks |
| Event-shape fixtures | `packages/maker-hermes-manager/src/__tests__/fixtures/real-hermes-0.22.5.ndjson`, `real-hermes-0.23.0.ndjson`, `fixture-parity.test.ts` (0.7) | Canary compares a fresh capture against them with the same shape comparator (extract it into a shared helper) |
| Fake Hermes for tests | `packages/maker-hermes-manager/src/__tests__/fixtures/fake-hermes.mjs` | All doctor tests that need a Hermes binary use this, never the real one |
| Full backup / restore | `scripts/cindy-backup.mjs` → `apps/desktop/src/main/backup/localBackup.ts` (`createBackup`, `restoreBackup`, `defaultBackupPaths`, move-aside to `.pre-restore-<stamp>`) | Heavy snapshot = this tarball (`pnpm backup:create`). LKG snapshots (§4) are a small, config-only layer next to it; restore reuses the move-aside convention |
| Config parsers / validators | `packages/model-providers/src/routingFile.ts` (incl. 13.8 `workers:`), `packages/maker-core/src/providers/routing-file.ts`, the providers.yaml reader, `packages/maker-hermes-manager/src/web-budget.ts`, `guardrails.ts`, experts `tools.yaml` reader (3.2b) | Config checks call these; they never re-implement YAML schemas |
| Endpoint probes | `packages/maker-core/src/providers/discovery.ts` (`probeEndpoint`, `discoverEndpoints`), `route-preflight.ts`, `packages/model-providers/src/routeHealth.ts` (`assessRoute`) | Endpoint checks + "route X is blocked because…" |
| MCP catalog + health | `packages/maker-core/src/mcp/mcp-catalog.ts` (`buildMcpCatalog`, `checkMcpHealth`) | `proc.mcp.*` checks |
| Daemon RPC | `packages/maker-hermes-manager/src/protocol.ts` (`protocol/hello`, `config/status`, `session/list`), `client.ts`; socket path `hermesManagerSocketPathFor(userData)` in `apps/desktop/src/main/maker-host/hermes-manager-client.ts` | `proc.daemon` check connects to the socket and calls read-only methods only |
| Storage sizes | `packages/maker-core/src/storage/housekeeping.ts` (`planHousekeeping`), ADR 0014, 13.2c Prune | `data.storage` reports sizes and points at Settings → Storage. The doctor never prunes |
| Is the app running | `scripts/desktop-whoami.mjs`, `scripts/desktop-dev-verdict.mjs` | Pattern for `proc.app` |
| User data dir | `defaultBackupPaths()` → `~/Library/Application Support/CindyGlobal-dev2-private` (DB `cindy-local-v1.db`) | `ctx.paths.userDataDir` default |
| Error banner "Diagnose" | `apps/desktop/src/renderer/components/chat/ErrorBanner.tsx` (`onDiagnose`) | Untouched in Phase 14 |

---

## §2 Architecture

```
scripts/cindy-doctor.mjs                    ← CLI entry (pnpm doctor), app may be closed
        │
packages/maker-core/src/doctor/             ← subpath @cindy/maker-core/doctor
   types.ts        DoctorCheck, DoctorFix, CheckResult, DoctorReport, DoctorContext
   registry.ts     createRegistry(packs) → { checks, fixes }, duplicate-id guard
   runner.ts       runChecks(registry, ctx, {only, cost}) → DoctorReport (never throws)
   redact.ts       redactText / redactConfig (key values, tokens, home path → ~)
   report-text.ts  formatReportText / formatReportJson / formatReportMarkdown
   context.ts      createNodeContext(): real fs/exec/probe adapters + paths      (14.2)
   snapshots.ts    takeSnapshot / listSnapshots / restoreSnapshot / pruneSnapshots (14.5)
   fix-runner.ts   previewFix / applyFix (backup → apply → re-check → rollback)   (14.6)
   canary/         hermes-canary.ts, contracts.ts, cli-help-diff.ts              (14.7)
   packs/
     index.ts      ALL_PACKS = [environment, runtimes, config, endpoints, processes, data]
     environment.ts runtimes.ts (14.2) · config.ts (14.3) · endpoints.ts processes.ts data.ts (14.4)
        │
apps/desktop/src/main/maker-ipc/doctor.ts                         ← (14.8) IPC
apps/desktop/src/renderer/components/settings/DoctorSection.tsx   ← (14.8) viewer
```

### §2.1 Types (starting point; adjust names to house style after reading neighbours)

```ts
export type DoctorLayer = 'environment' | 'runtimes' | 'config' | 'endpoints' | 'processes' | 'data';
export type Severity = 'ok' | 'warn' | 'fail' | 'skip';
export type CheckCost = 'instant' | 'fast' | 'slow'; // timeouts: 500 ms / 3 s / 30 s

export interface CheckResult {
  id: string;                 // 'runtime.hermes.pin'
  severity: Severity;
  summary: string;            // one line, plain English: "Hermes 0.23.0 installed, pin is 0.22.7"
  detail?: string;            // why it matters + what was looked at (paths, commands)
  action?: string;            // the ONE next step: "Run pnpm doctor canary --runtime hermes"
  fixIds?: string[];          // fixes that can address it (§5)
  evidence?: Record<string, string | number | boolean | null>; // redacted
  durationMs: number;
}

export interface DoctorCheck {
  id: string;
  layer: DoctorLayer;
  title: string;
  cost: CheckCost;
  dependsOn?: string[];       // skip with reason if a dependency failed
  needs?: Array<'app-closed' | 'app-running'>;
  run(ctx: DoctorContext): Promise<Omit<CheckResult, 'id' | 'durationMs'>>;
}

export interface DoctorFix {
  id: string;                 // 'fix.config.restore-lkg'
  title: string;
  risk: 'moves-files' | 'kills-process';
  needsAppClosed: boolean;
  recheck: string[];          // check ids re-run after apply
  preview(ctx: DoctorContext, target?: string): Promise<FixPlan>;   // no side effects
  apply(ctx: DoctorContext, plan: FixPlan): Promise<FixOutcome>;
}

export interface FixPlan { fixId: string; target?: string; steps: string[]; touches: string[]; }
export interface FixOutcome { ok: boolean; rolledBack: boolean; message: string; recheck: CheckResult[]; }

export interface DoctorReport {
  startedAt: string; durationMs: number; host: { node: string; platform: string };
  counts: Record<Severity, number>;
  results: CheckResult[];     // fixed order: layer order, then registration order
}

export interface DoctorContext {
  paths: { home: string; hermesHome: string; harnessDir: string; userDataDir: string; repoRoot: string; socketPath?: string };
  fs: Pick<typeof import('node:fs/promises'), 'readFile' | 'stat' | 'readdir' | 'access'>;
  exec(cmd: string, args: string[], opts: { timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  probe: typeof import('../providers/discovery').probeEndpoint;
  now(): Date;
  signal: AbortSignal;
}
```

### §2.2 Runner rules

- Runs checks in layer order `environment → runtimes → config → endpoints → processes → data`.
  Within a layer, registration order for output; independent checks may run in parallel (cap 4).
- Each check is wrapped: timeout by `cost`; any throw/timeout → `fail` with summary
  `check crashed: <message>` or `check timed out after <n> ms`. The runner itself never throws.
- `dependsOn` failed or skipped → `skip`, summary `skipped: <dep> failed`.
- `needs: ['app-closed']` while the app is running → `skip` with that reason (and the reverse).
- `cost` filter: default CLI run = `instant,fast`; `--all` adds `slow`; app start = `instant,fast`.
- Output is deterministic for the same inputs (tests snapshot the text formatter).

### §2.3 Loading the core from the CLI (spike first in 14.2)

`scripts/cindy-backup.mjs` loads a `.ts` file directly with Node 22 type stripping; that works
because `localBackup.ts` imports only `node:*`. The doctor imports workspace code
(`@cindy/model-providers`, maker-core subpaths). **Spend ≤ 15 minutes first:** try Node 22 type
stripping on `packages/maker-core/src/doctor/index.ts`. If extensionless or workspace imports
fail, run the CLI through `vite-node` (already in `node_modules/.bin`) or bundle with the repo's
`esbuild` (also present) into a git-ignored cache dir at run time. Record the choice and why in
STATUS. **Do not add a new dependency.** Whatever is chosen must work with the app closed and
start in < 3 s.

---

## §3 Check catalogue (initial set; ids are stable API)

Severity guide: `fail` = something the owner uses is broken now; `warn` = works now, likely to
break or degrade; `ok`; `skip` = could not run, with reason.

### Layer `environment` (pack `environment.ts`, row 14.2)

| id | What it checks | fail / warn when | Action text |
|---|---|---|---|
| `env.node` | `process.version` major is 22 | fail ≠ 22 | `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` |
| `env.pnpm` | `pnpm --version` vs HANDOVER pin 10.33.2 | warn mismatch, fail missing | name the pinned version |
| `env.native-sqlite` | `better-sqlite3` loads under this Node (NODE_MODULE_VERSION) | fail on ABI error | `pnpm rebuild better-sqlite3` (printed, not run) |
| `env.paths` | `~/.hermes-cindy`, `~/.cindy-harness`, user-data dir exist and are writable | fail missing/unwritable | which path, which permission |
| `env.disk` | free space on the volume holding `~/.hermes-cindy` | warn < 5 GB, fail < 1 GB | point at Settings → Storage |
| `env.hermes-home` | the `hermes-cindy` launcher points `HERMES_HOME` at `~/.hermes-cindy` (read the launcher's text, do not run it) | fail if it resolves to the daily home | — |

### Layer `runtimes` (pack `runtimes.ts`, row 14.2; canary checks added in 14.7)

| id | What it checks | fail / warn when |
|---|---|---|
| `runtime.hermes.present` | `hermes-cindy` on PATH, `--version` parses | fail missing / unparsable |
| `runtime.hermes.pin` | installed vs `HERMES_CLI_PINNED_VERSION` | warn mismatch; action: run the canary (§6) |
| `runtime.claude.present`, `runtime.codex.present`, `runtime.pi.present` | resolve as the adapters do (12.5 logic), `--version` | fail missing **only if** a roster agent uses it, else `skip` ("not used") |
| `runtime.<name>.changed` (14.7) | version differs from the latest LKG snapshot's `versions.json` | warn: "Claude Code changed 2.1.296 → 2.1.300 since <date>; run the canary" |
| `runtime.hermes.canary-fresh` (14.7) | a canary result for the installed version exists and passed | warn none, fail last canary failed |

### Layer `config` (pack `config.ts`, row 14.3)

Each check: file exists (a missing optional file → `ok` "not configured"), parses, validates with
the existing reader, and cross-references resolve.

| id | File | Cross-references |
|---|---|---|
| `config.providers` | `~/.cindy-harness/providers.yaml` | each `keyEnv` name is set in the environment (report the name only) |
| `config.routing` | `~/.cindy-harness/routing.yaml` | every route → known provider; every task-class rule → known route; `workers.allowed_routes` → known routes (13.8) |
| `config.experts` | `~/.cindy-harness/experts/*/` (expert frontmatter + `tools.yaml`) | expert route exists; `mcp_servers.allow` names exist in the MCP catalog; toolsets known |
| `config.guardrails` | `~/.cindy-harness/guardrails.yaml` | parses with `guardrails.ts` |
| `config.web-budget` | `~/.cindy-harness/web-budget.yaml` | parses with `web-budget.ts` |
| `config.small-json` | `housekeeping.json`, `plugins.json`, `security.json`, `vault.json`, `*-sessions.json` in `~/.cindy-harness` | JSON parses; report the file and the byte offset of the error |
| `config.hermes` | `~/.hermes-cindy/config.yaml` (read-only) | YAML parses; `custom_providers` names used by routes exist |
| `config.lkg-diff` (14.5) | each file above vs the latest LKG snapshot | warn "changed since last good snapshot <date>", listing files; hint for `fix.config.restore-lkg` |

### Layer `endpoints` (pack `endpoints.ts`, row 14.4)

| id | What it checks | fail / warn when |
|---|---|---|
| `endpoint.<providerId>` | `probeEndpoint` for each providers.yaml endpoint. Local endpoints always; API endpoints **only** with `--include-api` (outbound; default off) | fail offline **if** a routing rule or the chat default uses it, else warn |
| `endpoint.routes` | `assessRoute` for every routing rule | fail blocked, with routeHealth `alternatives` in `detail` |

### Layer `processes` (pack `processes.ts`, row 14.4)

| id | What it checks | fail / warn when |
|---|---|---|
| `proc.app` | is a Cindy instance running (socket answers / `desktop-whoami` logic) | always `ok`; informational; used by `needs` |
| `proc.daemon` | connect to the hermes-mgr socket, `protocol/hello`, `config/status` (read-only methods only) | fail: socket file present but no listener (stale), or hello fails; skip when the app is closed and no socket file exists |
| `proc.orphans` | `ps` for `hermes`, bridge shims and MCP server processes whose cwd is under `~/.hermes-cindy/session-homes/` and whose parent is gone | warn with count + pids; fix `fix.proc.kill-orphans` |
| `proc.ports` | ports the setup depends on (LM Studio 1234, Ollama 11434, dev CDP 9222) — which process holds each | warn if held by an unexpected process |
| `proc.mcp.<serverId>` | `checkMcpHealth` for every server from `buildMcpCatalog` | fail when an enabled server's command is missing |

### Layer `data` (pack `data.ts`, row 14.4)

| id | What it checks | fail / warn when |
|---|---|---|
| `data.sqlite` | open `cindy-local-v1.db` **read-only** (`readonly: true, fileMustExist: true`), `PRAGMA quick_check` | fail on anything but `ok`; never writes, never checkpoints |
| `data.hermes-state` | `state.db` of the 20 most recent session homes opens read-only | warn per broken home with session id |
| `data.registry` | the daemon session registry file parses; each entry's home exists | warn missing homes |
| `data.storage` | `planHousekeeping` totals | warn over thresholds; action: Settings → Storage. Never prunes |
| `data.logs` | size of `apps/desktop/logs/` and `~/.hermes-cindy/logs/agent.log`; last 200 lines scanned for known fatal patterns (each with a plain-English meaning, list lives in `packs/data.ts`) | warn with the first matching line (redacted) |

---

## §4 Last-known-good (LKG) snapshots — row 14.5

Small, frequent, config-only copies. The full tarball (`pnpm backup:create`) remains the heavy
option and is what restores the DB and session homes.

- **Location:** `~/.cindy-harness/doctor/lkg/<UTC stamp>/` containing:
  - `files/harness/…` and `files/hermes/config.yaml` — byte-exact copies of every file in the
    §3 `config` layer, preserving relative paths.
  - `versions.json` — Node, pnpm, Hermes, Claude Code, Codex, Pi versions and paths.
  - `manifest.json` — `{ createdAt, reason, reportCounts, files: [{ rel, sha256, bytes }] }`.
- **Excluded always:** `.env`, `auth.json`, `*.key`, names containing `token` / `credential` /
  `secret`, `*.db*`, `session-homes/`, `cache/`, `installs/`, `logs/`.
- **When taken:**
  1. `pnpm doctor snapshot [--reason "<text>"]`.
  2. By the app (14.8) at most once per 24 h, **only** when the start-up run has zero `fail`.
     A run with any fail never creates a "good" snapshot.
  3. Before any file-moving fix applies (reason `pre-fix:<fixId>`; that copy is the rollback point).
- **Retention:** keep the newest 20 and anything younger than 14 days (configurable in
  `~/.cindy-harness/doctor/doctor.yaml`: `lkg_keep`, `lkg_min_days`). Pruning removes only
  directories under `doctor/lkg/` whose name matches the stamp pattern; never follows symlinks.
- **Restore:** `pnpm doctor rollback <stamp> [--file <rel>]`:
  - Requires the app to be **closed** when `hermes/config.yaml` is among the files (the daemon
    owns it while running). Harness files may be restored with the app running; the existing
    `onProvidersChanged` watcher picks them up.
  - Each replaced file is first moved aside to `<file>.pre-rollback-<stamp>` (same convention as
    `restoreBackup`), then the snapshot copy is written via temp file + rename in the same dir.
  - Afterwards the `config` layer re-runs and its result is printed.
  - **Rule note for ADR 0015:** AGENTS.md §3 forbids hand-editing `~/.hermes-cindy/config.yaml`
    so that formatting and comments survive. A byte-exact restore of an earlier copy, with the
    app closed, keeps formatting and comments; ADR 0015 records this as the one sanctioned
    non-RPC write, owner-approved.

---

## §5 Fix protocol — row 14.6

Every fix, without exception:

1. `preview()` returns a `FixPlan`: steps in words, every file/pid it touches. No side effects.
2. CLI prints the plan and asks `Apply? [y/N]` (`--yes` skips the prompt). The UI shows a confirm
   dialog. Default is no.
3. If `needsAppClosed` and the app is running → refuse with the reason.
4. Take a `pre-fix:<fixId>` LKG snapshot (files) or record pids + command lines (processes).
5. `apply()`; file writes are atomic (temp + rename).
6. Re-run the `recheck` checks. Any still `fail` → roll back from step 4, report
   `rolledBack: true` with the re-check results.
7. Append one line to `~/.cindy-harness/doctor/fix-log.jsonl`:
   `{ at, fixId, target, ok, rolledBack, recheckCounts }`.

Initial fixes (add more only through a ROADMAP row):

| fix id | For check | What it does | Risk |
|---|---|---|---|
| `fix.config.restore-lkg` | any `config.*` fail, `config.lkg-diff` | restore one file (or all) from the newest LKG snapshot whose copy of that file passes validation | moves-files |
| `fix.proc.kill-orphans` | `proc.orphans` | SIGTERM, wait 3 s, SIGKILL — **only** pids re-verified at apply time to be orphaned and rooted under `~/.hermes-cindy/session-homes/` | kills-process |
| `fix.proc.stale-socket` | `proc.daemon` stale | with the app closed, move the stale socket file aside so the next start can bind | moves-files |

Not a fix: re-pinning a runtime. `runtime.hermes.pin` only prints the two edits (pin in
`hermes-version.ts`, HANDOVER §3) once the canary passed; bumping the pin is a normal code task.

The doctor must **not** offer: deleting session homes or DB rows, installing or updating a
runtime, editing `config.yaml` keys, changing API keys.

---

## §6 Upgrade canary — row 14.7

Runtime updates are the most likely cause of breakage. The canary proves the contracts Cindy
depends on still hold for the installed version.

`pnpm doctor canary --runtime hermes [--model <route>]`:

1. Create a throwaway home under `$TMPDIR/cindy-doctor-canary-<stamp>/` the way the 13.1a probe
   did (symlink the venv, generate a minimal `config.yaml`; never copy `.env` / `auth.json`).
   The real `~/.hermes-cindy` is never written.
2. Use a **local** route by default (routing.yaml `local-small`, else the first online local
   provider). None online → `skip` with that reason. `--paid` allows an API route, prints the
   expected cost, and needs the owner's confirmation in chat first.
3. Run one `hermes-cindy chat` turn with the fixed prompt
   `Reply with the single token CINDY_CANARY_OK.` and capture NDJSON + `logs/agent.log`.
4. Contracts (one function each in `canary/contracts.ts`, each traced to HANDOVER §3):
   - event shapes match the newest stored fixture (shared comparator extracted from
     `fixture-parity.test.ts`);
   - `session_id` present on the `result` event;
   - `agent.log` has the `agent.conversation_loop: API call #N: model=… provider=… in=…` line;
   - the `--safe-mode --provider custom --base-url` launch form still runs;
   - reply text contains `CINDY_CANARY_OK`.
   `pre_tool_call` timing, compression log lines and web tool names stay manual re-probes; the
   output lists them as "not covered — re-probe per HANDOVER §3".
5. Write `~/.cindy-harness/doctor/canary/hermes-<version>.json`
   `{ version, at, route, contracts: [{ id, ok, detail }] }`, delete the throwaway home, print
   the verdict: `safe to bump pin` or `do not bump: <failed contracts>`.

`pnpm doctor canary --runtime claude|codex|pi`: no model call. Store `--version` and `--help`
output per version in `~/.cindy-harness/doctor/canary/<runtime>-help-<version>.txt` and diff
against the previous version's file: report added/removed flags, and mark as `fail` any removed
flag that Cindy's adapter passes (a static list in `canary/cli-help-diff.ts`, one entry per flag
with the adapter source file it comes from; build the list by reading the adapters, do not
change them). A real turn on these runtimes is paid: only with `--paid` and the owner's chat
confirmation.

---

## §7 CLI specification — row 14.2 (subcommands added by later rows)

Root `package.json` script: `"doctor": "node scripts/cindy-doctor.mjs"` (or the form chosen in
the §2.3 spike).

```
pnpm doctor                          instant+fast checks, human text, exit code       (14.2)
pnpm doctor --all                    include slow checks                              (14.2)
pnpm doctor --only <id|layer>[,...]  subset                                           (14.2)
pnpm doctor --json                   DoctorReport as JSON                             (14.2)
pnpm doctor --include-api            also probe API endpoints' /models (outbound)     (14.4)
pnpm doctor snapshot [--reason <t>]  take an LKG snapshot                             (14.5)
pnpm doctor snapshots                list LKG snapshots                               (14.5)
pnpm doctor rollback <stamp> [--file <rel>] [--yes]                                   (14.5)
pnpm doctor fix <fixId> [--target <x>] [--yes]                                        (14.6)
pnpm doctor canary --runtime <hermes|claude|codex|pi> [--model <route>] [--paid]      (14.7)
pnpm doctor bundle                   write the incident bundle (§9)                   (14.9)
```

Hidden test-only flags: `--home`, `--hermes-home`, `--harness-dir`, `--user-data` (point every
path at temp dirs; tests must never touch real state).

Exit codes: `0` no `fail`; `1` at least one `fail`; `2` the doctor itself failed (usage, crash).
Text output: one line per check, then a summary block with failures first:

```
Cindy doctor · 2026-11-15 14:02 · 41 checks · 36 ok · 3 warn · 1 fail · 1 skip

FAIL  config.routing      route "local-small" names provider "lmstudio" — not in providers.yaml
      → pnpm doctor fix fix.config.restore-lkg --target harness/routing.yaml   (good copy: 2026-11-14)
WARN  runtime.hermes.pin  Hermes 0.23.0 installed, pin is 0.22.7
      → pnpm doctor canary --runtime hermes
```

No colour when stdout is not a TTY. No emoji.

---

## §8 Settings → Doctor section + start-up run — row 14.8

- Location: a **Doctor** section in Settings. Mount it the way `WorkerAllowlistSection.tsx` /
  `McpCatalogSection.tsx` are mounted in `SettingsView.tsx`. Edit `SettingsView.tsx` and the
  other upstream files with a script, not the Edit tool (the ECC stop hook reformats whole files;
  compare `git diff --stat` with `git diff -w --stat`).
- IPC in `apps/desktop/src/main/maker-ipc/doctor.ts`, channels in `channels.ts`, registration in
  `register.ts`, bridge in `preload.ts`, types in `vite-env.d.ts` — use 13.8's worker-allowlist
  files as the template:
  `maker:doctor:run {cost?, only?}` → `DoctorReport`;
  `maker:doctor:fix-preview {fixId, target?}` → `FixPlan`;
  `maker:doctor:fix-apply {plan}` → `FixOutcome`;
  `maker:doctor:snapshots` → list; `maker:doctor:snapshot {reason}`.
- UI: summary line (counts); results grouped by layer, failures expanded, each with its action
  text; **Fix…** when `fixIds` exist → preview dialog → confirm → outcome; fixes with
  `needsAppClosed` show the CLI command with a copy button instead. **Run all checks** (adds
  slow). **Copy report** (markdown, redacted — wired in 14.9).
- App start: run `instant,fast` once, 20 s after the main window is ready, async in the main
  process, never on the turn path. Zero fails → take the daily LKG snapshot (§4). Any fail →
  a small dot on the Settings entry; no modal, no toast. `doctor.yaml` `run_on_start` (default
  `true`) turns it off.
- English-only strings (ADR 0002).

---

## §9 Incident bundle + redaction — row 14.9

`pnpm doctor bundle` (and **Copy report** in the UI) writes
`~/.cindy-harness/doctor/bundles/<stamp>.md`:

1. A header telling an AI agent what Cindy is and to read `AGENTS.md`, `HANDOVER.md` first.
2. Full report (`--all`).
3. `versions.json`.
4. Config files from §3, **redacted** (`redactConfig`): values of keys matching
   `/key|token|secret|password|auth|bearer|cookie/i` → `«redacted»`; URLs lose userinfo and
   query; the home directory becomes `~`.
5. Last 200 lines of the newest `apps/desktop/logs/main-*.log` and `~/.hermes-cindy/logs/agent.log`,
   through `redactText` (bearer tokens, `sk-…`, `ghp_…`, JWT-shaped strings, email addresses).
6. Last 20 lines of `fix-log.jsonl`.

The bundle never leaves the machine; the doctor has no upload. Redaction has its own test file:
one fixture per pattern, plus a mutation check (remove one pattern → a test fails).

---

## §10 Guards (apply to every 14.x row)

- AGENTS.md wins over this file. Gates per AGENTS.md §2: Tier 1 mid-task, Tier 2 before the
  commit that closes a row.
- Tests use temp dirs and `fake-hermes.mjs`; never the real `~/.hermes-cindy`, never `~/.hermes`.
  Live proofs on real state back up first (`<name>.bak-<date>`) and say so in STATUS.
- No new outbound calls: only the local `/models` probes from 2.2a, API probes behind
  `--include-api`, and the canary turn on a local model. Grep the diff for `fetch(` / `http`.
- No new dependencies. No changes to Claude Code / Codex / Pi adapters, lizi MCP schemas, or
  any system prompt.
- Every `summary` is plain English; every `fail` has an `action`.
- One row per session; label honestly — `unit-tested` for 14.1, `live-proven` for any row that
  reads real files, runs a process, or renders UI. Evidence files go in
  `docs/evidence/14.<n>-<slug>-live-proof.md`.

---

## §11 Rows — what to build, how to prove it

### 14.0 ADR 0015 — doctor contract (docs-only)

Write `docs/decisions/0015-cindy-doctor.md`: CLI-first; read-only default; fix protocol (§5);
LKG scope and the sanctioned app-closed byte-exact restore of `config.yaml` (§4 rule note);
canary local by default, `--paid` opt-in; no auto-fix at start; the doctor never prunes, installs,
or edits keys. Gate: Tier 0. Done when the owner accepts the ADR in chat (record the date).

### 14.1 Doctor core (pure)

Files: `packages/maker-core/src/doctor/{types,registry,runner,redact,report-text,index}.ts`,
subpath `./doctor` in `packages/maker-core/package.json`, tests in `src/doctor/__tests__/`.
Tests (minimum): duplicate ids rejected; output order fixed; throw → `fail` "check crashed";
timeout per cost; `dependsOn` → skip; `needs` → skip; counts; text formatter snapshot; one
redaction test per pattern. Mutation checks: (a) map a throw to `ok` → a test fails; (b) drop
one redaction pattern → a test fails.
Done when: 🧪 `unit-tested`.

### 14.2 `pnpm doctor` CLI + environment and runtimes packs

Files: `scripts/cindy-doctor.mjs`, root `package.json` script, `doctor/context.ts`,
`packs/{index,environment,runtimes}.ts`. Do the §2.3 spike first. Tests: each check against temp
dirs and a stub `exec` (fake versions, missing binary, ABI error text); CLI parsing and exit codes
by spawning the script with the hidden path flags.
Live proof: `pnpm doctor` on the real machine with the app closed and again with it open.
Expected: `runtime.hermes.pin` WARN 0.23.0 vs 0.22.7. Then run with a PATH lacking `pi` →
`runtime.pi.present` changes (fail if a roster agent uses Pi, else skip).

### 14.3 Config pack

Files: `packs/config.ts` (+ tests). Reuse every existing reader (§1). Tests: valid, missing,
broken YAML (error names file + line), dangling route→provider, dangling
`workers.allowed_routes`, dangling expert MCP server, broken JSON with byte offset.
Live proof: back up `~/.cindy-harness/routing.yaml` to `.bak-<date>`, introduce a dangling
provider name, `pnpm doctor --only config` → FAIL with the plain-English summary; restore the
backup; run again → ok.

### 14.4 Endpoints, processes and data packs

Files: `packs/{endpoints,processes,data}.ts` (+ tests: real local HTTP servers for probes, a real
unix-socket stub for `proc.daemon`, temp SQLite files including a deliberately corrupted copy).
Live proof: LM Studio running → endpoint ok; LM Studio quit → `endpoint.lmstudio-local` FAIL and
`endpoint.routes` lists the blocked routes; a leftover socket file in a **temp** user-data dir →
`proc.daemon` stale; `data.sqlite` ok on the real DB and the DB file's mtime unchanged.

### 14.5 LKG snapshots + rollback

Files: `doctor/snapshots.ts` (+ tests), CLI `snapshot` / `snapshots` / `rollback`,
`config.lkg-diff` check. Tests: excluded files never copied (fixture `.env`, `auth.json`);
manifest sha256 correct; retention keeps newest 20 + < 14 days and ignores non-matching names;
rollback moves aside then writes atomically; `hermes/config.yaml` rollback refused while the app
runs.
Live proof: `pnpm doctor snapshot`; break `routing.yaml` (after `.bak-<date>`);
`pnpm doctor rollback <stamp> --file harness/routing.yaml`; `config.routing` back to ok;
`.pre-rollback-*` file present.

### 14.6 Fix runner + initial fixes

Files: `doctor/fix-runner.ts`, the three fixes in §5 registered next to their checks, CLI `fix`,
`fix-log.jsonl`. Tests: preview has no side effects (fs spy); a failing re-check rolls back;
`needsAppClosed` refused while running; kill-orphans re-verifies pids at apply time (a pid that
stopped being orphaned is not killed).
Live proof: start a harmless orphan (`sleep 600` with cwd under `session-homes/` of a **temp**
hermes home passed with `--hermes-home`); `pnpm doctor` → WARN; `pnpm doctor fix
fix.proc.kill-orphans` → preview, confirm, process gone, re-check ok, fix-log line written.

### 14.7 Upgrade canary

Files: `doctor/canary/{hermes-canary,contracts,cli-help-diff}.ts`, shared shape comparator
extracted from `fixture-parity.test.ts` (that test keeps passing with the same assertions), CLI
`canary`, checks `runtime.hermes.canary-fresh` and `runtime.<name>.changed`.
Tests: contracts pass on the stored 0.22.5 and 0.23.0 fixtures and fail on a mutated fixture
(`session_id` removed); help diff flags a removed adapter flag.
Live proof: `pnpm doctor canary --runtime hermes` on local `qwen3-8b` (zero spend) → per-contract
results and a verdict; `~/.hermes-cindy/config.yaml` sha256 identical before and after.
`pnpm doctor canary --runtime claude` → help snapshot stored; a second run reports "no change".

### 14.8 Settings → Doctor section + start-up run

Files per §8. Tests: IPC handlers with an injected registry; section renders counts, groups,
action text, the Fix flow (preview → confirm → outcome) and the CLI-command fallback; start-up
scheduler runs once, instant/fast only, snapshots only on zero fails.
Live proof in the dev app: section counts equal `pnpm doctor --json` counts; break `routing.yaml`
(backed up) → dot on next start → Fix restores from LKG → re-check ok; time to the first `hi`
reply with and without the start-up run, both recorded (no measurable delay). The chat hot path
is not touched; show that in the diff.

### 14.9 Incident bundle

Files: CLI `bundle`, markdown formatter, **Copy report** wiring. Tests: every section present;
no planted fixture secret survives; home path replaced by `~`.
Live proof: `pnpm doctor bundle` on the real machine; grep the bundle for `sk-`, `Bearer `, the
real home path and every value behind the `.env` key names → zero hits; record the grep command
and result in evidence.

### 14.10 Proposed rule: new features ship a doctor check (docs-only)

Add to `STATUS.md` under "Proposed rule changes": "From Phase 15 on, a ROADMAP row that adds a
config file, a runtime dependency, a process, or a stored file also adds a doctor check (and, if
safe, a fix) in the matching pack." The owner accepts or rejects; if accepted, the owner edits
AGENTS.md.

### 14.11 ⛔ Parked — doctor as a read-only MCP tool for agents

Expose redacted, read-only `run_checks` to Hermes / Claude through a Cindy MCP server so an agent
can diagnose itself. Do not build until the owner asks.

---

## §12 Order and dependencies

```
14.0 ADR ─► 14.1 core ─► 14.2 CLI + env/runtimes ─► 14.3 config ─► 14.4 endpoints/processes/data
                                    │
                                    └─► 14.5 LKG ─► 14.6 fixes ─► 14.7 canary
                                                                    │
                       14.8 Settings section (needs 14.1–14.6) ◄────┘
                       14.9 bundle (needs 14.1–14.4)
                       14.10 rule proposal (any time after 14.2)
```

Minimum useful doctor: 14.0–14.5, about 3–4 sessions. After that, the canary (14.7) is the most
valuable row, because runtime updates are the most likely failure.

## §13 Owner decisions with defaults (use the default unless the owner says otherwise)

| Decision | Default |
|---|---|
| Run fast checks at app start | on (`doctor.yaml` `run_on_start: true`) |
| LKG retention | newest 20 + anything younger than 14 days |
| API endpoint probes in `pnpm doctor` | off; `--include-api` turns them on |
| Canary model | local route; `--paid` opt-in, cost shown, owner confirms in chat |
| Byte-exact `config.yaml` restore with the app closed | allowed once ADR 0015 is accepted |
