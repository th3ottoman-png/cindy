# ADR 0014 — Storage housekeeping: prune re-creatable bulk, never the transcript

- **Status:** Accepted (2026-11-14). ROADMAP **13.2a** probe (no feature code), per
  `docs/phase-13-blueprint.md` §4. Feeds **13.2b** (Settings → Storage + Prune).
- **Date:** 2026-11-14
- **Decider:** probe 13.2a. Full method, numbers and log excerpts:
  `docs/evidence/13.2a-storage-housekeeping-probe.md`.
- **Cost:** local models only (LM Studio Gemma / qwen3-8b). No API turn, no spend.

## Context

Logs already rotate after 30 days (`apps/desktop/src/main/logger.ts`, `LOG_RETENTION_DAYS`). The
growth is elsewhere. Measured 2026-11-14: `session-homes/` **4.7 GB / 166 homes** (1.5 GB / 151 on
2026-11-13), `cache/` **443 MB**, `installs/` 617 MB, `~/.cindy-harness/` **9.3 MB**,
`apps/desktop/logs/` **74 MB**. `reapOrphanHomes` (`session-home.ts`) only removes homes whose
session is no longer in the daemon registry, after 24 h idle.

The blueprint asked three questions before any deletion feature is built. The probe answered all
three live, and found a fourth fact that changes the design.

## What the probe found

1. **The visible transcript is not in the session home.** It is in Cindy's own SQLite
   (`cindy-local-v1.db`, `sessions` + `messages`, 1773 rows). Deleting a home and reopening the
   session in the dev app rendered the **complete** history (all markers present, DOM text 5860 vs
   5830 chars baseline). Reopening alone does **not** rebuild the home; the home is rebuilt at the
   next send.
2. **The agent's context is in the home's `state.db`** (`sessions` + `messages`; 127 MB across all
   homes). `sessions/` is *not* the transcript — 160/166 homes have it empty, the rest hold a gateway
   `sessions.json` or a `request_dump_*.json`. `kanban.db` / `projects.db` are Hermes indexes, not
   the conversation. Within one app run, continuation reuses the same daemon session and home and
   recalls correctly (proved: the agent quoted its own previous answer).
3. **Deleting the home loses the agent's context, not the owner's history.** After the deletion the
   next send produced `Hermes no longer has the previous session, so this message starts a new one.`
   and the model answered `NO CONTEXT` while the full transcript stayed on screen. The rebuilt home
   had 51 entries, the same 7 symlinks, a fresh `config.yaml` and an empty `state.db`.
4. **The control proves that loss is not caused by deletion.** A second session whose home was left
   **intact** behaved identically after the app restart: new daemon session, new home, `resume-reset`,
   `NO CONTEXT`. Cause: `agent.ts startSession` mints `const sessionId = randomUUID()`, so every app
   start creates a new `session-homes/<uuid>-<hash>` with an empty `state.db`, and
   `--resume <persisted id>` cannot resolve there. No state migration exists between homes. This is
   the behaviour behind the existing Debt row "Orphan Hermes session homes accumulate" (2026-10-29);
   the consequence is now proved and is recorded as its own Debt item.
5. **The bulk is re-creatable, not transcript.** A typical 6.9 MB home is **5.7 MB
   `models_dev_cache.json`** (83 %), 576 KB `state.db`, 204 KB `cache/`, 116 KB `kanban.db`, 60 KB
   `logs/`. Across homes: **143 catalog copies = 836 MB**. `cache/uv/` is a standard uv cache
   (`CACHEDIR.TAG` signature, 441 MB of unpacked wheels) — re-downloadable, not read by an
   already-built venv. The JSON catalogs are remote-fetched or locally recomputed. The tool artifact
   dirs (`images`, `screenshots`, `videos`, `documents`, `audio`, `scratch`, `browser-use`) are
   **empty in every home today** but hold generated, non-re-downloadable artifacts when used.
6. **3273 MB of the 4.7 GB is 3 orphan homes** carrying a *real* 620 MB venv and a *real* 467 MB uv
   cache each (163 homes symlink `installs`, 3 do not). They survived this app start only because
   they were ~15 h idle, under the 24 h threshold.
