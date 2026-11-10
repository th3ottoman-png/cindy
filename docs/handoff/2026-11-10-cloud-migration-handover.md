# Cloud Migration Handover (2026-11-10)

This handover document provides the exact context, current state, and step-by-step instructions for continuing autonomous execution on cloud machines.

---

## 1. Current State & Completed Work

- **Branch / Commit:** `origin main`.
- **Repository Gates:** 100% green under Node 22 (`typecheck`, `test:runner`, `test:unit:related`, `check:test-hygiene`).
- **Most Recent Completed Task:**
  - **Phase 7.3: Local Semantic / Hybrid Search for Notes Vault** (✅ `live-proven`).
  - Added `DeterministicLocalEmbedder`, `HttpEmbeddingClient`, `VaultSemanticIndex` (SQLite in `~/.cindy-harness/vault-embeddings.db`), and Reciprocal Rank Fusion `hybridSearchVault` in `@cindy/maker-core/vault-semantic`.
  - Wired into `apps/desktop` IPC (`maker:vault:search-notes`, `maker:vault:index-embeddings`) and MCP server `cindy_vault_notes` (`search_notes` tool).
  - Verified live against `/Users/turko/Bishi-memory` with conceptual queries returning semantic matches.
- **5 BenAI Claude Code Mods Registered in ROADMAP:**
  - `7.5`: Reflect / Rule Learner from User Corrections (`benai-mods/reflect`)
  - `7.6`: Brain-Dump Prompt Structurer (`benai-mods/brain-dump`)
  - `7.7`: Screen-Share & Recording Privacy Redaction Mode (`benai-mods/screen-share`)
  - `7.8`: Session Compaction & Clean Handoff (`benai-mods/handoff`)
  - `8.8`: Chat Inventory & Session Audit Panel (`benai-mods/chat-inventory`)

---

## 2. Next Immediate Task: Phase 7.4

When resuming in the cloud, pick the next open row in Phase 7:
**`Phase 7.4: Git Workspace ↔ Vault Project Note Auto-Sync`**

### Requirements from `ROADMAP.md`:
- **Task description:** Right sidebar inspector and agent tool that inspects active workspace git diff and recent commits, offering a 1-click button or tool: *"Append progress & commit log to project note"* in `<vault>/memory/Project — <Name>.md`.
- **Done when:**
  - Unit: git diff/commit parser, project note matching heuristic, and markdown section formatter.
  - Live: 1-click sync appends formatted progress block and commit list to the matching vault project note.

### Architecture / File Guide for 7.4:
- **Core pure logic:** `packages/maker-core/src/notes/vault-git-sync.ts` (export in `package.json`).
  - Finds project name from workspace git root (`path.basename(gitRoot)`).
  - Reads recent commits (`git log -n 5 --oneline`) and git status summary.
  - Formats dated markdown block `### Progress (<date>)\n\n- Commits: ...\n- Status: ...`.
  - Appends to `<vault>/memory/Project — <Name>.md` atomically.
- **Desktop IPC / Main:** `apps/desktop/src/main/maker-ipc/vaultGitSync.ts` (or in `vaultNotes.ts`).
- **Agent MCP Tool:** Add `sync_workspace_git_to_project_note` to `cindy_vault_notes` MCP server (`apps/desktop/src/main/mcp-integrations/vaultNotesMcpServer.ts`).
- **UI:** Right sidebar inspector tab or button in `apps/desktop/src/renderer/features/right-sidebar/plugins/`.

---

## 3. Subsequent Tasks in Sequence

Once 7.4 is completed and proven:
1. **Phase 7.5:** Reflect / Rule Learner from User Corrections (`benai-mods/reflect`).
2. **Phase 7.6:** Brain-Dump Prompt Structurer (`benai-mods/brain-dump`).
3. **Phase 7.7:** Screen-Share Privacy Redaction Mode (`benai-mods/screen-share`).
4. **Phase 7.8:** Session Compaction & Clean Handoff (`benai-mods/handoff`).
5. **Phase 8:**
   - `8.5b`: Library artifacts (if artifact store exists)
   - `8.6b`: Operations rail view and actions
   - `8.7`: Capability packs, graph and budget
   - `8.8`: Chat Inventory & Session Audit Panel (`benai-mods/chat-inventory`)
6. **Phase 9:**
   - `9.4`: Local tool-call JSON repair & misformat guard
   - `9.5`: Deep research & local document ingestion for Notes Vault

---

## 4. Environment Rules Reminder (`AGENTS.md`)

- **Node 22 only**: Always run `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` or equivalent cloud node 22 path.
- **Never touch or reference `~/.hermes`**: Always use `~/.hermes-cindy` or mock fixtures.
- **Green gates before every commit**:
  ```bash
  pnpm typecheck
  pnpm test:runner
  pnpm test:unit:related
  pnpm check:test-hygiene
  ```
- **Commit signing**: `git commit -s` (DCO) with imperative subject under 72 chars.
