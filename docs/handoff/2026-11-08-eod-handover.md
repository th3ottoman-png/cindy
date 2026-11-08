# Handover — 2026-11-08 EOD

Supersedes `2026-11-07-eod-handover.md` and every older file in `docs/handoff/`. Pair:
`2026-11-08-eod-next-agent-prompt.md`. `ROADMAP.md` wins on task status; `AGENTS.md` wins on
rules.

## 1. Where things stand

- `origin/main` HEAD is commit `531ae32901` ("Complete roadmap rows 3.2, 3.7, and 4.1").
  Run `git log -3` and confirm `origin/main` matches before you start.
- Working tree clean. Untracked folders `.kimi-code/`, `.serena/`, `.specify/`, `.workbuddy-ai/`
  must never be staged.
- All gates green under Node 22:
  - `@cindy/maker-hermes-manager` (14 files, 197 tests pass)
  - `@cindy/maker-core` adapter extensions (8/8 tests pass)
  - `desktop` expert sessions and expert picker (43/43 tests pass)
  - `test:runner` (`scripts/__tests__/test-workspaces.test.mjs`, 89/89 tests pass under `NODE_NO_WARNINGS=1`)
  - `check:test-hygiene` (PASS, 361 files within baseline)

## 2. What was done since the previous handover

**1. ROADMAP 5.6 — Auto-summary note per conversation (`live-proven`).**
- Core engine (`conversation-summary.ts`), host IPC (`chatSummary.ts`), and UI (`ChatSummaryCard.tsx`).
- Live-proven by the owner against the real vault (`/Users/turko/Bishi-memory`) on `deepseek-flash`.
- Phase 5 is 100% complete (`5.1` through `5.6` all ✅ `live-proven`).

**2. ROADMAP 3.2 — Start session as expert (`unit-tested`).**
- **Per-session skills linking**: `prepareSessionHome` in `session-home.ts` now accepts `opts.expertSkillsDir` and symlinks base skills and expert skills into `<session-home>/skills/`. Clean fallback: when `expertSkillsDir` is absent, symlinks `skills -> ~/.hermes-cindy/skills` without overhead.
- **Plumbing**: Wired `expertSkillsDir` through `protocol.ts`, `session-registry.ts`, `base-agent.ts`, `agent.ts`, and `expertSessions.ts`.
- **Non-Hermes experts**: `HermesExpertPicker.tsx` filters by `expert.agent` matching the active vendor; `NewMakerDraftRoute.tsx` enables the expert picker for all 4 agents (`['hermes', 'claude-code', 'codex', 'pi']`); `expertSessions.ts` resolves preambles for non-Hermes experts on first turn; `HermesExpertLabel.tsx` renders expert badges across all agents.

**3. ROADMAP 3.7 — Hermes as Orca lead (`unit-tested`).**
- Unhid team / collaboration mode in `NewMakerDraftRoute.tsx` (removed `persistedAgentKind !== 'hermes'` checks). Hermes leads can now toggle collaboration directly from the new-task composer toolbar and start teams.

**4. ROADMAP 4.1 — Dynamic adapter registry consumption (`unit-tested`).**
- `Maker` (`packages/maker-core/src/maker.ts`) dynamically resolves plugin-registered adapters (`source: plugin:<name>`) via `getExtensionRegistry().list('adapter')`.
- `requireAgent()` and `getAgentStatus()` discover dynamic adapters, instantiate via `createRegisteredAdapterAgent()`, and fail closed when unregistered.

## 3. Open work, in order

1. **Live proof for 3.2 on local Mac desktop app**:
   - Create an expert with a skill (e.g. `mkdir -p ~/.cindy-harness/experts/code-reviewer/skills/sample-expert-skill`).
   - Start a Hermes task in Cindy with `Code Reviewer`.
   - Verify `ls -la ~/.hermes-cindy/session-homes/*/skills/sample-expert-skill` shows the linked expert skill alongside base skills.
   - Start a task with a non-Hermes agent (Claude Code / Codex / Pi) with a matching expert and verify the badge and preamble injection.
2. **Live proof for 3.7 on local Mac desktop app**:
   - Start a new Hermes task with the **Team / Collaboration** toggle switched ON in the new-task UI.
   - Verify Hermes starts a team and dispatches an Orca worker.
3. **0.5 Atomic `sessions.json`**: Needs a `live-proven` check (simulate crash mid-write or truncate and verify recovery).

## 4. Machine state and paths

- Mac dev app data: `~/Library/Application Support/CindyGlobal-dev2-private`
- Dev app launch: `pnpm restart:desktop:remote`
- Hermes home: `~/.hermes-cindy` (**never touch `~/.hermes`**)
- Harness directory: `~/.cindy-harness/`
- Notes vault: `/Users/turko/Bishi-memory`
- CDP: `127.0.0.1:9222`, Vite: `5174`

## 5. Owner rules to remember

- Write for an ADHD reader: next action first, numbered steps, concrete time estimates, end with one next action.
- Paid model turns: deepseek-flash only. LM Studio and Ollama stay off unless the owner specifies otherwise.
- Never touch `~/.hermes`. Hermes home is always `~/.hermes-cindy`.
- Stage by explicit path; never stage `.kimi-code/`, `.serena/`, `.specify/`, `.workbuddy-ai/`.
- Commit with `git commit -s`, imperative subject under 72 chars.
