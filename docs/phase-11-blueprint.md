# Phase 11 Blueprint: Progressive Skills, Multi-Model Council & Autonomous Safeguards

**Target Repository:** Cindy (Private Desktop Harness)  
**Applicable Rules:** `AGENTS.md` (Node 22, strict path quoting, `~/.hermes-cindy` isolation, local-first file-backed, fail-closed safety, no hidden state).  
**Source Inspiration:** Curated handpicked skills collection (`davidondrej/skills`) adapted from prompt-only heuristics into first-class desktop harness implementations.  
**Decisions Incorporated:**
1. Placement: Confirmed as **Phase 11** immediately following Phase 10.
2. Skill Activation: **Dual Activation** supported — both autonomous MCP tool (`activate_skill`) and user-driven composer (`@skill:<name>` / `/name`).
3. Council Review Selection: **Interactive Model Picker** allowing the owner to choose up to 3 models (any mix of local and API models from their active provider catalog) directly in the review UI.

---

## Architecture Compatibility & Non-Clash Guarantee

1. **Hermes Daemon Isolation (`packages/maker-hermes-manager`):**  
   All hooks, session-homes, and socket RPCs remain isolated in `~/.hermes-cindy/`. No references to `~/.hermes`.
2. **Multi-Model Provider Guard (`packages/model-providers`):**  
   The Council Review engine queries the active provider catalog (`providers.yaml` / `routing.yaml`). Models chosen by the owner are validated for online health before dispatch; if an offline local model or unauthenticated provider is selected, it warns clearly with no silent substitution.
3. **Safe-Mode & Chat-Only Compatibility (Phase 10.3):**  
   Progressive skill loading respects `--safe-mode` and `-t ''`. If a session is in Chat-Only mode, all skill discovery and activations are strictly disabled.
4. **Vault Containment (`Bishi-memory`):**  
   ADRs and handoff summaries strictly write to the configured notes vault (`Cindy/Decisions/`, `Cindy/Memory/`) with secret redaction and path traversal checks.

---

## Roadmap Tasks (Phase 11 for `ROADMAP.md`)

```markdown
## Phase 11 — Progressive Skills, Multi-Model Council & Autonomous Safeguards
```

