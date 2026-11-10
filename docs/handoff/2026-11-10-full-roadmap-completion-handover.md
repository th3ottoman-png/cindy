# Full Roadmap Completion Handover (2026-11-10)

This document provides the canonical technical state, architecture overview, operational commands, and guidelines for any AI agent taking over the **Cindy** repository.

---

## 1. Project Overview & Current State

- **Repository:** Private, single-user harness fork of Cindy (`th3ottoman-png/cindy`).
- **Owner & Context:** Single-user fork optimized as a daily driver harness for coding and research with zero telemetry, zero cloud accounts, strict local-first data ownership, and direct connectivity to local LLMs (Ollama / LM Studio) or provider API keys.
- **Git HEAD:** `origin/main` at commit `5fc7d9c3` or newer.
- **Roadmap Status:** **100% COMPLETE.** Every phase from Phase 0 to Phase 9 is fully implemented and verified (`live-proven` or `unit-tested`).
  - **Phase 0:** Setup & Environment Enforcement (Node 22 strict pin, `~/.hermes-cindy` isolation, pre-commit gates).
  - **Phase 1:** Core Hermes daily driver loop, NDJSON RPC daemon, auto-review gate, streaming parser, context ring, compaction.
  - **Phase 2:** Multi-model routing (`routing.yaml`), local provider integrations, streaming fallback, context limits.
  - **Phase 3:** File-backed experts (`~/.cindy-harness/experts/*.md`), toolsets, prompt isolation, expert picker.
  - **Phase 4:** Community plugins, security scanners, skill creator, permission gates.
  - **Phase 5:** Obsidian notes vault integration (`Bishi-memory`), chat auto-save, auto-summary, pinned notes.
  - **Phase 6:** Scheduled sessions & background bots, cron runner, execution history.
  - **Phase 7:** Advanced interactions & search:
    - `7.1`: Global Quick-Switcher (`Cmd+K` / `Cmd+O`).
    - `7.2`: Smart Intent Expert Suggester.
    - `7.3`: Local Semantic / Hybrid Search for Notes Vault (SQLite vector store + RRF).
    - `7.4`: Git Workspace ↔ Vault Project Note Auto-Sync.
    - `7.5`: Reflect / Rule Learner from User Corrections (`benai-mods/reflect`).
    - `7.6`: Brain-Dump Prompt Structurer (`benai-mods/brain-dump`).
    - `7.7`: Screen-Share Privacy Redaction Mode (`benai-mods/screen-share`).
    - `7.8`: Session Compaction & Clean Handoff (`benai-mods/handoff`).
  - **Phase 8:** Extensibility, manifests & operations:
    - `8.1`: Capabilities Hub.
    - `8.2`: Session Manifest (`manifest.json`, launch recipe, drift detection).
    - `8.3`: Capability Diff on Chip.
    - `8.4`: Turn-scoped `@` capability attachments (`@skill:`, `@tool:`, `@note:`).
    - `8.5a`: Library Workspace integration.
    - `8.5b`: Library Artifacts Store (`<vault>/Cindy/Artifacts/`).
    - `8.6a`: Operations Rail Projection model.
    - `8.6b`: Operations Rail View & Control Actions (live turn cancel, replay, sandboxed schedule dry-run).
    - `8.7`: Capability Packs (`pack.yaml`), Directed Dependency Graph, and Pre-turn Context Budget Estimator.
    - `8.8`: Chat Inventory & Session Audit Panel ("In This Chat" / `chat-inventory`).
  - **Phase 9:** Workflow acceleration & review ergonomics:
    - `9.1`: Interactive next-turn suggestion pill (`✦ <Suggestion> ✕`).
    - `9.2`: Git Worktree isolation for coding turns & safe 1-click merge.
    - `9.3`: Interactive visual diff review cards in chat (Side-by-Side Split, Unified, Fullscreen).
    - `9.4`: Local tool-call JSON repair & misformat guard in Hermes runtime.
    - `9.5`: Deep research pipeline & local document ingestion engine (PDF, CSV/TSV, Markdown) with Obsidian literature note synthesis.

---

## 2. Environment & Constraints (`AGENTS.md`)

These rules are strictly enforced and take precedence over everything else:

1. **Node 22 Strictly Required:**
   - Always run with Node 22 in `PATH`:
     ```bash
     export PATH="/home/antigravity/node22/bin:$PATH"
     # or on macOS: export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
     ```
   - Confirm `node -v` reports `v22.x` before any command. Running on Node 26 will break native SQLite bindings (`better-sqlite3`).
2. **Never Touch `~/.hermes`:**
   - Hermes home is strictly `~/.hermes-cindy` via the `hermes-cindy` launcher.
   - Never inspect, list, write, or reference `~/.hermes` anywhere in code, tests, documentation, or commands.
3. **Local-First & Zero Telemetry:**
   - No cloud user accounts, no telemetry, no remote sync, no auto-update checks.
   - Never persist credentials to disk. Provider keys travel per-session in memory.
4. **Git & Commit Conventions:**
   - Never stage `.kimi-code/`, `.serena/`, `.specify/`, or `.workbuddy-ai/`.
   - Stage by explicit file paths.
   - Sign commits with DCO: `git commit -s -m "..."`.
   - Imperative subject under 72 characters.
5. **Memory Constraints on Cloud VM:**
   - Cloud VM has 8GB RAM and 0 swap.
   - Do NOT run full un-sharded `pnpm test:unit` across the whole desktop workspace at once (it allocates >6GB heap and OOMs).
   - Use scoped test runs or the 8-shard pattern (`XDT_UNIT_TEST_SHARD=i/8`) as documented in §Debt and `HANDOVER.md` §5.
