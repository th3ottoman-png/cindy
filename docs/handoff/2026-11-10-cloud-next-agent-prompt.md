# Next Agent Prompt — Cindy (Cloud Autonomous Execution)

Copy and paste the entire block below into the prompt box for the next AI agent:

```markdown
You are taking over autonomous development on Cindy, a private, single-user fork of an AI agent desktop application.
Before writing any code or executing commands, read:
1. `AGENTS.md` (non-negotiable rules — overrides everything else).
2. `HANDOVER.md` (architecture, paths, locations, version pins).
3. `docs/handoff/2026-11-10-cloud-migration-handover.md` (the latest handover status).
4. `ROADMAP.md` (source of truth for task status).

---

### Critical Environment Constraints:
- **Node 22 Only:** System default is Node 26 which breaks native SQLite bindings. Always run:
  `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` (or equivalent Node 22 path on cloud).
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
  `pnpm typecheck`
  `pnpm test:runner`
  `pnpm test:unit:related`
  `pnpm check:test-hygiene`

---

### Current Project State:
- Git HEAD is `origin/main` at commit `379b4e1787` or newer.
- Phases 0, 1, 2, 3, 4, 5, and 6 are **100% complete and live-proven**.
- Phase 7:
  - **7.1** (Global Quick-Switcher `Cmd+K` / `Cmd+O`) is ✅ `live-proven`.
  - **7.2** (Smart Intent Expert Suggester) is ✅ `live-proven`.
  - **7.3** (Local Semantic / Hybrid Search for Notes Vault) is ✅ `live-proven`.
- Phase 8:
  - **8.1** (Capabilities hub), **8.2** (Session manifest), **8.3** (Capability diff on chip), **8.4** (Turn-scoped @ attach), **8.5** (Library workspace), **8.6a** (Operations rail model) are ✅ `live-proven` / `unit-tested`.
- Phase 9:
  - **9.1** (Interactive next-turn suggestion pill), **9.2** (Worktree isolation), **9.3** (Interactive inline diff cards) are ✅ `live-proven`.

---

### Your Autonomous Work Order:
Work autonomously across the remaining roadmap tasks. Do not stop between tasks; finish each to its required verification label (`unit-tested` or `live-proven`), run all 4 gates green, update `ROADMAP.md`, `STATUS.md`, and `/Users/turko/Bishi-memory/memory/Project — Cindy.md`, commit with DCO (`git commit -s`), push to `origin main`, and proceed to the next:

1. **Immediate Task: ROADMAP 7.4 (Git Workspace ↔ Vault Project Note Auto-Sync)**
   - **Goal:** Right sidebar inspector tab and agent tool in `cindy_vault_notes` that inspects the active workspace git diff and recent commits, offering a 1-click button or tool: *"Append progress & commit log to project note"* into `<vault>/memory/Project — <Name>.md`.
   - **Done when:**
     - Unit: git commit/diff parser, project note matching heuristic, and markdown section formatter in `packages/maker-core/src/notes/vault-git-sync.ts`.
     - Live: 1-click sync or agent tool execution appends formatted progress block and commit list to matching project note in the vault.
2. **Phase 7.5:** Reflect / Rule Learner from User Corrections (`benai-mods/reflect`).
3. **Phase 7.6:** Brain-Dump Prompt Structurer (`benai-mods/brain-dump`).
4. **Phase 7.7:** Screen-Share Privacy Redaction Mode (`benai-mods/screen-share`).
5. **Phase 7.8:** Session Compaction & Clean Handoff (`benai-mods/handoff`).
6. **Phase 8:** 8.5b (Library artifacts), 8.6b (Operations rail view & actions), 8.7 (Capability packs & budget), 8.8 (Chat Inventory inspector).
7. **Phase 9:** 9.4 (Tool-call JSON repair & misformat guard), 9.5 (Deep research & document ingestion).
```