| # | Task | Done when | Status |
|---|---|---|---|
| 11.1 | **3-Tier Progressive Skill Loading Engine (`effective-agent-skills`).** Replace eager loading of all `SKILL.md` files with a 3-tier progressive disclosure pipeline. **Level 1 (Discovery):** Daemon compiles a lightweight manifest of installed skills (`name` + `description`, ~50 tokens per skill) into system context. **Level 2 (Dual Activation):** 1) Autonomous MCP tool `activate_skill({ name })` loads full `SKILL.md` (<5,000 tokens) dynamically on-demand when matched by model; 2) Composer `@skill:<name>` / slash command `/name` pins skill instructions for that turn. **Level 3 (Execution):** Nested `references/` and `scripts/` are executed via shell or read via file tools without loading raw source into prompt context. | 🧪 `unit-tested` across `packages/maker-core/src/skills/` and `session-home.ts`. `live-proven` on dev app: session with 20 installed skills boots with <800 discovery tokens; calling `activate_skill` or typing `@skill:foo` injects full instructions without session restart. | 🔲 |
| 11.2 | **Native OS Power & Sleep Manager (`anti-sleep`).** Integrate Electron `powerSaveBlocker` into desktop main process (`powerSaveController.ts`). Automatically acquires `'prevent-app-suspension'` when any session turn is active (`running: true`) or a background scheduled job (5.4) / deep research (9.5) runs; automatically releases on turn completion or error. Header status indicator displays coffee cup icon with live wake lock status and optional manual toggle. | 🧪 `unit-tested` (mock Electron powerSaveBlocker lifecycle). `live-proven` on macOS: running 5-minute turn prevents system display sleep and socket hangup; releasing lock resets power state. | 🔲 |
| 11.3 | **Deterministic Command Guardrails (`global-agent-guardrails`).** Add zero-latency, deterministic POSIX regex denylist in `packages/maker-hermes-manager/src/auto-review-gate.ts` and the Python `pre_tool_call` hook. Reads patterns from local-first, human-editable `~/.cindy-harness/guardrails.yaml`. Catastrophic commands (`rm -rf /`, `mkfs`, `git reset --hard` with uncommitted changes, DB drop, credential exfiltration) are blocked in $\approx 1\,\text{ms}$ before LLM auto-review runs. Renders prominent UI warning card with 1-click "Allow Once (Override)" for the owner. | 🧪 `unit-tested` (25 positive/negative regex cases including obfuscation variants). `live-proven` against Hermes `terminal` tool: `git push --force` or destructive wipe blocked instantly with zero token cost. | 🔲 |
| 11.4 | **Multi-Model Council Review with Selectable Reviewers (`total-review`, `codex-subagent`).** Extend `apps/desktop/src/main/git-review` with a Council Review modal. Diff viewer (9.3) gains a "Request Council Review" button opening an interactive model picker populated from active `providers.yaml`: owner selects 1 to 3 models (any mix of local and API models, e.g. 1 local Qwen + 2 API models like Codex/Claude, or 1 local + 1 API). Dispatches parallel review turns with neutral diff briefs. Deduplicates findings by file/line, ranks by consensus (`[2/3 models agreed]`), and renders an interactive checklist in the Review sidebar with 1-click patch application. Remembers last-used reviewer selection in `routing.yaml`. | 🧪 `unit-tested` (model picker validation, concurrent dispatch, consensus deduplication). `live-proven` on a 50-line git diff: owner selects 1 local + 1 API model; parallel reviews generate consensus findings in UI with zero model hallucination leaks. | 🔲 |
| 11.5 | **1-Click Clean-Slate Session Handoff (`handoff`).** Add "Handoff to Fresh Session" action to `SessionContextGuardBanner` (2.5) and session header menu. Automatically compiles a structured handoff payload: 1) Active decisions & architecture constraints from `Synthesis.md`, 2) Uncommitted git working tree diff / modified file list, 3) Pending next steps & unresolved questions. Spawns a fresh Hermes or Codex session seeded with this structured payload, terminating the bloated session and preserving 100% of context window capacity. | 🧪 `unit-tested` (payload assembly, secret redaction, token count verification). `live-proven` in running app: session at 95% context triggers handoff; new session opens with clean context, correct file state, and continues task without re-asking questions. | 🔲 |
| 11.6 | **Local Dev Service Supervisor (`persistent-localhost`).** Background process & port tracker in `apps/desktop/src/main/local-services/`. Automatically indexes child processes and TCP ports spawned by agent bash commands (`vite`, `node`, `python`, `docker`). Mounts an "Active Services" panel into the Operations Rail (8.6), showing port numbers, process handles, uptime, logs, and 1-click restart/terminate buttons. Prevents orphaned server instances and port collisions on rerun. | 🧪 `unit-tested` (port detection via `lsof`, graceful kill + force kill escalation). `live-proven`: agent launches local Vite dev server on port 5173; Operations Rail shows live status; 1-click stop cleanly frees port without orphan processes. | 🔲 |
| 11.7 | **Pre-Flight Decision Cards & Interrogate Mode (`before-building`, `4x4`, `ask-then-build`).** Composer modifier chip `✦ Plan First` (alongside `Chat-Only` in 10.3). When enabled, the model's first turn is constrained to architectural discovery: it must return 1–3 consequential choices or a 4x4 matrix of tradeoffs rendered as interactive `DecisionCard` UI elements. File modification tools remain locked until the owner makes selections or clicks "Proceed to Build". | 🧪 `unit-tested` (decision card parsing, state machine gating tool calls). `live-proven`: prompt "Build user auth" in Plan First mode renders 3 choice cards (JWT vs Session, local DB vs SQLite, cookie vs header); selecting options unlocks turn execution with choices injected. | 🔲 |
| 11.8 | **Vault ADR Manager & Automatic Context Ingestion (`adr-verbatim`, `read-all-adrs`).** Add first-party MCP tools `record_adr` and `query_adrs` to `cindy_vault_notes`. `record_adr` writes structured Markdown ADRs conforming to `docs/decisions/` standard directly to `<vault>/Cindy/Decisions/<YYYY-MM-DD>-<slug>.md` and local repo `docs/decisions/`. On new session start, Cindy automatically performs keyword matching against the prompt and injects titles of relevant past ADRs into the session's manifest strip to prevent re-litigating settled decisions. | 🧪 `unit-tested` (ADR schema validation, atomic temp+rename, path containment). `live-proven`: agent calls `record_adr`; ADR file appears in vault and repo; subsequent session querying that topic cites the ADR. | 🔲 |
| 11.9 | **High-Blast-Radius Pre-Check Guard (`risky-changes`).** Static inspection layer in `packages/maker-hermes-manager/src/auto-review-gate.ts`. Evaluates target file paths in tool calls against high-risk categories: authentication/crypto (`auth.*`, `keychain*`, `jwt*`), database schemas/migrations (`schema.sql`, `migrations/*`), payment/pricing files, and harness configuration (`providers.yaml`, `routing.yaml`). Any tool modifying these files automatically triggers an elevated Owner Review Card with an explicit blast-radius checklist before execution. | 🧪 `unit-tested` (path classifier, sensitivity scoring). `live-proven`: Hermes attempt to edit `providers.yaml` is paused by auto-review gate; UI displays amber "High-Risk System File" review card with diff. | 🔲 |
| 11.10 | **Session Uncertainty & Assumption Audit Panel (`decisions`, `state`).** Enhance right sidebar "In This Chat" inspector (8.8) with an "Audit & Assumptions" tab. Turn event parser extracts: 1) Completion progress %, 2) Explicit architectural decisions made during the turn, 3) Self-reported low-confidence assumptions (extracted via structured turn footer or reflection). Amber warning pill appears next to assumptions below 80% confidence, giving the owner instant visibility into potential hallucinations. | 🧪 `unit-tested` (uncertainty reflection extraction, schema normalization). `live-proven`: agent generates complex refactor; inspector tab surfaces "Assumption: Redis is running on default port 6379 (Confidence: 60%)" with 1-click verify action. | 🔲 |
| 11.11 | **Git Worktree Isolation & Council Integration (Phase 9.2 Expansion) (`git-worktree`).** Complete Phase 9.2 with deep wiring into Phase 11.4 Council Review. Turns running on branches (`cindy/task-<id>`) in isolated worktrees automatically run council reviews on the worktree diff. If review passes and the owner approves, 1-click "Merge to Main Worktree" cleanly merges and deletes the temporary worktree without dirtying the active editor state. | 🧪 `unit-tested` (worktree creation, branch cleanup, merge conflict detection). `live-proven`: coding task runs in isolated worktree; council passes; 1-click merge lands cleanly in working directory. | 🔲 |

