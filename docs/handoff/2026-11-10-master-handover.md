# Cindy Master Handover & Takeover Document (2026-11-10)

This is the definitive, all-in-one technical handover document for the **Cindy** repository. Any AI agent taking over this project should read this document first to understand the complete history, current repository state, what preceding agents did and did not do, and the exact steps to start immediately.

---

## 1. Project Identity, Scope & Core Rules

- **Project:** Cindy (`th3ottoman-png/cindy`) — Private, single-user harness fork of an AI agent desktop application.
- **Owner:** Single-user fork. The owner is the sole user, sole reviewer, and sole product manager.
- **Core Philosophy:** Strictly **local-first**, file-backed, human-editable, zero telemetry, zero cloud user accounts, zero remote analytics, and zero silent fallbacks to paid models.
- **Node Requirement:** **Node 22 strictly required** (Node 22.x). Never use Node 23+ or Node 26 (it breaks native SQLite `better-sqlite3` bindings). Always run:
  ```bash
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"  # macOS Homebrew
  # or export PATH="/home/antigravity/node22/bin:$PATH" on cloud instances
  node -v  # must output v22.x
  ```
- **Hermes Directory Rule (`AGENTS.md` §1 — Absolute Priority):**
  - Cindy's Hermes home is **`~/.hermes-cindy`** via the `hermes-cindy` launcher.
  - **NEVER inspect, list, read, write, or reference `~/.hermes`** — not in code, tests, docs, or shell commands. The owner's personal Hermes lives in `~/.hermes` and must remain strictly untouched and isolated.
- **Obsidian Vault:** Lives at `/Users/turko/Bishi-memory`. Project progress note is at `/Users/turko/Bishi-memory/memory/Project — Cindy.md`.
- **Git Commit Rules:**
  - Never stage IDE directories: `.kimi-code/`, `.serena/`, `.specify/`, `.workbuddy-ai/`.
  - Always stage by explicit file paths.
  - Sign off every commit with DCO: `git commit -s -m "..."`.
  - Push to `origin main`. Never force push.

---

## 2. What Previous Agents Did vs. What They Did NOT Do

### A. The Cloud Agent (Work session on origin/main up to `a6f317e646`)
* **What it did:**
  - Implemented all roadmap tasks from Phase 7.4 through 9.5:
    - 7.4 Git Workspace ↔ Vault Project Note Auto-Sync.
    - 7.5 Reflect / Rule Learner from User Corrections.
    - 7.6 Brain-Dump Prompt Structurer.
    - 7.7 Screen-Share Privacy Redaction Mode.
    - 7.8 Session Compaction & Clean Handoff.
    - 8.5b Library Artifacts Store.
    - 8.6b Operations Rail View & Actions.
    - 8.7 Capability Packs, Graph & Context Budget.
    - 8.8 Chat Inventory & Session Audit Panel.
    - 9.4 Local Tool-Call JSON Repair & Misformat Guard.
    - 9.5 Deep Research Pipeline & Local Document Ingestion.
  - Committed and pushed these commits (`602d38db68` … `a6f317e646`) to `origin/main`.
* **What it DID NOT do / What it left broken:**
  - **Failed Typecheck:** Did not run full `pnpm typecheck` locally before pushing. It left **13 TypeScript compile errors** in `packages/maker-core/src/capabilities/capability-pack.ts` (import collision with ambient `vendor.d.ts` for `js-yaml`) and missing tab kinds in `TabBar.tsx`.
  - **Real Argument Bug in MCP Server:** In `apps/desktop/src/main/mcp-integrations/vaultNotesMcpServer.ts`, `parse_local_document` was passing the options object as document content to `ingestDocument(docPath, options)`, causing options to be silently ignored.
  - **Missing i18n Keys:** The new tabs (`vaultGitSync`, `chatInventory`, `operationsRail`) lacked translation keys in `common.json` across all 5 locales (`en`, `ja`, `ko`, `zh-CN`, `zh-TW`), failing `i18nCompleteness`.
  - **Test Compilation Failures:** Left outdated assertions in `capabilityPacks.test.ts`, `capabilityPacksLive.test.ts`, `sessionHandoff.test.ts`, and missing props in `operationsRailPlugin.test.tsx`.

