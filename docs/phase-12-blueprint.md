# Phase 12 Blueprint: Agent Roster — imported agents, one Agents page, @-teammates, squads, runtimes

**Target repository:** Cindy (private, single-user desktop harness)
**Applicable rules:** `AGENTS.md` (all of it). In particular: Node 22, quote every path,
`~/.hermes-cindy` only (never `~/.hermes`), local-first and file-backed, no deletion of upstream
code, no edits to existing agents' system-prompt text, one task per session, honest labels.
**Source inspiration:** the owner's screenshots of the Qwen Code desktop app (2026-11-13):
an *Agents / Squads / Runtimes* page, a *New agent* form (name, start from a role, working
instructions, "when should other agents bring it in", model, conversations at once, runs on,
program), and an agent library (74 definitions with Project / User / Built-in / Extension filters).
**Status of this document:** design only. Nothing here is built. Task status lives in
`ROADMAP.md` Phase 12, never here.

---

## 0. What Cindy already has (do not rebuild it)

| Screenshot feature | Cindy today | Where |
|---|---|---|
| Agent defined in a file | **Expert** directory `~/.cindy-harness/experts/<slug>/expert.md` | `packages/maker-core/src/experts/expert-loader.ts` (`Expert`, `loadExperts`, `watchExperts`) |
| Edit / create agents in UI | Expert editor (3.3) | `apps/desktop/src/main/maker-ipc/expertsHandlers.ts` (`EXPERTS_LIST/READ/SAVE`) |
| "Generate with model" | Expert creator, owner approves the draft (3.8, ADR 0007) | `expert-draft.ts`, `expertsMcpServer.ts`, `expertDraftConfirm.ts` |
| Role templates | Starter experts (3.5) | `docs/experts-examples/` |
| Program picker | `agent:` frontmatter, `EXPERT_AGENTS = hermes, claude-code, codex, pi` | `expert-loader.ts:22` |
| Model field | `model:` = route name from `routing.yaml` (2.3) | |
| "When should others bring it in" | `description:` — the orchestrator (3.9) picks experts by it | |
| An agent brings in others | Orca lead/worker (3.7, 3.9; ADR 0005/0006/0008) | `maker-ipc/orcaHermesWorker.ts`, `orcaTeamService.ts`, `orcaWorkerCreationService.ts` |
| @ an agent | 8.4 `@expert:` — **one message only**; project `.claude/agents` already appear as `@` candidates | `packages/maker-core/src/session/turn-attachment.ts`, `maker-ipc/atAgentCatalog.ts` |
| Library of agent definitions | Claude Code adapter **already scans** `.claude/agents/*.md` (kind `agent`, scope `global`/`project`) | `packages/maker-core/src/agents/shared/customization-scanner.ts`, `types/customizations.ts` (`AgentCustomization`) |
| Library UI with filters | Capabilities hub (8.1), one source per kind, no switch statement | `apps/desktop/src/renderer/components/capabilities/capabilitySources.ts`, `packages/maker-core/src/extensions/registry.ts` |
| Bundles | Capability packs (8.7) | `packages/maker-core/src/capabilities/capability-pack.ts`, `~/.cindy-harness/packs/` |
| Group chat with several agents | Upstream **bot groups** (`maker:bot-group:*`, `features/bots/BotGroup*`) | `maker-ipc/channels.ts`, `register.ts` — **not yet proven local-only in this fork** |

On this machine: `~/.claude/agents` holds 278 entries and `~/.qwen/agents` holds 68 `.md` files.
Both use the same frontmatter shape: `name`, `description`, `tools` (comma list), `model`.

**Rule for every Phase 12 row:** extend these seams. A new parallel "agent" concept beside
experts is forbidden: the owner's mental model is *one roster*, and two registries drift.

---

## 1. Shared vocabulary

- **Expert** — owner-owned, editable, under `~/.cindy-harness/experts/`. Unchanged.
- **Imported agent** — a read-only definition Cindy finds in a foreign directory
  (`~/.claude/agents`, `<project>/.claude/agents`, `~/.qwen/agents`, `<project>/.qwen/agents`).
  Cindy never writes there. The owner can **copy** one into an expert.
- **Roster** — experts + imported agents, one list, one id space: `expert:<slug>` and
  `imported:<source>:<relative-path>`.
- **Squad** — a saved team: a lead and members, each a roster id. File-backed.
- **Runtime** — a program Cindy can launch on this computer (`hermes-cindy`, `claude`, `codex`,
  `pi`), with resolved path, version and health. Remote runtimes are out of scope (§7).