---

## Technical Blueprints

### Task 11.1: 3-Tier Progressive Skill Loading Engine (`effective-agent-skills`)
- **Level 1 (Discovery):** `skill-manager.ts` parses `SKILL.md` frontmatter and injects `<name>` + `<description>` catalog into turn context (~700 tokens for 20 skills).
- **Level 2 (Dual Activation):**
  - **Autonomous Model Activation:** Tool `activate_skill({ name: string })` in Cindy's internal MCP server. When the model invokes it, Cindy loads the full `SKILL.md` into the conversation context as tool output.
  - **User-Driven Composer Activation:** Typing `@skill:<name>` or `/name` pins that skill for the turn via `pinned-skill-invocation.ts`.
- **Level 3 (Execution):** Nested `references/` are read on-demand via file tools; `scripts/` are executed via bash without loading source code into LLM context.

### Task 11.4: Multi-Model Council Review with Selectable Reviewers
- **Council Trigger:** "Request Council Review" button in Diff Viewer (Phase 9.3) or Operations Rail (Phase 8.6).
- **Reviewer Modal:**
  - Interactive multi-select listing models from `providers.yaml` (e.g. `lmstudio-local/qwen2.5-coder-14b`, `anthropic-direct/claude-3-5-sonnet`, `codex/gpt-5.6-sol`, `ollama/deepseek-r1-14b`).
  - Limits selection to 1–3 models (enforcing flexible local + API combinations).
  - Remembers the user's last selection in `~/.cindy-harness/routing.yaml` under `council.last_selected_reviewers`.
- **Concurrent Dispatch:** Spawns background review passes with neutral diff brief via `maker-core` adapters.
- **Consensus Engine:** Deduplicates findings by file/line and tags agreement (e.g., `[Qwen + Claude agreed]`). Renders collapsible checklist with 1-click apply.
