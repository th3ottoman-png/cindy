# Next-agent prompt (copy below the line)

---

You are taking over Cindy. Continue from the stopping point. Do not restart or ask what happened.
English, British spelling, short sentences, no em dashes.

**Repo:** `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy`. Path has spaces and `=`, quote it.
Branch `main`, remote `origin`. HEAD is the handoff docs commit; last code commit is
`c483e79e3d` (5.3b). Run `git log -3` for exact SHAs and confirm `origin/main` matches.

**Read first, in order:**

1. `AGENTS.md`. Hard rules. Overrides everything, including this prompt.
2. `docs/handoff/2026-11-04-eod-handover.md`. Current handover. Supersedes all older notes.
3. `ROADMAP.md`. Phases and Debt. Wins on task status.
4. Top `STATUS.md` entries: handoff, 5.3b, 4.5 re-verify, 2.4b-fix.
5. `HANDOVER.md`. Architecture, commands, versions.
6. `docs/dev-rules/desktop-development.md`. Startup and CDP rules.

Then `git status`, `git log -3`, `git pull`. Never clean first.

**State:**

- Phase 4 is functionally complete. 4.1 `unit-tested`, 4.2/4.4 `live-proven`, 4.3 `live-proven`
  but narrowed. 4.5 is drafted, examples re-verified. Its done-test, "owner can follow
  `docs/extending.md` unaided", is the owner's call. You cannot close it.
- 2.4b-live was re-run and the banner defect fixed at `221e3d74cd`. One-click "Use X instead" is
  `unit-tested` only.
- 5.3b is `live-proven` at `c483e79e3d`: a panel after 120 s with elapsed time, tool spans and
  Cancel wired to the existing Stop handler. 25 new tests.
- 5.1a, 5.2a, 5.3a, 5.4a are `unit-tested` modules. 5.1b, 5.2b, 5.4b need app-facing halves.
  3.2b `tools.yaml` schema is a product decision blocking 5.1b and 4.3's "add to expert". Ask
  the owner one question only if it blocks your task.
- Machine: dev app pid 77776, CDP 9222, Vite 5174, LM Studio 1234 with 11 models, Ollama 11434
  offline. The main chat shows a frozen `cancelled` panel from the live proof. Expected. No
  config edit, no linked sessions, no worker teams.

**Open work, in order:** 4.5 owner done-test; 2.4b alternatives; 3.2b schema; 5.1b vault
bridge; 5.2b export; 5.4b schedules; 3.7; Debt picks. Detail in handover §4. One task per
session.

**Non-negotiables:**

- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. Version 22.23.4.
- Hermes home is `~/.hermes-cindy`. Never read, write, list or name the owner's daily Hermes
  home. Never hand-edit `config.yaml`; use daemon RPCs and back up first.
- All four gates before every commit: `pnpm typecheck`, `pnpm test:runner`,
  `pnpm test:unit:related`, `pnpm check:test-hygiene`. No docs-only exception. Run in a real
  Terminal via a `.command` file launched with computer-use `open_app`. The agent shell injects
  `NODE_OPTIONS` and breaks FS-heavy tests. Confirm `NODE_OPTIONS=[]`. Use non-desktop unit plus
  `XDT_UNIT_TEST_SHARD=i/8` for i=1..8. A shard may die with the known V8-GC SIGSEGV; rerun only
  that shard standalone. Never count a crashed run as green.
- Label honestly: `typechecked`, `unit-tested`, `live-proven`, `unverified`. Never claim done
  without the proof the row demands.
- `git commit -s`, imperative subject under 72 chars, push `origin main`, never force-push.
  End with `ROADMAP.md` and `STATUS.md` edits, `HANDOVER.md` only for stable changes, and a dated
  line appended to `/Users/turko/Bishi-memory/memory/Project — Cindy.md`.
- Never stage `.kimi-code/`, `.serena/`, `.specify/`, `.workbuddy-ai/` or
  `apps/desktop/src/renderer/__tests__/tmp-probe/`.

**Live-proof gotchas:** CDP main page is the `#/cc-agent/` target, not the first `page`. Composer
is a Tiptap `DIV[contenteditable=true]`; Send is `button[aria-label="Send message"]`. Never edit
a renderer file during a live turn; the Vite reload kills it. Start the app with
`pnpm restart:desktop:remote --region=global` and wait for `DESKTOP_DEV_VERDICT=ready`.

**Start now:** read the six files, check git state, then state in two lines where things stand
and your first move.
