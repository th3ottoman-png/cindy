> **English translation** of `docs/dev-rules/orca-team-architecture.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Orca Collaboration Architecture and Execution Unit Planning

> This is Orca's sole authoritative document, covering the current implementation, design constraints, and future planning.
>
> **Status**: authoritative (authoritative).
> **Binding force**: this document's "Collaboration runtime behavior contract" and "Pitfalls and invariants" sections are the binding source for Orca collaboration code, with a governing scope including `apps/desktop`'s `maker-ipc/orca*` services and `mcp-integrations` codex MCP integration, `packages/lizi-mcps`'s `orca` server and worker control tools, `packages/orca-workflow`, and `packages/maker-core`'s codex MCP context. Read this document before changing these modules; when this document conflicts with the code implementation, the code wins (following the "source code implementation is authoritative" principle), but this document must be fixed in sync.

## Table of Contents

- [Part 1 · Current Architecture](#part-1--当前架构)
  - [Goals and Boundaries](#目标与边界)
  - [Core Concepts and Data Model](#核心概念与数据模型)
  - [Service Boundaries after PR #101](#pr-101-后的服务边界)
  - [MCP and IPC Control Plane](#mcp-与-ipc-控制面)
  - [Codex Lead Mechanism](#codex-lead-机制)
  - [UI, Collaboration Tab, and Worktree](#uisplit-view-与-worktree)
  - [Collaboration Runtime Behavior Contract](#协同运行时行为契约)
  - [Test and Regression Checklist](#测试与回归清单)
  - [Pitfalls and Invariants](#坑点与不变量)
- [Part 2 · Future Planning](#part-2--未来规划)
  - [Execution Unit Vision](#执行单元愿景)
  - [Three-State Separation](#三态拆分)
  - [Worker Lifecycle Typing](#worker-生命周期分型)
  - [Top-Level Types and Runner Layering](#顶层类型与-runner-分层)
  - [Side Chat](#side-chat)
  - [Relation Contract](#关系契约)
  - [The Control Plane's Nine Mechanisms](#控制面九大机制)
  - [Phased Roadmap](#分阶段路线)
  - [Open Discussion Items](#待讨论项)

## Part 1 · Current Architecture

### Goals and Boundaries

Orca is Cindy Desktop's multi-agent collaboration capability: one **Lead session** is responsible for splitting tasks, dispatching work, acceptance, and summarization, while multiple **Worker sessions** are responsible for parallel or serial execution. A Worker is a complete session, not a one-shot subagent; it has its own model, effort, tool-call stream, context, and visible history.

Currently implemented capabilities:

- Multiple workers: multiple workers can be created under the same active team, supporting role, label, focused worker switching, soft/hard limits, and archiving. After creation, the worker's display role name `role` and team-unique identifier `label` can be changed via the collaboration panel's edit entry or `update_worker` (only identity metadata changes; Agent/model/permissions do not; see "Worker runtime state" item 10).
- Split view: the Lead and the focused Worker share the `OrcaSplitView` pane shell; wide screens use a left/right split and the doc rail is a Lead/Worker toggle. See `OrcaSplitView` and `OrcaPaneShell` in `apps/desktop/src/renderer/features/cc-agent/OrcaSplitView.tsx`.
- Ordinary Leads of local Claude Code, Codex, and Pi can enable collaboration whether project or dialogue, and local Workers also support these three agent kinds; Claude Code, Codex, and Pi of SSH remote sessions can all be Lead or Worker (remote agents connect to the local MCP bridge via SSH remote-forward: Codex via daemon config injection, Claude Code via per-query HTTP injection, Pi via internal MCP bridge URL rewriting); device-link controlled-end projects and dialogues can likewise be Leads (the true bodies of Lead / Worker / team all live on the controlled end; the controlling end is only a mirror). The renderer's entry determination converges in `resolveCollabEntryPolicy` of `apps/desktop/src/renderer/features/cc-agent/collabEntryPolicy.ts`, shared by the new draft (`NewMakerDraftRoute`) and the session view (`CCAgentSessionView`'s `allowCollabToggle`): ordinary Leads all show the entry; only Orca Worker sub-sessions that cannot nest collaboration are excluded. Projects query by project-level policy; Main's `resolveLocalCollabPolicyWorkingDir` serves both entry-state queries and final authorization, and only queries user-level/global-level policy (even if `.cindy/plugins.json` appears in the cwd) when the workspace kind is dialogue AND Main confirms the directory lies under the app-managed dialogue root; dialogues explicitly bound to a real directory still query that directory's project-level policy — bypassing project disabling by self-reporting `workspaceKind` is not allowed.
- Codex Lead uses the globally registered `cindy_orca`, restoring identity via context at call time and rejecting overreach inside the handler. Remote Codex also routes via `params._meta.threadId` — remote threads register into `CodexMcpThreadContextStore` just like local threads (`registerCodexMcpContext` in `packages/maker-core/src/agents/codex/index.ts` no longer skips remoteHostId). Remote cc has no threadId; identity goes through a persistent bearer token + URL `?session=<id>` routing (`codexHttpBridge.registerSessionCtx`), and the approval-attribution snapshot is finalized per the final `startParams.mcpServers` list after `remoteCcQueryFactory` injection.
- SSH remote Codex MCP bridging: the local `codexHttpBridge` accepts a persistent bearer token (safeStorage) in addition to the original per-run main token; `remote-ssh/codex-remote-mcp.ts` completes per-host fixed-port remote-forward (`RemoteHost.openRemoteForward`, auto rebind on reconnect), drift detection of the `mcp_servers` managed section in the remote `$CODEX_HOME/config.toml` (line-level marker + stripping user tables of the same name), and daemon idempotent bootstrap (the token is injected only via a stdin KEY=value block, never argv) before session start/resume; when config drift requires a daemon restart and the same host has a live turn, this pass degrades (left for the next ensure). Worker creation spawns on the same remote host inherited via `OrcaLeadSessionSnapshot.remoteHostId`, going through `ensureRemoteReadyForSessionStart` (SSH reconnect / agent install / MCP injection) before creation; the lazy resume and Orca worker wake paths likewise ensure first, then bootstrap.
- PR #107 provides side_chat's underlying fork data action: both user/assistant messages can fork; assistant copies at turn granularity; Claude uses uuid anchors; Codex uses ThreadFork + ThreadRollback. It currently navigates as an ordinary session; in the future it must be registered as a side activity and mounted into the unified pane.

Current boundaries:

- Orca Teams are still strictly bound to a single Lead session; sharing workers across Leads is not supported.
- Worker focused switching is "single worker pane replacement", not multiple workers side by side.
- After a Worker is archived there is no unarchive entry in the UI; the DB record is kept, and the user needs to create a new worker to continue.
- workflow_run / CC Workflow orchestration is not yet part of the current implementation.
- side_chat is not yet registered as a side activity object, nor mounted into a pane; PR #107 is only the fork data action.
- For device-link collaboration, Lead / Worker / team are all orchestrated within the controlled-end process; the controlling end only routes via the tunnel by session origin (`makerTransport`'s `makerApiFor` / `orcaWorkflowsFor` / `subscribeOrcaWorkerChanged`; channels in the Orca section of `packages/device-link/src/allowlist.ts`). The collab switch also queries the controlled end (`maker:plugins:get-state` via `pluginEnableStateFor`): projects read the controlled end's project-level policy, dialogues read the controlled end's user-level/global-level policy. The controlling end's local state cannot represent the controlled end's truth. Old controlled ends without the channel return `CHANNEL_NOT_ALLOWED`; the controlling end fails closed, grays out the entry, and prompts that the device version is too old, rather than letting it through to `enableOrca` before hitting the error.
- Mobile is the same device-link controlling end: Lead / Worker tasks are operable like ordinary tasks (sending messages, handling confirmations, editing the queue, Fork / Rewind, task settings); collaboration orchestration goes through the `orca` group of `apps/mobile/src/device-link/mobileMakerTransport.ts` over the same channels as the desktop controlling end (enable / create / confirm done / archive / end, Worker list, read-only collaboration settings); "focus" only decides which Worker the desktop collaboration panel expands — mobile neither displays it nor offers switching. Entry determination, timeout re-checks, and error copy live in `apps/mobile/src/session/orcaTeam.ts`; session page and new-task page states in `useSessionOrcaCollab.ts`. Archiving a Worker (long-press in the collaboration panel and the Worker's own menu) takes effect optimistically: in the click frame the Worker task is moved out of its physical shard and removed from the team view (archiving itself simultaneously and immediately returns to the Lead); in-flight registration reuses task archiving's `sessionMetaWriteGuard` / `sessionPendingWrites`, and during the in-flight period pushes, full reconciliation, and single upserts cannot bring it back; the timeout re-check closes as success if the Worker is already gone, otherwise it rolls back (re-inserts into the same shard, restores the team view, and reseeds) with a prompt. The controlled end's `archiveWorkerSession`, like ordinary archiving, receipts once status is persisted, with worktree recycling backgrounded via `scheduleWorktreeRecycleForStatusChange`. Enabling collaboration on a new task does not use two-phase dispatch: immediately after createSession and before the first message is enqueued, `enable-orca` runs, with the Worker task carrying the pending Lead input as context per `buildDraftWorkerInitialTask`; on failure the task continues as a single task with a prompt on the session page. Collaboration settings (Worker limits, idle release) are read-only on mobile; `maker:worker:update` is already in the controlled end's allowlist and capability bit (`supportsOrcaWorkerUpdate`), but mobile UI does not yet offer a rename entry (separate integration later). The "create Worker" memory rules match desktop's `workerCreationPrefs` (last Agent, each Agent's model / effort / Fast, Worker permissions; initial task not remembered; first-time defaults shared via `@cindy/maker-shared/orca-team`); like the desktop controlling end, they live on the end that initiates creation (`apps/mobile/src/session/orcaWorkerPrefs.ts`, isolated per account), not reading or writing controlled-end preferences; a remembered model not in that computer's available list falls back to the controlled end's default.
- SSH remote collaboration supports Claude Code, Codex, and Pi Lead / Worker; Workers inherit the Lead's `remoteHostId` and remote working directory, executing on the same remote host and reusing the remote-readiness check before start. Remote cc appends `cindy_orca` / `orca_worker_bridge` as http form into `startParams.mcpServers` via `cc-remote-mcp.ts` (persistent token + `?session=` routing; the allowlist has only these two servers). A remote worker's manual `send_to_lead` depends on the daemon-side `orca_worker_bridge` being reachable over the same bridge; auto-bridge reporting does not depend on worker-side MCP and works naturally. When Claude Code / Codex multi-instance sharing userData connects to the same remote host, only the instance that established the SSH forward first can hold that host's MCP bridge port; other instances degrade as "remote without MCP" (consistent with historical behavior). Remote sessions' project-level collab switch does not query the local fs; `assertCollabProjectEnabled` for remote checks only user-level/global-level switches; the remote project-level configuration mechanism is a follow-up.

Pi's remote Lead follows the unified Lead identity and prompt assembly; internal MCP (including `cindy_orca`,
`orca_worker_bridge`) connects to the local bridge via an independent SSH remote-forward and does not reuse Codex's
per-host forwarding slot. Actual availability is still constrained by the collaboration switch and bridge state. Verification entry points:

- Lead activation and prompt: `activateLeadTeam` / `startTeam` in [orcaLifecycleService.ts](../../../apps/desktop/src/main/maker-ipc/orcaLifecycleService.ts),
  and [orcaSessionStartOptions.ts](../../../apps/desktop/src/main/maker-ipc/orcaSessionStartOptions.ts).
- Pi bridge injection: `preparePiExtraSpawnConfig` in [pi-host.ts](../../../apps/desktop/src/main/maker-host/pi-host.ts), and `rewriteRemotePiMcpBridgeUrl` in [maker-host/index.ts](../../../apps/desktop/src/main/maker-host/index.ts).
- Worker creation: [orcaWorkerCreationService.ts](../../../apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts);
  the `allows Pi workers for a remote lead` case in [the corresponding test](../../../apps/desktop/src/main/maker-ipc/__tests__/orcaWorkerCreationService.test.ts) verifies the Pi Worker inherits the remote host, working directory, and Worker role.

### Core Concepts and Data Model

| Concept        | Current meaning                                                    | Carrier                                                        |
| -------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Lead session   | Mainline session, responsible for opening a team, creating workers, dispatching work, and acceptance              | `sessions.orca_role = 'lead'`                               |
| Worker session | A complete side session dispatched by the Lead, with independent agent/model/context | `sessions.orca_role = 'worker'` + `orca_workers.session_id` |
| Team           | A Lead's currently active collaboration context                          | `orca_teams`                                                |
| Worker record  | The worker's metadata within a team: role, label, status, focused, etc.   | `orca_workers`                                              |
| Fork relation  | Ordinary session fork origin relation, the foundation of side_chat               | `sessions.parent_session_id` + `forked_at_message_id`       |

`orcaRole` and fork parent are two fields and must not be mixed. The schema explicitly states `orca_role` is for the Orca split-session role and `parent_session_id` is reserved for fork/session-branch; see the `sessions` schema in `apps/desktop/src/main/localDb/schema.ts`. The fork relation must not carry Orca dispatch semantics — this is the data prerequisite for later bringing side_chat into side activity.

`orca_teams` guarantees a Lead has at most one active team at a time: the unique constraint `uniq_active_team_per_lead` constrains only `status = 'active'`. Constraint: active uniqueness must use a partial unique, not a whole-table unique; otherwise non-active teams occupying the index would make the same Lead unable to re-enable collaboration.

`orca_workers` stores workers within a team: `team_id`, `session_id`, `status(idle/running/done/error)`, `label`, `role`, `focused`, `idle_since`. A team can have only one focused worker, guaranteed by the partial unique `uniq_orca_workers_focused_per_team`; see the `orcaWorkers` schema in `apps/desktop/src/main/localDb/schema.ts`.

The minimal provenance of fork/session-branch currently has only two columns:

- `parent_session_id`: source session self-FK, set null when the source is deleted.
- `forked_at_message_id`: the source message's client id, no FK. After PR #107, assistant forks also write the assistant client id; the schema comment needs to be synced to the actual semantics; see `sessions.forkedAtMessageId` in `apps/desktop/src/main/localDb/schema.ts`.

### Service Boundaries after PR #101

After PR #101, Orca's main-side business is carried by independent services; `register.ts` only handles dependency assembly, IPC/MCP wiring, and host adapters. Service boundaries:

| Service                        | File                                                           | Responsibility                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrcaLifecycleService`      | `apps/desktop/src/main/maker-ipc/orcaLifecycleService.ts`      | `start_team`, enabling collaboration `enableTeam`, creating a team, reading or updating Worker creation permission preferences, setting the Lead `orcaRole`, first-worker creation compensation                                                              |
| `OrcaWorkerCreationService` | `apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts` | Creating workers in an existing team, unified role/label/model/effort/fast validation and defaults; a new Worker uses `workerCreationPrefs` permission preferences and does not inherit the Lead's current mode; creates the worker session and writes `orca_workers` |
| `OrcaTeamService`           | `apps/desktop/src/main/maker-ipc/orcaTeamService.ts`           | Dispatching work to existing workers, resume, idle, archive, terminal turn handling, and auto-bridge                                                                                                             |
| `OrcaInterAgentDispatcher`  | `apps/desktop/src/main/maker-ipc/orcaInterAgentDispatcher.ts`  | Direct sending or queuing of Lead/Worker messages, accepted callbacks, rollback/settle semantics                                                                                                               |

Contract: the four responsibility classes — team lifecycle, worker creation, worker lifecycle/auto-bridge, inter-agent dispatch — must not sneak past each other; all entries must reuse this set of services, and an IPC or MCP handler must not implement its own state machine. Key implementation entry points: `OrcaLifecycleService.startTeam/enableTeam`, `OrcaWorkerCreationService.createWorkerInTeam`, `OrcaTeamService.dispatchWorkerTask/handleWorkerTerminalTurn`, `OrcaInterAgentDispatcher.dispatchOrEnqueueOrcaInterAgentMessage`.

