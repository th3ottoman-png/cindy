# Next-agent prompt (copy below the line)

---

You are taking over Cindy, a private single-user AI harness. Continue from the stopping point. Do
not restart or ask what happened. Write for an ADHD reader: next action first, numbered steps,
concrete time estimates, end with one next action.

**Repo:** `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy`. The path has spaces and `=`, so quote
it. Branch `main`, remote `origin`. Run `git log -3` and confirm `origin/main` matches.

**Read first, in order:**

1. `AGENTS.md`. Hard rules. Overrides everything, including this prompt.
2. `docs/handoff/2026-11-08-eod-handover.md`. Current state, open work, traps, owner rules.
3. `ROADMAP.md`. Wins on task status.
4. The top three `STATUS.md` entries.
5. `HANDOVER.md`. Architecture, commands, versions, known traps.

Then `git status`, `git log -3`, `git pull origin main`. Never clean or reset first.

**State:**
- Phase 5 is 100% complete and `live-proven` (including 5.6 Auto-summary note on `deepseek-flash`).
- Rows 3.2 (Start session as expert + per-session skills + non-Hermes experts), 3.7 (Hermes as Orca lead with new-task collaboration toggle unhidden), and 4.1 (dynamic adapter registry consumption) are completed and `unit-tested`.

**Your task:**
Pick up the open live-proof validations on the running Mac desktop app:
1. **Live-prove 3.2 per-session skills linking**: Add a dummy skill to an expert (`mkdir -p ~/.cindy-harness/experts/code-reviewer/skills/sample-expert-skill`), start a Hermes task with Code Reviewer, and verify `ls -la ~/.hermes-cindy/session-homes/*/skills/sample-expert-skill` links the expert skill into the session home alongside base skills.
2. **Live-prove 3.2 non-Hermes experts**: Select Claude Code / Codex / Pi in New Task, pick an expert matching that agent, send a turn, and verify badge and prompt preamble.
3. **Live-prove 3.7 Hermes collaboration lead**: Start a new Hermes task with the Team/Collab toggle ON, and verify Hermes dispatches a team worker.

**Non-negotiables:**

- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` must say 22.
- Hermes home is `~/.hermes-cindy`. Never touch `~/.hermes`. Never hand-edit `config.yaml`. Back
  up `~/.hermes-cindy/hermes-mgr/sessions.json` to `.bak-<date>` before any live test.
- All four gates before every commit, docs included: `pnpm typecheck`, `pnpm test:runner`,
  `pnpm test:unit:related`, `pnpm check:test-hygiene`.
- Label honestly: `typechecked`, `unit-tested`, `live-proven`. Never claim done without the proof
  the row demands. Split a narrowed task instead of marking it done.
- `git commit -s`, imperative subject under 72 chars, no attribution lines, push `origin main`,
  never force-push. Stage by explicit path; never stage `.kimi-code/`, `.serena/`, `.specify/`,
  `.workbuddy-ai/`.
- After any edit, check `git diff --stat`: a formatter hook can rewrite whole files.
- End with `ROADMAP.md` + `STATUS.md` edits, `HANDOVER.md` only for stable changes, and a dated
  line appended to `/Users/turko/Bishi-memory/memory/Project — Cindy.md`.

**Start now:** read the five files, check git state, then say in two lines where things stand and
your first move.
