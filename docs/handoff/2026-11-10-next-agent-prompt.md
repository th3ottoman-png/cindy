# Next Agent Prompt — Cindy (Post-Roadmap Operational Handover)

Copy and paste the entire block below into the prompt box for the next AI agent:

```markdown
You are taking over autonomous development and operational maintenance on Cindy, a private, single-user harness fork of an AI agent desktop application.
Before writing any code or executing commands, read:
1. `AGENTS.md` (non-negotiable rules — overrides everything else).
2. `HANDOVER.md` (architecture, paths, locations, version pins).
3. `docs/handoff/2026-11-10-full-roadmap-completion-handover.md` (latest complete handover status).
4. `ROADMAP.md` (source of truth for task status).

---

### Critical Environment Constraints:
- **Node 22 Only:** System default may be Node 26 which breaks native SQLite bindings. Always run:
  `export PATH="/home/antigravity/node22/bin:$PATH"` (or `/opt/homebrew/opt/node@22/bin:$PATH` on macOS).
  Confirm `node -v` reports `v22.x`.
- **Never Touch `~/.hermes`:**
  Hermes home is strictly `~/.hermes-cindy` via `hermes-cindy`.
- **No Cloud Accounts / No Telemetry / No Silent Fallbacks:**
  Cindy is strictly local-first. Never persist credentials, never add telemetry, never fall back silently to paid models.
- **Git Hygiene:**
  Never stage `.kimi-code/`, `.serena/`, `.specify/`, or `.workbuddy-ai/`.
  Stage by explicit paths. Sign commits with DCO: `git commit -s -m "..."`.
- **Pre-commit Gates (Node 22):**
  Must pass before every commit:
  `pnpm check:test-hygiene`
  `pnpm test:runner`
  `pnpm --filter @cindy/maker-core test`
  `pnpm design:inventory --check` (if renderer UI touched)

---

### Current Project State:
- Git HEAD is `origin/main` at commit `5fc7d9c3` or newer.
- Phases 0 through 9 are **100% complete, verified, and live-proven**.
- All 5 BenAI Claude Code mods (7.5 Reflect, 7.6 Brain-Dump, 7.7 Screen-Share Privacy, 7.8 Session Handoff, 8.8 Chat Inventory) are shipped and verified.
- Operations Rail (8.6a/b), Capability Packs (8.7), Artifacts Store (8.5b), Tool-Call Repair (9.4), and Deep Research (9.5) are fully live-proven.

---

### Next Work & Areas of Focus:
1. **Dogfooding & Operational Verification:** Run the application via `pnpm dev:desktop`, test agent sessions with local LLMs (Ollama / LM Studio) or API providers.
2. **Packaging:** Run `pnpm release:package` to verify multi-platform packaging assets, licenses, and notices.
3. **New Tasks / Maintenance:** When the owner provides new feature requests or bug reports, follow the strict `AGENTS.md` rules: one task per session, prove at the required level (`unit-tested` or `live-proven`), update `ROADMAP.md`, `STATUS.md`, and `/Users/turko/Bishi-memory/memory/Project — Cindy.md`.
```