7. **41 homes (300 MB) belong to conversations the owner soft-deleted** (`sessions.status='deleted'`,
   messages still present). The daemon registry still lists them, so the reaper never removes them.
8. **`~/.cindy-harness` backups are not a space problem:** 42 `*.bak*` entries = 684 KB,
   12 `experts.bak-*` dirs = 528 KB, `backups/` 8.4 MB. Pruning them is hygiene, not reclamation.
9. `apps/desktop/logs/dev-terminal.log.fifo` is a **FIFO**, and `dev-terminal (1).log` (8.4 MB,
   2026-10-27) is an orphaned rotation leftover. Neither is covered by the logger's rotation.

## Decision

**13.2b prunes re-creatable bulk and unreachable homes. It never deletes a transcript that a
still-existing conversation could need.** The planner classifies every candidate into three tiers.

### Tier 1 — SAFE (re-creatable; no transcript involved)

| Candidate | Rule |
|---|---|
| `models_dev_cache.json` + `models_dev_cache.etag` in a home | home idle > `retentionDays`; re-downloaded on demand |
| `cache/uv/` (base home and session homes) | idle > `retentionDays`; next install/update re-downloads |
| `cache/*.json` catalogs (base home and homes) | idle > `retentionDays`; remote-fetched or recomputed |
| `logs/` inside a home | home idle > `retentionDays`; diagnostics only |
| **whole orphan homes** (no daemon registry record) | already reaped at 24 h; 13.2b may report them and reuse the same name-pattern + gateway-stop guard |
| `dev-terminal*.log` | older than `retentionDays`; **regular files only** |
| `*.bak-*` files and dirs in `~/.cindy-harness` | older than `retentionDays`, **always keep the newest per base file** |

### Tier 2 — SAFE ONLY WITH THE TRANSCRIPT PRESERVED

Whole homes of conversations whose Cindy row is `deleted` (41 homes / 300 MB today). Soft delete
keeps the messages, so the conversation can come back. Prune such a home **only** after its
`state.db` (+ `-wal`/`-shm`) has been copied into the prune archive, or prune Tier-1 bulk inside it
and keep the DB. Never silently drop it.

### Tier 3 — NEVER

- `state.db`, `state.db-wal`, `state.db-shm` of any home whose conversation still exists in Cindy's
  DB (any status), and the whole home of any **open / running / scheduled / pinned** session or of
  the live daemon session.
- Symlinks — never followed, never resolved. `.env` and `auth.json` are credentials.
- Tool artifact dirs when **non-empty** (`cache/images`, `cache/screenshots`, `cache/videos`,
  `cache/documents`, `cache/audio`, `cache/scratch`, `cache/browser-use`, `image_cache`,
  `audio_cache`) — generated content, not re-downloadable.
- `installs` when it is a symlink. A *real* `installs` venv goes only with its whole orphan home.
- Non-regular files (the `dev-terminal.log.fifo` FIFO), sockets, and anything outside the expected
  roots. Same containment + name-pattern guard as `reapOrphanHomes`
  (`/^.+-[0-9a-f]{10}$/` directly under `session-homes/`).
- `~/.cindy-harness/backups/` newest archive, `experts/`, `routing.yaml`, `providers.yaml`,
  `housekeeping.json`, and the newest backup of every base file.

### Additional rules

- **Do not build on finding 4.** The cross-restart resume reset is a defect, not a feature. 13.2b
  must stay safe if it is fixed (i.e. if homes become resumable again): Tier 3 keeps `state.db` for
  every existing conversation regardless of how idle it is.
- **Report freed bytes honestly.** uv on APFS may clone rather than copy, so `du` can overstate what
  a deletion returns. Measure, or label the figure a `du` estimate.
- Preview + owner confirm before any deletion; afterwards report freed bytes and every skip with its
  reason (blueprint §4, guard §14.6).

## Consequences