---

## 2. Task 12.1 — Import foreign agent definitions as read-only roster entries

### Problem
The owner has 278 + 68 ready agent definitions that Cindy cannot start as experts. The scanner
that finds the Claude ones exists (Claude Code customizations), but its result only feeds `@`
candidates and SkillHub, not the expert system.

### Design
1. **Pure module** `packages/maker-core/src/experts/imported-agents.ts`, subpath
   `@cindy/maker-core/imported-agents` (add to `packages/maker-core/package.json` `exports`):

   ```ts
   export type ImportedAgentSource = 'claude-user' | 'claude-project' | 'qwen-user' | 'qwen-project';

   export interface ImportedAgent {
     id: string;                 // `imported:${source}:${relPath}`
     source: ImportedAgentSource;
     absolutePath: string;
     name: string;               // frontmatter name, else file stem
     description: string;        // ≤ 500 chars
     declaredTools: string[];    // raw names from `tools:`, untouched
     declaredModel?: string;     // raw `model:` (e.g. "opus"), never auto-mapped to a paid route
     prompt: string;             // markdown body
     runsOn: ExpertAgent[];      // see rule 3
     blockedTools?: string[];    // tools that stopped it running on hermes
     error?: string;             // malformed file → listed with the error, never thrown
   }

   export function parseImportedAgent(
     raw: string,
     meta: { source: ImportedAgentSource; absolutePath: string; relPath: string },
   ): ImportedAgent;
   export function importedAgentToExpertDraft(agent: ImportedAgent): ExpertDraftInput; // "copy to my experts"
   ```
   Zero I/O in the parser. Reuse `parseFrontmatter` from `customization-scanner.ts`; do not add a
   second YAML parser.
2. **Discovery** lives in desktop main (`apps/desktop/src/main/maker-ipc/importedAgents.ts`):
   reads the four directories, recursion depth 1 (Claude allows one level of sub-folders), skips
   symlinks that leave the directory, caps at 1,000 files, hot-reloads with the same watcher
   pattern as `watchExperts`. Project directories come from the active session's working dir.
3. **Which program can run it (`runsOn`)** — fail closed:
   - Claude-sourced: `claude-code` always. `hermes` only if every `declaredTools` name is empty
     or is in a small, unit-tested map (`Read→read_file`, `Grep/Glob→search_files`,
     `Bash→terminal`, `Edit/Write→patch/write_file`). Any unmapped tool → not runnable on Hermes,
     and the UI names the tool that blocked it (`blockedTools`).
   - Qwen-sourced: same map; there is no Qwen adapter, so `claude-code`/`hermes` only.
4. **IPC**: `maker:imported-agents:list`, `maker:imported-agents:read`,
   `maker:imported-agents:copy-to-expert` (writes through the existing `EXPERTS_SAVE` path and
   the 3.8 draft rules, so validation is shared). Copy never overwrites an existing slug.
5. **Capabilities hub**: one new source `kind: 'imported-agent'` in `capabilitySources.ts` with
   `trust: 'local-file'` and a source badge. No switch over kinds.
6. **Starting a session as an imported agent** reuses 3.2: the picker lists it; the session
   header (rule §6.4, no hidden state) shows `imported · claude-user · <name>` and the file path.
   The prompt is applied as *expert prompt text*, i.e. a new feature's text, not an edit of an
   existing agent's system prompt.

### Not doing
- No write-back into `~/.claude/agents` or `~/.qwen/agents`.
- No automatic mapping of `model: opus` to any route (rule §6.3: missing model → clear message,
  never a silent paid fallback). The session uses the owner's chosen route.

### Tests and proof
- `unit-tested`: parser (good, no frontmatter, CRLF, tools as list and as string, oversized body,
  missing name), tool map and `runsOn`, id stability, copy draft (slug clash → numbered slug).
- `unit-tested` (desktop): discovery against a temp directory tree with a symlink escape and 1,001
  files; IPC handler refuses unknown ids.
- `live-proven`: dev app shows the real counts from `~/.claude/agents` and `~/.qwen/agents`; one
  imported agent starts a Claude Code session and one Hermes-compatible one starts a Hermes
  session; "copy to my experts" produces a folder the 3.1 loader accepts. Back up
  `~/.cindy-harness/experts` first (`experts.bak-<date>-12.1`).

