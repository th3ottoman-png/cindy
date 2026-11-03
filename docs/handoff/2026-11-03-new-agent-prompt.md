# Prompt for the new agent (copy everything below the line)

---

You are taking over the Cindy project from another agent. The owner is away until after Thursday
(2026-11-06) and wants you to continue from the exact stopping point, without starting over and without
asking what happened so far.

**Project folder:** `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy`. The path has spaces and `=`, so
quote it every time. Branch `main`, remote `origin`.

**Before you do anything else, read these, in order:**

1. `AGENTS.md`: hard rules. They override everything, including this prompt.
2. `docs/handoff/2026-11-03-handover.md`: where the last agent stopped, what is open, and every gotcha
   learned.
3. `ROADMAP.md` rows 1.11 and 1.12, plus the Debt section.
4. The top entries of `STATUS.md` (newest first).
5. `HANDOVER.md`: architecture, commands, pinned versions.

**Where things stand (details in the handover doc):**

- 1.11a and 1.11b (auto context compression shown in the chat, including plain turns) are done and
  `live-proven`.
- 1.12a is done: the cause of "Hermes caps every model at 65,536 tokens" is proven. The cause is
  `model.ollama_num_ctx: 65536` in `~/.hermes-cindy/config.yaml`, which Hermes 0.22.5 applies on any
  endpoint.
- **1.12b (the fix) is the next task.** It needs the owner to pick one of the two options in the
  handover doc §4. Do not pick for them. If they have not answered, ask that one question, then take
  another open task (handover doc §5) while you wait.

**A linked session may still be running:** "Hermes caps deepseek-flash at 65,536 tokens",
`local_b3392dcf-4e4b-4407-8c25-e6545b96bad1`. It was working when the handover was written, and it
shares this checkout. Do not stop it. Before you edit anything, run `git status`, `git log -3` and
`git pull`. If it is still active, do not edit ROADMAP/STATUS or the 1.12 files at the same time as it.

**Non-negotiables (from AGENTS.md):**

- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- Never read, write, list or mention the owner's daily Hermes home. Use `~/.hermes-cindy` only.
- Never hand-edit `~/.hermes-cindy/config.yaml`: go through the daemon RPCs. Back up first.
- Gates green before every commit: `pnpm typecheck`, `pnpm test:runner`, `pnpm check:test-hygiene`,
  `pnpm test:unit:related`. The desktop tier may crash with the known SIGSEGV; then run it as 8 shards
  (command in the handover doc §6).
- Label every finished task honestly (`unit-tested` / `live-proven`). Never claim done without proof.
- `git commit -s`, push to `origin main`, never force-push.
- End your session with ROADMAP + STATUS updates, and a dated line in the owner's vault note
  `/Users/turko/Bishi-memory/memory/Project — Cindy.md`.

**Start now:** read the five files above. Check the linked session's state and `git status`. Then
state in two lines where things stand and what you will do first.
