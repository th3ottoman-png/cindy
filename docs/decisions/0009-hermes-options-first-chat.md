# ADR 0009 — "Ask before acting" as an Options-first Hermes chat

- **Status:** Accepted (owner, 2026-11-03: forwarded an outside reviewer's recommendation "A now, D next",
  with read-only MCP facades). Build waits on the `list_experts` stdio-loss Debt fix being `live-proven`.
- **Date:** 2026-11-03
- **Decider:** owner. ROADMAP 3.10. Options and probe: `docs/research/3.10-ask-before-acting-options.md`.

## Context

When asked for options, a Hermes agent on Full access started building instead of waiting (3.10). Cindy
cannot approve single Hermes tool calls (v1 adapter gets no approval requests). The only hard lock is
`hermes chat -t/--toolsets`, and Hermes 0.22.5 fixes it at session creation: a different `-t` on
`--resume` is refused. `-t` does not scope MCP servers, accepts whole toolsets only, and `file` bundles
read with write. `--safe-mode` disables MCP entirely, so Cindy tools exist only under `--yolo`.

## Decision

1. **A new chat kind, not a per-turn toggle.** "Options first" is chosen when the chat is created and
   holds for that chat's whole life. Normal chats are unchanged.
2. **Hermes enforces the built-in lock.** `HermesSpawnSpec` gets `toolsets?: string[]`; `buildHermesArgs`
   passes `-t <list>`. The session runs `--yolo -t <read-only toolsets>` (the bridge needs `--yolo`). The
   toolsets are recorded with the session and never changed on `--resume`.
3. **The bridge enforces Cindy's tools, per server.** `createHermesBridgePreparer` derives the exposed
   servers from the chat kind and freezes them into `RUNTIME_MCP_NAMES_KEY` and the allowed-plugin list,
   as today. A read-only need (e.g. `list_experts`) gets its own **read-only facade server**, not
   tool-name policy in `findBlockedToolCall`, so the existing server-level fail-closed checks
   (connect, discovery, batches, calls) cover it unchanged.
4. **The shim stays policy-free.** `shim.ts` only proxies; the HTTP bridge is the one boundary.
5. **"Go ahead" opens a new full-access chat** seeded with the options conversation. The Options-first
   Hermes session is never unlocked.
6. **Visible.** The session header shows "Options first" and the locked toolsets (AGENTS.md §6.4).
7. **Next (D), separate row:** a read-only project reader facade (`read_project_file`,
   `search_project`, limited to the chat's folder), so an Options-first chat can look at the project.

## Consequences

- An Options-first chat cannot read project files until D lands; its suggestions come from the chat,
  the web and read-only Cindy facades.
- Picking an option switches chats; history reaches the new chat as text, not a native resume.
- Existing agents' system prompts are not edited; any Options-first instruction is new feature text.
- Depends on the exact `-t` behavior of Hermes 0.22.5; record it in `HANDOVER.md` §Versions with a
  runtime warning on mismatch when built.

## Implementation note (2026-11-03)

Built as an **expert lock**, not a new chat kind: an expert's `expert.md` frontmatter `toolsets:` locks
its Hermes session, and the starter expert `options-first` is the Options-first chat. This reuses the
file-backed expert binding (chosen before the first turn, kept in `expert-sessions.json`, shown in the
header) and keeps decisions 1–6. A locked session gets no Cindy bridge at all (no facade was needed
for 3.10). "Go ahead" (decision 5) is ROADMAP 3.10c; until then the expert points to Ask expert (3.6b).

## Implementation note — 3.10d (2026-11-03)

Decision 7 is built as its own MCP server `cindy_project_reader` (`read_project_file`,
`search_project`), not as a widening of the Cindy bridge. A locked session still gets no bridge unless
its expert opts in with `tools: [read_project_file, search_project]`; then it mounts only this server.
Reads are limited to the task folder's real path, and secrets, binaries and symlink escapes are
refused. The first Consequence ("cannot read project files until D lands") no longer applies to
experts that opt in. Live-proven in ROADMAP 3.10d.