---

## 3. Task 12.2 — One Agents page (roster + New agent form)

### Problem
Experts are edited in Settings, imported agents (12.1) appear only in the hub, Orca workers and
bot groups live elsewhere. The screenshot's single *Agents* page is the owner's preferred shape.

### Design
1. Route `#/agents` with three tabs: **Agents** (this row), **Squads** (12.4), **Runtimes**
   (12.5). Tabs whose row is not built are hidden, not disabled (rule §6.3 fail open on
   convenience). Sidebar entry next to the Capabilities hub row (`SidebarTopNav.tsx`).
2. **Agents tab**: search box; filter chips `All · Mine (experts) · Claude user · Claude project ·
   Qwen · Built-in (starter experts)`; cards show name, one-line description, program badge,
   source badge, and an error badge for invalid entries. Click → detail drawer (prompt preview,
   file path, "Reveal in Finder", "Edit" for experts, "Copy to my experts" for imported).
3. **New agent form** maps 1:1 onto `expert.md` frontmatter — no new storage:

   | Form field | `expert.md` |
   |---|---|
   | Name | `name` (slug derived) |
   | Start from a role | prefill from a starter expert or an imported agent (12.1 copy path) |
   | Working instructions | body |
   | When should other agents bring it in | `description` |
   | Model | `model` (route picker from `routing.yaml`; empty = inherit) |
   | Conversations at once | **new optional** `max_concurrent: <int ≥1>` (default 1) |
   | Program | `agent` |
   | Generate with model | opens the 3.8 expert creator with the form contents as the brief |

   "Runs on" shows only *This computer* and the session working dir, read-only (§7).
4. **`max_concurrent`**: loader accepts it (invalid → expert listed with an error). The
   enforcement point is where sessions start as an expert (3.2 binding +
   `orcaWorkerCreationService` for workers): an attempt over the cap is refused with a clear
   message naming the running sessions. No queueing in this row.
5. The existing Settings expert editor stays (no deletion); it may link to the new page.

### Tests and proof
- `unit-tested`: loader accepts/rejects `max_concurrent`; form ⇄ frontmatter round-trip keeps
  unknown keys and the body byte-identical; cap check is a pure function.
- `live-proven`: create an agent from the form, hand-edit the file, see the edit in the page;
  start two sessions of a `max_concurrent: 1` expert → the second is refused with the message.

---

## 4. Task 12.3 — @-mention an expert into a running conversation as a teammate

### Problem
8.4 `@expert:` changes *one message*. The screenshot's model is different: "@ an agent in any
conversation to bring it in; it can bring in others". Today that needs an Orca team started by
a Hermes lead (3.7), which the owner cannot do from an ordinary chat.

### Needs an ADR first
Write `docs/decisions/0011-at-mention-teammates.md` before code: why one worker per teammate
(not a shared context), the depth rule, the permission ceiling, and how it differs from 8.4.

### Design (hot path — rule §6.5 applies)
1. A composer token `@agent:<roster-id>` (distinct from 8.4's `@expert:` so 8.4 behaviour does
   not change). On send, the host:
   - starts (or reuses) an **Orca worker** for that roster entry, attached to the current session
     as lead — reuse `createHermesWorkerInTeam` / `orcaWorkerCreationService`, depth 1, the
     current permission mode as the ceiling (never higher);
   - dispatches the message text plus a bounded excerpt of the conversation
     (reuse `buildExpertHandoff` from 3.6 for the excerpt);
   - shows the worker's reply **inline** in the lead conversation as a teammate card
     (reuse the Orca reply bridge that 3.7 proved), with a link to the worker's own session.
2. **Persistence**: the teammate stays joined until the owner removes it from the session
   header's manifest strip (8.2). A later `@agent:` to the same id goes to the same worker.
   Joined teammates are listed in the manifest (no hidden state).
3. **"It can bring in others"**: a joined teammate gets the Orca lead tools only if the owner
   ticks "may bring in others" on the card; default off. Depth stays 1 by ADR 0005 — a teammate
   can *propose* a second teammate, and the owner confirms it.
4. Turn cap and cost: each teammate turn shows on the 10.4 usage card; the 3.9 turn cap applies.

### Tests and proof
- `unit-tested`: token parser; teammate registry (join, reuse, remove); permission ceiling.
- `live-proven` with a **before/after transcript** (rule §6.5): in a Hermes chat, `@agent:` a
  Claude-sourced imported agent, get an inline reply, send a second mention to the same worker,
  remove it, confirm the next turn has no teammate. Normal turns without a mention must be
  unchanged before and after (diff the event stream).

