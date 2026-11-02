# ADR 0008 — Hermes as an Orca worker, started as an expert

- **Status:** Accepted (owner, 2026-11-02: picked "Hermes Orca worker" over a separate delegate tool)
- **Date:** 2026-11-02
- **Decider:** owner. ROADMAP 3.9 (ADR 0005 step 4). Widens ADR 0006 by one server and changes one
  lizi MCP tool schema (AGENTS.md §3 allows this only when the row says so; row 3.9a says so).

## Context

ADR 0005 has the orchestrator delegate each job to an expert as an Orca worker. Two parts are missing:

- Experts only run on Hermes (3.2a; 3.2b is blocked), but `create_worker` / `create_workers`
  accept only `claude-code | codex | pi` (`packages/lizi-mcps/src/xdt-helper/create_worker.ts`).
- The worker creation path (`orcaWorkerCreationService.ts` `createWorkerInTeam`) routes model and
  provider per agent; Hermes has no providers there (its model is a Cindy route name or the
  `hermes-default` home model, checked by the Hermes adapter's preflight on each turn).
- A Hermes worker in a team would get `cindy_orca` through ADR 0006's collab gate, so it could
  create workers itself: that breaks ADR 0005's depth-1 rule.

## Decision

1. **Schema.** `create_worker` / `create_workers` accept `agent: "hermes"` and an optional
   `expert: "<slug>"`. `expert` is only valid with `agent: "hermes"`; the tool refuses it otherwise.
   `session_control` and the scheduler enums are not changed.
2. **Own branch, upstream path untouched.** `createWorkerInTeam` hands `agent: "hermes"` to a new
   `createHermesWorkerInTeam` (new file, same pattern as the existing remote branch). It keeps the
   shared rules (label, hard limit, reservation, plan validation, bootstrap, rollback) and skips
   provider routing. Local only: no `execution_device_id`, `agent_device_id`, `new_worktree`, or
   SSH lead (refused with `INVALID_PARAMS`).
3. **Expert first, fail closed.** The expert must load and be `agent: hermes` before any session is
   created. Model: `model` argument, else the expert's `model:` route, else `hermes-default`.
   The worker session is bound to the expert right after bootstrap, before its first turn, so the
   existing first-turn preamble (3.2a, with memory 3.4b) applies; the route check stays at send time.
4. **Depth 1 on the bridge.** A Hermes session whose `orcaRole` is `worker` sees
   `orca_worker_bridge` (`send_to_lead`, ...) and **not** `cindy_orca`. A lead keeps `cindy_orca`
   only. Same collab gate and Full-access rule as ADR 0006.
5. Not in 3.9a: the orchestrator expert file, the per-job turn cap, and the live run (3.9b).

## Consequences

- An orchestrator lead can start a visible Hermes worker as any loadable Hermes expert.
- Hermes workers cost what their route costs; the owner picks the route in the expert file.
- Upstream changes are limited to the schema enum/field, the type, a pass-through, and one branch
  line in `createWorkerInTeam`; the provider logic is not edited.

## Addendum — 3.9b (2026-11-02)

- **Listing experts.** `list_experts` on `cindy_experts` (read-only): loadable Hermes experts with
  slug, name, description, model, memory, tags; other agents and broken folders under `unavailable`
  with the reason. Mounted only for a session whose expert lists `tools: [list_experts]`, re-checked
  per call. Starter expert `docs/experts-examples/orchestrator/`.
- **Turn cap.** Every run of a Hermes session with `orcaRole: worker` gets `--max-turns 40`
  (`HERMES_ORCA_WORKER_MAX_TURNS`, maker-core Hermes agent; the daemon stores `maxTurns` from
  `query/start`, 1–1000, and passes it on each run). Hermes 0.22.5 counts tool-calling iterations
  per conversation turn. Leads and solo sessions keep the Hermes home default (150). Fixed, not per
  expert, until a run shows a need.
- **Bind order fix.** The worker is bound to its expert before `bootstrapSession`, because bootstrap
  starts the Hermes agent and its tool bridge reads the binding then (an Expert Creator worker needs
  `draft_expert`). A failed bootstrap leaves an inert binding to an id that never existed.
- **Draft wait (3.9b2).** `draft_expert` waits 280 s for the owner (`EXPERT_DRAFT_TIMEOUT_MS`), not
  the 9-minute host-confirm timeout in ADR 0007: Hermes 0.22.5 abandons an MCP tool call after
  300 s, so a later answer would save the expert while the agent saw a failure. The Team pane
  mounts the draft card for the shown worker, since an embedded worker view has no session header.