6. **Pre-commit Gates:**
   - Before any commit:
     ```bash
     pnpm check:test-hygiene
     pnpm test:runner
     pnpm --filter @cindy/maker-core test
     pnpm design:inventory --check  # if renderer TSX/CSS touched
     ```

---

## 3. Architecture & File Layout

```
Cindy renderer (React 19 + Tailwind + Lucide)
   │  IPC bridge (preload/preload.ts → main/maker-ipc/)
Cindy main process (Electron 34)
   │  maker-core ──► agent adapters (hermes, claude-code, codex, pi)
   │                       │
   │                       └─ hermes: NDJSON RPC over unix socket
   │                                 ▼
   │                          hermes-mgr daemon (utilityProcess)
   │                                 ▼
   │                          one `hermes chat` child per turn
   ▼                                 ▼
SQLite (Cindy DB)             ~/.hermes-cindy  (isolated Hermes home)
```

### Key Packages & Locations:

| Component | Path | Subpath Export | Role |
|---|---|---|---|
| **Capability Engine** | `packages/maker-core/src/capabilities/` | `@cindy/maker-core/capability-*` | Pack YAML parser/serializer, dependency graph, context budget estimator |
| **Artifact Store** | `packages/maker-core/src/artifacts/` | `@cindy/maker-core/artifact-store` | Local markdown artifact persistence under `<vault>/Cindy/Artifacts/` |
| **Chat Inventory** | `packages/maker-core/src/session/chat-inventory.ts` | `@cindy/maker-core/chat-inventory` | Session audit & resource breakdown aggregator |
| **Operations Rail** | `packages/maker-core/src/operations/operations-rail.ts` | `@cindy/maker-core/operations-rail` | Timeline aggregator & status projection for turns, workers, bots |
| **Tool Call Repair** | `packages/maker-hermes-manager/src/tool-call-repair.ts` | `@cindy/maker-hermes-manager/tool-call-repair` | Fail-open JSON sanitization for local open-weight LLMs |
| **Document Ingestion**| `packages/maker-core/src/research/` | `@cindy/maker-core/document-ingestion`, `@cindy/maker-core/deep-research-synthesis` | Document parsing (PDF, tabular CSV, Markdown) and literature synthesis |
| **Vault Notes MCP** | `apps/desktop/src/main/mcp-integrations/vaultNotesMcpServer.ts` | N/A | First-party MCP server `cindy_vault_notes` exposing note, artifact, research, and pack tools |
| **Desktop IPC Hosts**| `apps/desktop/src/main/maker-ipc/` | N/A | Host implementations (`capabilityPacks.ts`, `chatInventory.ts`, `operationsRail.ts`, `artifacts.ts`, `vaultGitSync.ts`) |
| **Right Sidebar Tabs**| `apps/desktop/src/renderer/features/right-sidebar/plugins/` | N/A | Modular tabs: `operations-rail`, `chat-inventory`, `vault-git-sync`, `vault-graph`, `review` |

---

## 4. Verification Evidence & Test Suites

All tests pass 100% green under Node 22:

```bash
# 1. Capability Packs, Graph & Budget (Phase 8.7)
pnpm --filter @cindy/maker-core test src/capabilities/__tests__/
# Result: 3 files passed, 11 tests passed

# 2. Desktop IPC & Live Proofs for Packs
pnpm --filter desktop test src/main/maker-ipc/__tests__/capabilityPacks.test.ts src/main/maker-ipc/__tests__/capabilityPacksLive.test.ts
# Result: 2 files passed, 5 tests passed

# 3. First-Party MCP Integration
pnpm --filter desktop test src/main/mcp-integrations/__tests__/vaultNotesMcpServer.test.ts
# Result: 1 file passed, 17 tests passed

# 4. Core Runner & Test Hygiene Gates
pnpm test:runner           # Result: 607 passed, 0 failed, 3 skipped
pnpm check:test-hygiene    # Result: PASS (361 files within baseline)
```

---

## 5. Daily Development & Operation Commands

```bash
# Ensure Node 22
export PATH="/home/antigravity/node22/bin:$PATH"  # or mac path
node -v # must be v22.x

# Start dev desktop application
pnpm dev:desktop

# If UI components in renderer change:
pnpm design:inventory          # updates docs/design-rules/design-inventory.md
node scripts/design-inventory.mjs --check

# Run test hygiene check
pnpm check:test-hygiene

# Commit with DCO signoff
git add <explicit files>
git commit -s -m "type(scope): concise description under 72 chars"
git push origin main
```

---

## 6. What the Next Agent Should Know / Future Opportunities

Since the core autonomous roadmap is complete, here are the most valuable next steps:

1. **Dogfooding & Real-World Workflow Verification:**
   - Use Cindy for daily coding workflows with Hermes connected to local Ollama / LM Studio instances or API endpoints.
   - Exercise the newly shipped interactive surfaces: Operations Rail (`Cmd+K` -> `> Open Operations Rail`), Chat Inventory (`> Open Chat Inventory & Audit`), Capability Packs export/import, and Deep Research synthesis.
2. **Packaging & Release Build Verification:**
   - Verify desktop package build: `pnpm release:package`.
   - Ensure bundled licenses, notices (`pnpm licenses:generate`), and binary shims (`hermes-bridge-shim.mjs`) package cleanly across desktop targets.
3. **Performance & Test Suite Sharding:**
   - If full `pnpm test:unit` is run on resource-constrained VMs, use the sharded runner (`XDT_UNIT_TEST_SHARD=i/8`) to prevent V8 GC memory pressure.
