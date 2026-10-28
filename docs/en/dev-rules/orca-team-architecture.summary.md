> **English SUMMARY — not a full translation** of `docs/dev-rules/orca-team-architecture.md` at commit `7c5bd270c9` (written 2026-10-27). The Chinese original (824 lines) is authoritative; it also contains a Part 2 "future planning" section (execution-unit vision, worker lifecycle typing, side chat, control-plane mechanisms, phased roadmap) not summarized here. Full translation deferred to after the account quota reset (2026-10-30 08:45) or on demand.

# Orca Team Architecture (summary)

Orca is Cindy Desktop's multi-agent collaboration system: one **Lead session** decomposes work, dispatches, and accepts results; multiple **Worker sessions** execute in parallel or serially. Workers are full sessions with their own agent, model, effort, tool stream, context, and visible history — not one-shot subagents.

## Core concepts and data model

| Concept | Meaning | Carrier |
|---|---|---|
| Lead session | Mainline session that opens a team, creates workers, dispatches and accepts | `sessions.orca_role = 'lead'` |
| Worker session | Full side session dispatched by the Lead | `sessions.orca_role = 'worker'` + `orca_workers.session_id` |
| Team | A Lead's currently active collaboration context | `orca_teams` |
| Worker record | Role, label, status, focused metadata within a team | `orca_workers` |
| Fork relation | Normal session fork provenance; foundation for side_chat | `sessions.parent_session_id` + `forked_at_message_id` |

- `orca_role` and fork parent are separate fields and must not be conflated (fork relations cannot carry Orca dispatch semantics).
- `orca_teams`: at most one `active` team per Lead, enforced by a **partial** unique constraint (`uniq_active_team_per_lead`, scoped to `status='active'`).
- `orca_workers`: `team_id`, `session_id`, `status(idle/running/done/error)`, `label`, `role`, `focused`, `idle_since`; exactly one focused worker per team, also a partial unique constraint.

## Service boundaries (after PR #101)

Main-side business logic lives in dedicated services; `register.ts` only wires dependencies, IPC/MCP, and host adapters:

- `OrcaLifecycleService` — start/enable team, read/update worker-creation permission prefs, set Lead role, first-worker compensation.
- `OrcaWorkerCreationService` — create workers in an existing team; validate role/label/model/effort/fast; apply `workerCreationPrefs` permissions (does NOT inherit the Lead's current permission mode).
- `OrcaTeamService` — dispatch tasks to workers, resume, idle, archive, terminal turn handling, auto-bridge.
- `OrcaInterAgentDispatcher` — direct or queued inter-agent messages, accepted callbacks, rollback/settle semantics.

Rule: the four responsibility classes must not duplicate each other; every entry point (IPC or MCP handler) must reuse these services rather than reimplement the state machine.

## MCP and IPC control surface

`cindy_orca` is a standalone MCP server registering 21 tools at top level: 18 team-control tools (`start_team`, `end_team`, `create_worker`, `create_workers`, `list_workers`, `switch_focus`, `send_to_worker`, `interrupt_worker`, queue controls, `idle_worker`, `archive_worker`, `update_worker`, `list_available_models`) plus 3 read-only diagnostics (`get_workspace_info`, `worker_status`, `read_worker`). It shares the same main-side services as renderer IPC, so MCP and UI must have identical permissions, state, and rollback semantics.

Key constraints:
- Tools are globally visible; **visibility is not a permission boundary** — handlers and host services enforce per-role authorization.
- Worker permission mode is a *creation preference*, independent of the Lead's permission mode. Default when nothing saved is `bypassPermissions` (Full access); upgrading from `auto` requires a real user confirmation before any side effect.
- Batch creation must be one `create_workers` call (sequential, stops at hard limit, per-item summary), never multiple parallel `create_worker` calls.
- `cindy_orca` is the only Lead→team tool surface; `orca_worker_bridge` (in `packages/orca-workflow`) is the only Worker→Lead surface.

## Codex Lead mechanics

Codex app-server is a singleton process sharing one set of MCP servers across threads. Design boundary: tools are globally registered, identity is recovered per call from thread context, and handlers/host services reject overreach — there is no per-thread MCP tool isolation.

- `mcp-session-id` identifies only the MCP transport, not the maker session; it is **not** a routing basis. The HTTP bridge reads `params._meta.threadId` from initialized MCP messages and looks up the maker-core thread context; if missing/unknown/inconsistent it yields no context (safe `NO_SESSION_CONTEXT` degradation) rather than guessing.
- Codex `developerInstructions` has two delivery channels (`cindy_gateway` HTTP Responses vs `cindy_openai` Responses WebSocket); each thread must select exactly one, never both, and any feature that appends host instructions must reuse the same `isCodexProxyChannelReady` / `useProxyChannel` judgment.
- ADR: do not rewrite Responses `tools` in the proxy for per-role isolation; align with Claude Code's "globally visible + handler rejection" semantics instead of adding multi-process complexity.

## Runtime behavior contracts (invariants)

The doc's "Runtime behavior contracts" and "Worker runtime state" sections are binding invariants, not future plans. Highlights (full detail in the original):

**Dispatch and execution channel**
1. Orca Worker dispatch must never be impersonated by a native subagent; when a requested role/label has no matching Worker, the Lead must say so and ask before creating, never silently reassign.
2. The actual execution channel must be disclosed and accepted on the same channel (`Orca Worker` vs `native subagent`), with terminal states attributed accordingly.
3. Only a real async dispatch (specific `ok`/`wake_kind`/`dispatched=true` signals) allows ending a turn silently; otherwise report real results immediately, never poll or sleep.

**Message dispatch and auto-bridge**
4. Busy targets never lose messages — default to the input queue; steering is opt-in per sender (`delivery:'steer'`), never a default.
5. Only send-accepted may produce runtime side effects (mark `running`, create auto-bridge pending); failures roll back without overwriting terminal states.
6. Queued accepts settle with the same rollback/discard semantics as direct sends.
7. Worker-initiated `send_to_lead` clears that worker's auto-bridge pending (no double reporting).
8. Manual stop/abort does not auto-bridge.
9. A vendor terminal error while interrupted-turn auto-resume is still pending is not a product terminal state.
10. Lead queue management: "see everything, modify only your own"; cancelling/editing must settle or discard accepted callbacks.
11. Interrupt is one atomic operation (reserve next input + graceful stop of old turn), not stop+send.
12. Queue merge is one validate, one swap, one persist — all or nothing.
13. Late accepted callbacks after a turn ends may only check delivery-level authority, not turn-level credentials.
14. Archived status is a reversible sidebar bucket, not revocation; queued dispatches still deliver.

**Worker runtime state**
15. Worker terminal states are never overwritten by failed-dispatch rollback.
16. `done` acknowledgement and dispatch are mutually exclusive per worker.
17. Idle-worker resume preserves `extraDirs`.
18. Focus switching never blocks on worker cold start (prewarm in background, deduplicated with the send lock).
19. Every real worker status change broadcasts `ORCA_WORKER_CHANGED`.
20. Switching sessions must not reset worker unread state (attention store is process-level).
21. After restart, known workers are lazily reconstructed from DB (`sessions.orca_role`, `orca_workers`, `orca_teams`) — in-memory state is never the sole source of truth.
22. Lead↔Worker inter-visit/resume works regardless of how collaboration was enabled or when the restart happened.
23. Deferred done-acknowledgements settle at the terminal boundary once.
24. Lead completion is judged by team settlement (auto-bridge pending count), not by the Lead's own turn ending.
25. Remote Workers run only on their execution device; the local row is a proxy that must never spawn an agent locally.
26. Renaming (`role`/`label`) changes identity metadata only — never agent/model/permissions/working directory (no mid-flight model swap).

## Known boundaries (current implementation)

- A Team is strictly bound to a single Lead session; no cross-Lead worker sharing.
- Focus switching replaces a single worker pane; multiple workers are not shown side by side.
- No unarchive entry in the UI (DB records kept; create a new worker).
- `workflow_run` / CC Workflow orchestration not yet integrated.
- side_chat is a fork data action only; not yet registered as a side activity or attached to a pane.
- device-link collaboration: Lead/Worker/team all live on the controlled device; the controller mirrors.
- SSH collaboration supports Claude Code, Codex, and Pi as Lead/Worker; remote project-level collaboration switches are user/global-level only (project-level config is a follow-up).

Implementation entry points cited by the original: `apps/desktop/src/main/maker-ipc/orcaLifecycleService.ts`, `orcaWorkerCreationService.ts`, `orcaTeamService.ts`, `orcaInterAgentDispatcher.ts`, `orcaDiagnostics.ts`; `packages/lizi-mcps/src/orca/server.ts`; `packages/orca-workflow/src/orca-bridge-prompt.ts`.