- The reclaimable space is dominated by Tier 1: **~836 MB of catalog copies + ~442 MB base uv cache +
  3273 MB of orphan homes**, against only **127 MB of actual transcript**. Pruning bulk inside homes
  is both safer and larger than pruning whole homes.
- 13.2b's planner needs, per home: idle time, the owning daemon session id, whether that session is
  open/running/scheduled/pinned, the Cindy `sessions.status` for that conversation, and which
  entries are symlinks or non-regular files. The Cindy↔daemon join is
  `sessions.sdk_session_id` = registry `hermesSessionId`; the home is named by the **daemon**
  `sessionId`, not the Cindy id.
- `reapOrphanHomes` stays as it is (24 h, registry-only). 13.2b adds the retention-driven layer above
  it; it does not change the reaper's contract.
- The cross-restart context loss is recorded in ROADMAP §Debt as a separate item. Fixing it (reuse
  the daemon session id, or migrate `state.db` into the new home) is **not** part of 13.2a/13.2b.
- Hermes pin: findings are on the installed **0.23.0** (pin 0.22.7). Re-check the home layout and the
  resume wording if the pin moves.

---

## Addendum (2026-11-14, ROADMAP 13.2c) — when a recent orphan home may go

Tier 1 above says whole orphan homes are "already reaped at 24 h". Implemented literally, that
left the three real orphans (3.0 GB) unreachable for hours: measured 18.7 h, 20.2 h and 20.2 h
idle, so `retentionDays` could never reach them and the 24 h window had not elapsed.

`reapOrphanHomes`' own comment states what the 24 h window is for: *"Guards a record that is not
flushed yet."* It is a latency guard, not a reachability rule. So 13.2c adds one fact that makes
the guard unnecessary in the common case:

> An orphan home is removable when it is idle ≥ 24 h **or** the daemon registry file
> (`hermes-mgr/sessions.json`) was itself written **after** the home's last activity.

**Why this is safe.** The registry is one daemon process writing its whole in-memory map through
an atomic temp+rename (ROADMAP 0.5). A record can therefore be absent only because the session
was never created or was removed — not because a write is pending — once the file has been
written since the home last did anything. A home still in use cannot satisfy the condition: its
own activity would be newer than the registry write. The candidate field is
`registryFlushedAfterIdle`, computed by the host from `lstat(sessions.json).mtimeMs > homeIdleMs`.

**What did not change.** Every other guard still applies to such a home, in the same order:
symlink refusal, non-regular-file refusal, transcript refusal, root containment, the
`/^.+-[0-9a-f]{10}$/` name pattern, and `stopSessionGateway` before removal (a home whose gateway
cannot be stopped is kept, exactly as the reaper keeps it). The fact is ignored for any home a
registry record still owns, so it can never shorten retention for a live conversation. An
unknown fact (`undefined`) keeps the 24 h behaviour — fail closed.

**Also decided here.** `models_dev_cache.etag` is pruned together with `models_dev_cache.json`.
Deleting the catalog while keeping its validator could let Hermes accept a `304 Not Modified`
for a file that is no longer on disk.

**Protection sources wired by 13.2c.** Daemon registry `running`; Cindy DB `pinned_at`, an active
`schedules.target_session_id`, and a turn in flight or interrupted
(`active_turn_started_at > last_turn_ended_at`). "Open in a window" needs no separate channel:
only orphan homes — no registry record at all — are ever removed whole, and a session open in
the UI always has a record. Interior bulk is re-creatable, so removing it cannot lose anything.
The startup run cannot know what is open, so it protects **every** registered session.

**Tier 2 as built.** A soft-deleted conversation's whole home is kept
(`soft-deleted-transcript-kept`); the re-creatable bulk inside it is removed
(`soft-deleted-home-bulk`) and `state.db` is never a candidate. This is the ADR's second option
("prune Tier-1 bulk inside it and keep the DB"), so no prune archive is needed.

**Not built.** Empty tool artifact dirs are not scanned: they are empty in every home today, so
they reclaim nothing, and a non-empty one must never go. The planner still carries the
`home-artifact-dir` kind and its `artifact-dir-not-empty` refusal for when that changes.
