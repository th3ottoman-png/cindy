# ADR 0015 — Cindy Doctor contract: diagnose, snapshot, repair

- **Status:** Accepted (2026-11-15). ROADMAP **14.0** (docs only), per `docs/phase-14-blueprint.md` §11.
- **Date:** 2026-11-15
- **Decider:** Owner (chat decision on 2026-11-15: option 1 — approve the contract and the scoped `AGENTS.md` §3 exception from `docs/phase-14-blueprint.md` §4 & §13).

## Context

Cindy, Hermes, and the Claude Code / Codex / Pi runtimes change frequently (for example, Hermes installed `0.23.0` while the code pin remains `0.22.7`). When an upgrade, a broken route/config edit, a stale socket, an unreachable local endpoint, or an orphaned process breaks a workflow, the owner needs a standalone diagnostic and recovery tool ("Cindy Doctor") that explains what is broken in plain English and offers safe, reversible repairs — even when the desktop app will not start.

Two constraints shape the design:

1. `AGENTS.md` §6 requires local-first, file-backed, plugin-boundary design with no hidden state.
2. `AGENTS.md` §3 forbids editing `~/.hermes-cindy/config.yaml` by hand so daemon-managed formatting and comments survive. Without a narrow exception, the doctor could report `config.yaml` damage but could never restore a broken `config.yaml` when the app and daemon are closed.

## Decision

Adopt the Cindy Doctor contract specified in `docs/phase-14-blueprint.md` for Phase 14 (`14.1`–`14.10`):

### 1. CLI-first, read-only by default

- **Single core, CLI first:** All checks, snapshot logic, fix protocol, redaction, and canary verification live in `@cindy/maker-core/doctor` and are driven by `pnpm doctor` (`scripts/cindy-doctor.mjs`), which must run with the desktop app closed. Settings → Doctor (14.8) is a viewer over that same core, never a second implementation.
- **Plugin registry boundary:** Checks and fixes register through a single registry with duplicate-id protection and run in deterministic layer order (`environment → runtimes → config → endpoints → processes → data`).
- **Read-only by default:** Plain `pnpm doctor` modifies no files, kills no processes, and makes no outbound API calls. Local endpoint probes run as in `2.2a`; outbound API endpoint probes require `--include-api`.
- **Fail closed & no hidden state:** A check that throws or exceeds its cost-tier timeout reports `fail` (`check crashed: …` / `check timed out after … ms`), never `ok`. Reports name every path, version, and command inspected.
- **No auto-fix at app start:** Start-up diagnostics (`doctor.yaml` `run_on_start`, default `true`) run `instant` and `fast` checks asynchronously ~20 s after the main window is ready, never on the chat turn path, and never repair failures automatically. Any `fail` surfaces only a passive dot on Settings; zero `fail` allows at most one daily LKG snapshot.

### 2. Safety, isolation, and credential hygiene

- **Isolated Hermes home only:** The doctor operates strictly on `~/.hermes-cindy`, `~/.cindy-harness`, the Cindy user-data directory, and the repo, reusing `assertNotDailyHermes` (`apps/desktop/src/main/backup/localBackup.ts`). It never reads, writes, lists, or references any Hermes home outside `~/.hermes-cindy`.
- **Credentials stay out of reports, snapshots, and bundles:** `.env`, `auth.json`, `*.key`, and key/token/secret values are never copied into snapshots or written to output. Checks may report whether a `keyEnv` variable name is set or missing, never its value. Incident bundles (`14.9`) pass configs and log tails through `redactConfig` and `redactText` and replace the user home directory with `~`. Bundles stay local on disk; there is no upload.

### 3. Fix protocol (every fix, without exception)

Every repair (`pnpm doctor fix <fixId>` or the UI Fix flow) follows one strict lifecycle:

1. `preview()` builds a `FixPlan` (plain-English steps, every file path or PID touched) with **zero side effects**.
2. **Explicit confirmation:** CLI prints the plan and prompts `Apply? [y/N]` (`--yes` skips the interactive prompt); UI requires a confirmation dialog. Default is no.
3. **App-closed guard:** Any fix marked `needsAppClosed: true` refuses if a Cindy instance is running.
4. **Pre-fix checkpoint:** File-moving fixes take a `pre-fix:<fixId>` LKG snapshot first; process fixes record target PIDs and command lines and re-verify at apply time that each PID is still an orphan rooted under `~/.hermes-cindy/session-homes/`.
5. **Atomic apply:** File writes use sibling temp file + `rename` in the target directory.
6. **Verify and roll back on failure:** After applying, the fix's `recheck` checks run. If any `recheck` remains `fail`, the runner rolls back automatically from step 4 and reports `rolledBack: true`.
7. **Audit log:** Every apply appends one JSON line to `~/.cindy-harness/doctor/fix-log.jsonl`.