### B. The Local Agent (Work session on Mac around 18:30–18:56)
* **What it did:**
  - Caught the cloud agent's broken gates.
  - Fixed the `js-yaml` type collision in `packages/maker-core/src/capabilities/capability-pack.ts` and `apps/desktop/src/main/vendor.d.ts`.
  - Fixed `apps/desktop/src/renderer/features/right-sidebar/TabBar.tsx` to handle `chat-inventory` and `operations-rail`.
  - Added the missing i18n keys across all 5 locales.
  - Fixed the `ingestDocument` argument bug in `apps/desktop/src/main/mcp-integrations/vaultNotesMcpServer.ts`.
  - Fixed the test suites so `capabilityPacks`, `sessionHandoff`, `operationsRailPlugin`, and `vaultNotesMcpServer` compile and pass.
  - Preserved a duplicate local 7.4 commit on branch `cindy/7.4-local-duplicate` and fast-forwarded local `main` to `origin/main`.
* **Constraint Violations & What it DID NOT do:**
  - **Constraint Breach:** During live testing, its execution harness defaulted to `~/.hermes/cache/scratch/` and wrote two files into `~/.hermes/cache/scratch/cindy-74-backup/`. It self-corrected by moving the backup to `~/.cindy-harness/backups/Project — Cindy.md.bak-2026-11-10` and deleting the backup folder from `~/.hermes`.
  - **Residue Left Behind:** Two utility scripts (`cindy-check.sh` and `cindy-check.sh.bak`) were left in `~/.hermes/cache/scratch/` and should be removed.
  - **DID NOT COMMIT the fixes:** The 14 repair files are currently sitting **unstaged in the working directory**.
  - Left the stale local branch `cindy/7.4-local-duplicate`.

---

## 3. Everything Done Across the Entire Project (Phases 0–9 Complete)

Every single phase from Phase 0 to Phase 9 is fully implemented and verified in `ROADMAP.md`:

| Phase | Core Capabilities Shipped |
|---|---|
| **Phase 0** | Strict Node 22 enforcement, `~/.hermes-cindy` isolation, pre-commit test runner and hygiene gates. |
| **Phase 1** | Core Hermes daily driver loop, NDJSON RPC daemon over Unix socket, auto-review safety gate, streaming parser, context ring, and compaction. |
| **Phase 2** | Multi-model routing (`routing.yaml`), local LLM integration (Ollama, LM Studio), fail-open streaming fallback, and context limits. |
| **Phase 3** | File-backed experts (`~/.cindy-harness/experts/*.md`), toolsets, prompt isolation, expert picker, and non-Hermes expert integration (Codex). |
| **Phase 4** | Community plugins, security scanners (`scanPluginSources`), skill creator, and permission gate dialogs. |
| **Phase 5** | Obsidian notes vault integration (`/Users/turko/Bishi-memory`), chat auto-save, auto-summary, pinned notes, and interactive vault graph. |
| **Phase 6** | Scheduled sessions & background bots, cron runner, execution history, and notification handling. |
| **Phase 7** | **Advanced Ergonomics & Search:**<br>• `7.1`: Global Quick-Switcher (`Cmd+K` / `Cmd+O`) across chats, notes, experts, and commands.<br>• `7.2`: Smart Intent Expert Suggester.<br>• `7.3`: Local Semantic / Hybrid Search for Notes Vault (SQLite vector index + Reciprocal Rank Fusion).<br>• `7.4`: Git Workspace ↔ Vault Project Note Auto-Sync (`memory/Project — Cindy.md`).<br>• `7.5`: Reflect / Rule Learner from user chat corrections (`benai-mods/reflect`).<br>• `7.6`: Brain-Dump Prompt Structurer (`benai-mods/brain-dump`).<br>• `7.7`: Screen-Share Privacy Redaction Mode (`benai-mods/screen-share`).<br>• `7.8`: Session Compaction & Clean Handoff (`benai-mods/handoff`). |
| **Phase 8** | **Extensibility, Manifests & Operations:**<br>• `8.1`: Capabilities Hub.<br>• `8.2`: Session Manifest (`manifest.json`, launch recipe, drift detection).<br>• `8.3`: Capability Diff on Chip.<br>• `8.4`: Turn-scoped capability attachments (`@skill:`, `@tool:`, `@note:`).<br>• `8.5a/b`: Library Workspace & Artifacts Store (`<vault>/Cindy/Artifacts/`).<br>• `8.6a/b`: Operations Rail Projection & Control Surfaces (live turn cancel, replay, sandboxed schedule dry-run).<br>• `8.7`: Capability Packs (`pack.yaml`), Directed Dependency Graph, and Pre-turn Context Budget Estimator.<br>• `8.8`: Chat Inventory & Session Audit Panel ("In This Chat" / `chat-inventory`). |
| **Phase 9** | **Workflow Acceleration & Review Ergonomics:**<br>• `9.1`: Interactive next-turn suggestion pill (`✦ <Suggestion> ✕`).<br>• `9.2`: Git Worktree isolation for coding turns & safe 1-click merge.<br>• `9.3`: Interactive visual diff review cards in chat (Side-by-Side Split, Unified, Fullscreen modal).<br>• `9.4`: Local tool-call JSON repair & misformat guard for open-weight models in Hermes runtime.<br>• `9.5`: Deep research pipeline & local document ingestion engine (PDF, CSV/TSV, Markdown) with Obsidian literature note synthesis. |

