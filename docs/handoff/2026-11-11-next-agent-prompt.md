# Next agent prompt — Cindy Phase 11 (2026-11-11)

Copy the whole block below into the taking-over agent's prompt box:

```markdown
You are taking over autonomous development on Cindy — a private, single-user harness fork of an AI agent desktop
app, at `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy` (the path has spaces and `=`; always quote it).

Read, in this order, before you touch anything:
1. `AGENTS.md` — non-negotiable rules; they override everything else, including this prompt.
2. `HANDOVER.md` — architecture, paths, version pins.
3. `docs/handoff/2026-11-11-phase11-handover.md` — your brief. What shipped today, what was verified, and what comes next.
4. `phase-11-blueprint.md` — architectural blueprint for Phase 11 features (derived from davidondrej/skills).
5. `ROADMAP.md` — single source of truth for task status. Phase 11 is the current active phase.
6. `STATUS.md` — top entries are the honest record of recent commits and proofs.

## Environment (enforced, not remembered)
- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` must print v22.x.
- Cindy's Hermes home is `~/.hermes-cindy` via the `hermes-cindy` launcher. **Never read, write, list or reference
  `~/.hermes`** — not in code, tests, shell commands or docs.
- Start the dev app only with `pnpm restart:desktop:remote --region=global` and wait for `DESKTOP_DEV_VERDICT=ready`.
  Never `pnpm dev:desktop`.
- Never hand-edit `~/.hermes-cindy/config.yaml`; use the daemon RPCs.
- Provider keys live only in `~/.hermes-cindy/.env`. Never in the repo, never in Cindy's config or DB.
- Git: commit with `git commit -s` (DCO), push to `origin main`, never force-push.
- Before committing, verify all 4 gates under Node 22:
  ```bash
  export NODE_OPTIONS=--max-old-space-size=12288 && pnpm typecheck
  pnpm test:runner
  pnpm test:unit:related
  pnpm check:test-hygiene
  ```
  Note: When styles/tokens change, regenerate `docs/design-rules/design-inventory.md` via `pnpm design:inventory` before running `test:runner`. If `test:unit:related` spans too far back on fork git refs, sync `refs/remotes/upstream/main` to `origin/main` via `git update-ref refs/remotes/upstream/main refs/remotes/origin/main`.

## What Was Just Completed (Phase 11.12 - live-proven)
- **First-Class Project Creation Modal (`NewProjectDialog.tsx` & `projectCreate.ts`):** Supports multi-folder directories with PRIMARY tag, Git init, IDEA.md, .gitignore, SQLite project alias upsert, and Notes Vault project note auto-generation (`memory/Project — <Name>.md`).
- **Professional Idea Presets:** Includes 8 developer suggestions: Code Reviewer, Full-Stack App, Debug & Diagnostics, Backend Service, Dev CLI Tool, MCP Server, Agent Harness, Test Automation.
- **Collapsible PROJECTS Sidebar Section (`ProjectsSection.tsx`):** Explicit "PROJECTS" section header with dynamic folder count badge (`Projects (4)`), always-visible `+` button triggering `NewProjectDialog`, and `localStorage` collapse persistence (`'cindy:sidebar:projects-collapsed'`).

## Your Next Task: Phase 11.1
Take the top open row in `ROADMAP.md`:
**11.1 — 3-Tier Progressive Skill Loading Engine (`effective-agent-skills`)**.

### Goal & Implementation Guide
Instead of dumping full `SKILL.md` documents into the system prompt for every turn (wasting context tokens), implement a 3-tier progressive disclosure engine:
1. **Tier 1 (Discovery Manifest):** The daemon compiles an indexed lightweight manifest containing only `name` and `description` (~50 tokens per skill) into system context.
2. **Tier 2 (Dual Activation):**
   - **Autonomous Mode:** Provide an MCP tool `activate_skill(skill_name)` on `cindy_skills`. When an agent identifies a task needing a skill, it calls this tool to load the full `SKILL.md` body into turn context on demand.
   - **User Mode:** Composer token `@skill:<name>` or `/name` pins the skill directly into turn preamble via `turn-attachment`.
3. **Tier 3 (Execution):** Detailed scripts and reference materials are executed or fetched on demand.

Read `phase-11-blueprint.md` §1 for full schemas, interfaces, and testing strategies.

Work one task per session. Follow AGENTS.md rules: smallest diff that proves the point, unit tests first, update ROADMAP.md and STATUS.md, and commit with `git commit -s`.
```
