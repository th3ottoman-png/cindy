# Next agent prompt — Cindy Phase 10 (2026-11-10)

Copy the whole block below into the taking-over agent's prompt box.

```markdown
You are taking over autonomous development on Cindy — a private, single-user harness fork of an AI agent desktop
app, at `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy` (the path has spaces and `=`; always quote it).

Read, in this order, before you write any code:
1. `AGENTS.md` — non-negotiable rules; they override everything else, including this prompt.
2. `HANDOVER.md` — architecture, paths, version pins.
3. `docs/handoff/2026-11-10-phase10-handover.md` — your brief. Where the repo is, what changed on 2026-11-10, the
   design briefs for each Phase 10 row, the traps, and what was deliberately not taken from Goose.
4. `docs/handoff/2026-11-10-latest-handover.md` — environment history and the remaining non-Phase-10 open items.
5. `ROADMAP.md` — single source of truth for task status. Phase 10 is the only open phase.
6. `STATUS.md` — top six entries are the honest record of the last two sessions.

## Environment (enforced, not remembered)
- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` must print v22.x. Node 26 breaks
  `better-sqlite3`.
- Cindy's Hermes home is `~/.hermes-cindy` via the `hermes-cindy` launcher. **Never read, write, list or reference
  `~/.hermes`** — not in code, tests, shell commands or docs. Your own shell exports `HERMES_HOME=~/.hermes`; never
  let it reach a probe or the app.
- Start the dev app only with `pnpm restart:desktop:remote --region=global` and wait for `DESKTOP_DEV_VERDICT=ready`.
  Never `pnpm dev:desktop`.
- Never hand-edit `~/.hermes-cindy/config.yaml`; use the daemon RPCs (add one if it is missing — see `9b7563aaa6`).
- Provider keys live only in `~/.hermes-cindy/.env`. Never in the repo, never in Cindy's config or DB.
- Git: stage by explicit path (never `.kimi-code/`, `.serena/`, `.specify/`, `.workbuddy-ai/`), commit with
  `git commit -s`, push to `origin main`, never force-push.

## Your task
Take ROADMAP row **10.1 — runtime prompt-injection & dangerous-command guard**, one task per session, to the label its
acceptance criteria demand (`live-proven` for 10.1: it changes what executes). If you finish it, stop and report;
do not start 10.2 to fill time.

Why it exists: in Full access Cindy passes `--yolo` to Hermes, which bypasses Hermes's own command approvals, and
`--safe-mode` does not apply — so today nothing inspects a tool call before it runs. Cindy has no injection detection
at all. The brief names the seams (tool-call-repair.ts, auto-review-gate.ts and its measured 30 s/24 s hook cap, the
tool-result path back into context), the scorer shape, the policy (`block` / `hold` / `log`, default threshold 0.8),
and the false positives that must not fire. Local heuristics only — no network call, no hosted classifier.

Before you touch anything: `git status`, `git log --oneline -6`, `pnpm typecheck && pnpm test:runner &&
pnpm check:test-hygiene` under Node 22, and read the files the brief names. Then write the scorer as a pure module with
tests first, wire it at the seam, and prove it in a live Full-access turn — a benign destructive-but-intended command
must still pass.

Finish with: the `ROADMAP.md` row updated honestly, a dated `STATUS.md` entry (what changed, how it was verified, what
is still open), a DCO commit pushed to `origin main`, and a one-paragraph report of what is proven and what is not.
If you cannot reach `live-proven`, say so plainly and leave the row open — an honest red cell beats a misleading green.
```