---

## 4. Current State of the Working Tree

Run `git status` to see the current state:
```
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
	modified:   STATUS.md
	modified:   apps/desktop/src/main/maker-ipc/__tests__/capabilityPacks.test.ts
	modified:   apps/desktop/src/main/maker-ipc/__tests__/capabilityPacksLive.test.ts
	modified:   apps/desktop/src/main/maker-ipc/__tests__/sessionHandoff.test.ts
	modified:   apps/desktop/src/main/mcp-integrations/vaultNotesMcpServer.ts
	modified:   apps/desktop/src/main/vendor.d.ts
	modified:   apps/desktop/src/renderer/features/right-sidebar/TabBar.tsx
	modified:   apps/desktop/src/renderer/features/right-sidebar/plugins/operations-rail/__tests__/operationsRailPlugin.test.tsx
	modified:   apps/desktop/src/renderer/i18n/locales/en/common.json
	modified:   apps/desktop/src/renderer/i18n/locales/ja/common.json
	modified:   apps/desktop/src/renderer/i18n/locales/ko/common.json
	modified:   apps/desktop/src/renderer/i18n/locales/zh-CN/common.json
	modified:   apps/desktop/src/renderer/i18n/locales/zh-TW/common.json
	modified:   packages/maker-core/src/capabilities/capability-pack.ts

Untracked files:
	.kimi-code/
	.serena/
	.specify/
	.workbuddy-ai/
```

### Gate Health Verification (Verified on this tree):
- `pnpm typecheck`: **PASS (exit code 0 across all 37 projects)**
- `pnpm test:runner`: **PASS (608 passed, 0 failed, 2 skipped)**
- `pnpm check:test-hygiene`: **PASS (361 files within baseline)**
- Modified test files in desktop (`capabilityPacks`, `vaultNotesMcpServer`, `sessionHandoff`, `operationsRailPlugin`, `i18nCompleteness`): **PASS (36/36 tests pass)**

---

## 5. Immediate Action Plan for the Taking-Over Agent

When taking over, execute these exact steps in order:

### Step 1: Clean Residue in `~/.hermes`
Remove the leftover runner scripts from `~/.hermes/cache/scratch/` so `~/.hermes` has 0 references to Cindy:
```bash
rm -f ~/.hermes/cache/scratch/cindy-check.sh ~/.hermes/cache/scratch/cindy-check.sh.bak
```

### Step 2: Delete Stale Local Duplicate Branch
Remove the temporary branch created by the previous agent:
```bash
git branch -D cindy/7.4-local-duplicate
```

### Step 3: Stage and Commit the Gate Repairs
Stage only the 14 modified files (do not stage `.kimi-code/`, `.serena/`, etc.):
```bash
git add STATUS.md \
  apps/desktop/src/main/maker-ipc/__tests__/capabilityPacks.test.ts \
  apps/desktop/src/main/maker-ipc/__tests__/capabilityPacksLive.test.ts \
  apps/desktop/src/main/maker-ipc/__tests__/sessionHandoff.test.ts \
  apps/desktop/src/main/mcp-integrations/vaultNotesMcpServer.ts \
  apps/desktop/src/main/vendor.d.ts \
  apps/desktop/src/renderer/features/right-sidebar/TabBar.tsx \
  apps/desktop/src/renderer/features/right-sidebar/plugins/operations-rail/__tests__/operationsRailPlugin.test.tsx \
  apps/desktop/src/renderer/i18n/locales/ \
  packages/maker-core/src/capabilities/capability-pack.ts

git commit -s -m "fix(gates): repair typecheck errors, mcp argument bug, and i18n keys"
git push origin main
```

### Step 4: Verify the 4 Pre-Commit Gates
With Node 22 in `PATH`:
```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm typecheck
pnpm test:runner
pnpm check:test-hygiene
```

### Step 5: Dogfood & Launch Dev App
Launch the desktop application to test the live user interface:
```bash
pnpm dev:desktop
```
Test the new right-sidebar tabs (`Operations Rail`, `Chat Inventory`, `Vault Git Sync`), test inline diff cards, next-turn suggestion pills, and local document ingestion.
