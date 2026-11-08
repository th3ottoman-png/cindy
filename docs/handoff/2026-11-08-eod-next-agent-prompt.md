# Next Agent Prompt — Cindy Phase 7 (Power-User Speed & Ergonomics)

Copy and paste the entire block below into the prompt box for the next AI agent:

```markdown
You are taking over development on Cindy, a private, single-user developer fork of an AI agent desktop application.
Before writing any code or executing commands, read:
1. `AGENTS.md` (non-negotiable rules — overrides everything else).
2. `HANDOVER.md` (architecture, paths, locations, version pins).
3. `docs/handoff/2026-11-08-eod-handover.md` (the latest EOD status).
4. `ROADMAP.md` (source of truth for task status).

---

### Critical Environment Constraints:
- **Node 22 Only:** System default is Node 26 which breaks native SQLite bindings. Always run:
  `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
  Confirm `node -v` reports `v22.x`.
- **Never Touch `~/.hermes`:**
  Hermes home is strictly `~/.hermes-cindy` via `hermes-cindy`.
- **No Cloud Accounts / No Telemetry / No Silent Fallbacks:**
  Cindy is strictly local-first. Never persist credentials, never add telemetry, never fall back silently to paid models.
- **Git Hygiene:**
  Never stage `.kimi-code/`, `.serena/`, `.specify/`, or `.workbuddy-ai/`.
  Stage by explicit paths. Sign commits: `git commit -s -m "..."`.
- **Pre-commit Gates (Node 22):**
  Must pass before every commit:
  `pnpm typecheck`
  `pnpm test:runner`
  `pnpm test:unit:related`
  `pnpm check:test-hygiene`
- **Communication Style:**
  Write for an ADHD reader: Next action first, numbered steps, concrete time estimates, end with one clear next action.

---

### Current Project State:
- Git HEAD is `origin/main` at commit `1192e6e2f6` or newer.
- Phases 0, 1, 2, 3, 4, 5, and 6 are **100% complete and live-proven**.
- **Phase 7** has just started:
  - **7.1** (Global Quick-Switcher `Cmd+K` / `Cmd+O`) is complete and ✅ `live-proven`.

---

### Your Immediate Task:
**ROADMAP Row 7.2: Smart Intent Expert Suggester ("Task Router")**
The owner explicitly identified this feature as their personal favorite.

**Goal:**
When the user types a prompt in the new task draft composer (`NewMakerDraftRoute.tsx` or `ChatInput.tsx`), analyze the text and suggest a matching installed expert (e.g. `code-reviewer` for code/git/bugs, `vault-researcher` for notes/vault/research) via a subtle 1-click chip above the input box.

**Implementation Steps:**
1. **Pure Classifier (`@cindy/maker-core/experts/intent-classifier.ts`):**
   - Pure function `suggestExpertForPrompt(prompt: string, installedExperts: Expert[]): ExpertSuggestion | null`.
   - Keyword/regex pattern matcher (e.g., git diff, PR, bug, refactor, test -> `code-reviewer`; vault, note, memory, backlink, obsidian -> `vault-researcher`).
   - Add unit tests in `packages/maker-core/src/experts/__tests__/intent-classifier.test.ts`.
2. **UI Suggestion Banner (`ExpertSuggestionChip.tsx`):**
   - Non-intrusive chip rendered above the composer input:
     `✨ Task resembles Code Review. Switch to Code Reviewer? [Switch] [✕]`
   - Clicking [Switch] sets the pending expert via `setPendingExpert(...)`.
   - Clicking [✕] dismisses the chip for the current draft session.
   - Zero modal lock-in (Enter still submits without forcing any selection).
3. **Verification:**
   - Run all 4 gates green under Node 22.
   - Live-prove via CDP on port 9222: type a coding prompt, observe the chip appear, click [Switch], and verify the expert updates.
4. **Docs & Commit:**
   - Update `ROADMAP.md` (Row 7.2 -> ✅ `live-proven`).
   - Add dated entry in `STATUS.md`.
   - Append dated entry in `/Users/turko/Bishi-memory/memory/Project — Cindy.md`.
   - Commit (`git commit -s`) and push to `origin main`.
```