### MCP and IPC Control Plane

`cindy_orca` is an independent MCP server that directly registers 21 tools at top level: 18 team control tools + 3 read-only diagnostic tools (the latter bridged in from the decommissioned `orca_bridge`, keeping bare names). It shares the same set of main-side services with renderer IPC, so MCP and UI operations must have consistent permission, state, and rollback semantics.

1. `start_team`
2. `end_team`
3. `create_worker`
4. `create_workers` (batch creation; sequential execution, stops after hard limit and returns a per-item summary; each item supports optional `images` to send local images with `initial_task`)
5. `list_workers`
6. `switch_focus`
7. `send_to_worker` (supports optional `images`: local image absolute paths, sent with the message to local workers; SSH remote workers reject)
8. `interrupt_worker` (atomically reserves the next input and gracefully stops the current turn; images not supported)
9. `get_worker_queue_status` (working state and full queue)
10. `update_queued_message` (queued message control)
11. `cancel_queued_message` (queued message control)
12. `merge_queued_messages` (atomically merges consecutive queued messages)
13. `steer_queued_message` (converts a queued message into an interjection)
14. `move_queued_message` (adjusts queue order)
15. `idle_worker`
16. `archive_worker`
17. `update_worker` (changes the worker's display role name `role` and team-unique identifier `label`; only identity metadata, not Agent/model/permissions)
18. `list_available_models`
19. `get_workspace_info` (read-only diagnostics)
20. `worker_status` (read-only diagnostics)
21. `read_worker` (read-only diagnostics)

Batch creation must go through a single `create_workers` call; the Lead must not issue multiple independent `create_worker` calls in parallel or in sequence. The batch tool reuses the same `OrcaLifecycleService.createWorker` primitive in input order; after the first `WORKER_LIMIT_HARD_EXCEEDED` or batch-level `HOST_NOT_READY`, the host is no longer called and the remaining items are stably marked `skipped`. The return value must include the request count, actually-attempted count, success count, failure count, skipped count, total not-created count, the quota gate (闸) snapshot, the code-deterministically generated `user_report`, and per-item real worker/session or failure terminal state, so the Lead can close out truthfully with the user; `success_count + failure_count + skipped_count` must equal `request_count`, where `not_created_count = failure_count + skipped_count`. The single `create_worker` remains as a compatibility entry and returns the same structured hard-limit snapshot.

The 6 queued-message control tools let the Lead manage the queued messages it sent before a worker consumes them: `send_to_worker` / `create_worker` (initial_task) return `queued_message_id` (the clientId in the coordinator queue) when `wakeKind='queued'`, so the Lead can view working state and the full queue, rewrite whole entries, withdraw, atomically merge consecutive Lead messages, convert to interjections, or adjust order. When `get_worker_queue_status` / `steer_queued_message` / `move_queued_message` omit `worker_id` they act on the caller's own queue (Worker reports queue here when the Lead is busy). Implementation goes through `OrcaTeamService.listWorkerQueuedMessages / updateWorkerQueuedMessage / cancelWorkerQueuedMessage / mergeWorkerQueuedMessages / steerWorkerQueuedMessage / moveWorkerQueuedMessage`; semantic constraints are in "Collaboration runtime behavior contract · Message dispatch and auto-bridge" items 1b, 6–9.

The 3 diagnostic tools are purely read-only, implemented in host `apps/desktop/src/main/maker-ipc/orcaDiagnostics.ts` (reads active team + DB worker list + live session state + recent assistant messages), with **no team-creating write side effects** — this is the key difference from the old `orca_bridge` version (the old version would casually create a team via `ensureWorkflowForLead`). The early Lead-side `orca_bridge` (facade + private registry/restore/auto-bridge) has been deleted entirely: the Lead→worker/team tool surface is only `cindy_orca` (C), and worker→lead is only `orca_worker_bridge` (B, in `packages/orca-workflow`); the `@cindy/orca-workflow` package is still depended on by the host via the B provider and the two render functions `renderOrcaLeadSystemPrompt`/`renderOrcaWorkerSystemPrompt`.

`cindy_orca` registers directly at top level rather than hiding behind `list_tools/call_tool`; the model needs to reliably discover `start_team/create_worker` when "enabling collaboration / dispatching workers". Implementation: `createOrcaMcpServer`, `DirectToolSink`, `OrcaMcpDeps` in `packages/lizi-mcps/src/orca/server.ts`.

Worker permissions are a **Worker creation preference**, the same kind as the Agent/model/effort/Fast "next-creation defaults"; they are not an inheritance of Lead permissions and not a Team database field:

- The source of truth is renderer `workerCreationPrefs` localStorage; main keeps only an in-memory mirror, synced by the renderer at app startup and on preference changes.
- When no permission preference has been saved, the product default is `bypassPermissions` (Full access); this is merely a selectable initial value, not a fixed mode. The UI may reselect `auto` or `bypassPermissions` on every Worker creation, and the submission becomes the next default; already-saved choices keep priority and are not rewritten as the product default changes.
- MCP `start_team` may explicitly specify `worker_permission_mode`; when omitted, the current preference is used. When explicitly upgrading from `auto` to `bypassPermissions`, Main must wait for user confirmation held by the host before writing the preference or creating the Team; relying only on MCP approval, tool descriptions, or prompts is not allowed, and cancel/timeout must produce no side effects. Only after confirmation passes is the main mirror updated, and the renderer is notified to write back the same localStorage. When the user has already saved `bypassPermissions`, later uses do not re-confirm.
- `create_worker` / `create_workers` omit the permission parameter and uniformly read the current preference; they do not inherit the Lead's `sessions.permission_mode` and do not modify already-created Workers.
- A new device-link controlling end may enable collaboration only when the controlled end's capabilities explicitly declare support for Worker permission selection; existing old remote Teams keep the old creation behavior for compatibility, without claiming or writing back preferences that end does not support.

Tool registration is globally visible + handler rejection:

- Tool visibility is not a permission boundary: the `cindy_orca` provider in `providers.ts` has no per-role `isEnabled` gate; differences among ordinary session / worker / lead must be rejected by the handler and host services.
- In the Codex scenario the real session identity comes from the MCP request context; `session-context.ts` uses `AsyncLocalStorage` to provide `withLiziMcpSessionContext` / `resolveLiziMcpSessionContext`; relying on a global fallback to guess identity is not allowed.
- The renderer enables collaboration via `CCAgentSessionView.tsx`'s `requestEnableCollab`; MCP tools enter the same set of services through the `cindy_orca` callback.
- When the renderer enables collaboration via the UI and a first task is filled in, `OrcaLifecycleService.enableTeam` reuses the existing
  `initial_task` body, attaching the Lead session id and on-demand re-check instructions. An existing Lead session continues immediate dispatch;
  the new-task page first uses a ready placeholder to establish a recoverable Worker agent history but does not dispatch the user task; after the first
  ordinary input/Goal has been accepted by the host and user history is queryable,
  the same `initial_task` is dispatched via `maker:worker:dispatch-ui-assignment`. Desktop slash commands
  are control actions consumed by an independent handler that do not form ordinary user history, so command accepted
  is the ordering boundary rather than waiting for a nonexistent history row; on command rejected or ordinary input/Goal delivery failure
  no Worker is dispatched, and the user is clearly prompted to check status in the Worker panel.
- Two-phase dispatch credentials are persisted before the Lead's first input is accepted; if the renderer exits after accepted but before the actual invoke,
  the Lead session, once remounted and reading user history, automatically consumes credentials still `pending`. Before invoking it first flips to
  `uncertain`, together with an in-process tombstone, ensuring lost responses, restart recovery, and late receipts cannot auto-dispatch twice.
  Multiple windows may resume the same `pending` simultaneously, so the Main process must also establish a
  shared claim keyed by Lead, Worker, and snapshot time; concurrent or subsequent requests for the same assignment share the first dispatch result, and Worker
  delivery is invoked exactly once.
- Worker-side on-demand queries uniformly go through `orca_worker_bridge.read_lead_history`: the tool reverse-looks-up the unique Lead from the authenticated
  `worker_id + worker session` attribution, and the caller cannot specify an arbitrary session; it returns only
  `user/assistant`, excludes rewound entries, limits the per-page count, and keeps `(createdAt,rowid)` cursor pagination. It does not
  create/resume the Lead and does not send messages, so both local and SSH Workers can read
  the same context without waking the Lead. A Worker queries only when its task depends on relative scopes like "current work / continue / this PR";
  self-contained tasks execute directly. Without an explicit Worker task it will not start a task on its own from Lead input; this handoff also
  does not rewrite the `initial_task` already organized by the Lead via MCP `create_worker` / `create_workers`.
- device-link establishes two-phase dispatch credentials only when both the controlled end's capability and this `enableOrca` success response prove support for deferred
  handoff (including `dispatched=false` and a host timestamp); old ends continue immediate dispatch,
  keeping the pending Lead text for compatibility. On tunnel timeout, two-phase dispatch does not auto-retry, nor is an ambiguous terminal state called a
  failure, avoiding duplicate execution of the same task; the UI guides the user to check the Worker panel first.

### Codex Lead Mechanism

The Codex app-server is a singleton process with multiple threads sharing the same set of MCP servers. The Codex Lead design boundary is: tools globally registered, identity restored at call time via thread context, and overreach rejected by handler / host services; it is not per-thread MCP tool isolation.

Key constraint: `mcp-session-id` only identifies the MCP transport and does not prove maker session attribution, so it **is not a routing basis**. The Codex HTTP bridge reads `params._meta.threadId` from initialized MCP POST messages and uses it to look up the Codex thread context registered by maker-core; when missing, unknown, inconsistent within a batch, or incomplete, the bridge would rather give no context (letting the tool call safely degrade to NO_SESSION_CONTEXT) than guess a wrong context causing cross-session crosstalk. Implementation: the MCP bridge request handling in `apps/desktop/src/main/mcp-integrations/codexHttpBridge.ts`, and `registerThreadContext`, `unregisterThreadContext`, `getContextForThreadId` in `apps/desktop/src/main/mcp-integrations/codexMcpThreadContextStore.ts`.

Codex `developerInstructions` have two delivery channels. The final choice depends on this thread's Responses transport form and whether the proxy registry is available; it cannot be decided by credential type alone, nor by whether the request merely enters the loopback proxy. Credential type participates in provider selection but is not the final criterion for the instructions channel; in a proxy-ready local `oauth-bearer` host, the `base_url` of both `cindy_gateway` and `cindy_openai` points to the same proxy:

- `cindy_gateway`: `supports_websockets=false`, using HTTP Responses whose request body is parseable. When the proxy is ready, API key/gateway, `codex/`-prefixed, third-party providers, and other requests depending on body routing or compatibility rewriting all use this provider; when the proxy registry channel is available, maker-core registers the instructions assembled at startup per thread, and the proxy injects the top-level `instructions`. When the channel is unavailable, only sessions meeting the `gateway-key` direct-connection degradation conditions below switch to the native channel. Implementation: provider assembly in `apps/desktop/src/main/maker-host/codex-gateway-config.ts`, `registerCodexDeveloperInstructions` in `packages/maker-core/src/agents/codex/index.ts`, and `registerComposed` in `apps/desktop/src/main/maker-host/codex-proxy-host.ts`.
- `cindy_openai`: defined only in `oauth-bearer` hosts and explicitly selected by official subscription threads; `supports_websockets=true`, with Codex defaulting to Responses WebSocket. On this channel the loopback proxy only does socket tunneling and cannot see or rewrite the request body, so instructions are carried by the native `developerInstructions` of `thread/start`/`thread/resume`. Configuring an independent Subagent Provider route does not globally turn off WebSocket; the proxy, based on the thread/subagent/parent-thread identity in the upgrade, returns 426 only to child threads hitting that route, letting that sub-session degrade to HTTP transform while the parent thread keeps WebSocket. Even when the proxy uses 426 to degrade a session to HTTP, the native channel remains the sole delivery source; temporarily switching to registry injection is not allowed.
- When the proxy is unavailable it cannot pretend the registry still works: currently only `gateway-key` hosts may degrade to direct gateway connection, with maker-core switching to native `developerInstructions`; OAuth and third-party credential injection depend on the proxy and fail closed at startup failure.

Any capability relying on host-appended instructions must reuse the full judgment of `isCodexProxyChannelReady`/`useProxyChannel` (host proxy active, thread non-WebSocket, registry registration hook available) to choose exactly one delivery source per thread; deriving a separate scheme by API key/OAuth is forbidden, as is walking both channels simultaneously as a backstop. If refreshing arbitrary context mid-session is wanted in the future, the design must separately describe the update entry points of the HTTP registry and the app-server native channel, and how consistency is kept after start/resume/compact; when the native channel has no runtime update capability, claiming WebSocket threads support per-request refresh is not allowed.

#### ADR: Codex per-role tool isolation does not rewrite tools via the proxy

Decision: do not rewrite the Responses `tools` field at the proxy layer to make each Codex lead/worker/main thread see different tools.

Rationale:

- The Codex app-server does not support per-thread MCP configuration within one process; MCP server configuration is injected globally at the app-server spawn/config layer, and thread/start parameters have no per-thread MCP override.
- An equivalent alternative is splitting into multiple app-server instances by profile, but that introduces startup latency, resident memory, resume profile matching, shutdown management, and prompt cache evaluation costs.
- On the Claude Code side, `cindy_orca` itself is also globally visible + handler rejection. Codex aligning with this semantics is enough; do not pay multi-process complexity for stronger exposure isolation.
- Re-evaluate in the future only when the Codex app-server natively supports per-thread MCP configuration.

### UI, Collaboration Tab, and Worktree

Ordinary chat routes no longer render an independent Worker pane, nor auto-navigate to `/cc-agent/orca/<sessionId>` after a Lead becomes an Orca Lead. The current main form is the ordinary Lead route `/cc-agent/<leadSessionId>` + the right sidebar "Collaboration" tab: the Lead is still rendered by `CCAgentSessionView`, and the Worker list and focused Worker session stream are mounted by `apps/desktop/src/renderer/features/right-sidebar/plugins/orca-workers`. The collaboration tab is a singleton, resident while collaboration is ongoing; clicking the tab's X is equivalent to "end collaboration" — it first pops a confirmation, and after confirming ends the team and closes the tab.

Routing layer: `/cc-agent/orca/:sessionId` remains only as a compatibility shim for old deep links. It redirects to the ordinary Lead route; if the session is still an active Orca Lead, it opens/focuses the right sidebar "Collaboration" tab and translates `?worker=<workerSessionId>` into the collaboration tab state, then clears the URL query. A Worker deep link resolves to `/cc-agent/<leadSessionId>?worker=<workerSessionId>`; `CCAgentSessionView` translates the worker hint into the collaboration tab state in the ordinary Lead route and then clears the query. Implementation: `resolveSessionRoute` in `apps/desktop/src/renderer/lib/orcaSessionIdentity.ts`, `apps/desktop/src/renderer/features/cc-agent/OrcaWorkflowRoute.tsx`, `apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx`.

The doc rail does not use the right sidebar tab and does not do route navigation. When the active session is an Orca Lead, the narrow chat column of WorkdirBrowseRoute reuses `apps/desktop/src/renderer/features/cc-agent/OrcaSplitView.tsx`; that component now serves only the `/cc-agent/files/:sessionId` document mode, showing one pane at a time via a Lead / Worker toggle.

Workers do not appear in the ordinary sidebar. The renderer identifies workers via `isOrcaWorkerSession(session) => session.orcaRole === 'worker'`, and the sidebar filter directly excludes workers; see `isOrcaWorkerSession` in `apps/desktop/src/renderer/lib/orcaSessionIdentity.ts` and the `sidebarSessions` filter in `apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx`. A worker deep link resolves to its Lead's ordinary route and one-shot focuses the right sidebar collaboration tab via `?worker=`; see `resolveSessionRoute` in `apps/desktop/src/renderer/lib/orcaSessionIdentity.ts`.

Although Workers do not enter the sidebar, their errors and pending confirmations aggregate onto their Lead's row (2026-10 user ruling, covering only local Leads): the Lead row's status dot, project collapse light, rail tile, sort pinning, and Dock badge all take the highest of "Worker error (red) > Worker awaiting confirmation (blue) > the Lead's own status"; red / blue likewise override running; Worker completion is not aggregated. The aggregation is a read-side derivation only: its sources are the Worker's own attention in `sessionAttentionStore` and Worker projections (Leads still held in `workerProjectionStore`; archived Workers and teams whose collaboration has ended are not in the projection and naturally not counted), with the lifecycle fully following the Worker's attention (retry / banner close, Lead re-dispatch, confirmation answered — then it disappears); opening the Lead does not clear it, and it still displays while viewing that Lead. The aggregated result **must not be written back** to `sessionAttentionStore`: that store syncs to Main (Dock / Dynamic Island / remote) and would be wiped by the "navigation marks read" passive clearing, breaking the Lead's own attention lifecycle and completion-persistence judgment. The Dock badge counts 1 per Lead, consistent with the sidebar row. Per-row components (`SessionItem` / `SessionCard` / `SessionStatusIcon`) may only use the per-id primitive subscription `useOrcaLeadWorkerAttentionKind`; aggregate views use `useSessionAttentionKindsWithOrcaLeads` / `useOrcaLeadWorkerAttention` and `mergeOrcaLeadNotifications`. Implementation pointers: `apps/desktop/src/renderer/features/cc-agent/lib/orcaLeadWorkerAttention.ts`, `workerProjectionStore.ts`'s `listRetainedWorkerProjections`, and the `orcaLeadWorkerAttention` input of `lib/appAttentionCount.ts`.

Worktree is optional. When old callers and MCP do not pass the new fields, the Worker still inherits the Lead-recorded directory.
Local Desktop manual Worker creation (including the first Worker of enabling collaboration) can select a project and can create a separate worktree for the Worker.
The project list defaults to the current project each time it opens and does not remember the selection; the list is, in order: the current project, other projects the current data owner actively selected and successfully created Workers in
(locally recorded independently, at most 10 items; the default current project is not written), and global recent projects. The current project is deduplicated by Git main repo, and no extra Lead-home-directory option is provided;
Worker project history is deduplicated by normalized path string when written, keeping the most recent 10;
when the list is read it is deduplicated by realpath identity, falling back to normalized paths on failure, with display and submission keeping original paths;
the list runs realpath / stat with at most 4-way concurrency and does not probe Git item by item; opening the panel reads the Lead-inherited directory,
the list is kept for this opening, project switch probes only the selected directory, and reopening after closing re-reads Lead info.
Browse-folder is kept; the entries for hiding dialogues and removing from the global recent list are hidden. Workers still do not write recent_workdirs.

When the new panel opens, Main calls resolveWorkerInheritedDirectory: on top of the existing resolveSessionGitDir inference,
it adopts only telemetry directories that still exist and whose real Git common dir matches the Lead-recorded directory; cross-clone, nested independent repos,
deleted, or no telemetry all fall back to the recorded directory. Candidates are compared first by realpath'd checkout root: the same checkout
always keeps the recorded directory; another worktree uses its root, and if the recorded directory is a monorepo sub-project and the same relative
path still exists, that sub-project location is kept. Subdirectories created by file editing do not change the Worker's default directory.
This new wrapper does not change the top-bar branch badge and is not used for MCP default inheritance. The panel's default inheritance of the actual directory is UI behavior;
when a tool omits working_dir it still silently inherits the Lead's task-recorded directory, and an Agent wanting to share the current worktree must pass the parameter explicitly.
When the inference equals the recorded directory, workingDir is not passed; otherwise the directory displayed by the panel is passed explicitly, then validated by the existing directory and project policies.

The new-worktree checkbox and source branch are both not remembered; switching projects resets the checkbox, branch, and dirty state. Eligibility depends on the current target:
not offered when the current project is dialogue or non-Git; other projects judge only that directory. The default source branch takes the selected actual directory's HEAD,
and for tree creation baseRepo resolves to the main repo, allowing another independent worktree to branch off a linked worktree.
The creation flow reserves a slot, registers the worktree with the Worker's own sessionId, then bootstraps. With the checkout root selected it
matches ordinary tasks, waiting only for startup-required files to check out while the full checkout continues in the background; with a sub-project selected its relative path is kept,
entering the corresponding subdirectory after the full checkout, and if the source branch lacks that directory it falls back to the new worktree root and logs a warning.
Failure compensation first waits for this background checkout to settle,
then inside the session lock goes through cancelPrecreatedWorktree's sealing, preserveDirty, and ownership checks; retained results are logged and never force-deleted.
Normal archiving continues with the existing snapshot and recycling rules; when only a Lead-inherited directory (including model-created) is used, ownership is not registered and it is not recycled.

This project UI is only for local Leads on the local running device; an Agent using another computer's provider does not change the task directory's ownership.
SSH, device-link controlling ends, mobile, and other running devices keep the original UI and behavior; the new local project parameters are rejected at those entries.
Project reads and label reads use local-only preload methods and do not enter the device-link allowlist; the original creation protocol only gains optional fields.
When the Worker and Lead are in different projects, the model sub-line shows a folder icon and project name; same project gets no extra marking.

The Agent tool can also create an independent worktree for a single or each Worker in a batch via `new_worktree: { source_branch?: string }`. Only local execution is supported; SSH Leads, other running devices, and dialogue Leads without other targets specified
are rejected before slot reservation and session creation. The target must be a Git repo with commits; when the source branch is omitted, the target directory's current branch is used
(current commit when HEAD is detached); creation, sub-project path retention, and failure compensation reuse the panel flow above.
The appearance of `new_worktree` (including empty objects or illegal values) enters the existing permission approval like `working_dir`, and trusted MCP servers must not bypass it; Full Access, Auto, Ask still execute per their own permission flows.
On success the actual `working_dir` is returned, and an owned worktree additionally returns `worktree: { path, branch }`.
Each Worker of `get_workspace_info` returns `owns_worktree`, with the same metadata when owned;
ownership is queried only by WorktreeManager per Worker sessionId and cannot be inferred by path. A directory inherited from the Lead or
created by the model itself does not become the Worker's owned worktree. Pi reads the same schema from the dynamic MCP tool list,
maintaining no other Worker parameter definition.

Each Worker of `create_worker` / `create_workers` may explicitly specify `working_dir` (an absolute directory already existing on the Worker's host). When omitted, it still inherits the Lead's task-recorded working directory (the directory at start,
keeping #4332's existing semantics), not following directories inferred by later cd or edit operations. If an Agent wants to share the
worktree being operated on (including self-created git worktree add), it passes the absolute path explicitly; when an independent checkout is needed it passes new_worktree.
Explicit working_dir / new_worktree goes through session permission approval, and the returned working_dir is used to verify the actual start directory.
When explicitly specified, it is validated and bound before reservation, session
bootstrap, and the first task dispatch, with project context and agent process using the same directory.
Local directories resolve the real path and check the directory and collaboration switch; SSH directories are verified remotely via the inherited remoteHostId,
reusing that host's readiness/reconnect entry before probing and not touching other hosts; resolution keeps shell-prefix-output compatibility and path spaces,
and the SSH line protocol does not accept inputs or physical paths (including symlink targets) containing CR/LF, binding no other directory after rejection.
The local filesystem is not used to judge remote paths. Invalid directories or target projects with collaboration disabled return an error, without falling back to the Lead
directory and without creating the Worker. Path resolution and session persistence both keep spaces in directory names.
Runtime consumers likewise keep directory identity: Git initialization, repo root detection, and savepoint cleanup only strip Git output's line endings;
document tools, history filtering, and iOS tool project permission checks must not trim paths; trim is only for emptiness checks.
Policy queries uniformly map Cindy-managed worktrees to the base repo, but the run directory and persisted directory remain the actual worktree; user-created worktrees
keep independent project settings. This parameter does not create directories or
Git worktrees, and does not change provider, model, or Worker creation permission preferences.
Explicit `working_dir` single or batch MCP calls go through the existing session approval: Full Access executes directly, Auto
reviews user authorization, Ask uses the existing confirmation; it must not be let through directly by a trusted server or cached server authorization.
When omitted, the original silent inheritance stays; when approval lacks tool-name or parameter evidence, silent pass-through is not allowed. The MCP new-worktree parameter and default-inheritance adjustments are outside this local-UI change's scope.

### Collaboration Runtime Behavior Contract

When automated input initiates write operations via `cindy_orca`, it must go through the Host action authorization shared with `cindy_helper`; the owner's private chat or owner requests in groups verified by the Chat Server follow the ordinary permission flow, with no additional action confirmation cards. Lead identity and the collaboration switch only decide the original scope and add no new user consent. Collaboration attribution verification for ordinary user tasks is unchanged. After an ordinary Lead receives a Worker report from the current active team, it may continue that team's collaboration; the Host verifies the source Worker's and team's attribution and re-checks before executing that the team is still valid, not treating the report as authorization to act on unrelated tasks.

This section records runtime invariants the current system must continuously satisfy. They are not long-term plans but behavior contracts already relied upon during Lead / Worker collaboration.

#### Lead Dispatch and Execution Channels

1. **Orca Worker dispatch must not be impersonated by native subagents (status: invariant)**<br>
   When the user assigns a task to an existing Worker's role/label, asks the Lead to dispatch to Workers, or dispatches in parallel by multiple roles within an active team,
   the Lead must first read the workspace, then enter the Orca state machine per scenario via
   `send_to_worker` (reuse an existing Worker) / `create_worker` (explicitly create one Worker) / `create_workers` (explicitly create multiple Workers); if the requested role/label has no matching existing Worker, the Lead must first truthfully state there is no match and ask whether to create; silently reassigning to another Worker is not allowed, nor is falling back to a native subagent.
   If the user only generically says "Worker" and there are currently no Workers, the Lead must likewise explain first and ask whether to create;
   task assignment itself is not creation authorization. Multi-role requests must resolve all role/label entries
   before dispatching any task;
   as long as a target is missing or creation authorization is pending, partial dispatch is not allowed — missing items must be listed together and asked first. Once all mappings
   and authorizations are determined, multi-role requests must be issued in one parallel tool-call batch: existing targets go
   `send_to_worker`, exactly one authorized new target goes `create_worker` with `initial_task`, and two or more
   authorized new targets go one `create_workers` carrying all `initial_task`s; waiting for some dispatch result before sending the
   remaining tasks is not allowed. Codex
   `spawn_agent` or Claude Code Agent/Task completion results must not be treated as Orca
   Worker completion. Only when the user explicitly requests a one-shot subagent/child agent without assigning the task to an Orca
   Worker, or explicitly requests not using Orca Workers, does the native subagent path apply.

2. **The actual execution channel must be disclosed and accepted by the same channel (status: invariant)**<br>
   Before summarizing, the Lead must confirm the real terminal state via the same channel that executed the task, marking each item
   `Orca Worker` or `native subagent`. Native subagents are displayed by Codex
   `collabAgentToolCall`/Claude Agent/Task task cards with identity, task, and terminal state, but must not be written into Orca
   Worker state, nor trigger Orca Worker completion reminders. Native subagent lifecycle tools (including
   `wait_agent` or equivalent capabilities) may only manage native subagents the user explicitly requested, and must not be used to wait for or manage Orca Workers. When some Worker reports arrive first, the Lead handles only the current report and necessary follow-up questions, not actively waiting for Workers still
   working; later reports wake the Lead automatically as new messages. Implementation pointers:
   `renderOrcaLeadSystemPrompt` in `packages/orca-workflow/src/orca-bridge-prompt.ts`, and
   `handleCollabAgentToolCall` in `packages/maker-core/src/agents/codex/translator.ts`.

3. **Only real async dispatch may end the turn silently (status: invariant)**<br>
   `send_to_worker` counts as real dispatch only when it returns `ok=true` and `wake_kind` is `resumed`/`already-active`/
   `queued`. For `create_worker` and each created result of `create_workers`, real dispatch requires `dispatched=true`, an existing `queued_message_id`, or
   `dispatch_outcome.kind=session-dispatch` with `dispatch_outcome.dispatched=true`
   (including `dispatch_outcome.wakeKind=queued`). The Lead may end the current turn with zero output only based on these concrete signals; on tool failure, creating a Worker without a first task, or an undispatched first task, it must
   immediately report the real result to the user and must not wait for a Worker report that will never come. Every `create_workers`
   return must first relay `user_report` (if present) and summarize per-item terminal states. After a multi-role batch returns it must also
   summarize other tools' failure/undispatched results; if at least one result meets the above dispatch signals, make this one merged report
   and end the turn immediately, ending with zero output when all succeed and there is no mandatory `create_workers` content. If no task was
   dispatched, report the result and wait for the user's decision. In all cases further tool calls are forbidden, and no sleep, no poll.
   Implementation pointers:
   `renderOrcaLeadSystemPrompt` in `packages/orca-workflow/src/orca-bridge-prompt.ts`, and
   the batch result contract in `packages/lizi-mcps/src/xdt-helper/create_workers.ts`.

#### Message Dispatch and Auto-Bridge

1. **Busy targets do not lose messages (status: invariant)**<br>
   When Lead/Worker messages are exchanged and the target session is running a turn, has a queue lock, or happens to return `SESSION_RUNNING` in a dispatch race, the default is entering the input queue. Only when the sender explicitly chooses `delivery='steer'` does it attempt same-turn interjection per 1b; auto-bridge and other system supplements never pass `delivery`. A rejection after an attempted interjection must not be treated as ordinary busy resending. Implementation pointers: `orcaInterAgentDispatcher.ts`'s `dispatchOrEnqueueOrcaInterAgentMessage`, and `register.ts`'s `AgentInputCoordinator` wiring.

1b. **Interjection is chosen explicitly by the sender only; after takeover, no duplicate supplements (status: invariant)**<br>
   No default interjection (2026-10-06 product decision, #5505). `send_to_worker` and `send_to_lead` accept optional
   `delivery: 'queue' | 'steer'`, defaulting to `queue`, with old call behavior unchanged. `steer` is attempted only on running local
   targets: when the target is idle, send directly as usual (without a reason); when the runtime does not support `sameTurnSteer` or it is an SSH task,
   queue as usual and return `STEER_UNSUPPORTED`; when the input boundary is occupied, queue and return `INPUT_BOUNDARY_BUSY`.
   On interjection success it returns `steered: true`; `send_to_worker`'s `wake_kind` remains
   `already-active` as recognized by the Lead prompt (an interjection is delivered to an already-online session), so the Lead system section needs no change. Origin, original body, and
   `delegated-continuation` human authorization semantics follow the original Orca message format, not going through the generic `steer_session`.
   The coordinator (`steerControlInput`) restores the queue first, forbidden to cross pauses, Stop, interaction locks, pending interactions,
   resume, credential switches, other interjections, and unfinished dispatch boundaries; since the sender chose interjection, crossing earlier queued rows is allowed.
   The same guard set is re-checked once after async screening and before provider delivery; interjection never lifts the user's queue pause.
   The session object and turn generation must be re-checked after preparation and before provider delivery.
   The interjection merges into the other side's running turn and does not open a new turn: the accepted/commit callback takes over the "new turn" running/auto-bridge identity, and when the interjection succeeds it never runs (otherwise it would create another pending for the already-running Worker, which after the old terminal closes would have no terminal left to settle). Lead→Worker interjections are reported by that turn's existing
   auto-bridge; Worker→Lead report settlement is completed by `send_to_lead` itself. An interjection into a Worker turn not
   dispatched by the Lead will not auto-report — a known boundary kept intentionally simple.
   When the receipt is uncertain and the coordinator has retained the same `clientId` in the paused queue, the dispatcher returns the queued
   (`STEER_UNCERTAIN`) takeover result, neither enqueueing nor lifting the pause, and registers callbacks per ordinary queuing (if drained later it is a new turn); the bridge settles the report immediately, avoiding the terminal adding another. Input screening interception
   (`rejected`) is a definite rejection, returning failure directly; switching to queue-retry is not allowed; only the remaining undelivered with no retained row
   (`not-attempted`) goes back to the ordinary direct-send/queue path.
   In device-link / mobile control scenarios the controlled Desktop performs the same judgment; the controlling end does not additionally send.
   Implementation pointers: `AgentInputCoordinator.steerControlInput` and
   `OrcaInterAgentDispatcher.dispatchOrEnqueueOrcaInterAgentMessage`.

1a. **Idle live direct send must first do the window-change pre-check (status: invariant)**<br>
When the target is idle and already has a live session, the dispatcher still goes through `session.send()`, not `sendToSessionInternal()`. This direct send must first call the same `prepareUnhealthySession` as user sends: when the window is full or the in-process `needsRollover` is latched, close the old native window, then `getLiveSession`. Inter-agent messages must not be fired into an old window that should be discarded. The whole prepare → re-fetch live → send segment must reuse `sendToSessionInternal`'s per-session lock; when the lock is held, queue first — do not treat an in-flight prepare as healthy and keep direct-sending. When there is no live, release the lock then go through `sendToSessionInternal`, avoiding queueing yourself. Implementation pointers: the live branch of `orcaInterAgentDispatcher.ts`, and `prepareUnhealthySession` / `withSendToSessionLock` injected by `register.ts`.

1c. **Image attachments are for local targets only, going through the existing attachment channel (status: invariant)**<br>
   `send_to_worker` and `create_worker` / `create_workers`'s `images` parameter accepts two kinds of addresses:
   images the user pasted in the session use managed addresses (`cindy-media://blobs/` / `xdt-image://`, i.e. the uris in context
   `<cindy-host-image-references>`), and files the Lead saved to disk use local absolute paths;
   `resolveOrcaImageAttachmentInput` normalizes them into readable image files (non-images are always rejected). The cap is 8 images,
   and when the target session's DB snapshot carries `remoteHostId` it must be rejected,
   without degrading to plain text (silently dropping images is a product bug). The dispatcher entry validates via the host-injected
   `validateImageAttachments`; on direct send the image block follows the formatted text,
   on queue/interject the files attach to entry `files`, and drain restores the same block sequence via `buildMakerUserMessage`; `update_queued_message`'s rebuild only changes the text field, with files preserved via `...entry`;
   `merge_queued_messages` merges the other merged entries' images into the retained entry in queue order. An image message's
   `persistedContent` (DB/display) remains the plain-text protocol,
   and queue bubbles do not preview images (known boundary). Implementation pointers: `orcaInterAgentDispatcher.ts`'s
   `imageFiles` / `agentMessageTextWithImages`, `orcaImageAttachments.ts`, and `register.ts`'s
   `validateImageAttachments`.

2. **Only accepted may produce runtime side effects (status: invariant)**<br>
   Only after the underlying send is accepted may the worker be marked `running`, auto-bridge pending established, and UI broadcast; dispatch failure must roll back to the pre-accepted state, and rollback must not overwrite an existing terminal state. Implementation pointers: `orcaTeamService.ts`'s `dispatchResolvedWorker` and `rollbackAcceptedDispatchState`.

3. **Queued accepted must settle the same way (status: invariant)**<br>
   If an inter-agent message enters the queue, the accepted callback must keep the same settle / rollback / discard semantics as the direct-send path, avoiding auto-bridge pending leakage. Accepted only means temporarily taking over the worker's running/auto-bridge/manual-interrupt identity; commit happens only after vendor dispatch succeeds. On the direct-send/resume path, if accepted is followed by reverting to queue due to `SESSION_RUNNING`, this temporary takeover must first be rolled back before waiting for the next accepted; if the accepted lifecycle function itself fails, it must roll back and cancel vendor dispatch — ordinary callback exceptions must not be swallowed leaving half a state. If an old terminal hits this window, it must first release the worker transition lock, then wait for commit/rollback: after commit the old terminal is void; after rollback the old identity is restored and final closure continues; holding the lock to wait for settlement is not allowed, and rollback must not overwrite the updated manual-interrupt mark produced during the provisional period. If Stop wrote an updated mark in the provisional window, the rollback settlement must carry the finally-retained manual identity, and the waiting old terminal rebinds that identity before closing, not continuing to judge itself stale by the original snapshot. Implementation pointers: `orcaInterAgentDispatcher.ts`'s queued accepted callback API, `orcaTeamService.ts`'s provisional dispatch settlement, and `register.ts`'s `AgentInputCoordinator` callbacks.

   When the Host passes an in-call origin re-verification for a plugin Worker's first input, both direct-send and post-queue accepted check along the existing callback; async lifecycle updates of task acceptance must be re-verified before and after. Readiness messages use the same origin verification and reject dispatch with `AcceptedCallbackDispatchCancelled`; ordinary callback errors must not be swallowed and then continue executing. After direct rejection, the lifecycle cleans up this new Worker, without closing the Session inside the send/transition lock; a late rejection after queuing only cancels that input and this provisional state, keeping the Worker. Ordinary send errors keep the original return semantics. This callback is not a permission transaction across restarts or tool executions.

4. **A worker's proactive report settles the auto-report state (status: invariant)**<br>
   Once a worker's proactive `send_to_lead` is enqueued or accepted, that worker's auto-bridge pending must be cleared, preventing the Lead from receiving both the manual report and the auto-bridge's duplicate result. Implementation pointers: `orca-bridge-mcp.ts`'s `send_to_lead` tool handler, and `orcaTeamService.ts`'s `clearAutoBridgeState` / `clearRuntimeState`.

5. **Manual interruption does not auto-bridge (status: invariant)**<br>
   After the user manually stops / aborts a worker, its terminal turn must not auto-bridge the last message to the Lead. Implementation pointers: `register.ts`'s stop / abort IPC handlers, and `orcaTeamService.ts`'s `handleWorkerTerminalTurn`.

5a. **A vendor terminal state within the auto-resume window is not a product error (status: invariant)**<br>
When a Worker turn is terminated by a vendor-reported error but interrupted-turn auto-resume is still pending / deferred, "abnormal termination" must not be auto-bridged, and the worker DB must not be marked `error`. A subsequent unclaimed `done` of the same failed turn (Codex/Claude's error→done tail) is likewise not a product terminal state and must not call `handleWorkerTerminalTurn(status:'done')`: that would mark the still-resuming worker done, clear auto-bridge runtime, and let later L3 surface hit the terminal short-circuit and miss the report. Zero-output / pure tool-failure turns have no assistant persist id; user takeover also force-flushes the suppressed entry and clears pending. This failed-turn completion tail must be independent of those two states, living by the failed turn's `sessionTurnGeneration` until its paired `done` is consumed, and must not be cleared when the user enqueues. Only a new attempt's token-bearing running discards it, to avoid hurting the product `done` after a successful resume. Old tails without a paired `done` (SDK / event loop crash etc.) must not stay alive forever via `status(true)` without a token: later ordinary user / Orca new turns often have no `turnAttemptToken`, and their larger generation's `done` is not this tail, so `handleWorkerTerminalTurn` must run as usual. The auto-bridge pending must be retained, so the real `done` after a successful resume can still bridge. Only when the resume is exhausted, rejected, or surfaced as a product failure may the originally suppressed terminal payload (including capture identity) call `handleWorkerTerminalTurn` exactly once. flush / discard / user takeover / manual stop must not go through this closure. Implementation pointers: `register.ts`'s event adapter, `autoResumeBookkeeping.ts`'s `shouldSkipOrcaWorkerTerminal` / `noteFailedTurnCompletionTail`, and the suppressed-error surface path.

Cross-device auto reporting follows the same boundary: `orcaRemoteWorkerRuntime.readDelivery` checks the running-device projection's
`turnInProgress`, `autoResumePending`, `usageLimitWait`, and hidden `autoResume` inputs in the queue.
Backoff, queuing, or dispatch preparation must not report progress, clear dispatch identity, or accumulate missing-reply counts merely because the vendor is temporarily idle;
after history reads, verify once more, and if a resume has started, discard that candidate and pagination cursor, re-reading from the latest history after the true end.
Resume after later interjections is isolated by `retrySourceClientId` / input identity; `queue-head` resume first locates the queue item by `clientId`,
then verifies its original input attribution, and must not let an unrelated interjection's quota wait block an already-completed dispatch report. After the host abandons the resume, close out along the original error boundary.
Old ends with missing fields keep compatible behavior. Regressions: `orcaRemoteWorkerRuntime.test.ts` and
the real coordinator-plus-poller combination cases in `agent-input-coordinator.test.ts`.

6. **The Lead can only manage its own queued messages, and withdrawal must settle the accepted staging (status: invariant)**<br>
   `get_worker_queue_status` / `update_queued_message` / `cancel_queued_message`, after attribution verification via `resolveWorkerRef` per the caller Lead, may only operate on entries with `origin.kind='orca'` in the target worker's queue (orca entries in a worker queue can only come from its Lead); the queue visibility rule is "see everything, touch only your own" (2026-07-21 product decision) — user-typed and scheduler-queued entries are visible to the Lead body (for orchestration based on full queue content), pre-dispatch active / direct steering entries must also appear and be marked `consuming=true`, but non-Lead entries cannot be modified or withdrawn (`NOT_LEAD_MESSAGE`). `get_workspace_info` and `get_worker_queue_status`'s `queued_count` must both use this full inspection's `messages.length`; letting workspace count only pending is not allowed. Modification is whole-body replacement, must rebuild `text` / `persistedContent` / `chatMessage.content` / `origin.displayText` in the original dispatch format via `rebuildQueuedOrcaLeadMessage`, with identity fields (clientId / createOpts / createdAt / senderLabel) anchored to the original entry; calling the coordinator's `updateText` directly is not allowed (it would break the orca dispatch format coupling). Withdrawal must go through coordinator `remove` (triggering `onDiscardedQueuedMessage` → the dispatcher discards that clientId's accepted staging callback, the same settle path as Stop clearing the queue), otherwise the accepted callback table leaks. Entries being steered are always rejected (`MESSAGE_CONSUMING`). Implementation pointers: `orcaTeamService.ts`'s `resolveLeadQueuedMessage` and queue control methods, `orcaInterAgentDispatcher.ts`'s `rebuildQueuedOrcaLeadMessage`, `agent-input-coordinator.ts`'s `replaceQueuedMessage`.

7. **Interrupt is a single atomic operation of "reserving the next input + gracefully stopping the old turn" (status: invariant)**<br>
   `send_to_worker`'s public schema keeps ordinary direct-send/queue semantics without an interrupt field; `interrupt_worker` is the only public interrupt entry. Both enter `OrcaTeamService`'s same private dispatch path, split by internal normal/interrupt mode; implementing `interrupt_worker` as stop + send two tool calls is not allowed. Interrupt must reuse `buildQueuedOrcaInterAgentMessage`, accepted callbacks, host acceptance stamp, clientId dedup, and the persistence chain; after queue restore completes, in an await-free coordinator critical section the new message is inserted at the head of the existing pending queue, and before emit/drain the old turn's graceful stop is initiated synchronously. The message stays queue-head on `unsupported`/`unconfirmed` without hard abort; the user's paused state must not be lifted; when the stop adapter throws/refuses or the result is `unconfirmed`, `queue_paused` must read the coordinator's current projection and must not default to `false`. `lead_interrupt` must be captured synchronously before the old terminal wakes the drain; the old turn does not auto-bridge and must not overwrite the already-accepted new turn state; the next accepted dispatch clears the mark. The whole flow from before reservation to stop result confirmation counts into `activeWorkerDispatches`, mutually exclusive with done confirmation.
   `onReserved` may return a wait ticket for the same stop request: the local coordinator still calls synchronously; remote adapters wait for the ticket before delivering the replacement message and must not call abort a second time. The ticket absorbing errors is only for wait settlement; the real stop result is still returned by TeamService's original stopPromise.

8. **Multi-message merge must be one validation, one swap, one persistence (status: invariant)**<br>
   `merge_queued_messages` accepts only at least two distinct, consecutive in live-queue order, pending, non-consuming/steering messages sent by the current Lead. The durable restore must succeed first; from then until the one-shot array swap there must be no await after a synchronous re-read. If any message is missing, order changed, non-consecutive, non-Lead, or consuming, the whole operation makes zero modifications and returns `QUEUE_CHANGED` with the latest full queue; partial merging is not allowed. The survivor keeps the frontmost target's clientId, queue position, and `hostAcceptedAtMs`; removed items must each go through discard settlement to settle accepted callbacks; finally only one emit/persistence, with no intermediate snapshots exposed. `update_queued_message` and `cancel_queued_message` keep single-entry semantics and must not simulate merging in multiple steps.

9. **Post-queue steering and reordering reuse the same boundary (status: invariant)**<br>
   `steer_queued_message` / `move_queued_message` and cindy_helper's
   `steer_session_queued_message` / `move_session_queued_message` go through the shared
   `createSessionQueueControlService`'s locating, authorization, and race classification; on the host side
   `createQueueReorderAdapter` uniformly judges runtime state, capability, and remote tasks, then hands to
   `AgentInputCoordinator.steerControlInput({ queuedClientId })` and `move`. Steering does not change body or identity;
   when the steer fails, the message stays in place and returns `NO_ACTIVE_TURN` / `STEER_UNSUPPORTED` / `INPUT_BOUNDARY_BUSY` /
   `STEER_UNCERTAIN`. `position` is the final index among waiting messages (0 = frontmost, out of range goes last), returning the actual landing point.
   Authorization: the worker queue opens only Lead-sent orca entries (`NOT_LEAD_MESSAGE`); when `worker_id` is omitted, only
   orca entries in the caller's own queue are open (`NOT_ORCA_MESSAGE`). cindy_helper opens only messages the caller itself sent,
   or machine messages in its own queue from other tasks / collaboration members; user-typed, buddy-delegated, plugin, and scheduled-task
   entries have their own acceptance bookkeeping and are never opened. The UI likewise allows converting collaboration queued rows to interjections (editing still forbidden);
   interjections bypass drain, so after each provider-accepted interjection the coordinator calls `onSteerAccepted`, and the host
   releases the Orca callback registered when that clientId was queued (not run — reason in 1b). Reordering also obeys the edit lock:
   rows the user is editing cannot be moved (`MESSAGE_CONSUMING`).

10. **An accepted landing only after the turn ends can only use delivery-level credentials (status: invariant, 2026-10-24)**<br>
    A queued message's accepted callback only runs after the target drains the queue, by which time the turn that initiated it has long ended; therefore it can only re-verify
    delivery-level invariants (account epoch, session row not `deleted` and `cleared_at` unchanged, task attribution unchanged, permission mode not revoked,
    the Worker still in that Lead's active team), and cannot reuse turn-level credentials (this turn's input origin, `turnOrigin`).
    Runtime release/rebuild itself is not revocation: when the runtime exists, compare the live tier; when absent, compare the persisted
    permission mode / Plan — the two baselines each come from their own source (cold-start recovery may run a different tier than the DB; mixing them would
    wrongly cancel); do not compare the live session's generation counter — it resets to zero on instance rebuild. When the permission mode is mid-switch (stable
    snapshot empty), delivery is rejected. **Archiving (`status='archived'`) is only reversible shelving in the sidebar; it does not trigger ending the team,
    and does not count as revocation**; queued dispatch is delivered as usual. A standalone UI's done confirmation carries no caller credentials and takes no delivery credentials.
    Cancel only when identity/attribution/permissions truly changed, restoring per the existing rollback; state writes and broadcasts failing inside accepted
    still go through the existing failure path (whether bookkeeping failure should cancel delivery is a separate issue, handled separately). The synchronous control plane (archive, end team,
    rename, focus switch, queue add/remove/modify) still uses turn credentials. Implementation pointers: `register.ts`'s `captureOrcaPluginAuthority` (turn) and
    `captureOrcaDeliveryAuthority` (delivery), `orcaTeamService.ts`'s
    `dispatchResolvedWorker.onAccepted` and `deferDoneAcknowledgement`; regressions in
    `orcaTeamService.test.ts`'s queued/deferred cases.

#### Worker Runtime State

1. **Worker terminal states are not overwritten by failure rollback (status: invariant)**<br>
   After dispatch accepted, if a later failure occurs, rollback may only restore workers still in `running` to their old state; workers already in `done/error/idle` must not be overwritten by rollback. Implementation pointers: `orcaTeamService.ts`'s `rollbackAcceptedDispatchState` and `handleWorkerTerminalTurn`.

2. **Done confirmation and dispatch must be mutually exclusive (status: invariant)**<br>
   A `done` worker's implicit `idle_worker(expectedStatus='done')` confirmation must not interleave with dispatch to the same worker: dispatch holds the active dispatch count from pre-resume reservation until host dispatch settles, done confirmation must execute serially in each worker's transition queue, and be rejected when the count is non-zero. The confirmation must also check the live turn, `send_to_session` lock, and pending input before and after the DB CAS; close must use `Session.closeIfIdle` to be atomic and mutually exclusive with send reservation. When any check or the close fails, if already CAS'd to `idle`, only records still `idle` may be restored to `done`; new terminal states must not be overwritten. Implementation pointers: `orcaTeamService.ts`'s `withWorkerTransition`, `activeWorkerDispatches`, `dispatchWorkerTask`, `idleWorker`.

3. **Idle worker resume must retain extraDirs (status: invariant)**<br>
   When an idle worker is woken by `switch_focus` or `send_to_worker`, `extra_dirs` must be read from the DB and carried back to `bootstrapSession`, otherwise the resumed worker loses its extra-directory context. Implementation pointer: `register.ts`'s idle worker resume helper.

3a. **Focus switch does not wait for worker cold start (status: invariant)**<br>
   `switch_focus` is a pure UI focus operation: after `setWorkerFocus` succeeds and `ORCA_WORKER_CHANGED` is broadcast it must return immediately, and must not synchronously `await` the cold session's resume / `bootstrapSession` (Pi cold start measured 2~3s, which would block panel switching). The idle worker's runtime warm-up moves to the background and shares the same per-session dedup + `sendToSession` lock as the send/dispatch paths: concurrent focus / dispatch bootstraps only once; when a send acquires the lock first and completes lazy resume, the background resume re-checks live inside the lock and skips; warm-up failure only warns and does not change `switch_focus`'s result. Worker history comes from the DB; display needs no live runtime. Background warm-up must be cancellable: ending collaboration / archiving / explicit idle cancels the un-landed wake before releasing the runtime; before cold start and after `bootstrapSession` returns, re-verify the session is still active, and if invalid, shut down the just-started runtime — an archived worker must not be left running. Implementation pointers: `register.ts`'s `resumeOrcaWorkerSessionIfMissing` / `disableOrcaInternal` / `orcaWorkerResumeScheduler.ts`, and `orcaTeamService.ts`'s `cancelWorkerResume`.

4. **Worker state changes must be broadcast to the renderer (status: invariant)**
   Creating a worker, `enableOrca` creating the first worker, running after any real worker turn starts, idle, archive, and terminal done/error must all broadcast `ORCA_WORKER_CHANGED`. The worker DB `status` follows the real turn lifecycle: when the Lead dispatches or the user directly talks to a worker, only a real turn start sets `running`, and only a **product** terminal sets `done/error` (a vendor terminal with auto-resume still pending/deferred is not a product terminal — see Message dispatch and auto-bridge 5a); `switch_focus` / resume / restore may only restore accessibility and must not set `running` out of thin air. Implementation pointers: `orcaLifecycleService.ts`'s `createWorker` / `enableTeam`, `orcaWorkerCreationService.ts`'s `createWorkerInTeam`, `orcaTeamService.ts`'s `dispatchWorkerTask` / `handleWorkerTurnStarted` / `handleWorkerTerminalTurn`, `register.ts`'s status event adapter, `useWorkers.ts`'s `useWorkers`.

5. **Switching sessions does not reset worker unread state (status: invariant)**
   The worker done green dot is maintained by the renderer's process-level edge-trigger attention store, not local state reset by component switching. Attention is marked only when worker state jumps into `done`; it is cleared while viewing that worker; merely switching away and back must not make the same turn's done unread again. The collaboration tab icon additionally shows the Worker's error (red) and awaiting confirmation (blue): error comes from the Worker's own attention in `sessionAttentionStore`, awaiting confirmation from unhandled interactions or tasks awaiting; with multiple Workers the highest of red > blue > green (completion unread) is taken, and red / blue show even when the tab is active, while the green dot still counts as seen when activated. Implementation pointers: `useOrcaWorkerAttentionWatcher.ts`'s `computeWorkerAttentionUpdates`, `RolePillDropdown.tsx`'s selected worker clear effect, `workerAttentionStore.ts`'s `attentionWorkerIds`, `OrcaWorkersAttentionIcon.tsx`'s `resolveOrcaWorkersTabTone`.

   The Worker list (`RolePillDropdown.tsx`'s dropdown rows, flat tabs, collapsed entry) likewise reads the local Worker's
   own task reminders: the red outline and ERR badge show only when the task reminder is `error`; after the error is closed, even if the run state
   is still `error`, the list and avatar clear the error expression in sync. Without an error,
   when the Worker has unhandled interactions (AskUserQuestion / permissions / plan review / plugin settings / proxy input) or the task is
   `awaiting`, a blue dot shows at the avatar's top-right, kept when switching to the Worker and away, until the interaction is handled and the task's
   awaiting disappears; the completion unread green dot still shows only when unselected. Priority is
   error > awaiting confirmation > completion unread. The collapsed entry also hints at hidden Workers' errors or pending confirmations, not aggregating completion.
   "Running device" Workers, remote Workers, or Workers under a remote Lead cannot read local task reminders,
   keeping the existing expression of run state `error`; a remote provider does not change the computer where the task lives and is not in this fallback's scope.
   `orcaWorkerTaskAttention.ts` unifies task reminders for the list, collaboration tab, Lead row, and Dock derivation; the list
   additionally uses `resolveWorkerListAttention` to select the error source by the same scope as `isLocalOrcaWorkerTask`. Subscription notifies downstream only when the relevant Worker's pending boolean
   changes; primitive snapshots prevent streaming output or unrelated tasks from piercing render isolation.
   It writes back no reminder state, does not change ordinary tasks' passive clearing, Worker run state, or system notification sending rules,
   and does not change main / Dynamic Island / mobile. The list title's "Running" counts only by
   `isRunningWorkerStatus`; Worker creation's soft and hard limits still use the un-archived slot count `activeWorkerCount`.

6. **Lazy registration of known workers after restart (status: invariant)**
   After an app restart, in-memory known workers / vendorOptions are lost. Recovery must not trust the in-memory cache alone; it must lazily synthesize Orca vendorOptions / worker links through the DB's `sessions.orca_role`, `orca_workers`, `orca_teams`, so manual stop, terminal turns, and the worker list still recognize existing workers; manual interrupt tracking can only be a runtime optimization, never the sole source of truth. When collaboration was just enabled but the worker has not yet conversed, a recoverable agent-side history must also be written first; currently a ready placeholder triggers the worker's first send, preventing Codex workers from being unable to resume after restart due to missing rollout. Implementation pointers: `register.ts`'s `synthesizeOrcaVendorOptionsFromDb`, `sessionCreateHandler.ts`'s `sendWorkerReadyMessage`, `orcaLifecycleService.ts`'s `enableTeam` / `sendWorkerReadyPlaceholder` dependencies, `orcaTeamStore.ts`'s `listWorkersByLead` / `getWorkerLink`, `orcaManualInterrupt.ts`'s known worker / manual interrupt store.

7. **After restart, Lead↔Worker mutual access / resume does not vary by enablement path (status: invariant)**
   Whether collaboration was enabled by `enableTeam` auto-creating the first worker, MCP `start_team` + `create_worker`, or the renderer's collaboration button; and whether the restart happened mid-conversation or after initialization completed but before the worker took a real task, after a maker restart the Lead and Workers must be able to keep accessing each other. `send_to_worker`, `send_to_lead`, and `switch_focus` / idle resume must not fail because of lost in-memory state, missing lazy worker-link registration, or missing empty worker rollout. Implementation pointers: `CCAgentSessionView.tsx`'s `requestEnableCollab`, `packages/lizi-mcps/src/orca/server.ts`'s `start_team` / `create_worker` top-level registration, `xdt-helper/start_team.ts` / `create_worker.ts`, `orcaLifecycleService.ts`'s `startTeam` / `createWorker` / `enableTeam`, `register.ts`'s `synthesizeOrcaVendorOptionsFromDb` / `resumeOrcaWorkerSessionIfMissing`, `orcaTeamService.ts`'s `sendToWorker`, `orca-bridge-mcp.ts`'s worker `send_to_lead` handler.

8. **Done confirmations rejected by same-turn wrap-up must be closed out at the terminal boundary (status: invariant)**
   A worker's report settle (`send_to_lead` accepted/enqueued) first sets the persisted state to `done`, while the worker's own turn may still be wrapping up; the renderer's "ack on seeing done" is then rejected by active-turn / send lock guards with `WORKER_STATE_CHANGED`. Confirmations rejected by these two guard kinds must be registered and retried once at that turn's `handleWorkerTerminalTurn` done branch (fire-once; a failed retry does not re-register); a new turn starting (`handleWorkerTurnStarted`) must void registrations. Unregistered done must not be auto-closed at the terminal boundary — `done`'s product semantics are "hold until the user sees it". Implementation pointers: `orcaTeamService.ts`'s `deferredDoneAcknowledgements`, `idleWorker`, `handleWorkerTurnStarted`, `handleWorkerTerminalTurn`.

9. **The Lead's completion is judged by team closure (status: invariant)**
   When the Lead finishes its turn after dispatching work while the team is still working, that turn is not completion: the Dynamic Island keeps the Lead as running (no completion card, no completion sound, no unread recorded), and the Work Louder keyboard, sidebar cards, and remote session list read the same activity snapshot and so also stay running; the renderer sends no completion notification (desktop/mobile/Feishu) and lights no completion badge. Only after Worker reports arrive and the Lead is woken is that turn's done the team completion. There is exactly one criterion, in Main: "there are still accepted dispatches owed reports to the Lead" (auto-bridge pending) is authoritative; when the last report is delivered or discarded (manual stop, archiving, etc.), if the Lead is idle the deferred completion is sent; the renderer does not compute Worker state itself — when the completion debounce lands it reads the Dynamic Island activity snapshot, and if Main still holds the session as `running` it is not completion (a paused input queue likewise keeps the Dynamic Island running but keeps the original completion reminder, hence excluded). Workers themselves still do not enter the Dynamic Island; a Worker's completion is not notified separately, while errors and needed confirmations are notified separately as "Lead title · Worker title" (desktop / Feishu / mobile push, through the same `sendSessionEventNotification`; falling back to the Worker title when the Lead cannot be found; covering only local Workers), and clicking routes by Worker id via `resolveSessionRoute` to the Lead opening that Worker. After a Worker error and the Lead is woken and finishes handling, there is also a Lead completion notification — both are kept. Known gap (accepted by the user): when the Dynamic Island is on, the renderer does not pop system banners, and Workers do not enter the Dynamic Island, so during that time Worker errors/confirmations get no desktop popup, while Feishu / mobile push is unaffected. Implementation pointers: `CCAgentSidebarUpper.tsx`'s `fireSessionNotification`, `orcaLeadWorkerAttention.ts`'s `shouldNotifyOrcaWorkerEvent` / `formatOrcaWorkerNotificationTitle` / `findOrcaLeadSessionIdForWorker`. Known boundaries (deliberately unhandled, kept simple): tasks dispatched to a busy Worker still sitting in its queue un-accepted have no pending-report record yet (a busy Worker usually means a same-Lead pending-report record already exists); silent completions (e.g. silent automated runs) do not defer, and the Lead activity directly becomes completion. Implementation pointers: `orcaTeamService.ts`'s `hasPendingWorkerReports` / `deletePendingReport` / `onLeadWorkerReportsSettled`, `register.ts`'s `setCompletionDeferResolver` and `onLeadWorkerReportsSettled` wiring, `agent-island/service.ts`'s `notifyQueueEmptied`, renderer `state/agentIslandActivity.ts`'s `isSessionCompletionHeldByAgentIsland` and `useSessionRunningStatus.ts`'s done debounce.

10. **Remote Workers run only on the running device (status: invariant)**
   A Worker can be placed on another computer of the same account (running device): the real task lives there; locally there is only a proxy task row that runs no Agent and has an empty `working_dir`, with `orca_workers.execution_device_id` / `remote_session_id` recording the location. The proxy row carries slot counting, state machine, auto-bridge, and archiving; no path may start an Agent for it locally (`bootstrapSession` rejects remote Workers outright) or copy it to other computers; dispatch, stop, and liveness queries are routed to the running device via `orcaRemoteWorkers.ts`'s `wrapTeamDeps`, with other dependencies passed through as-is, without building another state machine. Reports rely on polling: when a dispatched message has entered the conversation (delivery receipt accepted) and the device is not running, the user / assistant history is read with pagination, locating the last assistant reply corresponding to the dispatch user's clientId and deduplicating by message id; replies to later user interjections and abnormal states must not be attributed to earlier dispatches, and new dispatches during history reads must not be cleared by old reports. Each round scans at most 2000 rows; when the budget is insufficient, keep the cursor and continue next round, without misjudging missing replies; only after the host onAccepted / onAcceptedCommit completes is the report identity frozen and polling wrap-up allowed; on accepted-callback failure the previous generation's waiting state is restored, and while old results are saved, new dispatch identities must not be consumed nor their captured text written. The same remote Worker's enqueue, accepted / commit, and identity confirmation reuse the existing session send lock to execute serially, avoiding concurrent callbacks and delivery-order misalignment. Messages the user sends directly on the running device count as interjections and do not trigger reports. Device unreachability is only a runtime projection (`executionDevice.reachable`) and does not extend `OrcaWorkerStatus`; dispatching while unreachable fails directly, with no fallback to local. Remote Workers forward the four existing Worker bridge tools via the running device, and the Lead verifies attribution by same-account source device, real task, Worker, and active team; old ends without the channel keep auto reporting. Remote queue editing is still unsupported; send_to_lead's steer is judged by the Lead's computer along the original local guards. UI: the create dialog's "running device" applies to desktop local tasks and mobile-controlled non-SSH Leads; the desktop remote-control view keeps the original directory-read boundary — the controlling end itself cannot read its own directories via device-link, and cross-device dispatch can still be executed by the Lead's MCP; a Lead whose Agent runs on another computer can also dispatch cross-device Workers. The working computer and the Agent's computer can be chosen independently; the latter requires the working computer to declare the `agentDevice` capability. The entry is controlled by `CreateWorkerPopover.executionDevicesEnabled`, reusing the standard dropdown list, with bounded scrolling and keyboard by-name search for many devices; after choosing another computer, the working directory offers "dialogue / specified directory" — "dialogue" passes no `workingDir` and creates a project-unbound task on the running device; "specified directory" uses only absolute paths on that computer. Mobile's new-task "enable collaboration" and the Lead's "create Worker" share the device dropdown and both directory modes; the device list is read from the Lead's computer, and Agent, model, and provider catalogs from the chosen running device. The collaboration panel shows the remote Worker's real task on the running device (`RemoteWorkerSessionPane`, registering attribution before reading/writing). Implementation pointers: `orcaRemoteWorkerRuntime.ts`, `orcaRemoteWorkers.ts`, `orcaWorkerCreationService.ts`'s `createRemoteWorkerInTeam`, the running-device-side `orcaRemoteWorkerHost.ts`; protocol in `protocol-compatibility.md` "Collaboration remote Worker" (协同远端 Worker).

11. **Renaming only changes identity metadata, not rebuilding the execution unit (status: invariant)**
   The Worker's display role name `role` (1-32 characters) and team-unique identifier `label` (slug, `/^[a-z0-9_-]+$/i`, ≤32) can be changed after creation via `update_worker` / `maker:worker:update`. Renaming is not swapping the execution unit: Agent, model, permissions, working directory, and already-initiated turns are unaffected, and **using rename to swap models mid-flight is not allowed** (see Pitfall #6). `label` uniqueness is finally enforced by `uniq_orca_workers_team_label` (the constraint covers archived workers too); conflicts must return `DUPLICATE_LABEL` with zero side effects; no-op must be idempotent. The same Worker's read-modify-write must serialize by worker id, preventing UI role changes and Lead label changes' concurrent requests from fully overwriting each other; the UI can only commit fields the user actually changed on save (server locks cannot stop requests carrying stale values). A plugin team plan freezes Worker attribution and delegation auto-authorization by label and is immutable as a whole once registered: labels (old or new value) referenced by unsettled plan entries must not be renamed, returning `WORKER_STATE_CHANGED`; role renaming is unaffected; receipts retained after the plugin is uninstalled (task attribution truly revoked) no longer constitute a lock; disabled / unapproved can be recovered and plans continue after re-enabling, so the lock stays (fail closed). When the worker session title is still in the `orcaWorkerSessionTitle` generated form (`Worker · role · label`, deduplicated to `Worker · role` when role and label are equal), rewrite it to the new form; user-customized/renamed titles must not be overwritten. A successful rename must broadcast `ORCA_WORKER_CHANGED` and sync the worker session's `local-db:sessions:patched` (if the title was rewritten). Implementation pointers: `orcaTeamService.ts`'s `updateWorker`, `orcaTeamStore.ts`'s `updateWorkerIdentity`, `pluginTaskService.ts`'s `isTeamPlanLabelLocked` / `isTeamPlanLabelLockedByReceipt`, `orcaWorkerCreationService.ts`'s `orcaWorkerTitle`, `packages/lizi-mcps/src/xdt-helper/update_worker.ts`.

11. **Worker Agent location: remote providers and local providers treated equally (status: invariant, 2026-10-10 user ruling)**
   Unlike the previous "running device" item, here the task, directory, commands, and files stay on the Lead's computer; only the Worker's Agent runs on another same-account computer or a shared provider (the same mechanism as ordinary tasks' remote Agent, `sessions.agent_device_id`). Each Worker can choose its location individually: `OrcaWorkerCreateParams.agentDeviceId` not passed = follow the Lead (old callers, old controlling ends, and MCP omissions all take this), `null` = the computer where the task lives, string = that computer or `share:<id>`; equal to the local device id is treated as `null`. Models and sources read the catalog per the Worker's own location (that computer lists only providers allowed to be called remotely), and only when in the same location as the Lead does it reuse the Lead's source (a source id is not the same thing on different computers); when the Agent is on another computer, the local Cindy AI key must not be used to judge budget models. When that computer cannot read the catalog, it fails at slot reservation and before start (`REMOTE_AGENT_DEVICE_UNREACHABLE` / `REMOTE_AGENT_SHARE_*`), with no fallback to local. An SSH Lead cannot specify another computer (`INVALID_PARAMS`); cross-device Worker creation may specify an independent Agent computer, with `agentDeviceId` interpreted relative to the working computer — omitted or null uses the working computer's default and does not inherit the Lead. The working computer first admits per the chosen provider computer's catalog, reusing ordinary tasks' remote Agent and tool execution channels, without migrating the working directory, and plugin tasks can only follow the Lead or stay on the task's computer. One entry, one set: desktop's "create Worker / enable collaboration" dialog and new task use the same model panel, listing other computers and shares after the task computer's providers (`useWorkerAgentDevices`); whichever row is selected, the Worker's Agent runs there, defaulting to the Lead's location; after choosing a remote provider the working computer entry is kept; switching the working computer first restores that computer's local default, after which remote providers or shares it can call can be chosen. Old working computers do not open the independent Agent location, and explicit requests must not be silently ignored. After desktop manual model selection and submitted creation, the full selection (Agent, model, source, Agent's computer, effort, and Fast) is saved per account and task computer in `workerCreationPrefs.modelSelectionByHost`, restored with priority on next open, not overwritten by the Lead's later model or location changes; without manual selection it still follows the Lead's location, and cancelled uncommitted edits are not saved. Old per-Agent memory remains readable, without inferring which computer it originally belonged to; SSH and running-device temporary selections are not written into this location memory. Remote selection does not overwrite old per-Agent local catalog memory, and model-row tier presets still use `agentDeviceModelMemory`. Regressions: the reopen and task-computer isolation cases in `CreateWorkerPopover.test.tsx`. Mobile likewise supports choosing the Agent location (`useOrcaWorkerForm`'s `agentDeviceId`; the model panel's `remote` shares the new task's `useRemoteAgentCatalogs`), saving the same full selection per account and task computer locally via `orcaWorkerPrefs.modelSelectionByHost`, written back after creation succeeds or the new-task collaboration draft is confirmed; async reads must not overwrite edited forms. When the recovered source or model is unavailable, the original route is kept, blocked by the UI or explicitly rejected by the host, without silently switching elsewhere; old ends that cannot honor the location also reject. Regressions: `useOrcaWorkerForm.test.tsx` and `orcaTeam.test.ts`. When the controlled computer declares `supportsOrcaWorkerAgentDevice`, new tasks' remote providers and collaboration are no longer mutually exclusive. The Lead's `list_available_models` can list models there by `agent_device_id` and give `locations`, and `create_worker` / `create_workers` use the same `agent_device_id`. The Worker list projects `session.agentDeviceId`, with desktop Worker avatars showing the same single-ripple + dot as remote tasks; mobile Worker rows keep the original status dot without remote marking (2026-10-11 user request to keep as-is). Started Leads and Workers can have their Agent location changed by the user in the model list (local providers, other computers, and shared providers listed together), using the same computer-switch transaction as ordinary tasks: the choice is first registered as an intent, and after the next send boundary's full handoff it is rebuilt at the new location, with the collaboration identity unchanged (2026-10-16 user ruling: tasks are all local, only the provider's computer changes, and this should not be excluded). Running-device Workers and SSH tasks remain closed; collaboration tasks on controlled computers are not yet open in the controlling end (old controlled ends reject), and mobile likewise not yet open. Provider groups moving tasks across computers: see item 12. Implementation pointers: `orcaWorkerCreationService.ts`'s `resolveWorkerAgentDeviceId` / `agentDeviceCatalogFailure`, `register.ts`'s `listWorkerAgentLocations` and `listAvailableModels`, renderer `CreateWorkerPopover.tsx`, `hooks/useWorkerAgentDevices.ts`; protocol in `protocol-compatibility.md` "Worker Agent location" (Worker 的 Agent 位置).

12. **Collaboration tasks belong to provider groups; computer switching does not lose reports (status: invariant, 2026-10-10 user ruling)**
   Leads and Workers, like ordinary tasks, are assigned to provider groups and auto-switch computers on problems (product rules in `docs/product-rules/provider-groups.md` §6.1 "Collaboration tasks"); only review tasks remain excluded (`readProviderGroupSessionRow`). Key points:
   - **New Workers are also assigned**: a Worker's task record is written by the start step and unreadable at assignment time, so `applyProviderGroupAssignment` uses the start parameters as the "never ran" snapshot (`assignBeforeStart`'s `startRow`); when the record already exists, the record is authoritative.
   - **Following the Lead means following the Lead's group**: when the Lead has a group binding, the Worker's chosen location is where the Lead currently is and its source has no separate selection (or the selection is the Lead's current source / group item), and the Agent kind is the same, the Worker switches to the group item (local group: task computer + the group's provider; group on another computer: that computer + the group's provider), then the group picks the computer by policy; when the group item does not offer that model or is unreadable, keep following the Lead's computer as before. `list_available_models` without a location uses the same rule. Implementation: `OrcaLeadSessionSnapshot.providerGroupEntry`, `leadProviderGroupFollowCandidate`.
   - **Location-change entry**: Leads and local Workers explicitly changing `agentDeviceId` go through `performSessionAgentSwitch` like ordinary tasks (from 2026-10-16, see item 11). When clicking another provider group and the group selects back to the current location at send time with an unchanged engine, collaboration tasks go through handoff rebuild rather than in-place model switch: in-place model switching requires the window verified at click time, while location-change clicks skip that verification, and switching to a smaller-window model would be stuck before sending; the user already confirmed at click time to restart via handoff. Running-device Workers' (`orcaRemoteLead`) explicit `agentDeviceId` still accepts only main-internal applyNow calls carrying `providerGroupRelocation`, with engine and model both unchanged; that flag is not read from IPC.
   - **Lead leaving an unreachable remote computer**: when the Lead's Agent is on another computer, the old remote session must be closed before switching. If the close request failed to reach the other side due to link failure (`DeviceLinkError.code` being `DEVICE_OFFLINE`, `INVOKE_TIMEOUT`, `DEVICE_UNRESPONSIVE`, `NOT_CONNECTED`, `LINK_NOT_OPEN`, `PEER_RESET`, `BACKPRESSURE`, or the message carrying the corresponding `[DEVICE_LINK_*]` prefix), `performSessionAgentSwitch` logs a warn and still commits the new location; permission, version, and business errors (e.g. `REMOTE_DISABLED`, `CHANNEL_NOT_ALLOWED`, `ACCESS_REVOKED`, `VERSION_MISMATCH`, code-less `REMOTE_AGENT_UNAVAILABLE`) still abort without writing the DB. Effective only for Leads; Workers' and ordinary tasks' close-failure semantics are unchanged. The list corresponds to `apps/desktop/src/main/device-link/ipc.ts`'s `DEVICE_LINK_CODE_MAP` — when changing one, look at the other. When the old session already finished locally but the other side did not receive the close, its host recycles it as `controller-gone` after `REMOTE_AGENT_HOST_IDLE_MS` (3 minutes without poll). Unverified: no real-machine Orca collaboration regression done (Lead leaving an unreachable computer's team/Worker report chain).
   - **Computer-switch eligibility and quota recovery are separate**: the group's `isFailoverEligible` uses `isProviderGroupFailoverEligible` (Workers can switch); auto-continue after quota recovery still uses `isUsageLimitAutoResumeEligible` (Workers do not wait; failures go to the Lead).
   - **After switching it is still a member**: `bootstrapSwitchedSession` calls `synthesizeOrcaVendorOptionsFromDb` for collaboration tasks; the new session carries the collaboration identity, prompts, and `cindy_orca` / `orca_worker_bridge`, without relying on the next send to restart a second time.
   - **Worker terminal states settle by the registration of that switch attempt** (same principle as 5a): during the input coordinator's "hold back for now" registration, a Worker's terminal state does not call `handleWorkerTerminalTurn`, but is staged by the registration id (`provider-group/heldWorkerTerminals.ts`; error events are staged together with the error row, and failures ending only in done are staged at terminal end). If the switch succeeded (resume already issued), discard; the auto-bridge pending is kept until that resume turn's product terminal state, then reported; if the switch failed, no outcome ever came, or someone took over, report this abnormal termination exactly once; if the account already switched, do not report. Late old settlements recognize only their own registration.
   - **Wake and computer switch are mutually exclusive**: `resumeOrcaWorkerSessionIfMissing` re-checks the live session inside the session send lock before starting, and will not start the Worker on the original computer per the old record in the gap of "close → write DB → start".
   - **Remote Worker reports**: `orcaRemoteWorkerRuntime.ts` skips auto-resume's hidden user messages (`agentMeta.autoResume`) when closing by history; replies after the resume still count as the dispatch result as usual.
   - Messages the Lead sends to the Worker during the switch, and Worker reports arriving at the Lead, are treated as personal takeover (stopping this switch trip; that message starts a new turn), without queue-jumping or deferring.

### Test and Regression Checklist

Proactive reporting of cross-device Workers (2026-10-21): the running device restores bridge marks from the persisted `orcaRemoteLead`,
still not writing local `orcaRole` nor creating local teams; Claude Code, Codex, and Pi share the existing four Worker tools.
Dispatch instructions carry the Lead-assigned `worker_id`; current-task queries and history task lists project source marks,
and `parentSessionId` still means only Fork. The running device verifies root Agent identity before forwarding, and after the Lead verifies source device,
real task, Worker, and current active team, the same local bridge handlers execute, accepting no arbitrary tools or target tasks.
The running host synchronously captures, before any async query, the origin of the coordinator's currently accepted input and this round's consumed input IDs.
Proactive reporting is allowed only when the current input comes from Orca dispatch and has consumed inputs; when the user sends directly on the running device, an accepted
manual interjection has taken over, or there is no active input, return `NOT_LEAD_ASSIGNED_TURN` without forwarding or settling. Current input must not be judged still the Lead's based only on persisted
Worker attribution or accumulated reply IDs; read-only Lead tools and the local Worker path are unchanged.
Consumed input IDs are passed to the Lead via optional `reportedInputClientIds`,
adding no parameters to model tools. Successful proactive reporting only removes these inputs' runtime and persisted waiting records; even if B is already
queued, A's report must not clear B or prematurely mark the Worker done. New dispatch's rollback chain synchronously removes reported inputs,
avoiding failure rollback restoring old waiting records. Only after everything is settled is the Worker terminal state updated; old ends lacking input identities keep auto reporting.
A full proactive report first completes TeamService's queries and identity verification, then commits the remaining
waiting records and Worker terminal state in the same database UPDATE, clearing the corresponding Team in-memory identity only after success; on database commit failure no layer of
waiting records is cleared — the existing polling continues closing out, and a restart will not treat committed retired records as unreported again. When new dispatch appears while waiting for Team
verification, remaining inputs are re-read; the new task must not be cleared per the pre-wait snapshot.
Remote dispatch failure completes two-layer rollback inside the same send lock before re-verification; when no inputs await reporting at runtime, also settle TeamService's
just-restored old waiting identity, avoiding the Lead waiting forever for the already-reported A; while inputs still await reports, do not settle.
Auto reporting only explains the system relaying results and cannot infer the Worker skipped calling tools; local Workers' proactive reporting rules,
original tool definitions and permissions are unchanged. Old ends or disconnections keep auto reporting, and write operations with unclear results are not blindly resent.
Implementation: `orcaRemoteWorkerBridge.ts`, `orcaRemoteWorkerRuntime.ts`; production-entry regressions in
`orcaRemoteWorkerBridge.test.ts` and the existing local `orca-bridge-mcp.test.ts`.

The remote report identity is saved in `orca_workers.pending_remote_report` before enqueue, and TeamService's
pending-report identity is rebuilt on recovery; duplicate starts of the same database owner do not clear dispatches. Only after the Lead accepts the report or that captured identity has been
settled/replaced are the dedup cursor and corresponding waiting records atomically updated; rejection or persistence failure keeps retrying, without clearing new dispatches.
Remote dispatch first saves the unfrozen pending-report identity, then executes the Lead's `onAccepted` permission/state verification; after success
owner and dispatch identity are verified again before enqueueing to the running device. On verification rejection nothing is sent, the previous generation's waiting records are restored and
the Lead state is restored per the existing accepted rollback; rollback's secondary errors are logged and do not overwrite the original rejection exception.
Explicit delivery failure also rolls back the staged accepted state; only after delivery succeeds or the result is unknown are commit and identity freezing done.
Dispatch accepted still means remotely persistently enqueued, not input consumed; proactive reporting settles by inputs the running host consumed,
providing no cross-device transactions or revocation of executed inputs.
Ending collaboration does not rely on cached running: first confirm the stop and save `remote_stop_confirmed_at`, then lift the collaboration marks;
cleanup is single-flight and reads the latest stage, later runs only completing unfinished stages. The remote route is cancelled only after archive commit succeeds.
When the creation receipt is lost, verify with the same sessionId, with unconfirmed identities saved in `orca_remote_opens`; orphan cleanup and
Worker association share the task lock, and after re-checking inside the lock only unassociated marks are lifted, keeping tasks, files, and user-initiated work.
The local proxy task row is created only when the Worker associates, committed in the same transaction as the Worker, remote route, and open receipt;
if it exits unassociated after open succeeded, there is no half-made local proxy, and only the persisted open identity lifts the remote mark.
A same-ID open succeeds only for tasks with matching origin, not yet released, and `status = active`; tasks the user archived or
soft-deleted return `PRECONDITION_FAILED`, without revival, association, or dispatch. Creation receipts are kept for orphan cleanup
to lift only origin marks; cleanup does not stop or delete tasks. Regressions cover archive/delete-then-retry after lost receipts and Host rebuilds.
The running device's real task and `orcaRemoteLead` are written in the same INSERT before starting the Agent; on startup failure or
process exit between the two, the same origin and Lead can still reconcile by task ID, leaving no ordinary task without a source mark.
Implementation: `createOrcaRemoteWorkerSessionOpener` in `orcaRemoteWorkerHost.ts`; regression in
`apps/desktop/src/main/localDb/__tests__/sessionOpening.test.ts`.
The open replies of new creations and same-ID retries carry the running device's actually-saved `fastMode`, adopted jointly by the local proxy and creation result;
only when an old running device lacks this optional field does it degrade to the request value, without guessing remote Fast capability from the local catalog.
Before recovery completes, dispatch and local-start entries
must not fall back to local per a missing runtime route, and read failure or owner change should refuse to continue.
Creation rollback atomically archives the proxy and releases the name and slot; Worker rows with unconfirmed release are kept for restart re-dispatch; normal
collaboration end still keeps the historical link, and rollback rows are deleted only after stop/release is confirmed.
Real tasks on the running device are identified by `orcaRemoteLead`, not disguised as local `orcaRole='worker'`;
Desktop and Mobile both hide the collaboration entry, and historical origin marks keeping `releasedAt` also do not allow nested collaboration.
Mobile's entry reads and leftover form submissions both check this identity, returning to the main panel after metadata completion marks;
regressions in `apps/mobile/src/__tests__/orcaTeam.test.ts` and `useOrcaWorkerForm.test.tsx`.

Known limitation of current stop compensation: `maker:abort-session` accepts only task IDs, with no target turn or persisted request
identity; if the running device already stopped but the receipt was lost, later compensation might stop turns the user newly initiated. Existing transport dedup
cannot cover new requests or running-device restarts. Treating timeout as success, cancelling all compensation, or substituting check-idle-then-stop
is not allowed; later, persistent idempotent stops, target-turn conditions, and old-end capability negotiation should be designed at an Orca-specific boundary, covering
new turns after lost receipts, restarts, concurrent retries, and account switches. The current implementation has not eliminated this risk.

Another known limitation of ending collaboration: abort only stops the current turn and release only writes the end mark, so remote Lead dispatches not yet executed
may remain in the persistent queue and execute later. Current remote-control enqueueing strips Orca semantic origin, and the source
device cannot distinguish user messages from auto dispatches sent by the same device; the last clientId alone cannot cover multiple
unconsumed inputs. The whole queue is not emptied directly, to avoid losing user messages. A complete fix must first establish a persistently verifiable Lead
delivery attribution and release boundary, then persist cancellation receipts and queue snapshots; covering multiple dispatches, user interleaving, consumption races,
lost receipts, restarts, and other controlling ends. This issue is not fixed this round; ending collaboration must not be considered to guarantee clearing pending dispatches.

This document requires keeping the following regression directions:

- Service boundaries: `orcaLifecycleService`, `orcaWorkerCreationService`, `orcaTeamService` unit tests covering the start/enable/create/dispatch/idle/archive/auto-bridge key paths.
- Auto-resume × auto-bridge: pending/deferred vendor terminal states must not bridge / set `error`; the failed turn's subsequent unclaimed `done` likewise must not close out (including after user-takeover force-flush, and the persist-id-less zero-output tail); old tails without a paired `done` must not swallow later larger-generation product `done`s; surface/exhaust closes exactly once; successful resume keeps `running` with pending retained; manual stop still does not bridge. See `autoResumeBookkeeping.test.ts`'s `shouldSkipOrcaWorkerTerminal` and `interruptedContinuationContract.test.ts`.
- Idle live direct send: `orcaInterAgentDispatcher` must first `prepareUnhealthySession` before `session.send()`, then re-fetch `getLiveSession`; after prepare closes the old handle, do not keep sending to the old object. Concurrent direct sends must serialize onto the same per-session lock.
- Worker creation permission preferences: cover default `bypassPermissions` when no preference saved, already-saved `auto` / `bypassPermissions` keeping priority, MCP explicit `auto → bypassPermissions` requiring user confirmation first with zero side effects on cancel/timeout, reusing a Team with omit-no-reset / update-only-on-explicit, first and later Workers both reading shared creation preferences, existing Worker permissions not written back, renderer localStorage startup sync and tool write-back, and old device-link controlled ends being blocked from enabling collaboration with an upgrade prompt.
- MCP tools: `cindy_orca`'s 21 tools (18 team + 3 read-only diagnostics) role gates, missing ctx, worker/main misuse, soft/hard limits, duplicate label, budget model API mode gate; `create_workers` additionally covering default hard limit, configured hard=3, partial success, consecutive failures, and no host calls after hard limit; `update_worker` covering attribution verification (cross-lead rejection), role/label normalization, idempotent no-op, duplicate label and generated title sync; the diagnostic tools' pure read-only semantics (empty workspace when no active team, no team creation); the 6 queued-message control tools' attribution verification (cross-lead rejection), full consuming projection, non-lead entry rejection (`NOT_LEAD_MESSAGE`), own-queue non-collab entry rejection (`NOT_ORCA_MESSAGE`), steering rejection (`MESSAGE_CONSUMING`), withdrawal settling accepted staging, merge consecutiveness, zero-modification on conflict and removal callback settlement, and steering reason receipts and reorder landing; `send_to_worker` / `send_to_lead`'s `delivery` default not passed through, explicit interjection and the various fallback reasons; `interrupt_worker` additionally covering queue-head reservation, paused state, all graceful-stop outcomes, auto-bridge suppression, and done mutual exclusion.
- Codex MCP context: `CodexMcpThreadContextStore` covering context lookup by threadId, unknown / missing threadId fail-closed, cleanup after unregister, `vendorOptions` reference retention; `codexHttpBridge` covering injecting the real session context from JSON-RPC `params._meta.threadId`.
- Host attribution verification: `send_to_worker`, `interrupt_worker`, queue control, `idle_worker`, `archive_worker` via shared `resolveWorkerRef` (accepting both worker_id / session_id) must verify with the caller's own Lead identity, rejecting cross-workflow worker ids and missing ctx; even if the model passes a wrong id or switches to the other id kind, overreach is impossible.
- UI route: Orca workers do not appear in the sidebar, Leads auto-enter the split route, worker deep links resolve to the Lead split route; covered by `apps/desktop/src/renderer/features/cc-agent/__tests__/OrcaWorkflowRoute.navigation.test.tsx` and `OrcaWorkflowRoute.compat.test.tsx`.
- Fork / side_chat foundation: user fork, assistant fork, Codex `tailTurnsToDrop`, Claude turn-final assistant uuid, tool_use rejection.
- Worktree: toggle off/on, non-git/already-in-worktree only disabling the worktree toggle without blocking send; worktree cleaned after Lead close.
- Post-restart Lead↔Worker mutual access (resume) regression matrix: covering enable paths `enableTeam` auto first worker / MCP `start_team` + `create_worker` / renderer `requestEnableCollab` → `SESSION_ENABLE_ORCA` → `enableTeam`, and restart timing "mid-conversation" and "initialized but no conversation yet"; acceptance actions must at least include `list_workers` seeing the worker, Lead-side `send_to_worker` able to deliver or queue, Worker-side `send_to_lead` able to reply, and focused / idle workers able to resume.
- Restart matrix / scenario 1 "lead worker normal initialization": after creating collaboration, Lead `orca_role='lead'`, worker session `orca_role='worker'`, the `orca_workers` link, and focused/list projections should be written simultaneously, with both the renderer split view and MCP `list_workers` seeing the same worker.
- Restart matrix / scenario 2 "collaboration halfway, restart maker, lead worker can access each other": with existing Lead↔Worker conversation history and possible running/done states, after restart vendorOptions / worker links are lazily synthesized from `sessions.orca_role` + `orca_workers/orca_teams`, and `send_to_worker` and worker `send_to_lead` can still resume delivery; Worker runtime recovery must keep `sessions.permission_mode` and must not silently escalate permissions.
- Restart matrix / scenario 3 "just enabled collaboration, initialization done, no conversation yet, restart maker, lead worker can access each other": the empty worker must not stay at just the DB link; the ready placeholder must make the worker agent side write a resumable history, especially guarding against Codex rollout missing.
- Restart matrix / scenario 4 "open a single session first, halfway through, enable collaboration via prompt, see lead worker initialize normally, then restart maker immediately, lead worker can access each other": the prompt path must go through MCP `start_team` + `create_worker` and the shared lifecycle service, without bypassing worker link, role marks, vendorOptions rehydrate, and resume constraints.
- Restart matrix / scenario 5 "open a single session first, halfway through, enable collaboration via the collaboration button, see lead worker initialize normally, then restart maker immediately, lead worker can access each other": the button path must enter `SESSION_ENABLE_ORCA` / `enableTeam` from `requestEnableCollab`, satisfying the same restart recovery and mutual-access capabilities as the MCP path.

### Pitfalls and Invariants

#### 1. Codex MCP context routing must fail-closed (status: invariant)

The Codex HTTP bridge may treat only JSON-RPC `params._meta.threadId` as the business-session routing basis; `mcp-session-id` only identifies the MCP transport and does not prove maker session attribution, so it is not a routing basis. Routing rule: inject only when threadId hits a registered context; when missing, unknown, inconsistent within a batch, or incomplete, never inject — let tool calls safely degrade to NO_SESSION_CONTEXT, and never guess a ctx causing cross-session crosstalk. Implementation: `CodexMcpThreadContextStore.getContextForThreadId` and `codexHttpBridge`'s message-level routing.

#### 2. Codex MCP context lifecycle must bind to the thread (status: invariant)

After a Codex thread start / resume succeeds, `threadId -> session context` must be registered; session close must unregister. Context injection happens during tool-call message processing, depending on neither the turn/item notification timing window nor a TTL. Thus long turns, concurrent tool calls, and outdated notifications do not affect session context availability; when `_meta.threadId` is truly missing, still fail-closed per Pitfall #1.

#### 3. Worker control entries must do attribution verification by the caller's own Lead identity (status: invariant)

`send_to_worker` / `interrupt_worker` / queue control / `idle_worker` / `archive_worker` resolve targets through the shared `resolveWorkerRef`: it **accepts both worker_id and worker session_id** (ids treated as opaque tokens, exact match; 0 hits → NOT_FOUND, multiple hits → error with no side effects), but resolves **only within the caller's own worker list**. The caller's own `ctx.sessionId` must be used as callerLeadSessionId, verifying the target worker matches that Lead/team; missing ctx must be rejected outright (`LEAD_NOT_SUPPORTED`, no pass-through, no backfill), and cross-workflow worker ids are rejected at the host service layer. This is defense-in-depth orthogonal to Pitfall #1: fail-closed routing guarantees ctx does not bleed into someone else's, and attribution verification then blocks the overreach of "ctx correct, model passed wrong id". Implementation: `orcaTeamService.ts`'s `resolveWorkerRef` and the worker control methods.

`switch_focus` is a pure UI focus operation going through the separate pure function `findFocusTargetWorker` (`orcaTeamService.ts`): **worker_id / session_id exact match first, label as fallback** — accepting the human-friendly label beyond what mutation tools accept (humans/agents often switch the view by label), deliberately not reusing `resolveWorkerRef` (mutation tools should not recognize labels). register.ts's IPC handler and the MCP holder's two switch_focus paths share this one helper; do not inline find separately again.

#### 4. `orca_worker_bridge` is globally visible to Codex/Pi shared bridging (status: follow-up)

Claude's per-session MCP mounts the Worker bridge only when `orcaRole === 'worker'` or `orcaRemoteWorker === true`
; ordinary tasks and Leads also have `getSessionContext`, and the accessor's existence must not be treated as Worker
identity evidence. The Codex/Pi shared HTTP bridge has no real task identity at factory stage and still registers a global server;
at tool-call time it must read the host-bound real identity from `getSessionContext`, verifying by local Worker link or remote
Worker origin, with ordinary task / Lead calls returning explicit errors and no guessing of a missing ctx. Implementation and mount-matrix
regressions: `packages/orca-workflow/src/orca-bridge-mcp.ts` and its `orca-bridge-mcp.test.ts`.

#### 5. Diagnostic tool names in the Lead prompt (status: resolved)

Historical issue: the Lead prompt of `renderOrcaLeadSystemPrompt` (`packages/orca-workflow/src/orca-bridge-prompt.ts`) referenced `get_workspace_info` / `worker_status` / `read_worker` by bare tool names, but these used to live only in the Claude-lead-specific `orca_bridge`, invisible to Codex Leads, creating steady noise. After unification, these 3 diagnostic tools are bridged as **same-named bare tools** into the globally visible `cindy_orca`, so both Claude and Codex Leads resolve real tools and the noise is gone. The Lead prompt continues using bare tool names only; new flow-control copy only declares the selection and atomicity boundaries of `interrupt_worker`, `get_worker_queue_status`, `merge_queued_messages`, and per [`maker-core-and-agent-behavior.md`](../../dev-rules/maker-core-and-agent-behavior.md) §4 keeps system-section changes minimal, locked by snapshot tests.

#### 6. Agent/model selection applies at the send boundary (status: invariant)

Leads/Workers can switch bidirectionally among Claude Code, Codex, and Pi and select models; the selection is first registered as a pending intent without interrupting the current turn. Cross-Agent switching closes the old runtime and rebuilds before the next send, keeping the collaboration identity; collaboration direct sends first call `applyPendingAgentSwitchIfIdle`, and queue dequeue and resume continue reusing the unified send transaction. Already-dispatched local receipts use the Agent of the runtime that actually accepted the message, and must not return the pre-switch Worker snapshot; messages still queued keep the current Agent, without forecasting a switch not yet executed. SSH tasks still do not support cross-Agent switching, and users cannot change Agent location through it. Effort remains a per-turn parameter. Implementation: `sessionAgentSwitchHandler.ts`, `orcaInterAgentDispatcher.ts`, `orcaTeamService.ts`, and `register.ts`; regressions for the three engines' six directions and Lead/Worker: `sessionAgentSwitchHandler.test.ts`, `orcaInterAgentDispatcher.test.ts`, `orcaTeamService.test.ts`, and `makerSendTransaction.test.ts`.

Running-device Worker dispatch still goes through `maker:input:enqueue`, and success only confirms delivery to that computer, not that the model has executed. After delivery, the existing `local-db:messages:around-client-id` reads a single message by that input's `clientId` (`radius: 0`, body capped at 1 character); a non-queued receipt's Agent takes the message row's `agentKind` written when the input was accepted (`cc` normalized to `claude-code`), not task configuration from before enqueue or after. When not yet accepted, old ends lack the engine field, or reads fail, reply queued only, without forecasting a pending engine switch, and do not turn a delivered input into a failed re-dispatch. Ordinary dispatch and interrupt re-dispatch reuse this rule; no new wire fields or shared-chain changes. When the running device dequeues and resumes sending, the unified transaction recognizes both local `orcaRole` and the persisted `orcaRemoteLead`; if the switch intent still exists after being applied, sending to the old Agent is rejected, and input-origin labels are not trusted to judge identity. Failure only blocks that task's current send, without disconnecting the shared chain or affecting other Workers. Regressions: `orcaRemoteWorkers.test.ts`, `orcaRemoteWorkerRuntime.test.ts`, and `makerSendTransaction.test.ts`.

Real Workers on the execution device are likewise constrained by the in-place switching boundary: the switching handler reads `orcaRemoteLead` from the task row, and the user cannot migrate it to a third computer via explicit `agentDeviceId`; same-location three-Agent/model switching is still allowed. The existing provider-group internal immediate-location-change exception is unchanged. When the Orca Agent is already on another computer, mobile's model panel reads the target Harness's prefetch, capability cache, panel loading, and selection validation all from that computer; the switching intent is still executed by the task's computer, without opening computer switching because of it.
Desktop and Mobile simultaneously hide the computer-switch entry per the existing `orcaRemoteLead` projection, not mistaking an execution-device Worker's empty `orcaRole` for an ordinary task, nor changing its collaboration role. Old controlling ends are still refused migration by the above main process, without new wire fields.

Desktop Orca same-Agent model selection continues to reuse ordinary tasks' window checks and confirmation dialogs, keeping the specifically verified window with the local switching intent. An unknown window only means the choice can be staged, not consent to rebuild; when a rebuild is needed before sending, the confirmed window must match the window verified at that time (including Pi's final window). On mismatch, keep the intent and stop sending; re-selecting the model re-checks. Effort/Fast-only adjustments keep the same route's confirmation; model/source switches cannot inherit it. device-link does not accept controlling-end-submitted window confirmation numbers, and ordinary tasks' original behavior is unchanged. Regressions: `orcaModelWindowSelection.test.ts`, `orcaModelSelectionIntent.test.ts`, and Mobile `orcaModelSelection.test.ts`.
Workers with only `orcaRemoteLead` on the execution device likewise obey the above window confirmation requirements: the initial check and Pi final-window check must not use ordinary tasks' send-time default confirmation, and Pi must not overwrite the currently verified window with an old confirmation number.

When the Orca Agent is on another computer, same-Agent selection re-reads the execution computer's authorized catalog at the send boundary, checking current usage against the verified window of the same source and model; the confirmation value at click time must not be treated as the latest window or default confirmation. Both online and cold recovery go through the existing window handoff entry; when a handoff is needed but the confirmation value mismatches the latest window, the catalog is unreadable, or the handoff is incomplete, keep the intent and do not persist the new selection. When the catalog still has no verified window, the hot-switch semantics stand, without guessing the window from an old confirmation value and rebuilding. The commit after window verification re-verifies task attribution; failure only blocks that task's current send, without reconnecting, re-dispatching, or affecting other tasks on the shared chain. Regression: `orcaRemoteModelWindowSelection.test.ts`.

Worker creation and default-model inheritance boundaries do provider-aware compatibility for legacy short IDs: prefer keeping the exact ID usable on the target route
; only when exact matching fails, the candidate source belongs to the managed Gateway, the
`namespace/short-id` canonical candidate is exactly one and simultaneously present in `list_available_models`'s capabilities
list, and the Model Registry confirms the route ID is itself a stable model identity, is it resolved to the canonical ID in memory.
Inferring by suffix alone is not allowed, otherwise standard models would silently switch to same-suffix discounted models. Custom Provider's exact short IDs
must stay unchanged; with zero or multiple candidates or catalog identity mismatch, fail closed — no guessing, no rewriting persisted values of existing Leads,
Sessions, or default configuration.
A `providerId` cached separately in Worker defaults does not constrain normalization of models inherited from the Lead / hard-coded defaults;
it participates in final routing only when it still provides the final exact model ID. Conversely, when old defaults cache only `model` without
`providerId`, they must not borrow the Lead's source either, and the default route must be resolved by currently connected sources. When the cached source is stale
or does not offer the model, the creation boundary may fall back to searching currently connected sources, but in the end it must still obtain an exact route or a unique
managed canonical candidate, otherwise reject before reservation / bootstrap.

Once the Worker creation boundary resolves the actual source, it must write that `providerId` into the Worker session; clearing it back
to `null` because the source belongs to official subscriptions or the managed default route is not allowed. Explicit sources win; without explicit selection, a
same-agent Lead source providing the target model wins first, then a valid Worker defaults source, then the default source is resolved by the same current
provider routing snapshot. When the Lead's bound same-model source is currently unavailable, it must be explicitly rejected before
reservation / bootstrap — silently switching to Cindy AI or another credential family is not allowed; old model-only
defaults are resolved per the current snapshot with the actual source saved. Thus Claude Code's Anthropic source reliably gets
`oauth-bearer`, while explicit Cindy AI / custom Providers keep their own routes.

#### 7. Prompt / tool / MCP registration paths must evaluate maker-core's four metrics (status: invariant)

Whenever a change lands on prompt concatenation, tool/MCP exposure, translator, event loop, model mapping, or usage/token metering paths, it must evaluate cache rate, performance/response speed, and returned-content accuracy, with live-measured evidence per [`maker-core-and-agent-behavior.md`](../../dev-rules/maker-core-and-agent-behavior.md) §3. In particular, do not stuff per-turn volatile content into the stable system/developer prefix, and do not casually add/remove/reorder tool definitions mid-session.

#### 8. `forkedAtMessageId` schema comment lagging (status: follow-up)

`forkedAtMessageId` needs to cover both user and assistant fork origins, and the schema comment should be maintained per that semantics; see `sessions.forkedAtMessageId` in `apps/desktop/src/main/localDb/schema.ts`. This is a doc/comment bug and does not affect runtime; later schema comment changes must go through the normal migration/code review process, not hand-editing migrations.

#### 9. `parent_session_id` does not mean Orca dispatch (status: invariant)

`parent_session_id` is a fork/session-branch relation, not worker attribution. Orca attribution must query `orca_teams/orca_workers`; route behavior regressions: `apps/desktop/src/renderer/features/cc-agent/__tests__/OrcaWorkflowRoute.navigation.test.tsx` and `OrcaWorkflowRoute.compat.test.tsx`.

#### 10. Worker recycling must be restrained (status: lossless idle release has landed)

A Worker's value is its continuable, observable, intervenable context. PR #340 landed lossless idle release: when a Worker exceeds the configured idle threshold with no running turn or queued input, the idle watcher closes the Maker runtime this process holds and atomically CAS-writes `status = idle` and `idle_since`. `idle_since != null` is the persisted marker that the runtime has been released, not a fifth Worker state beyond `idle/running/done/error`; the Worker record, session, history, and context all remain.

When work is dispatched to that Worker again, the existing resume chain reuses or rebuilds the runtime and restores the running state when the task is accepted. Under shared userData multi-instance, the watcher only releases Workers whose runtime this process actually holds; records without a local runtime stay unchanged, handled by their runtime owner.

This mechanism is only equivalent to lossless hibernate, not archive/delete. `idle_worker/archive_worker/end_team` keep their explicit control semantics; automatic lossy recycling of long-term Workers, and differentiated recycling policies after persistent/ephemeral typing, should stay conservative and land separately later.

## Part 2 · Future Planning

### Execution Unit Vision

Orca's long-term direction is not "entering one fixed collaboration mode", but casually opening a set of **side activity / child execution** beside the mainline. Different types have different underlying capabilities, but the UI and control plane should be as unified as possible: all can be seen, managed, interrupted/archived, with origin, artifacts, and state recorded.

Top-level side activity target types:

- `worker`: a Lead-dispatched side session; sustainable, interjectable, reportable back.
- `side_chat`: a branch dialogue the user forked from some message/turn; self-driven exploration, no report-back by default, optional report-back.
- `workflow_run`: deterministic orchestration runs, showing the step tree, progress, failure points, and artifacts.

`subagent` is not a top-level side activity. It is a runner: lightweight by default, use-and-discard, as the underlying execution body of workflow steps or the Lead's temporary small jobs. Only when the user needs to see the process, ask follow-ups, take over, or keep records are its records taken over into a visible side session.

### Three-State Separation

In the future all visible execution units must separate three things:

| Dimension        | Question                            | Example values          |
| ----------- | ------------------------------- | ----------------- |
| Does the object exist | Are identity, history, context retained      | exists / deleted  |
| Does the UI show it | Whether mounted in the current panel or sidebar      | active / archived |
| Is the background awake | Whether the SDK/process is live and can take work immediately | live / dormant    |

Do not let `idle`, `archive`, `close` keep mixing these three things. Archive is UI/visibility, dormant is background liveness, and only delete is object deletion.

### Worker Lifecycle Typing

The current schema has not yet landed persistent/ephemeral fields or typing strategies. PR #340 first provided type-agnostic idle release/resume fundamentals: all legal Worker states can release the local runtime after the idle timeout, recording the release result with `idle_since != null`. The following two classes are target strategies after typing lands:

Workers are planned in two classes:

| Type       | Semantics                                          | Default recycling policy                                     |
| ---------- | --------------------------------------------- | ------------------------------------------------ |
| persistent | Long-term collaborator, valued for context continuity and intervenability          | Lossless hibernate/resume allowed; no auto archive/delete |
| ephemeral  | Observable one-shot execution unit, like a "visible subagent" | After done/error may preferentially enter recycling candidates                  |

`role` is orthogonal to lifecycle. `developer/reviewer/tester/merger` are responsibilities, not long-term or one-shot. After typing lands, creation may declare lifecycle; runtime promotion/demotion comes later.

One-shot tasks do not necessarily need a worker. Only when conditions like "needs an independently visible history, multi-turn follow-ups, the Lead switching over to review, user takeover, shared model/bridge/audit" are met is an ephemeral worker worthwhile; otherwise a subagent should be used.

### Top-Level Types and Runner Layering

The first layer is top-level side activities:

| Type           | Visualized object                 | Intervention depth                               |
| -------------- | -------------------------- | -------------------------------------- |
| `worker`       | A single side session's process stream | Deep: dispatch, follow-ups, takeover, report-back             |
| `side_chat`    | The branch dialogue's process stream           | Deep: user-driven, optional report-back           |
| `workflow_run` | Orchestration tree, progress, failure points, artifacts | Orchestration-level: pause/cancel/retry/skip/view artifacts |

The second layer is the step tree inside workflow_run: each step has a runner, defaulting to a subagent; high-risk, long-running, failed, or user-intervention-needing steps can use a worker runner or be taken over into a worker.

A workflow step is not a top-level type; it belongs inside workflow_run. `subagent` is not a top-level type either; it is a runner.

### Side Chat

side_chat and workers share the same pane shell. The difference is not in the UI shell but in the relation contract:

| Dimension     | worker                                             | side_chat                                               |
| -------- | -------------------------------------------------- | ------------------------------------------------------- |
| Initiator   | Lead dispatch or user explicitly creating a worker                     | User forks from the current message/turn                                |
| Default communication | Lead ↔ Worker, auto/manual report-back                     | User ↔ Side chat, no report-back by default                            |
| Result attribution | By default returns to the Lead for acceptance                        | By default stays in the branch, optional adoption/report-back                             |
| Relation fields | task, role, label, return_to, communication policy | source session/message/turn, fork reason, return policy |

PR #107 has completed side_chat's underlying fork data actions:

- user fork: copies context before that user message; the new session composer pre-fills the original question.
- assistant fork: copies to the end of the turn containing that reply, avoiding dangling tool_use.
- Claude: finds the nearest non-subagent assistant uuid before the copy boundary and passes `upToMessageId`.
- Codex: first ThreadFork latest, then ThreadRollback the trailing user turns per `tailTurnsToDrop`.
- The new session records `parentSessionId/forkedAtMessageId`, but currently still navigates as an ordinary session.

What side_chat still needs:

1. Register as a side activity object: add `execution_type='side_chat'` and the relation contract.
2. Mount into the unified pane instead of the current `navigate(/cc-agent/<newSession.id>)` navigation away.
3. Relation contract typing: no report-back by default, optional report-back/adoption, recording the source turn and artifact provenance.

### Relation Contract

Relations must not be a single `relation_kind` enum. They should be a field set including at least:

- `execution_type`: `worker | side_chat | workflow_run`.
- `lifecycle_kind`: `persistent | ephemeral`, applying to worker / side_chat.
- `source_session_id`.
- `source_message_id` or `source_turn_id`.
- `initiator`: user fork, Lead dispatch, workflow trigger, system recovery, etc.
- `return_to`: which parent / step / user action the result returns to, or none.
- `communication_policy`: parent→child one-way, parent↔child two-way, user takeover allowed, peer allowed, etc.
- `artifact_ownership`: to whom diffs / file changes / artifacts belong by default.
- `provenance`: origin, adoption, overrides, human intervention, budget/gate results.

Note workflow_run is not a flat parent-child relation; it has a `run → step → runner` nested tree, and the relation table must be able to express that.

### The Control Plane's Nine Mechanisms

Behind the unified side activity shell, nine classes of control-plane capabilities are needed:

1. **Capability matrix / UI degradation contract**: which actions are available under each `execution_type × lifecycle_kind × runtime state`, e.g. send, interrupt, effort, archive, resume, takeover, delete.
2. **Communication topology**: who can message whom, and how parent-child, peer, and user takeover each route.
3. **Result report-back**: auto-return, manual pull, aggregation on completion, branch-only — to be distinguished from the current coarse-grained auto-bridge.
4. **Artifact aggregation**: how multiple execution units' diffs, file changes, reports, and conclusions aggregate into mainline decisions.
5. **Cancel / interrupt / retry semantics**: who may interrupt and whether it cascades; whether a workflow step retry is a new runner or reuses the worker.
6. **Quality gate / Lead acceptance**: `done` is only execution end; quality adjudication is an orthogonal axis. Do not stuff `gate_failed` into worker status; record quality verdict / terminal reason / provenance instead.
7. **Concurrency and resource governance**: soft/hard limits, queuing, priority, recycling policy under pressure.
8. **Budget gates (闸)**: per-worker and per-team turn/token/cost caps; soft limits go to Lead/user decisions, hard limits terminate and record the reason.
9. **Permission / attribution / consistency repair**: who may take over, whether a child can see parent context, how orphan steps/workers reconcile, and how report-back failures compensate.

### Phased Roadmap

1. **Stabilize the current worker foundation**: Codex MCP context routing is already fail-closed and worker control entries already do caller attribution verification (Pitfalls #1/#3 are already invariants); remaining follow-ups are adding the worker bridge role gate (Pitfall #4) and continuously adding regression tests. (Pitfall #5 was resolved by bridging the diagnostic tools into `cindy_orca`; `orca_bridge` (A) has been deleted entirely.)
2. **Lifecycle modeling**: introduce `lifecycle_kind` and live/dormant, unify the resume helper, no automatic lossy recycling by default.
3. **Side activity relation layer**: add relation/side activity data structures, compatible with existing `parent_session_id/forked_at_message_id` and `orca_teams/orca_workers`.
4. **Bring side_chat into the pane**: reuse PR #107's fork action, but create a side_chat child execution mounted into the unified pane, no report-back by default.
5. **Unified control plane**: capability matrix, communication/report-back/artifact aggregation, quality gates, budget governance.
6. **workflow_run**: introduce the step tree, runner policies, step retry/skip/cancel, and taking key steps over into workers.

### Open Discussion Items

1. Is the relation layer a single table, event table + projection, or split tables per side activity / workflow_run?
2. side_chat's default display policy: immediately occupy the worker pane after creation, open a new pane tab, or enter the side activity list awaiting user choice?
3. side_chat result adoption UX: report back a summary, insert into the parent composer, generate a diff/provenance review, or support all three?
4. persistent/ephemeral defaults: is side_chat persistent or ephemeral by default?
5. When does a workflow step auto-take-over into a worker: failure, timeout, high-risk files, user naming — the criteria need tightening.
6. Are budget / quality routing skill+memory decisions or main-process deterministic policies, and how do they coexist with user preferences?
