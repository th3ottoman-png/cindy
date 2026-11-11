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
   All hooks, session-homes, and socket RPCs remain isolated in `~/.hermes-cindy/`. Never touch or reference `~/.hermes`.
2. **Multi-Model Provider Guard (`packages/model-providers`):**  
   The Council Review engine queries the active provider catalog (`providers.yaml` / `routing.yaml`). Models chosen by the owner are validated for online health before dispatch; if an offline local model or unauthenticated provider is selected, it warns clearly with no silent substitution.
3. **Safe-Mode & Chat-Only Compatibility (Phase 10.3):**  
   Progressive skill loading respects `--safe-mode` and `-t ''`. If a session is in Chat-Only mode, all skill discovery and activations are strictly disabled.
4. **Vault Containment (`Bishi-memory`):**  
   ADRs and handoff summaries strictly write to the configured notes vault (`Cindy/Decisions/`, `Cindy/Memory/`) with secret redaction and path traversal checks.

---

## Detailed Technical Specification: Task 11.1
### 3-Tier Progressive Skill Loading Engine (`effective-agent-skills`)

### 1. The Problem Being Solved
Historically, AI agent harnesses eagerly loaded every installed skill's complete `SKILL.md` file (often 2,000–5,000 tokens each) into the system prompt on *every single turn*. With 15–30 installed skills, this consumed 30,000–80,000 tokens before the user even typed a word, causing:
1. Massive context window consumption.
2. Incurred latency and high API pricing on paid models.
3. Model confusion ("needle in a haystack" problem across dozens of unrelated skill instructions).

### 2. The 3-Tier Progressive Disclosure Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 1: Lightweight Discovery Manifest (System Context / Prompt)       │
│ - Injected on every session turn                                       │
│ - Only contains: name, slug, description, triggers (~40 tokens/skill)  │
│ - Budget: < 1,000 tokens for 25 installed skills                       │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
┌───────────────────────────────┐     ┌──────────────────────────────────┐
│ TIER 2A: Autonomous Activation│     │ TIER 2B: User-Driven Activation  │
│ - Model identifies need       │     │ - User types @skill:<slug>       │
│ - Calls activate_skill(slug)  │     │ - Or uses slash command /<slug>  │
│ - cindy_skills returns body   │     │ - Preloaded into turn preamble   │
└─────────────┬─────────────────┘     └─────────────────┬────────────────┘
              │                                         │
              └────────────────────┬────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 3: On-Demand Execution (Scripts & References)                     │
│ - scripts/ run via bash tool (never read into context)                 │
│ - references/ read via file tools only when specifically cited         │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 3. TypeScript Interfaces & Schemas

File: `packages/maker-core/src/skills/progressive-skill-engine.ts`

```typescript
export interface SkillFrontmatter {
  name: string;
  description: string;
  author?: string;
  version?: string;
  triggers?: string[];
  requiresTools?: string[];
  disableModelActivation?: boolean;
}

export interface SkillManifestEntry {
  /** Canonical skill identifier slug, e.g. "git-worktree" or "camerax" */
  slug: string;
  /** Human-readable display name */
  name: string;
  /** Bounded 1-2 sentence description explaining WHEN to use this skill */
  description: string;
  /** Absolute filesystem directory path containing SKILL.md */
  skillDir: string;
  /** Estimated token cost of the full SKILL.md file */
  fullTokenEstimate: number;
  /** Whether the skill has executable helper scripts in scripts/ */
  hasScripts: boolean;
  /** Whether the skill has reference docs in references/ */
  hasReferences: boolean;
}

export interface SkillDiscoveryCatalog {
  version: 1;
  compiledAtMs: number;
  totalSkills: number;
  estimatedDiscoveryTokens: number;
  skills: SkillManifestEntry[];
}

export interface SkillActivationResult {
  slug: string;
  name: string;
  instructions: string;
  scriptsDir: string | null;
  referencesDir: string | null;
  availableScripts: string[];
  availableReferences: string[];
}
```

