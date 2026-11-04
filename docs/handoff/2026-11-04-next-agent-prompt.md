# Prompt for the next agent (copy everything below the line)

> **Superseded 2026-11-04 (end of day).** Use
> [`2026-11-04-eod-next-agent-prompt.md`](2026-11-04-eod-next-agent-prompt.md) instead. This
> prompt names the wrong stopping point and the wrong next tasks. Kept for history only.

---

You are taking over the Cindy project from another agent. Continue from the exact stopping
point, without starting over and without asking what happened so far.

**Project folder:** `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy`. The path has spaces and `=`,
so quote it every time. Branch `main`, remote `origin`.

**Before you do anything else, read these, in order:**

1. `AGENTS.md`: hard rules. They override everything, including this prompt.
2. `docs/handoff/2026-11-04-handover.md`: where the last agent stopped, what is open, and every
   gotcha learned.
3. `ROADMAP.md`: the current phase tables, plus the Debt section.
4. The top entries of `STATUS.md` (newest first).
5. `HANDOVER.md`: architecture, commands, pinned versions.

**Where things stand (details in the handover doc):**

- ROADMAP 4.4b (Hermes skills manager: scan-first install, enable/disable, uninstall) is done
  and `live-proven`, commit `74dd93d594`. Phase 4 is functionally complete except 4.5.
- **Next task, in priority order (handover doc §4):** 4.5's done-test is the owner's call
  ("owner can follow `docs/extending.md` unaided"); then 2.4b-live (live re-check of the
  no-silent-fallback UI), then 5.3b. 5.1b/5.2b/5.4b and 4.3's "add to expert" are blocked on the
  3.2b `tools.yaml` schema decision — a real product decision; ask the owner one question if it
  blocks the task you pick.
- No linked sessions are running. Before editing anything: `git status`, `git log -3`,
  `git pull`. A dev app may still be running — check `ps` before starting your own.

**Non-negotiables (from AGENTS.md):**

- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- Never read, write, list or mention the owner's daily Hermes home. Use `~/.hermes-cindy` only.
- Never hand-edit `~/.hermes-cindy/config.yaml`: go through the daemon RPCs. Back up first.
- Gates green before every commit: `pnpm typecheck`, `pnpm test:runner`,
  `pnpm check:test-hygiene`, `pnpm test:unit:related`. The desktop tier may crash with the known
  SIGSEGV; then run it as 8 shards (command in the handover doc §5).
- Label every finished task honestly (`unit-tested` / `live-proven`). Never claim done without
  proof.
- `git commit -s`, push to `origin main`, never force-push.
- End your session with ROADMAP + STATUS updates, and a dated line appended at the end of the
  owner's vault note `/Users/turko/Bishi-memory/memory/Project — Cindy.md`.

**Start now:** read the five files above, check `git status`, then state in two lines where
things stand and what you will do first.