---

## 5. Task 12.4 — Squads (saved teams)

### Step 12.4a — probe first (no feature code)
Decide whether upstream bot groups already run fully local in this fork: create a bot group in
the dev app with the network off, send one message, record what happens, and grep the main log
for outbound calls. Record the result in `STATUS.md` and the decision in ADR
`docs/decisions/0012-squads-backend.md`:
- **Bot groups are local** → a squad *launches* a bot group.
- **They are not** → a squad launches an Orca team (lead + workers), which is proven local.

### Step 12.4b — file format and launch
```
~/.cindy-harness/squads/<slug>/squad.yaml
```
```yaml
name: Review squad
description: Reviews a diff from three angles and merges the findings.
lead: expert:orchestrator          # roster id
members:
  - expert:code-reviewer
  - imported:claude-user:security-reviewer.md
  - imported:claude-user:typescript-reviewer.md
worker_permission_mode: default    # ceiling for members
max_turns: 20
```
- Pure parser `packages/maker-core/src/squads/squad.ts` (subpath `@cindy/maker-core/squads`):
  unknown roster ids → squad listed with an error, never launched (fail closed).
- Squads tab: list, create/edit (writes the YAML atomically: temp file + rename), **Launch** →
  new session with the lead and members pre-joined (through 12.3's teammate registry if built,
  else the backend chosen in 12.4a).
- Packs (8.7) may reference a squad later; not in this row.

### Tests and proof
`unit-tested` parser and launch plan; `live-proven` launching a 3-member squad on a small real
task with every session visible.

---

## 6. Task 12.5 — Runtimes tab (read-only)

### Design
- Pure model `packages/maker-core/src/runtimes/runtime-status.ts`:
  `{ id: 'hermes'|'claude-code'|'codex'|'pi', path?: string, version?: string, pinned?: string,
  matchesPin: boolean | null, health: 'ok'|'missing'|'error', detail?: string }`.
- Desktop main `maker:runtimes:list` resolves each binary the way its adapter already does (do
  not invent a second resolver; Hermes reuses `packages/maker-hermes-manager/src/hermes-version.ts`
  and its pin), runs `--version` with a 5 s timeout, no network.
- Tab shows one card per runtime: path, version, pin match (Hermes), "agents using it" count from
  the roster, and a **Recheck** button. Nothing is installed or updated from here (no
  auto-update, by `AGENTS.md` §3).

### Tests and proof
`unit-tested` model and version parsing (fixtures from real `--version` output); `live-proven`
screenshot of the tab with the installed versions, and one runtime pointed at a missing path to
show `missing`.

---

## 7. Explicitly out of scope (owner may un-park later)

- Remote / joined runtimes ("A joined runtime works in its own folder") — conflicts with
  *Dropped: cloud accounts, remote sync*. Upstream remote-worker code stays untouched.
- A Qwen Code adapter. Qwen-sourced agents run on existing adapters only.
- Writing to `~/.claude/agents` or `~/.qwen/agents`.
- Automatic model routing from an imported agent's `model:` field.

---

## 8. Build order and dependencies

```
12.1 import ──► 12.2 Agents page ──► 12.3 @-teammates ──► 12.4b squads
                     │                                       ▲
                     │              12.4a probe (any time) ──┘
                     └──────────────► 12.5 runtimes (independent after 12.2's page shell)
```

Each row is one session. Each row ends with the three edits from `AGENTS.md` §5 (ROADMAP row,
STATUS entry, HANDOVER only if stable facts changed) and the §7 checklist. If a row is narrowed
to fit a session, split it (`12.xa` done / `12.xb` open) — never mark the parent done.

## 9. Non-negotiable guards (every row)

1. No path or command touches `~/.hermes`. Imported-agent discovery reads only the four listed
   directories.
2. No new outbound network call. Grep the diff for `fetch(` / `http` before committing.
3. Invalid files are listed with their error and never crash a loader.
4. Everything that changes what an agent does (imported prompt, teammate joined, squad
   membership, concurrency cap) is visible in the session header / manifest strip.
5. Back up `~/.cindy-harness/experts` (and `squads/` once it exists) before any live test that
   writes there, and say so in `STATUS.md`.
6. Gates green under Node 22: `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`,
   `pnpm check:test-hygiene`.
