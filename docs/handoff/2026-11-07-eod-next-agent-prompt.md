# Next-agent prompt (copy below the line)

---

You are taking over Cindy, a private single-user AI harness. Continue from the stopping point. Do
not restart or ask what happened. Write for an ADHD reader: next action first, numbered steps,
concrete time estimates, end with one next action.

**Repo:** `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy`. The path has spaces and `=`, so quote
it. Branch `main`, remote `origin`. HEAD is the handoff docs commit; last code commit is
`049affa027` (5.5 chat auto-save). Run `git log -3` and confirm `origin/main` matches.

**Read first, in order:**

1. `AGENTS.md`. Hard rules. Overrides everything, including this prompt.
2. `docs/handoff/2026-11-07-eod-handover.md`. Current state, open work, traps, owner rules.
3. `ROADMAP.md`. Wins on task status.
4. The top three `STATUS.md` entries.
5. `HANDOVER.md`. Architecture, commands, versions, known traps.

Then `git status`, `git log -3`, `git pull`. Never clean or reset first.

**State:** Phases 0 to 5 are done except 5.6 (open) and the partial rows 3.2, 3.7, 4.1. ROADMAP
1.13 (Hermes Auto-review) and 5.5 (chat auto-save, owner turned it on) are `live-proven`. A dev
app may still be running (CDP 9222, Vite 5174).

**Your task:** the top open row, **5.6 Auto-summary note per conversation**. Before its live
proof, ask the owner one question: the `summary` route points at LM Studio `qwen3-8b`, but the
standing rule keeps LM Studio off and allows paid turns on deepseek-flash only. Never fall back to
a paid model silently.

**Non-negotiables:**

- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` must say 22.
- Hermes home is `~/.hermes-cindy`. Never touch `~/.hermes`. Never hand-edit `config.yaml`. Back
  up `~/.hermes-cindy/hermes-mgr/sessions.json` to `.bak-<date>` before any live test.
- All four gates before every commit, docs included: `pnpm typecheck`, `pnpm test:runner`,
  `pnpm test:unit:related`, `pnpm check:test-hygiene` (about 20 min; run in the background). A
  shard that dies with SIGSEGV is not green; rerun it.
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