---

### 4. MCP Tool Specification: `activate_skill`

Server: `cindy_skills`  
Tool Name: `activate_skill`

#### Tool Schema (JSON Schema):
```json
{
  "name": "activate_skill",
  "description": "Load the complete instructions, procedures, and script definitions for an installed skill into your context. Call this when a task matches a skill listed in your Available Skills manifest.",
  "parameters": {
    "type": "object",
    "properties": {
      "skill_slug": {
        "type": "string",
        "description": "The exact slug of the skill to activate as listed in the Available Skills manifest (e.g. 'adaptive', 'git-worktree')."
      }
    },
    "required": ["skill_slug"]
  }
}
```

#### Tool Handler Logic:
1. Validates `skill_slug` against cached `SkillDiscoveryCatalog`.
2. If unknown slug: returns structured error with available matching slugs.
3. Reads `<skillDir>/SKILL.md` (bounded to 32 KB / ~8,000 tokens to prevent unbounded blowup).
4. Inspects `<skillDir>/scripts/` and `<skillDir>/references/` without reading file contents, returning file lists as available assets.
5. Returns formatted markdown:
   ```markdown
   # Skill Activated: <name> (<slug>)
   
   ## Instructions
   <SKILL.md content (frontmatter stripped)>
   
   ## Available Assets
   - Scripts: scripts/run_audit.sh (run via bash tool)
   - References: references/architecture.md (read via file tools if needed)
   ```

---

### 5. Tier 1 Discovery Catalog Formatter

The catalog injected into the prompt preamble formatted to maximize retrieval efficiency:

```markdown
<available_skills>
You have access to specialized skills. Full instructions are NOT loaded into context to save tokens.
When a task matches a skill's description, call tool `activate_skill(skill_slug: "<slug>")` to retrieve full instructions before proceeding.

- git-worktree: Isolate feature branches in dedicated git worktrees, preventing active editor churn.
- camerax: Implementation guide for Android CameraX hardware bindings and preview streams.
- effective-agent-skills: 3-tier progressive skill discovery, on-demand activation, and script execution.
- web-scraper: Headless browser scraping and structured data extraction patterns.
</available_skills>
```

Average token cost: ~35 tokens per skill. A library of 25 skills compiles to ~875 tokens (compared to ~60,000 tokens for eager loading).

---

### 6. Integration Seams in Cindy

1. **Catalog Builder (`packages/maker-core/src/skills/progressive-skill-engine.ts`):**
   - Scans installed skill directories (`~/.hermes-cindy/skills/`, `<workspace>/.skills/`, and builtin skills).
   - Parses YAML frontmatter using regex or safe yaml parser.
   - Caches discovery catalog in memory with directory mtime invalidation.
2. **MCP Tool Provider (`packages/mcps/src/cindy-skills/index.ts`):**
   - Registers `activate_skill` tool.
   - Resolves requests through `progressive-skill-engine.ts`.
3. **Turn Attachment Integration (`packages/maker-core/src/turn-attachment/`):**
   - Phase 8.4 already implemented `@skill:<slug>` parsing in the composer.
   - When the user explicitly mentions `@skill:git-worktree`, Cindy bypasses Tier 1 and directly injects the full `SKILL.md` into that specific turn's preamble.
4. **Hermes Session Bootstrap (`packages/maker-hermes-manager/src/session-home.ts`):**
   - When creating or assembling Hermes session arguments, injects the `<available_skills>` discovery strip into system instructions instead of symlinking/copying dozens of raw `SKILL.md` files into the session context.
   - Respects Chat-Only Mode: if `isChatOnly(sessionId)` is true, `<available_skills>` is omitted and `activate_skill` is not registered.

---

### 7. Failure Modes & Non-Negotiable Guards