### 4. Last-known-good (LKG) snapshots and the sanctioned `config.yaml` exception

- **Scope:** `~/.cindy-harness/doctor/lkg/<UTC stamp>/` stores small, config-only byte-exact copies (`files/harness/…` and `files/hermes/config.yaml`), `versions.json`, and `manifest.json` (`createdAt`, `reason`, `reportCounts`, per-file `sha256` and `bytes`). Full tarball backups (`pnpm backup:create` / `backup:restore`, ADR-independent / ROADMAP `0.11`) remain the backup mechanism for SQLite databases and session homes.
- **Always excluded from LKG snapshots:** `.env`, `auth.json`, `*.key`, filenames containing `token`, `credential`, or `secret`, `*.db*`, `session-homes/`, `cache/`, `installs/`, and `logs/`.
- **Retention:** Keep the newest `20` snapshots (`lkg_keep`) and anything younger than `14` days (`lkg_min_days`), configurable in `~/.cindy-harness/doctor/doctor.yaml`. Pruning deletes only stamp-matching directories under `doctor/lkg/` without following symlinks.
- **Sanctioned `AGENTS.md` §3 exception (owner-approved 2026-11-15):** Normal mutations to `~/.hermes-cindy/config.yaml` continue to go exclusively through `hermes-mgr` daemon RPCs. As the **one sanctioned non-RPC write**, `pnpm doctor rollback <stamp>` and `fix.config.restore-lkg` may restore `~/.hermes-cindy/config.yaml` **byte-exactly** from a validated LKG snapshot copy **only when the Cindy app (and daemon) is closed** (`needsAppClosed: true`), first moving the existing file aside to `<file>.pre-rollback-<stamp>` and writing the snapshot copy via sibling temp file + atomic rename. Because the restore reproduces an earlier byte-exact copy with no daemon running, formatting and comments survive without concurrent-write races. Harness files under `~/.cindy-harness/` may be restored with the app running using the same move-aside + atomic rename.

### 5. Upgrade canary

- **Local by default:** `pnpm doctor canary --runtime hermes` runs one turn in a throwaway home under `$TMPDIR/cindy-doctor-canary-<stamp>/` (symlinked venv, minimal generated `config.yaml`; never touches `~/.hermes-cindy` and never copies `.env` or `auth.json`) against a **local** route (`local-small`, else the first online local provider). If no local route is online, it reports `skip`.
- **Paid runs opt-in only:** `--paid` is required to target an API route, must display the expected cost, and requires explicit owner confirmation in chat before running.
- **Contracts checked:** Verifies the `HANDOVER.md` §3 Hermes contracts (stream-json event shapes vs stored parity fixtures, `session_id` on `result`, `agent.log` API-call line, `--safe-mode --provider custom --base-url`, reply token) and prints `safe to bump pin` or `do not bump: …`.
- **Other runtimes:** `canary --runtime claude|codex|pi` performs `--version` and `--help` diffs only (flagging any removed adapter flag as `fail`) with no model call unless `--paid` is explicitly confirmed.

### 6. Explicit exclusions (what the doctor never does)

- Never prunes storage, session homes, or database rows (owned by ROADMAP `13.2c` / ADR `0014`).
- Never installs, updates, or auto-re-pins runtimes (bumping `HERMES_CLI_PINNED_VERSION` stays a separate, reviewed code change after a passing canary).
- Never edits individual keys inside `config.yaml`, never writes or modifies API keys, and never transmits telemetry or incident bundles off the machine.

## Consequences

- Phase 14 rows `14.1`–`14.10` can proceed against one fixed contract without re-asking the §13 defaults.
- `AGENTS.md` §3 remains binding everywhere outside the narrow app-closed, move-aside, byte-exact `config.yaml` restore defined in §4 above.
- All defaults in `docs/phase-14-blueprint.md` §13 (`run_on_start: true`, retention `20` / `14` days, API probes opt-in via `--include-api`, canary local by default) are locked unless the owner revises them later.
