# Next Agent Takeover Prompt — Cindy (2026-11-10)

Copy and paste the entire block below into the prompt box for the taking-over AI agent:

```markdown
You are taking over autonomous development and operational maintenance on Cindy, a private, single-user harness fork of an AI agent desktop application.

Before writing any code or executing commands, read:
1. `AGENTS.md` (non-negotiable rules — overrides everything else).
2. `HANDOVER.md` (architecture, paths, locations, version pins).
3. `docs/handoff/2026-11-10-master-handover.md` (canonical master handover covering recent agent actions and current state).
4. `ROADMAP.md` (the only source of truth for task status).

---

### Critical Environment Constraints:
- **Node 22 Only:** System default may be Node 26 which breaks native SQLite bindings. Always run:
  `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` (or cloud node22 path).
  Confirm `node -v` reports `v22.x`.
- **Never Touch `~/.hermes`:**
  Cindy's Hermes home is strictly `~/.hermes-cindy` via `hermes-cindy`. Never read, write, list, or reference `~/.hermes`.
- **No Cloud Accounts / No Telemetry / No Silent Fallbacks:**
  Cindy is strictly local-first. Never persist credentials, never add telemetry, never fall back silently to paid models.
- **Git Hygiene:**
  Never stage `.kimi-code/`, `.serena/`, `.specify/`, or `.workbuddy-ai/`.
  Stage by explicit paths. Sign commits with DCO: `git commit -s -m "..."`.

---

### Current Project State & Immediate First Tasks:
The entire roadmap (Phases 0 through 9) is implemented.
The previous cloud agent pushed up to `a6f317e646`, but left 13 typecheck errors and an MCP bug.
The previous local agent fixed all 13 typecheck errors and i18n keys, but stopped before committing them.
Currently, there are **14 modified files unstaged in the working tree** (which pass `typecheck`, `test:runner`, and `check:test-hygiene`).

**Execute these 4 immediate tasks upon starting:**
1. Clean residue in `~/.hermes`:
   `rm -f ~/.hermes/cache/scratch/cindy-check.sh ~/.hermes/cache/scratch/cindy-check.sh.bak`
2. Remove stale branch:
   `git branch -D cindy/7.4-local-duplicate`
3. Stage and commit the 14 gate repair files:
   `git add STATUS.md apps/desktop/ packages/maker-core/`
   `git commit -s -m "fix(gates): repair typecheck errors, mcp argument bug, and i18n keys"`
   `git push origin main`
4. Verify the 4 gates with Node 22 (`pnpm typecheck`, `pnpm test:runner`, `pnpm check:test-hygiene`).

Once the working tree is clean and green, you can proceed with dogfooding via `pnpm dev:desktop`, packaging via `pnpm release:package`, or any new tasks requested by the owner.
```