| Failure Mode | Prevention Mechanism |
|---|---|
| Unknown skill slug requested | Fail closed: return clear error `"Skill '<slug>' is not installed. Available skills: [...]"` |
| Overly large `SKILL.md` file (>32 KB) | Truncate at 32 KB with explicit notice `"[Truncated: skill file exceeds 32KB]"` |
| Symlink traversal in `references/` | Refuse any reference path that resolves outside `skillDir` |
| Chat-Only mode active | Skill discovery catalog omitted; tool call returns `PERMISSION_DENIED` |
| Malformed YAML frontmatter | Fall back to folder name as slug, use first 160 characters of markdown as description |

---

### 8. Testing Strategy & Verification Criteria

#### Unit Tests (`packages/maker-core/src/skills/__tests__/progressive-skill-engine.test.ts`):
1. `parseSkillFrontmatter`: Validates extraction of name, description, and triggers from standard `SKILL.md`.
2. `buildDiscoveryCatalog`: Confirms token estimation and compact markdown formatting.
3. `activateSkill`:
   - Returns full markdown body for existing skill.
   - Rejects unknown skill slug with list of suggestions.
   - Redacts frontmatter to avoid duplicate metadata.
   - Indexes `scripts/` and `references/` directory entries without reading contents.
4. `chatOnlyGuard`: Verifies catalog is null and tool fails closed when chat-only is enabled.

#### Live Verification Criteria:
1. Boot a fresh Hermes task in dev app with 15+ skills installed.
2. Verify session initial token count reflects `<available_skills>` (< 1,000 tokens) instead of full files.
3. Prompt: *"How do I isolate a branch using git worktrees?"*
4. Verify Hermes invokes `activate_skill(skill_slug: "git-worktree")` on turn 1.
5. Verify turn 2 receives full instructions and answers with exact skill procedures.

---

## Technical Specifications: Tasks 11.2 – 11.11

### Task 11.2: Native OS Power & Sleep Manager (`anti-sleep`)
- **Seam:** `apps/desktop/src/main/powerSaveController.ts` using Electron `powerSaveBlocker`.
- **API:**
  - `acquireAppSleepLock(reason: string): number` -> calls `powerSaveBlocker.start('prevent-app-suspension')`.
  - `releaseAppSleepLock(id: number): void` -> calls `powerSaveBlocker.stop(id)`.
- **Wiring:** Hooks into `SessionRegistry` on `running: true` and background tasks (`scheduler-host`, `goal-host`).

### Task 11.3: Deterministic Command Guardrails (`global-agent-guardrails`)
- **Seam:** `packages/maker-hermes-manager/src/auto-review-gate.ts` (evaluated before LLM review).
- **Storage:** `~/.cindy-harness/guardrails.yaml` (local, file-backed).
- **Patterns:** Regex denylist for `rm -rf /`, `mkfs`, `dd`, `git reset --hard` (when uncommitted changes exist), `drop database`.
- **Performance:** Evaluated synchronously in $< 2\,\text{ms}$; if triggered, aborts execution with structured `GuardrailViolationCard`.

### Task 11.4: Multi-Model Council Review with Selectable Reviewers
- **Seam:** `apps/desktop/src/main/git-review/` and `apps/desktop/src/renderer/features/review/`.
- **Model Selector:** Reads online endpoints from `providers.yaml` via `@cindy/model-providers`. Allows user to select 1–3 models.
- **Deduplication:** Groups findings by `(file, startLine, endLine)` with consensus score (`2/3 reviewers agreed`).
- **Persistence:** Remembers user's selection in `routing.yaml` under `council.last_selected_reviewers`.

### Task 11.5: 1-Click Clean-Slate Session Handoff (`handoff`)
- **Seam:** `SessionContextGuardBanner.tsx` and `packages/maker-core/src/tasks/session-handoff.ts`.
- **Payload:** Extracts active constraints, uncommitted git diff, and pending questions; mounts directly into fresh session draft.
