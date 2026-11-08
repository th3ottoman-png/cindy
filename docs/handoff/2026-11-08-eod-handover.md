# Handover — 2026-11-08 EOD (End of Day & Agent Handoff)

**Supersedes `2026-11-07-eod-handover.md` and all earlier handovers in `docs/handoff/`.**  
Companion prompt for incoming AI agent: `docs/handoff/2026-11-08-eod-next-agent-prompt.md`.  
**Authoritative rule sources:** `AGENTS.md` (non-negotiable rules), `ROADMAP.md` (source of truth for task status), `HANDOVER.md` (architecture & locations).

---

## 1. Executive Summary & Git Status

- **Repo:** `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy` (quote path due to spaces and `=`).
- **Remote:** `origin main` on private GitHub.
- **Git HEAD:** `1192e6e2f6` ("Implement global quick-switcher spotlight palette (Cmd+K / Cmd+O)").
- **Working Tree:** Clean. (Untracked external dirs `.kimi-code/`, `.serena/`, `.specify/`, `.workbuddy-ai/` must **never** be staged).
- **Current Milestone:**
  - **Phases 0 through 6 are 100% complete and fully verified (`live-proven`).**
  - **Phase 7 (Power-User Speed & Daily-Driver Ergonomics) is active:**
    - **Row 7.1** (Global Quick-Switcher / Spotlight Palette `Cmd+K` / `Cmd+O`) is complete and ✅ `live-proven`.
    - **Row 7.2** (Smart Intent Expert Suggester / "Task Router") is the **top immediate priority** (the owner's personal favorite feature).

---

## 2. Complete Phase Status & Completed Work

### Phase 0 — Baseline & Environment (100% Complete)
- Node 22 pinned (`22.23.4` at `/opt/homebrew/opt/node@22/bin`), pnpm 10.33.2.
- Clean test gates established: `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene`.

### Phase 1 — Hermes Core Runtime & Adapter (100% Complete)
- Full Hermes daemon management (`packages/maker-hermes-manager`), protocol, session isolation, and lifecycle (`1.1` - `1.13`).
- Isolated home at `~/.hermes-cindy` (**never touch `~/.hermes`**).
- Context window monitoring, streaming token parsing, cancellation, auto-review gates, compression notices.

### Phase 2 — Local Model Routing & Providers (100% Complete)
- File-backed configuration at `~/.cindy-harness/providers.yaml` and `~/.cindy-harness/routing.yaml`.
- Offline route detection, fallback refusal (fail closed on safety, no silent paid fallback), one-click alternative switch banner (`SessionRouteBlockedBanner.tsx`).

### Phase 3 — Experts & Persona System (100% Complete)
- File-backed experts at `~/.cindy-harness/experts/<slug>/expert.md` + `tools.yaml`.
- Per-session skill symlinking into session homes (`3.2`), Hermes as Orca multi-agent lead (`3.7`), and expert management UI.

### Phase 4 — Plugin & Extension Surface (100% Complete)
- Dynamic adapter registry (`4.1`) in `@cindy/maker-core/extensions` and `@cindy/maker-core/adapter-extensions`.
- Local plugin directory loader (`4.2`) at `~/.cindy-harness/plugins/` toggled in Settings.
- Unified MCP server catalog (`4.3`) and Hermes Skills manager (`4.4`) with security scan previews and "Add to expert" affordances.
- Extension author guide (`4.5`) in `docs/extending.md`.

### Phase 5 — Research Workflow & Vault Integration (100% Complete)
- **5.1 Notes Vault Bridge:** Agent-facing MCP server `cindy_vault_notes` (`read_note`, `search_notes`, `append_note`, `list_notes`) pointing at `/Users/turko/Bishi-memory`.
- **5.2 Session Export:** Full Markdown transcript export with collapsed tool details and credential redaction.
- **5.3 Long-Running Task View:** Turn timeline adapter and banner for long turns with immediate cancellation feedback.
- **5.4 Scheduled Sessions:** Local cron scheduling (`schedules-config.json`, `schedules-state.json`) running experts on cron with output written to vault.
- **5.5 Auto-Save Every Conversation:** Automatic debounce Markdown persistence of every turn to `<vault>/Cindy/Chats/<date>-<slug>-<id>.md`.
- **5.6 Auto-Summary per Conversation:** Summaries generated on idle or session close by the routed summary model (`deepseek-flash`) into `<vault>/Cindy/Memory/<date>-<slug>-<id>-summary.md`.

### Phase 6 — Advanced Vault Integration & Knowledge Search (100% Complete)
- **6.1 Vault Knowledge Search & Starter Expert:** Starter expert `vault-researcher` and `allSessionsSearch` toggle in Settings → Notes Vault.
- **6.2 Real-time Vault File Watcher:** Recursive debounced watcher pushing `MAKER_PUSH.VAULT_CHANGED` on any note mutation.
- **6.3 Cross-Session Vault Memory Synthesis:** Consolidated synthesis note `<vault>/Cindy/Memory/Synthesis.md` with executive summary, decisions, facts learned, backlinks, and session history table.
- **6.4 Vault Tag Explorer & Backlink Graph Visualizer:** Pure indexer (`@cindy/maker-core/vault-graph`), agent tool `explore_vault_graph`, and right-sidebar tab plugin `vault-graph` with interactive tag cloud pills and incoming/outgoing link inspector.
- **6.5 Vault Note Quick-Capture & Context Pinning:** Instant note capture into `Inbox.md` with tagging and secret redaction. Context pinning (`pinned-vault-notes.json`) injecting bounded reference envelopes into Hermes expert preambles. UI Quick Capture drawer and Pin toggles in right sidebar.

### Phase 7 — Power-User Speed & Ergonomics (In Progress)
- **7.1 Global Quick-Switcher / Spotlight Palette (`live-proven`):**
  - Registered shortcut `open-quick-switcher` (`Cmd+K` / `Cmd+O` on darwin, `Ctrl+K` / `Ctrl+O` on win32/linux).
  - Pure fuzzy matcher `quickSwitcherMatcher.ts` with prefix modes (`>` actions, `@` experts, `#` notes, `/` sessions).
  - Spotlight modal `QuickSwitcherDialog.tsx` with arrow key navigation, auto-focus, filter pills, and instant command execution.
  - Live-proven via CDP against running app.
- **7.2 Smart Intent Expert Suggester ("Task Router"):** OPEN — Top priority for next agent.
- **7.3 Local Semantic / Hybrid Search for Notes Vault:** OPEN.
- **7.4 Git Workspace ↔ Vault Project Note Auto-Sync:** OPEN.

---

## 3. Environment & Non-Negotiable Rules

Before touching any code or running tests, remember:
1. **Node 22 Only:**
   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   node -v # MUST report v22.x
   ```
2. **Never Touch `~/.hermes`:**
   Hermes home is strictly **`~/.hermes-cindy`**. Never read, write, list, or delete `~/.hermes`.
3. **No Telemetry, No Accounts, No Cloud Fallbacks:**
   Zero external network calls or cloud dependencies. Fail closed on missing local models.
4. **Gates Must Be Green Before Commit:**
   ```bash
   pnpm typecheck
   pnpm test:runner
   pnpm test:unit:related
   pnpm check:test-hygiene
   ```
5. **Git Commit Format:**
   ```bash
   git commit -s -m "Imperative subject under 72 chars"
   git push origin main
   ```
   Never stage `.kimi-code/`, `.serena/`, `.specify/`, or `.workbuddy-ai/`.
6. **Communication Style:**
   Write for an ADHD reader: Next action first, numbered steps, concrete time estimates, end with one clear next action.

---

## 4. Key Paths & Component Map

| Area | Key Paths | Purpose |
|---|---|---|
| **Core Libraries** | `packages/maker-core/src/notes/` | Vault bridge, graph indexing, capture, synthesis |
| | `packages/maker-core/src/summary/` | Auto-summary generation logic |
| | `packages/maker-core/src/export/` | Session markdown and auto-save |
| | `packages/maker-core/src/extensions/` | Plugin and adapter registries |
| **Hermes Daemon** | `packages/maker-hermes-manager/` | Hermes process manager, protocol, config |
| **Desktop Main/IPC** | `apps/desktop/src/main/maker-ipc/vaultNotes.ts` | Host for vault bridge, graph, capture |
| | `apps/desktop/src/main/mcp-integrations/vaultNotesMcpServer.ts` | Agent MCP tools (`cindy_vault_notes`) |
| | `apps/desktop/src/main/maker-host/index.ts` | Adapter instantiation & preamble assembly |
| **Desktop Renderer** | `apps/desktop/src/renderer/components/quick-switcher/` | Spotlight command palette (Cmd+K) |
| | `apps/desktop/src/renderer/features/right-sidebar/plugins/vault-graph/` | Vault tag cloud & backlink explorer tab |
| | `apps/desktop/src/renderer/features/cc-agent/new-task/` | New task draft composer & expert pickers |
| **Harness User Config** | `~/.cindy-harness/` | `vault.json`, `pinned-vault-notes.json`, `experts/` |
| **Notes Vault** | `/Users/turko/Bishi-memory` | Owner's real Obsidian markdown vault |
| **Dev App Runtime** | CDP: `127.0.0.1:9222`, Vite: `5174` | `pnpm restart:desktop:remote` launches dev app |

---

## 5. Next Immediate Mission: Row 7.2 (Smart Intent Expert Suggester)

The owner specifically designated **Option D / Row 7.2** as their favorite feature.

### Goal:
When typing in the new task composer (`apps/desktop/src/renderer/features/cc-agent/new-task/NewMakerDraftRoute.tsx` or `ChatInput.tsx`), analyze the user's initial prompt and suggest a relevant installed expert via a non-intrusive 1-click pill banner above the composer (e.g. *"✨ Looks like a code review task. Switch to Code Reviewer?"* [Switch] [Dismiss]).

### Key Requirements:
1. **Zero Modal Lock-in:** The suggestion is a gentle suggestion chip; the user can completely ignore it or press Enter to proceed without interruption.
2. **Deterministic & Fast:**
   - Use keyword/regex heuristics (e.g., git diff, PR, bug, refactor, test → `code-reviewer`; vault, note, memory, backlink, obsidian → `vault-researcher`) with optional fallback to a fast local model if routed (`routing.yaml` `intent-classifier` or `local-small`).
   - Pure intent classifier in `@cindy/maker-core/experts/intent-classifier.ts` (with 100% unit test coverage).
3. **1-Click Switch:**
   - Clicking [Switch] invokes the existing `setPendingExpert(...)` hook or draft update, setting the expert badge and tooling without clearing the user's typed prompt.
   - Clicking [Dismiss] (or `X`) silences the suggestion for the current draft.
4. **Verification:**
   - Unit tests for the classifier and component.
   - Live CDP proof in running app: typing a coding prompt surfaces the `Code Reviewer` pill; 1-click switches expert.
